mod agent_text;
mod auth;
mod browser_import;
mod contracts;
mod control_server;
mod discovery;
mod error;
mod events;
mod google_veo;
mod pipeline_trace;
mod production;
mod production_task;
mod registry;
mod runninghub;
mod store;
mod tasks;
mod worker;

pub use browser_import::{
    BrowserImportArtifactPayload, BrowserImportBegin, BrowserImportChunkAck, BrowserImportPairing,
    BrowserImportReceipt, BrowserImportStore, BrowserImportTransfer, BROWSER_IMPORT_CHUNK_BYTES,
};
pub use contracts::{RuntimeError, RuntimeStatus};
pub use control_server::ControlServer;
pub use discovery::{default_discovery_path, DiscoveryRecord};
pub use error::RuntimeContractError;
pub use events::{RuntimeEvent, RuntimeEventPage};
pub use registry::CanonicalRegistry;
pub use tasks::{RuntimeTask, RuntimeTaskPage, TaskReceipt};

use contracts::{COMMAND_ENVELOPE_SCHEMA, COMMAND_ENVELOPE_SCHEMA_ID};
use registry::load_registry;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use store::RuntimeStore;
use uuid::Uuid;

/// Validate and resolve a `storeRelpath` value against the artifact root.
/// Strips the `runtime-artifacts/` prefix, rejects absolute paths and
/// `ParentDir` components, then canonicalizes and verifies the result
/// stays within the root.  Returns the resolved absolute path on success.
pub fn validate_store_relpath(
    store_relpath: &str,
    artifact_root: &Path,
) -> Result<PathBuf, String> {
    let relative_path = store_relpath
        .strip_prefix("runtime-artifacts/")
        .or_else(|| store_relpath.strip_prefix("runtime-artifacts\\"))
        .ok_or_else(|| "artifact path is invalid".to_owned())?;
    let relative_path = Path::new(relative_path);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("artifact path escapes the runtime artifact root".to_owned());
    }
    let canonical_root = std::fs::canonicalize(artifact_root)
        .map_err(|error| format!("artifact root is unavailable: {error}"))?;
    let path = std::fs::canonicalize(artifact_root.join(relative_path))
        .map_err(|error| format!("artifact is unavailable: {error}"))?;
    if !path.starts_with(&canonical_root) {
        return Err("artifact path is outside the runtime artifact root".to_owned());
    }
    Ok(path)
}

