use iris_lib::runtime::ProductionRuntime;
use serde_json::json;
use uuid::{Uuid, Version};

#[test]
fn runtime_status_comes_from_the_canonical_v1_contract() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime contract");
    let status = runtime.status();

    assert_eq!(status.protocol_version, "1");
    assert!(status.runtime_instance_id.starts_with("runtime_"));
    assert_eq!(status.registry_hash, runtime.registry().registry_hash);
    assert_eq!(status.authority, "desktop-runtime");
    assert_eq!(status.state, "ready");
    assert_eq!(
        runtime.registry().registry_hash,
        "e9aff2e7836dea0638b297d94f29490aa13c49b78139cbd4835207a2cb6dff0d"
    );
    assert!(runtime.registry().commands.contains_key("runtime.status"));
    assert!(!runtime.registry().commands.contains_key("workflow.run"));
}

#[test]
fn runtime_execute_dispatches_only_available_canonical_commands() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime contract");
    let envelope = |command: &str, args: serde_json::Value| {
        json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": command,
            "args": args,
            "actor": { "kind": "cli", "instanceId": "cli_test" }
        })
    };

    let list = runtime
        .execute(&envelope("command.list", json!({})))
        .expect("command list");
    assert_eq!(list["registryHash"], runtime.registry().registry_hash);
    assert_eq!(
        list["commands"]["runtime.status"]["availability"],
        "available"
    );

    let schema = runtime
        .execute(&envelope(
            "command.schema",
            json!({ "command": "generate.video" }),
        ))
        .expect("command schema");
    assert_eq!(schema["command"], "generate.video");
    assert_eq!(schema["schema"]["availability"], "available");

    assert_eq!(
        runtime
            .execute(&envelope("help", json!({})))
            .expect_err("legacy command must not dispatch")
            .code,
        "RUNTIME_UNAVAILABLE"
    );
}

#[test]
fn runtime_ids_and_payload_hashes_are_canonical() {
    let first = json!({"b": 2, "a": 1});
    let reordered = json!({"a": 1, "b": 2});

    assert_eq!(
        ProductionRuntime::hash_payload(&first).expect("canonical hash"),
        ProductionRuntime::hash_payload(&reordered).expect("canonical hash")
    );
    assert_eq!(
        ProductionRuntime::hash_payload(&first).expect("canonical hash"),
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );

    let id = ProductionRuntime::new_id("cmd");
    let uuid = Uuid::parse_str(id.strip_prefix("cmd_").expect("command prefix")).expect("uuid");
    assert_eq!(uuid.get_version(), Some(Version::SortRand));
}

#[test]
fn runtime_rejects_invalid_protocol_and_unknown_commands() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime contract");
    let base = json!({
        "protocolVersion": "1",
        "commandId": "cmd_test",
        "command": "runtime.status",
        "args": {},
        "actor": { "kind": "cli", "instanceId": "cli_local" }
    });

    let mut unknown_field = base.clone();
    unknown_field["leaked"] = json!(true);
    assert_eq!(
        runtime
            .validate_envelope(&unknown_field)
            .expect_err("unknown field")
            .code,
        "INVALID_ARGUMENT"
    );

    let mut protocol_mismatch = base.clone();
    protocol_mismatch["protocolVersion"] = json!("2");
    assert_eq!(
        runtime
            .validate_envelope(&protocol_mismatch)
            .expect_err("protocol mismatch")
            .code,
        "PROTOCOL_MISMATCH"
    );

    let mut unknown_command = base;
    unknown_command["command"] = json!("workflow.run");
    assert_eq!(
        runtime
            .validate_envelope(&unknown_command)
            .expect_err("unknown command")
            .code,
        "UNKNOWN_COMMAND"
    );
}

