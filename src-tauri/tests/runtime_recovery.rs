use iris_lib::runtime::ProductionRuntime;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

fn envelope(command: &str, args: Value, idempotency_key: Option<&str>) -> Value {
    let mut envelope = json!({
        "protocolVersion": "1",
        "commandId": ProductionRuntime::new_id("cmd"),
        "command": command,
        "args": args,
        "actor": { "kind": "cli", "instanceId": "cli_runtime_recovery_test" }
    });
    if let Some(key) = idempotency_key {
        envelope["idempotencyKey"] = json!(key);
    }
    envelope
}

fn get_task(runtime: &ProductionRuntime, task_id: &str) -> Value {
    runtime
        .execute(&envelope("task.get", json!({ "taskId": task_id }), None))
        .expect("task")
}

fn test_database_path() -> PathBuf {
    std::env::temp_dir()
        .join(format!("iris-runtime-recovery-{}", Uuid::now_v7()))
        .join("state.db")
}

#[test]
fn delay_worker_completes_a_durable_task_without_a_client_connection() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime");
    let receipt = runtime
        .execute(&envelope(
            "runtime.test.delay",
            json!({ "delayMs": 50 }),
            Some("worker-completes"),
        ))
        .expect("receipt");
    let task_id = receipt["taskId"].as_str().expect("task id");
    let deadline = Instant::now() + Duration::from_secs(2);

    let completed = loop {
        let task = get_task(&runtime, task_id);
        if task["status"] == "completed" {
            break task;
        }
        assert!(Instant::now() < deadline, "task did not complete: {task}");
        thread::sleep(Duration::from_millis(10));
    };

    assert_eq!(completed["result"], json!({ "delayedMs": 50 }));
    assert!(completed["leaseOwner"].is_null());
    assert!(completed["leaseExpiresAt"].is_null());
}

#[test]
fn a_restarted_runtime_reclaims_a_task_only_after_its_lease_expires() {
    let database_path = test_database_path();
    fs::create_dir_all(database_path.parent().expect("database parent"))
        .expect("create database directory");
    let (task_id, first_lease_owner, first_lease_expiry) = {
        let runtime =
            ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &database_path).expect("runtime");
        let receipt = runtime
            .execute(&envelope(
                "runtime.test.delay",
                json!({ "delayMs": 200 }),
                Some("recover-delay"),
            ))
            .expect("receipt");
        let task_id = receipt["taskId"].as_str().expect("task id").to_owned();
        let deadline = Instant::now() + Duration::from_secs(1);
        let working = loop {
            let task = get_task(&runtime, &task_id);
            if task["status"] == "working" {
                break task;
            }
            assert!(Instant::now() < deadline, "task was never claimed: {task}");
            thread::sleep(Duration::from_millis(10));
        };
        (
            task_id,
            working["leaseOwner"]
                .as_str()
                .expect("lease owner")
                .to_owned(),
            working["leaseExpiresAt"].as_i64().expect("lease expiry"),
        )
    };

    let restarted =
        ProductionRuntime::open(env!("CARGO_PKG_VERSION"), &database_path).expect("restart");
    let before_expiry = get_task(&restarted, &task_id);
    assert_eq!(before_expiry["status"], "working");
    assert_eq!(before_expiry["leaseOwner"], first_lease_owner);
    // 续租心跳在读出 working 与关闭第一个 Runtime 之间可能再续一次：只要求租约没有提前被新 Runtime 接管。
    assert!(
        before_expiry["leaseExpiresAt"].as_i64().expect("lease expiry") >= first_lease_expiry,
        "lease went backwards: {before_expiry}"
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let task = get_task(&restarted, &task_id);
        if task["status"] == "completed" {
            break;
        }
        assert!(Instant::now() < deadline, "task was not recovered: {task}");
        thread::sleep(Duration::from_millis(20));
    }

    drop(restarted);
    let _ = fs::remove_dir_all(database_path.parent().expect("database parent"));
}

#[test]
fn cancellation_is_persisted_and_honored_at_the_next_worker_safe_point() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime");
    let receipt = runtime
        .execute(&envelope(
            "runtime.test.delay",
            json!({ "delayMs": 2_000 }),
            Some("cancel-delay"),
        ))
        .expect("receipt");
    let task_id = receipt["taskId"].as_str().expect("task id");
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let task = get_task(&runtime, task_id);
        if task["status"] == "working" {
            break;
        }
        assert!(Instant::now() < deadline, "task was never claimed: {task}");
        thread::sleep(Duration::from_millis(10));
    }

    let requested = runtime
        .execute(&envelope(
            "task.cancel",
            json!({ "taskId": task_id, "reason": "test requested" }),
            Some("cancel-request"),
        ))
        .expect("cancel request");
    assert_eq!(requested["status"], "working");
    assert!(requested["cancelRequestedAt"].as_i64().is_some());

    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let task = get_task(&runtime, task_id);
        if task["status"] == "cancelled" {
            assert!(task["leaseOwner"].is_null());
            assert!(task["leaseExpiresAt"].is_null());
            break;
        }
        assert!(Instant::now() < deadline, "task was not cancelled: {task}");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn an_idle_worker_is_woken_by_a_new_task_instead_of_waiting_out_its_backoff() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime");
    // 让空闲退避涨到上限（2 秒）。
    thread::sleep(Duration::from_millis(2_500));
    let submitted = Instant::now();
    let receipt = runtime
        .execute(&envelope(
            "runtime.test.delay",
            json!({ "delayMs": 50 }),
            Some("wake-delay"),
        ))
        .expect("receipt");
    let task_id = receipt["taskId"].as_str().expect("task id");
    let deadline = submitted + Duration::from_secs(3);
    let claimed_after = loop {
        let task = get_task(&runtime, task_id);
        if task["status"] != "queued" {
            break submitted.elapsed();
        }
        assert!(Instant::now() < deadline, "task was never claimed: {task}");
        thread::sleep(Duration::from_millis(5));
    };
    assert!(
        claimed_after < Duration::from_millis(500),
        "idle worker took {claimed_after:?} to claim a new task"
    );
}

#[test]
fn a_long_running_task_keeps_its_lease_while_the_executor_is_busy() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime");
    let receipt = runtime
        .execute(&envelope(
            "runtime.test.delay",
            json!({ "delayMs": 1_500 }),
            Some("lease-heartbeat"),
        ))
        .expect("receipt");
    let task_id = receipt["taskId"].as_str().expect("task id");
    let deadline = Instant::now() + Duration::from_secs(1);
    let owner = loop {
        let task = get_task(&runtime, task_id);
        if task["status"] == "working" {
            break task["leaseOwner"].as_str().expect("owner").to_owned();
        }
        assert!(Instant::now() < deadline, "task was never claimed: {task}");
        thread::sleep(Duration::from_millis(10));
    };
    // 每次领单都有自己的所有者标记。
    assert!(owner.contains(':'), "owner should be per-claim: {owner}");
    for _ in 0..10 {
        thread::sleep(Duration::from_millis(100));
        let task = get_task(&runtime, task_id);
        if task["status"] == "completed" {
            break;
        }
        assert_eq!(task["leaseOwner"].as_str(), Some(owner.as_str()), "lease changed hands: {task}");
    }
}