pub struct ProductionRuntime {
    runtime_version: String,
    runtime_instance_id: String,
    registry: CanonicalRegistry,
    envelope_validator: jsonschema::Validator,
    store: Arc<RuntimeStore>,
    browser_imports: Arc<BrowserImportStore>,
    artifact_root: Option<PathBuf>,
    _worker: worker::RuntimeWorker,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifactPayload {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

impl ProductionRuntime {
    pub fn new(runtime_version: impl Into<String>) -> Result<Self, RuntimeContractError> {
        Self::build(
            runtime_version,
            RuntimeStore::in_memory()?,
            BrowserImportStore::in_memory()?,
            None,
        )
    }

    pub fn open(
        runtime_version: impl Into<String>,
        database_path: &Path,
    ) -> Result<Self, RuntimeContractError> {
        let artifact_root = database_path
            .parent()
            .map(|parent| parent.join("runtime-artifacts"));
        let browser_imports = match artifact_root.as_ref() {
            Some(root) => BrowserImportStore::open(database_path, root)?,
            None => BrowserImportStore::in_memory()?,
        };
        Self::build(
            runtime_version,
            RuntimeStore::open(database_path)?,
            browser_imports,
            artifact_root,
        )
    }

    fn build(
        runtime_version: impl Into<String>,
        store: RuntimeStore,
        browser_imports: BrowserImportStore,
        artifact_root: Option<PathBuf>,
    ) -> Result<Self, RuntimeContractError> {
        let schema: Value = serde_json::from_str(COMMAND_ENVELOPE_SCHEMA)?;
        if schema.get("$id").and_then(Value::as_str) != Some(COMMAND_ENVELOPE_SCHEMA_ID) {
            return Err(RuntimeContractError::InvalidSchema(format!(
                "expected {COMMAND_ENVELOPE_SCHEMA_ID}"
            )));
        }
        let envelope_validator = jsonschema::validator_for(&schema)
            .map_err(|error| RuntimeContractError::InvalidSchema(error.to_string()))?;
        let store = Arc::new(store);
        let worker = worker::RuntimeWorker::start(store.clone(), artifact_root.clone());
        Ok(Self {
            runtime_version: runtime_version.into(),
            runtime_instance_id: Self::new_id("runtime"),
            registry: load_registry()?,
            envelope_validator,
            store,
            browser_imports: Arc::new(browser_imports),
            artifact_root,
            _worker: worker,
        })
    }

    pub fn registry(&self) -> &CanonicalRegistry {
        &self.registry
    }

    pub fn browser_imports(&self) -> &BrowserImportStore {
        &self.browser_imports
    }

    pub fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            protocol_version: self.registry.protocol_version.clone(),
            runtime_version: self.runtime_version.clone(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            registry_hash: self.registry.registry_hash.clone(),
            authority: "desktop-runtime".to_owned(),
            state: "ready".to_owned(),
        }
    }

    pub fn get_task(&self, task_id: &str) -> Result<RuntimeTask, RuntimeError> {
        self.store.get_task(task_id)
    }

    pub fn get_production_task(&self, task_id: &str) -> Result<Value, RuntimeError> {
        self.store.get_production_task(task_id)
    }

    pub fn resume_production_task(&self, task_id: &str) -> Result<Value, RuntimeError> {
        self.store.resume_production_task(task_id)
    }

    pub fn read_artifact(&self, task_id: &str) -> Result<RuntimeArtifactPayload, RuntimeError> {
        let (path, mime_type, expected_sha256, expected_byte_size) = self.artifact_file(task_id)?;
        let bytes = std::fs::read(path).map_err(|_| {
            RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact cannot be read")
        })?;
        let actual_sha256 = hex::encode(Sha256::digest(&bytes));
        if bytes.len() as u64 != expected_byte_size || actual_sha256 != expected_sha256 {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Media artifact failed integrity verification",
            ));
        }
        Ok(RuntimeArtifactPayload { mime_type, bytes })
    }

    /// 给桌面 IPC 用的二进制帧：`[u32 BE mime 长度][mime UTF-8][文件字节]`。
    /// 文件直接读进带前缀的缓冲区，不经 JSON 数组，也不多拷一份；完整性校验与 read_artifact 相同。
    pub fn read_artifact_frame(&self, task_id: &str) -> Result<Vec<u8>, RuntimeError> {
        let (path, mime_type, expected_sha256, expected_byte_size) = self.artifact_file(task_id)?;
        let unreadable =
            || RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact cannot be read");
        let mime = mime_type.as_bytes();
        let header_len = 4 + mime.len();
        let capacity = usize::try_from(expected_byte_size)
            .ok()
            .and_then(|size| size.checked_add(header_len))
            .ok_or_else(unreadable)?;
        let mut frame = Vec::with_capacity(capacity);
        frame.extend_from_slice(&(mime.len() as u32).to_be_bytes());
        frame.extend_from_slice(mime);
        std::fs::File::open(path)
            .and_then(|mut file| file.read_to_end(&mut frame))
            .map_err(|_| unreadable())?;
        let body = &frame[header_len..];
        let actual_sha256 = hex::encode(Sha256::digest(body));
        if body.len() as u64 != expected_byte_size || actual_sha256 != expected_sha256 {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Media artifact failed integrity verification",
            ));
        }
        Ok(frame)
    }

    pub fn locate_artifact(&self, task_id: &str) -> Result<Value, RuntimeError> {
        let (path, mime_type, expected_sha256, expected_byte_size) = self.artifact_file(task_id)?;
        let mut file = std::fs::File::open(&path).map_err(|_| {
            RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact cannot be read")
        })?;
        let actual_byte_size = file
            .metadata()
            .map_err(|_| RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact cannot be read"))?
            .len();
        if actual_byte_size != expected_byte_size {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Media artifact failed integrity verification",
            ));
        }
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let bytes_read = file.read(&mut buffer).map_err(|_| {
                RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact cannot be read")
            })?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
        }
        let actual_sha256 = hex::encode(hasher.finalize());
        if actual_sha256 != expected_sha256 {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Media artifact failed integrity verification",
            ));
        }
        Ok(serde_json::json!({
            "taskId": task_id,
            "artifactId": format!("sha256:{expected_sha256}"),
            "path": path.to_string_lossy(),
            "mimeType": mime_type,
            "sha256": expected_sha256,
            "byteSize": expected_byte_size
        }))
    }

    fn artifact_file(&self, task_id: &str) -> Result<(PathBuf, String, String, u64), RuntimeError> {
        let task = self.get_task(task_id)?;
        if task.status != "completed" {
            return Err(RuntimeError::new(
                "TASK_NOT_COMPLETED",
                "Media artifact is available only after its task completes",
            ));
        }
        let artifact = task
            .result
            .as_ref()
            .and_then(|result| result.get("artifact"))
            .ok_or_else(|| RuntimeError::new("INVALID_ARGUMENT", "Task has no media artifact"))?;
        let store_relpath = artifact
            .get("storeRelpath")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact path is missing")
            })?;
        let root = self.artifact_root.as_ref().ok_or_else(|| {
            RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Runtime artifact storage is unavailable",
            )
        })?;
        let path = validate_store_relpath(store_relpath, root).map_err(|message| {
            RuntimeError::new("RUNTIME_UNAVAILABLE", message)
        })?;
        let metadata = std::fs::metadata(&path).map_err(|_| {
            RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact cannot be read")
        })?;
        let expected_sha256 = artifact
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact checksum is missing")
            })?;
        if expected_sha256.len() != 64
            || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Media artifact checksum is invalid",
            ));
        }
        let expected_byte_size = artifact
            .get("byteSize")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact size is missing")
            })?;
        if !metadata.is_file() || metadata.len() != expected_byte_size {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Media artifact failed integrity verification",
            ));
        }
        let mime_type = artifact
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                RuntimeError::new("RUNTIME_UNAVAILABLE", "Media artifact MIME type is missing")
            })?
            .to_owned();
        Ok((
            path,
            mime_type,
            expected_sha256.to_ascii_lowercase(),
            expected_byte_size,
        ))
    }

    pub fn list_tasks(
        &self,
        status: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<RuntimeTaskPage, RuntimeError> {
        if status.is_some_and(|status| {
            ![
                "queued",
                "working",
                "input_required",
                "completed",
                "failed",
                "cancelled",
            ]
            .contains(&status)
        }) {
            return Err(RuntimeError::new(
                "INVALID_ARGUMENT",
                "task status filter is invalid",
            ));
        }
        if !(1..=100).contains(&limit) {
            return Err(RuntimeError::new(
                "INVALID_ARGUMENT",
                "task list limit must be between 1 and 100",
            ));
        }
        self.store.list_tasks(status, cursor, limit)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn cancel_task(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        task_id: &str,
        reason: Option<&str>,
    ) -> Result<RuntimeTask, RuntimeError> {
        let payload_hash = Self::hash_payload(&serde_json::json!({
            "command": "task.cancel",
            "args": { "taskId": task_id, "reason": reason },
        }))
        .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
        self.store.request_cancel(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            &payload_hash,
            task_id,
            reason,
        )
    }

    pub fn stream_events(
        &self,
        after_event_id: i64,
        task_id: Option<&str>,
        limit: u32,
    ) -> Result<RuntimeEventPage, RuntimeError> {
        if after_event_id < 0 {
            return Err(RuntimeError::new(
                "INVALID_ARGUMENT",
                "event cursor must not be negative",
            ));
        }
        if !(1..=500).contains(&limit) {
            return Err(RuntimeError::new(
                "INVALID_ARGUMENT",
                "event limit must be between 1 and 500",
            ));
        }
        self.store.list_events(after_event_id, task_id, limit)
    }

    pub fn open_agent_text_stream(
        &self,
        request: &Value,
    ) -> Result<agent_text::AgentTextStream, RuntimeError> {
        let request = agent_text::parse_request(request)?;
        let routes = self.store.list_agent_text_routes()?;
        if routes.is_empty() {
            return Err(RuntimeError::new(
                "ROUTE_UNAVAILABLE",
                "No agent-text route is configured",
            ));
        }
        for route in routes {
            let secret = crate::keyring::read_secret(&route.provider, &route.credential_id)
                .map_err(|_| {
                    RuntimeError::new(
                        "RUNTIME_UNAVAILABLE",
                        "The operating-system keyring could not be read",
                    )
                })?;
            if let Some(secret) = secret {
                return agent_text::open_provider_stream(&route, &secret, &request);
            }
        }
        Err(RuntimeError::new(
            "ROUTE_UNAVAILABLE",
            "No configured agent-text credential is available",
        ))
    }

    pub fn execute(&self, envelope: &Value) -> Result<Value, RuntimeError> {
        self.validate_envelope(envelope)?;
        match envelope["command"].as_str().unwrap_or_default() {
            "runtime.status" => serde_json::to_value(self.status())
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string())),
            "command.list" => serde_json::to_value(&self.registry)
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string())),
            "command.schema" => {
                let requested = envelope["args"].get("command").and_then(Value::as_str);
                match requested {
                    Some(command) => self
                        .registry
                        .commands
                        .get(command)
                        .map(|definition| {
                            serde_json::json!({
                                "command": command,
                                "schema": definition,
                            })
                        })
                        .ok_or_else(|| {
                            RuntimeError::new(
                                "UNKNOWN_COMMAND",
                                format!("Unknown Iris command: {command}"),
                            )
                        }),
                    None => serde_json::to_value(&self.registry).map_err(|error| {
                        RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string())
                    }),
                }
            }
            "provider.status" => {
                let args = &envelope["args"];
                validate_exact_args(args, &[])?;
                let google_credentials = self.store.list_provider_credentials(Some("google"))?;
                let runninghub_credentials =
                    self.store.list_provider_credentials(Some("runningHub"))?;
                Ok(serde_json::json!({
                    "providers": [
                        {
                            "provider": "google",
                            "ready": !google_credentials.is_empty(),
                            "capabilities": ["video"],
                            "productModels": ["flovart:veo-3.1-lite"],
                            "route": {
                                "model": google_veo::VEO_LITE_MODEL,
                                "resolution": "720p",
                                "durationsSec": [4, 6, 8],
                                "nativeAudio": true
                            },
                            "credentials": google_credentials
                        },
                        {
                            "provider": "runningHub",
                            "ready": !runninghub_credentials.is_empty(),
                            "capabilities": ["image", "video"],
                            "productModels": [
                                "flovart:gpt-image-2",
                                "flovart:grok-imagine-video-1.5",
                                "flovart:veo-3.1-lite"
                            ],
                            "routes": [
                                {
                                    "productModel": "flovart:gpt-image-2",
                                    "routeId": runninghub::GPT_IMAGE_2_ROUTE,
                                    "channelTier": "low-price",
                                    "resolution": "1k",
                                    "pricePreview": true
                                },
                                {
                                    "productModel": "flovart:gpt-image-2",
                                    "routeId": runninghub::GPT_IMAGE_2_EDIT_ROUTE,
                                    "channelTier": "low-price",
                                    "mode": "image-to-image",
                                    "resolution": "1k",
                                    "pricePreview": true
                                },
                                {
                                    "productModel": "flovart:grok-imagine-video-1.5",
                                    "routeId": runninghub::GROK_VIDEO_ROUTE,
                                    "channelTier": "low-price",
                                    "resolution": "720p",
                                    "durationsSec": [6],
                                    "pricePreview": true
                                },
                                {
                                    "productModel": "flovart:veo-3.1-lite",
                                    "routeId": runninghub::VEO_LITE_ROUTE,
                                    "channelTier": "official-stable",
                                    "resolution": "720p",
                                    "durationsSec": [4, 6, 8],
                                    "nativeAudio": true,
                                    "pricePreview": true
                                },
                                {
                                    "productModel": "flovart:grok-imagine-video-1.5",
                                    "routeId": runninghub::GROK_VIDEO_IMAGE_ROUTE,
                                    "channelTier": "low-price",
                                    "mode": "image-to-video",
                                    "resolution": "720p",
                                    "durationsSec": [6],
                                    "maxSourceImages": 10,
                                    "pricePreview": true
                                }
                            ],
                            "credentials": runninghub_credentials
                        }
                    ]
                }))
            }
            "agent-text.route.sync" => {
                let routes = agent_text::validate_routes(&envelope["args"])?;
                self.store.replace_agent_text_routes(&routes)?;
                Ok(serde_json::json!({
                    "target": "runtime-capability:agent-text",
                    "routes": routes,
                    "secretFieldsStored": false
                }))
            }
            "runtime.test.delay" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "runtime.test.delay requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(args, &["delayMs"])?;
                let delay_ms = args.get("delayMs").and_then(Value::as_u64).ok_or_else(|| {
                    RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "runtime.test.delay requires an integer delayMs",
                    )
                })?;
                if delay_ms > 30_000 {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "runtime.test.delay delayMs must not exceed 30000",
                    ));
                }
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "runtime.test.delay",
                    "args": args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store
                    .submit_delay(
                        envelope["commandId"].as_str().unwrap_or_default(),
                        envelope["actor"]["kind"].as_str().unwrap_or_default(),
                        envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                        idempotency_key,
                        &payload_hash,
                        args,
                    )
                    .and_then(to_value)
            }
            "runtime.test.fixture-image" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "runtime.test.fixture-image requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(args, &[])?;
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "runtime.test.fixture-image",
                    "args": args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store
                    .submit_fixture_image(
                        envelope["commandId"].as_str().unwrap_or_default(),
                        envelope["actor"]["kind"].as_str().unwrap_or_default(),
                        envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                        idempotency_key,
                        &payload_hash,
                        args,
                    )
                    .and_then(to_value)
            }
            "production.dry-run" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "production.dry-run requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(
                    args,
                    &[
                        "projectId",
                        "title",
                        "reviewPolicy",
                        "draftBinding",
                        "director",
                        "spec",
                    ],
                )?;
                production::compile_production_plan(args)?;
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "production.dry-run",
                    "args": args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store
                    .submit_production_plan(
                        envelope["commandId"].as_str().unwrap_or_default(),
                        envelope["actor"]["kind"].as_str().unwrap_or_default(),
                        envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                        idempotency_key,
                        &payload_hash,
                        args,
                    )
                    .and_then(to_value)
            }
            "production.status" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["runId"])?;
                let run_id = args
                    .get("runId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        RuntimeError::new("INVALID_ARGUMENT", "production.status requires runId")
                    })?;
                self.store.get_production_status(run_id)
            }
            "production.approve" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "production.approve requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(
                    args,
                    &[
                        "runId",
                        "gateType",
                        "decision",
                        "hardLimitMicros",
                        "note",
                        "approvedStageKey",
                    ],
                )?;
                let run_id = args
                    .get("runId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        RuntimeError::new("INVALID_ARGUMENT", "production.approve requires runId")
                    })?;
                let gate_type = args
                    .get("gateType")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "production.approve requires gateType",
                        )
                    })?;
                let decision = optional_string(args, "decision")?.unwrap_or("approved");
                let hard_limit_micros = optional_i64(args, "hardLimitMicros")?;
                let note = optional_string(args, "note")?;
                let approved_stage_key = optional_string(args, "approvedStageKey")?;
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "production.approve",
                    "args": args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store.approve_production_gate(
                    envelope["commandId"].as_str().unwrap_or_default(),
                    envelope["actor"]["kind"].as_str().unwrap_or_default(),
                    envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                    idempotency_key,
                    &payload_hash,
                    run_id,
                    gate_type,
                    decision,
                    hard_limit_micros,
                    note,
                    approved_stage_key,
                )
            }
            "production.run" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "production.run requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(args, &["runId"])?;
                let run_id = args
                    .get("runId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        RuntimeError::new("INVALID_ARGUMENT", "production.run requires runId")
                    })?;
                // Fail fast when the run has not cleared its system gates.
                let status = self.store.get_production_status(run_id)?;
                let run_status = status.get("status").and_then(Value::as_str).unwrap_or("");
                if !["queued", "running", "recovering"].contains(&run_status) {
                    return Err(RuntimeError {
                        code: "PRECONDITION_FAILED".to_owned(),
                        message: format!(
                            "ProductionRun must be approved before execution (status: {run_status})."
                        ),
                        retryable: false,
                        details: Some(serde_json::json!({
                            "runStatus": run_status,
                            "blockers": status.get("blockers")
                        })),
                        action_url: None,
                    });
                }
                // Director gates are stage-scoped: the scheduler must start
                // so it can pause at the matching stage and await review.
                // The worker enforces each stage's requiredGates before submit.
                let normalized_args = serde_json::json!({ "runId": run_id });
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "production.run",
                    "args": normalized_args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store
                    .submit_production_run(
                        envelope["commandId"].as_str().unwrap_or_default(),
                        envelope["actor"]["kind"].as_str().unwrap_or_default(),
                        envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                        idempotency_key,
                        &payload_hash,
                        &normalized_args,
                    )
                    .and_then(to_value)
            }
            "pipeline.run.get" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["runId", "since"])?;
                let run_id = args
                    .get("runId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        RuntimeError::new("INVALID_ARGUMENT", "pipeline.run.get requires runId")
                    })?;
                let since = match args.get("since") {
                    None | Some(Value::Null) => 0,
                    Some(value) => value.as_i64().filter(|n| *n >= 0).ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "pipeline.run.get since must be a non-negative integer",
                        )
                    })?,
                };
                self.store.get_pipeline_run(run_id, since)
            }
            "workflow.projection.get" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["projectId"])?;
                let project_id = args
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "workflow.projection.get requires projectId",
                        )
                    })?;
                self.store.get_workflow_projection(project_id)
            }
            "generate.image" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "generate.image requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(
                    args,
                    &[
                        "prompt",
                        "provider",
                        "credentialId",
                        "productModel",
                        "aspectRatio",
                        "resolution",
                        "sourceImageIds",
                    ],
                )?;
                let prompt = args.get("prompt").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "generate.image requires prompt")
                })?;
                if prompt.trim().is_empty() || prompt.len() > 8_000 {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "generate.image prompt must contain 1 to 8000 bytes",
                    ));
                }
                let provider = optional_string(args, "provider")?.unwrap_or("runningHub");
                let product_model =
                    optional_string(args, "productModel")?.unwrap_or("flovart:gpt-image-2");
                if provider != "runningHub" || product_model != "flovart:gpt-image-2" {
                    return Err(RuntimeError::new(
                        "ROUTE_UNAVAILABLE",
                        "GPT Image 2 is currently enabled only through the trusted RunningHub low-price route.",
                    ));
                }
                let aspect_ratio = optional_string(args, "aspectRatio")?.unwrap_or("16:9");
                if !["1:1", "16:9", "9:16", "4:3", "3:4"].contains(&aspect_ratio) {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "GPT Image 2 aspectRatio is not enabled by the trusted route profile.",
                    ));
                }
                let resolution = optional_string(args, "resolution")?.unwrap_or("1k");
                if resolution != "1k" {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "GPT Image 2 low-price tracer bullet is capped at 1k.",
                    ));
                }
                let credential_id = optional_string(args, "credentialId")?;
                let source_image_ids = optional_string_array(args, "sourceImageIds")?;
                if source_image_ids.len() > 10 {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "GPT Image 2 accepts at most 10 sourceImageIds.",
                    ));
                }
                let normalized_args = serde_json::json!({
                    "prompt": prompt,
                    "provider": provider,
                    "productModel": product_model,
                    "aspectRatio": aspect_ratio,
                    "resolution": resolution,
                    "credentialId": credential_id,
                    "sourceImageIds": source_image_ids
                });
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "generate.image",
                    "args": normalized_args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store
                    .submit_image(
                        envelope["commandId"].as_str().unwrap_or_default(),
                        envelope["actor"]["kind"].as_str().unwrap_or_default(),
                        envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                        idempotency_key,
                        &payload_hash,
                        &normalized_args,
                    )
                    .and_then(to_value)
            }
            "generate.video" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "generate.video requires idempotencyKey",
                        )
                    })?;
                let args = &envelope["args"];
                validate_exact_args(
                    args,
                    &[
                        "prompt",
                        "provider",
                        "credentialId",
                        "productModel",
                        "sourceImageIds",
                        "sourceVideoIds",
                        "slots",
                        "durationSec",
                        "aspectRatio",
                        "resolution",
                        "generateAudio",
                        "watermark",
                        "seed",
                    ],
                )?;
                let prompt = args.get("prompt").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "generate.video requires prompt")
                })?;
                if prompt.trim().is_empty() || prompt.len() > 8_000 {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "generate.video prompt must contain 1 to 8000 bytes",
                    ));
                }
                let product_model =
                    optional_string(args, "productModel")?.unwrap_or("flovart:veo-3.1-lite");
                let source_image_ids = optional_string_array(args, "sourceImageIds")?;
                if source_image_ids.len() > 10 {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "Grok image-to-video accepts at most 10 sourceImageIds.",
                    ));
                }
                if !source_image_ids.is_empty() && product_model != "flovart:grok-imagine-video-1.5"
                {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "sourceImageIds are currently enabled only for Grok Imagine Video 1.5 image-to-video.",
                    ));
                }
                for unsupported in ["sourceVideoIds", "slots", "watermark", "seed"] {
                    if args.get(unsupported).is_some_and(|value| {
                        !value.is_null()
                            && value.as_array().is_none_or(|items| !items.is_empty())
                            && value.as_bool() != Some(false)
                    }) {
                        return Err(RuntimeError::new(
                            "INVALID_ARGUMENT",
                            format!(
                                "The current text-to-video tracer bullet does not support {unsupported}"
                            ),
                        ));
                    }
                }
                if !["flovart:veo-3.1-lite", "flovart:grok-imagine-video-1.5"]
                    .contains(&product_model)
                {
                    return Err(RuntimeError::new(
                        "ROUTE_UNAVAILABLE",
                        "The requested video Product Model is not enabled in Production Runtime.",
                    ));
                }
                let provider = optional_string(args, "provider")?.unwrap_or(
                    if product_model == "flovart:grok-imagine-video-1.5" {
                        "runningHub"
                    } else {
                        "google"
                    },
                );
                if product_model == "flovart:grok-imagine-video-1.5" && provider != "runningHub" {
                    return Err(RuntimeError::new(
                        "ROUTE_UNAVAILABLE",
                        "Grok Imagine Video is enabled only through the trusted RunningHub low-price route.",
                    ));
                }
                if product_model == "flovart:veo-3.1-lite"
                    && !["google", "runningHub"].contains(&provider)
                {
                    return Err(RuntimeError::new(
                        "ROUTE_UNAVAILABLE",
                        "Veo 3.1 Lite is enabled only for google or runningHub.",
                    ));
                }
                let default_duration = if product_model == "flovart:grok-imagine-video-1.5" {
                    6
                } else {
                    8
                };
                let duration_sec = optional_i64(args, "durationSec")?.unwrap_or(default_duration);
                let allowed_duration = if product_model == "flovart:grok-imagine-video-1.5" {
                    duration_sec == 6
                } else {
                    [4, 6, 8].contains(&duration_sec)
                };
                if !allowed_duration {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "durationSec is not enabled by the trusted Product Model route profile.",
                    ));
                }
                let aspect_ratio = optional_string(args, "aspectRatio")?.unwrap_or("16:9");
                if !["16:9", "9:16"].contains(&aspect_ratio) {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "The trusted video route profile supports 16:9 or 9:16.",
                    ));
                }
                let resolution = optional_string(args, "resolution")?.unwrap_or("720p");
                if resolution != "720p" {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "The trusted video route profile is capped at 720p.",
                    ));
                }
                let credential_id = optional_string(args, "credentialId")?;
                let generate_audio = optional_bool(args, "generateAudio")?.unwrap_or(true);
                let normalized_args = serde_json::json!({
                    "prompt": prompt,
                    "provider": provider,
                    "productModel": product_model,
                    "durationSec": duration_sec,
                    "aspectRatio": aspect_ratio,
                    "resolution": resolution,
                    "generateAudio": generate_audio,
                    "sourceImageIds": source_image_ids,
                    "credentialId": credential_id
                });
                let payload_hash = Self::hash_payload(&serde_json::json!({
                    "command": "generate.video",
                    "args": normalized_args,
                }))
                .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                self.store
                    .submit_video(
                        envelope["commandId"].as_str().unwrap_or_default(),
                        envelope["actor"]["kind"].as_str().unwrap_or_default(),
                        envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                        idempotency_key,
                        &payload_hash,
                        &normalized_args,
                    )
                    .and_then(to_value)
            }
            "task.get" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["taskId"])?;
                let task_id = args.get("taskId").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "task.get requires taskId")
                })?;
                self.get_task(task_id).and_then(to_value)
            }
            "artifact.locate" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["taskId"])?;
                let task_id = args.get("taskId").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "artifact.locate requires taskId")
                })?;
                self.locate_artifact(task_id)
            }
            "task.inspect" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["taskId"])?;
                let task_id = args.get("taskId").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "task.inspect requires taskId")
                })?;
                self.get_production_task(task_id)
            }
            "task.resume" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["taskId"])?;
                let task_id = args.get("taskId").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "task.resume requires taskId")
                })?;
                self.resume_production_task(task_id)
            }
            "task.list" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["status", "cursor", "limit"])?;
                let status = optional_string(args, "status")?;
                if status.is_some_and(|status| {
                    ![
                        "queued",
                        "working",
                        "input_required",
                        "completed",
                        "failed",
                        "cancelled",
                    ]
                    .contains(&status)
                }) {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "task.list status is invalid",
                    ));
                }
                let cursor = optional_string(args, "cursor")?;
                let limit = optional_i64(args, "limit")?.unwrap_or(50);
                if !(1..=100).contains(&limit) {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "task.list limit must be between 1 and 100",
                    ));
                }
                self.list_tasks(status, cursor, limit as u32)
                    .and_then(to_value)
            }
            "task.cancel" => {
                let idempotency_key = envelope
                    .get("idempotencyKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::new("INVALID_ARGUMENT", "task.cancel requires idempotencyKey")
                    })?;
                let args = &envelope["args"];
                validate_exact_args(args, &["taskId", "reason"])?;
                let task_id = args.get("taskId").and_then(Value::as_str).ok_or_else(|| {
                    RuntimeError::new("INVALID_ARGUMENT", "task.cancel requires taskId")
                })?;
                let reason = match args.get("reason") {
                    Some(Value::String(reason)) => Some(reason.as_str()),
                    Some(_) => {
                        return Err(RuntimeError::new(
                            "INVALID_ARGUMENT",
                            "task.cancel reason must be a string",
                        ))
                    }
                    None => None,
                };
                self.cancel_task(
                    envelope["commandId"].as_str().unwrap_or_default(),
                    envelope["actor"]["kind"].as_str().unwrap_or_default(),
                    envelope["actor"]["instanceId"].as_str().unwrap_or_default(),
                    idempotency_key,
                    task_id,
                    reason,
                )
                .and_then(to_value)
            }
            "event.stream" => {
                let args = &envelope["args"];
                validate_exact_args(args, &["afterEventId", "taskId", "limit"])?;
                let after_event_id = optional_i64(args, "afterEventId")?.unwrap_or(0);
                if after_event_id < 0 {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "event.stream afterEventId must not be negative",
                    ));
                }
                let task_id = optional_string(args, "taskId")?;
                let limit = optional_i64(args, "limit")?.unwrap_or(100);
                if !(1..=500).contains(&limit) {
                    return Err(RuntimeError::new(
                        "INVALID_ARGUMENT",
                        "event.stream limit must be between 1 and 500",
                    ));
                }
                self.stream_events(after_event_id, task_id, limit as u32)
                    .and_then(to_value)
            }
            command => Err(RuntimeError {
                code: "RUNTIME_UNAVAILABLE".to_owned(),
                message: format!("Command is not available in Production Runtime: {command}"),
                retryable: false,
                details: Some(serde_json::json!({ "availability": "legacy-only" })),
                action_url: None,
            }),
        }
    }

    pub fn new_id(prefix: &str) -> String {
        format!("{prefix}_{}", Uuid::now_v7())
    }

    pub fn hash_payload(payload: &Value) -> Result<String, RuntimeContractError> {
        let canonical = serde_json_canonicalizer::to_vec(payload)?;
        Ok(hex::encode(Sha256::digest(canonical)))
    }

    pub fn validate_envelope(&self, envelope: &Value) -> Result<(), RuntimeError> {
        if envelope
            .get("protocolVersion")
            .is_some_and(|version| version != self.registry.protocol_version.as_str())
        {
            return Err(RuntimeError::new(
                "PROTOCOL_MISMATCH",
                format!(
                    "Unsupported protocol version: {}",
                    envelope["protocolVersion"]
                ),
            ));
        }
        self.envelope_validator
            .validate(envelope)
            .map_err(|error| RuntimeError::new("INVALID_ARGUMENT", error.to_string()))?;
        let command = envelope["command"].as_str().unwrap_or_default();
        if !self.registry.commands.contains_key(command) {
            return Err(RuntimeError::new(
                "UNKNOWN_COMMAND",
                format!("Unknown Iris command: {command}"),
            ));
        }
        Ok(())
    }
}