#[test]
fn runtime_exposes_redacted_provider_status_and_durable_generation_receipts() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime contract");
    let status = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "provider.status",
            "args": {},
            "actor": { "kind": "cli", "instanceId": "cli_test" }
        }))
        .expect("provider status");
    assert_eq!(status["providers"][0]["provider"], "google");
    assert_eq!(status["providers"][0]["ready"], false);
    assert_eq!(status["providers"][1]["provider"], "runningHub");
    assert_eq!(status["providers"][1]["ready"], false);
    assert_eq!(
        status["providers"][1]["routes"][3]["routeId"],
        "rhart-video-v3.1-lite-official/text-to-video"
    );
    assert_eq!(
        status["providers"][1]["routes"][0]["routeId"],
        "rhart-image-g-2/text-to-image"
    );
    assert_eq!(
        status["providers"][1]["routes"][1]["routeId"],
        "rhart-image-g-2/image-to-image"
    );
    assert_eq!(
        status["providers"][1]["routes"][2]["routeId"],
        "rhart-video-g/text-to-video"
    );
    assert!(status.to_string().find("secret").is_none());

    let receipt = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.video",
            "args": {
                "prompt": "paper collage history explainer",
                "productModel": "flovart:veo-3.1-lite",
                "durationSec": 8,
                "aspectRatio": "16:9",
                "resolution": "720p"
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "video-contract-1"
        }))
        .expect("video receipt");
    assert_eq!(receipt["kind"], "task");
    assert_eq!(receipt["status"], "queued");

    let runninghub_receipt = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.video",
            "args": {
                "prompt": "paper collage history explainer",
                "provider": "runningHub",
                "productModel": "flovart:veo-3.1-lite",
                "durationSec": 8,
                "aspectRatio": "16:9",
                "resolution": "720p"
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "video-contract-runninghub-1"
        }))
        .expect("runninghub video receipt");
    assert_eq!(runninghub_receipt["kind"], "task");
    assert_eq!(runninghub_receipt["status"], "queued");

    let image_receipt = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.image",
            "args": {
                "prompt": "editorial paper collage senate diagram",
                "provider": "runningHub",
                "productModel": "flovart:gpt-image-2",
                "aspectRatio": "16:9",
                "resolution": "1k"
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "image-contract-runninghub-1"
        }))
        .expect("runninghub image receipt");
    assert_eq!(image_receipt["kind"], "task");
    assert_eq!(image_receipt["status"], "queued");

    let image_edit_receipt = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.image",
            "args": {
                "prompt": "preserve the approved paper collage style",
                "provider": "runningHub",
                "productModel": "flovart:gpt-image-2",
                "sourceImageIds": ["task_approved_style_reference"],
                "aspectRatio": "16:9",
                "resolution": "1k"
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "image-edit-contract-runninghub-1"
        }))
        .expect("runninghub image edit receipt");
    assert_eq!(image_edit_receipt["kind"], "task");
    assert_eq!(image_edit_receipt["status"], "queued");

    let grok_receipt = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.video",
            "args": {
                "prompt": "animated editorial paper collage",
                "productModel": "flovart:grok-imagine-video-1.5",
                "durationSec": 6,
                "aspectRatio": "16:9",
                "resolution": "720p"
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "video-contract-grok-1"
        }))
        .expect("grok video receipt");
    assert_eq!(grok_receipt["kind"], "task");
    assert_eq!(grok_receipt["status"], "queued");

    let grok_image_to_video_receipt = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.video",
            "args": {
                "prompt": "animate the supplied flat paper collage with subtle parallax",
                "productModel": "flovart:grok-imagine-video-1.5",
                "sourceImageIds": ["task_keyframe_1"],
                "durationSec": 6,
                "aspectRatio": "16:9",
                "resolution": "720p"
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "video-contract-grok-i2v-1"
        }))
        .expect("grok image-to-video receipt");
    assert_eq!(grok_image_to_video_receipt["kind"], "task");
    assert_eq!(grok_image_to_video_receipt["status"], "queued");

    let expensive = runtime
        .execute(&json!({
            "protocolVersion": "1",
            "commandId": ProductionRuntime::new_id("cmd"),
            "command": "generate.video",
            "args": {
                "prompt": "paper collage",
                "productModel": "flovart:veo-3.1",
                "durationSec": 8
            },
            "actor": { "kind": "cli", "instanceId": "cli_test" },
            "idempotencyKey": "video-contract-2"
        }))
        .expect_err("non-lite route");
    assert_eq!(expensive.code, "ROUTE_UNAVAILABLE");
}

#[test]
fn runtime_persists_only_non_secret_agent_text_routes() {
    let runtime = ProductionRuntime::new(env!("CARGO_PKG_VERSION")).expect("runtime contract");
    let route = json!({
        "protocolVersion": "1",
        "commandId": ProductionRuntime::new_id("cmd"),
        "command": "agent-text.route.sync",
        "args": {
            "routes": [{
                "provider": "openai",
                "credentialId": "openai-main",
                "model": "gpt-5-mini",
                "baseUrl": "https://api.openai.com/v1",
                "protocol": "openai-chat-completions",
                "order": 0
            }]
        },
        "actor": { "kind": "ui", "instanceId": "webui_test" }
    });

    let synced = runtime.execute(&route).expect("agent-text route sync");
    assert_eq!(synced["target"], "runtime-capability:agent-text");
    assert_eq!(synced["routes"][0]["credentialId"], "openai-main");
    assert_eq!(synced["secretFieldsStored"], false);
    assert!(!synced.to_string().contains("apiKey"));

    let mut leaked = route;
    leaked["commandId"] = json!(ProductionRuntime::new_id("cmd"));
    leaked["args"]["routes"][0]["apiKey"] = json!("must-never-enter-runtime-route-storage");
    let error = runtime
        .execute(&leaked)
        .expect_err("provider secret must be rejected");
    assert_eq!(error.code, "INVALID_ARGUMENT");
}
