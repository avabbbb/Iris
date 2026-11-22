use iris_lib::runtime::ProductionRuntime;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

struct TestWorkspace(PathBuf);

impl TestWorkspace {
    fn create() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".tmp")
            .join(format!("resolve-r1-{}", Uuid::now_v7()));
        fs::create_dir_all(&path).expect("create isolated Runtime workspace");
        Self(path)
    }

    fn database_path(&self) -> PathBuf {
        self.0.join("state.db")
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn envelope(command: &str, args: Value, idempotency_key: Option<&str>) -> Value {
    let mut envelope = json!({
        "protocolVersion": "1",
        "commandId": ProductionRuntime::new_id("cmd"),
        "command": command,
        "args": args,
        "actor": { "kind": "cli", "instanceId": "cli_resolve_r1_test" }
    });
    if let Some(idempotency_key) = idempotency_key {
        envelope["idempotencyKey"] = json!(idempotency_key);
    }
    envelope
}

fn await_completed_task(runtime: &ProductionRuntime, task_id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let task = runtime
            .execute(&envelope("task.get", json!({ "taskId": task_id }), None))
            .expect("read fixture task");
        if task["status"] == "completed" {
            return task;
        }
        assert_ne!(task["status"], "failed", "fixture task failed: {task}");
        assert_ne!(
            task["status"], "cancelled",
            "fixture task was cancelled: {task}"
        );
        assert!(
            Instant::now() < deadline,
            "fixture task did not complete: {task}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn resolve_fixture_task_returns_a_durable_verified_png_path() {
    let workspace = TestWorkspace::create();
    let runtime = ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &workspace.database_path())
        .expect("open Runtime");
    let first = runtime
        .execute(&envelope(
            "runtime.test.fixture-image",
            json!({}),
            Some("resolve-fixture-once"),
        ))
        .expect("submit deterministic image fixture");
    let replay = runtime
        .execute(&envelope(
            "runtime.test.fixture-image",
            json!({}),
            Some("resolve-fixture-once"),
        ))
        .expect("replay deterministic image fixture");

    assert_eq!(replay, first, "idempotent retry must reuse the same task");
    assert_eq!(first["kind"], "task");
    let task_id = first["taskId"].as_str().expect("task id");
    let task = await_completed_task(&runtime, task_id);
    let artifact = &task["result"]["artifact"];
    assert_eq!(artifact["kind"], "image");
    assert_eq!(artifact["mimeType"], "image/png");
    assert_eq!(task["result"]["providerCalled"], false);
    assert_eq!(task["result"]["costMicros"], 0);

    drop(runtime);
    let reopened = ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &workspace.database_path())
        .expect("reopen Runtime with the same artifact store");
    let located = reopened
        .execute(&envelope(
            "artifact.locate",
            json!({ "taskId": task_id }),
            None,
        ))
        .expect("locate the persisted artifact");
    let path = PathBuf::from(located["path"].as_str().expect("artifact path"));
    let root = workspace
        .path()
        .canonicalize()
        .expect("canonical test root");
    let canonical_path = path.canonicalize().expect("canonical artifact file");
    assert!(canonical_path.starts_with(&root));

    let bytes = fs::read(&canonical_path).expect("read persisted fixture");
    let payload = reopened
        .read_artifact(task_id)
        .expect("read artifact after Runtime reopen");
    let expected_sha256 = hex::encode(Sha256::digest(&bytes));
    assert_eq!(payload.mime_type, "image/png");
    assert_eq!(payload.bytes, bytes);
    // 桌面 IPC 的二进制帧：[u32 BE mime 长度][mime][文件字节]，内容与 read_artifact 一致。
    let frame = reopened
        .read_artifact_frame(task_id)
        .expect("read artifact frame after Runtime reopen");
    let mime_len = u32::from_be_bytes(frame[..4].try_into().expect("frame header")) as usize;
    assert_eq!(&frame[4..4 + mime_len], b"image/png");
    assert_eq!(&frame[4 + mime_len..], bytes.as_slice());
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert_eq!(located["taskId"], task_id);
    assert_eq!(located["mimeType"], "image/png");
    assert_eq!(located["byteSize"].as_u64(), Some(bytes.len() as u64));
    assert_eq!(located["sha256"], expected_sha256);
    assert_eq!(located["artifactId"], format!("sha256:{expected_sha256}"));
}

#[test]
fn same_size_artifact_tampering_is_rejected_by_locate_and_read() {
    let workspace = TestWorkspace::create();
    let runtime = ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &workspace.database_path())
        .expect("open Runtime");
    let receipt = runtime
        .execute(&envelope(
            "runtime.test.fixture-image",
            json!({}),
            Some("resolve-fixture-tamper"),
        ))
        .expect("submit deterministic image fixture");
    let task_id = receipt["taskId"].as_str().expect("task id");
    await_completed_task(&runtime, task_id);
    let located = runtime
        .execute(&envelope(
            "artifact.locate",
            json!({ "taskId": task_id }),
            None,
        ))
        .expect("locate the persisted artifact");
    let path = PathBuf::from(located["path"].as_str().expect("artifact path"));
    let mut tampered = fs::read(&path).expect("read original fixture");
    let original_size = tampered.len();
    tampered[20] ^= 0x01;
    fs::write(&path, &tampered).expect("overwrite fixture with same-size content");

    assert_eq!(tampered.len(), original_size);
    let locate_error = runtime
        .execute(&envelope(
            "artifact.locate",
            json!({ "taskId": task_id }),
            None,
        ))
        .expect_err("locate must reject same-size tampering");
    assert_eq!(locate_error.code, "RUNTIME_UNAVAILABLE");
    let read_error = runtime
        .read_artifact(task_id)
        .expect_err("artifact read must reject same-size tampering");
    assert_eq!(read_error.code, "RUNTIME_UNAVAILABLE");
    let frame_error = runtime
        .read_artifact_frame(task_id)
        .expect_err("artifact frame must reject same-size tampering");
    assert_eq!(frame_error.code, "RUNTIME_UNAVAILABLE");
}

#[test]
fn locate_does_not_expose_an_artifact_before_task_completion() {
    let workspace = TestWorkspace::create();
    let runtime = ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &workspace.database_path())
        .expect("open Runtime");
    let receipt = runtime
        .execute(&envelope(
            "runtime.test.delay",
            json!({ "delayMs": 400 }),
            Some("resolve-fixture-not-ready"),
        ))
        .expect("submit in-progress task");
    let task_id = receipt["taskId"].as_str().expect("task id");
    let error = runtime
        .execute(&envelope(
            "artifact.locate",
            json!({ "taskId": task_id }),
            None,
        ))
        .expect_err("locate must wait for task completion");

    assert_eq!(error.code, "TASK_NOT_COMPLETED");
}