fn validate_exact_args(args: &Value, allowed: &[&str]) -> Result<(), RuntimeError> {
    let object = args
        .as_object()
        .ok_or_else(|| RuntimeError::new("INVALID_ARGUMENT", "args must be an object"))?;
    if let Some(field) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(RuntimeError::new(
            "INVALID_ARGUMENT",
            format!("Unknown argument: {field}"),
        ));
    }
    Ok(())
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, RuntimeError> {
    serde_json::to_value(value)
        .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))
}

fn optional_i64(args: &Value, field: &str) -> Result<Option<i64>, RuntimeError> {
    match args.get(field) {
        Some(Value::Number(value)) => value.as_i64().map(Some).ok_or_else(|| {
            RuntimeError::new("INVALID_ARGUMENT", format!("{field} must be an integer"))
        }),
        Some(_) => Err(RuntimeError::new(
            "INVALID_ARGUMENT",
            format!("{field} must be an integer"),
        )),
        None => Ok(None),
    }
}

fn optional_string<'a>(args: &'a Value, field: &str) -> Result<Option<&'a str>, RuntimeError> {
    match args.get(field) {
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(RuntimeError::new(
            "INVALID_ARGUMENT",
            format!("{field} must be a string"),
        )),
        None => Ok(None),
    }
}

fn optional_bool(args: &Value, field: &str) -> Result<Option<bool>, RuntimeError> {
    match args.get(field) {
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(RuntimeError::new(
            "INVALID_ARGUMENT",
            format!("{field} must be a boolean"),
        )),
        None => Ok(None),
    }
}

fn optional_string_array(args: &Value, field: &str) -> Result<Vec<String>, RuntimeError> {
    match args.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) if !value.trim().is_empty() => Ok(value.to_owned()),
                _ => Err(RuntimeError::new(
                    "INVALID_ARGUMENT",
                    format!("{field} must contain non-empty strings"),
                )),
            })
            .collect(),
        Some(_) => Err(RuntimeError::new(
            "INVALID_ARGUMENT",
            format!("{field} must be an array of strings"),
        )),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn runtime_status(runtime: tauri::State<'_, Arc<ProductionRuntime>>) -> RuntimeStatus {
    runtime.status()
}

#[tauri::command]
pub fn runtime_execute(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    envelope: Value,
) -> Result<Value, RuntimeError> {
    if envelope["actor"]["kind"] != "ui" {
        return Err(RuntimeError::new(
            "PERMISSION_DENIED",
            "Tauri IPC accepts UI actors only",
        ));
    }
    runtime.execute(&envelope)
}

#[tauri::command]
pub fn runtime_artifact_read(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    task_id: String,
) -> Result<tauri::ipc::Response, RuntimeError> {
    // 原始二进制响应：前端拿到 ArrayBuffer，大视频不再被序列化成 JSON 数字数组。
    runtime
        .read_artifact_frame(&task_id)
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn browser_import_pairing_list_pending(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
) -> Result<Vec<BrowserImportPairing>, RuntimeError> {
    runtime.browser_imports().list_pending_pairings()
}

#[tauri::command]
pub fn browser_import_pairing_approve(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    extension_origin: String,
) -> Result<(), RuntimeError> {
    runtime.browser_imports().approve_pairing(&extension_origin)
}

#[tauri::command]
pub fn browser_import_pairing_reject(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    extension_origin: String,
) -> Result<(), RuntimeError> {
    runtime.browser_imports().reject_pairing(&extension_origin)
}

#[tauri::command]
pub fn browser_import_destination_set(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    project_id: Option<String>,
) -> Result<(), RuntimeError> {
    runtime
        .browser_imports()
        .set_active_project(project_id.as_deref())
}

#[tauri::command]
pub fn browser_import_list_pending(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
) -> Result<Vec<BrowserImportReceipt>, RuntimeError> {
    runtime.browser_imports().list_pending()
}

#[tauri::command]
pub fn browser_import_route_to_project(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    import_id: String,
    project_id: String,
) -> Result<BrowserImportReceipt, RuntimeError> {
    runtime
        .browser_imports()
        .route_to_project(&import_id, &project_id)
}

#[tauri::command]
pub fn browser_import_mark_consumed(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    import_id: String,
    project_id: String,
    node_id: String,
) -> Result<BrowserImportReceipt, RuntimeError> {
    runtime
        .browser_imports()
        .mark_consumed(&import_id, &project_id, &node_id)
}

#[tauri::command]
pub fn browser_import_artifact_read(
    runtime: tauri::State<'_, Arc<ProductionRuntime>>,
    import_id: String,
) -> Result<BrowserImportArtifactPayload, RuntimeError> {
    runtime.browser_imports().read_artifact_payload(&import_id)
}
