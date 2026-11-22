use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use super::{
    google_veo::{GoogleVeoClient, GoogleVeoError, PollResult as GooglePollResult, VEO_LITE_MODEL},
    production::compile_production_plan,
    runninghub::{
        image_to_video_body, MediaKind as RunningHubMediaKind, PollResult as RunningHubPollResult,
        RunningHubClient, RunningHubError, GPT_IMAGE_2_EDIT_ROUTE, GPT_IMAGE_2_ROUTE,
        GROK_VIDEO_IMAGE_ROUTE, GROK_VIDEO_ROUTE, VEO_LITE_ROUTE,
    },
    store::{ClaimedTask, RuntimeStore, StageExec},
    validate_store_relpath,
};

mod local_media;

const IDLE_POLL_MIN: Duration = Duration::from_millis(20);
const IDLE_POLL_MAX: Duration = Duration::from_secs(2);
const SAFE_POINT: Duration = Duration::from_millis(10);
const VIDEO_POLL: Duration = Duration::from_secs(10);
const SCHEDULER_POLL: Duration = Duration::from_secs(2);
const LEASE_MS: i64 = 500;
const RESOLVE_R1_FIXTURE_IMAGE: &[u8] = include_bytes!("../../../public/favicon.png");

/// 续租心跳：领单后由独立线程按 LEASE_MS/3 续租，不受执行线程里阻塞的网络 I/O 影响；
/// 续租失败（租约已被别人接管或任务已结束）时置 lost，执行者的后续写入会因 lease_owner 不匹配而失败。
struct LeaseHeartbeat {
    stop: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl LeaseHeartbeat {
    fn start(store: Arc<RuntimeStore>, task_id: String, owner: String) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let lost = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_lost = lost.clone();
        let interval = Duration::from_millis((LEASE_MS as u64 / 3).max(10));
        let handle = std::thread::spawn(move || {
            let mut next = Instant::now() + interval;
            while !thread_stop.load(Ordering::Acquire) {
                if Instant::now() < next {
                    std::thread::sleep(SAFE_POINT);
                    continue;
                }
                next = Instant::now() + interval;
                match store.renew_lease(&task_id, &owner, LEASE_MS) {
                    Ok(true) => {}
                    Ok(false) => {
                        thread_lost.store(true, Ordering::Release);
                        break;
                    }
                    Err(error) => {
                        log::warn!("Runtime lease heartbeat failed: {}", error.message);
                    }
                }
            }
        });
        Self {
            stop,
            lost,
            handle: Some(handle),
        }
    }

    #[allow(dead_code)]
    fn lost(&self) -> bool {
        self.lost.load(Ordering::Acquire)
    }
}

impl Drop for LeaseHeartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// 每次领单一个独立的所有者标记（worker id + 序号）：旧执行者即使与新执行者同一线程身份，
/// 失去租约后也无法再提交结果。
fn claim_owner(worker_id: &str, sequence: &mut u64) -> String {
    *sequence = sequence.wrapping_add(1);
    format!("{worker_id}:{sequence}")
}

pub struct RuntimeWorker {
    stopping: Arc<AtomicBool>,
    scheduler_thread: Option<JoinHandle<()>>,
    executor_thread: Option<JoinHandle<()>>,
}

impl RuntimeWorker {
    pub fn start(store: Arc<RuntimeStore>, artifact_root: Option<PathBuf>) -> Self {
        let stopping = Arc::new(AtomicBool::new(false));

        // Scheduler thread: only production.run, so it can block on child
        // tasks that the executor thread claims (see claim_next_task_filtered).
        let scheduler_stopping = stopping.clone();
        let scheduler_store = store.clone();
        let scheduler_id = super::ProductionRuntime::new_id("worker");
        let scheduler_thread = std::thread::spawn(move || {
            let scheduler_worker_id = scheduler_id;
            let mut claim_sequence: u64 = 0;
            let mut idle_count: u32 = 0;
            while !scheduler_stopping.load(Ordering::Acquire) {
                let generation = scheduler_store.work_generation();
                let scheduler_id = claim_owner(&scheduler_worker_id, &mut claim_sequence);
                match scheduler_store.claim_next_task_filtered(&scheduler_id, LEASE_MS, Some(true))
                {
                    Ok(Some(task)) => {
                        idle_count = 0;
                        let _heartbeat = LeaseHeartbeat::start(
                            scheduler_store.clone(),
                            task.id.clone(),
                            scheduler_id.clone(),
                        );
                        match task.kind.as_str() {
                        "production.run" => run_production_execution(
                            &scheduler_store,
                            &scheduler_id,
                            &scheduler_stopping,
                            &task,
                        ),
                        _ => {
                            let _ = scheduler_store.fail_task(
                                &task.id,
                                &scheduler_id,
                                &json!({
                                    "code": "UNKNOWN_COMMAND",
                                    "message": "Runtime scheduler does not support this task kind.",
                                    "retryable": false
                                }),
                            );
                        }
                        }
                    },
                    Ok(None) => {
                        idle_count = idle_count.saturating_add(1);
                        let backoff = IDLE_POLL_MIN
                            * 2u32.saturating_pow(idle_count.min(7));
                        // 入队会唤醒；退避等待只作兜底。
                        scheduler_store.wait_for_work(generation, backoff.min(IDLE_POLL_MAX));
                    }
                    Err(error) => {
                        log::warn!("Runtime scheduler ledger poll failed: {}", error.message);
                        idle_count = idle_count.saturating_add(1);
                        let backoff = IDLE_POLL_MIN
                            * 2u32.saturating_pow(idle_count.min(7));
                        std::thread::sleep(backoff.min(IDLE_POLL_MAX));
                    }
                }
            }
        });

        // Executor thread: everything except production.run (provider calls,
        // media pipelines, planning, diagnostics).
        let executor_stopping = stopping.clone();
        let executor_artifact_root = artifact_root;
        let executor_id = super::ProductionRuntime::new_id("exec");
        let executor_thread = std::thread::spawn(move || {
            let executor_worker_id = executor_id;
            let mut claim_sequence: u64 = 0;
            let mut idle_count: u32 = 0;
            while !executor_stopping.load(Ordering::Acquire) {
                let generation = store.work_generation();
                let executor_id = claim_owner(&executor_worker_id, &mut claim_sequence);
                match store.claim_next_task_filtered(&executor_id, LEASE_MS, Some(false)) {
                    Ok(Some(task)) => {
                        idle_count = 0;
                        let _heartbeat =
                            LeaseHeartbeat::start(store.clone(), task.id.clone(), executor_id.clone());
                        match task.kind.as_str() {
                        "runtime.test.delay" => {
                            run_delay(&store, &executor_id, &executor_stopping, &task)
                        }
                        "runtime.test.fixture-image" => run_fixture_image(
                            &store,
                            &executor_id,
                            &executor_stopping,
                            executor_artifact_root.as_deref(),
                            &task,
                        ),
                        "production.dry-run" => run_production_plan(&store, &executor_id, &task),
                        "audio.tts" => local_media::run_tts(
                            &store,
                            &executor_id,
                            &executor_stopping,
                            executor_artifact_root.as_deref(),
                            &task,
                        ),
                        "media.render" => local_media::run_render(
                            &store,
                            &executor_id,
                            &executor_stopping,
                            executor_artifact_root.as_deref(),
                            &task,
                        ),
                        "media.verify" => local_media::run_verify(
                            &store,
                            &executor_id,
                            &executor_stopping,
                            executor_artifact_root.as_deref(),
                            &task,
                        ),
                        "generate.video" => run_video(
                            &store,
                            &executor_id,
                            &executor_stopping,
                            executor_artifact_root.as_deref(),
                            &task,
                        ),
                        "generate.image" => run_runninghub_image(
                            &store,
                            &executor_id,
                            &executor_stopping,
                            executor_artifact_root.as_deref(),
                            &task,
                        ),
                        _ => {
                            let _ = store.fail_task(
                                &task.id,
                                &executor_id,
                                &json!({
                                    "code": "UNKNOWN_COMMAND",
                                    "message": "Runtime worker does not support this task kind.",
                                    "retryable": false
                                }),
                            );
                        }
                        }
                    },
                    Ok(None) => {
                        idle_count = idle_count.saturating_add(1);
                        let backoff = IDLE_POLL_MIN
                            * 2u32.saturating_pow(idle_count.min(7));
                        // 入队会唤醒；退避等待只作兜底。
                        store.wait_for_work(generation, backoff.min(IDLE_POLL_MAX));
                    }
                    Err(error) => {
                        log::warn!("Runtime executor ledger poll failed: {}", error.message);
                        idle_count = idle_count.saturating_add(1);
                        let backoff = IDLE_POLL_MIN
                            * 2u32.saturating_pow(idle_count.min(7));
                        std::thread::sleep(backoff.min(IDLE_POLL_MAX));
                    }
                }
            }
        });
        Self {
            stopping,
            scheduler_thread: Some(scheduler_thread),
            executor_thread: Some(executor_thread),
        }
    }
}

fn run_production_plan(store: &RuntimeStore, worker_id: &str, task: &ClaimedTask) {
    match compile_production_plan(&task.args) {
        Ok(draft) => {
            if let Err(error) = store.complete_production_plan(&task.id, worker_id, &draft) {
                let _ = store.fail_task(
                    &task.id,
                    worker_id,
                    &json!({
                        "code": error.code,
                        "message": error.message,
                        "retryable": error.retryable
                    }),
                );
            }
        }
        Err(error) => {
            let _ = store.fail_task(
                &task.id,
                worker_id,
                &json!({
                    "code": error.code,
                    "message": error.message,
                    "retryable": error.retryable
                }),
            );
        }
    }
}

fn required_stage_gates(stage: &StageExec) -> Vec<&str> {
    stage
        .input
        .get("requiredGates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn approved_style_reference_tasks(
    stage: &StageExec,
    run: &super::store::RunExecution,
) -> Vec<String> {
    let Some(gate_type) = stage
        .input
        .get("styleReferenceGate")
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    let Some(stage_key) = run
        .gate_decisions
        .get(gate_type)
        .and_then(|decision| decision.get("approvedStageKey"))
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    run.stages
        .iter()
        .find(|candidate| candidate.stage_key == stage_key && candidate.status == "succeeded")
        .and_then(|candidate| candidate.task_id.clone())
        .into_iter()
        .collect()
}

/// The stage command a scheduler tick derives from one `ready` StageRun.
fn stage_child_command(
    stage: &StageExec,
    run: &super::store::RunExecution,
) -> Option<(String, Value)> {
    let input = &stage.input;
    match stage.capability_id.as_str() {
        "image.generate" => Some((
            "generate.image".to_owned(),
            json!({
                "prompt": input.get("prompt").and_then(Value::as_str).unwrap_or_default(),
                "provider": "runningHub",
                "productModel": "flovart:gpt-image-2",
                "aspectRatio": input.get("aspectRatio").and_then(Value::as_str).unwrap_or("16:9"),
                "resolution": "1k",
                "sourceImageIds": approved_style_reference_tasks(stage, run),
                "credentialId": Value::Null
            }),
        )),
        "video.generate" => {
            // Motion stages consume the keyframe task artifact via sourceImageIds.
            let source_stage_key = input.get("sourceStageKey").and_then(Value::as_str)?;
            let source_task_id = run
                .stages
                .iter()
                .find(|item| item.stage_key == source_stage_key)?
                .task_id
                .clone()?;
            let duration_ms = input
                .get("durationMs")
                .and_then(Value::as_i64)
                .unwrap_or(6_000);
            // R6-H03: Route by duration — ≤6 s uses Grok image-to-video (720p/6s),
            // >6 s uses Veo 3.1 Lite with mapped durationSec (4/6/8), matching
            // the estimate logic in production.rs build_route_plan.
            if duration_ms <= 6_000 {
                Some((
                    "generate.video".to_owned(),
                    json!({
                        "prompt": input.get("prompt").and_then(Value::as_str).unwrap_or_default(),
                        "provider": "runningHub",
                        "productModel": "flovart:grok-imagine-video-1.5",
                        "durationSec": 6,
                        "aspectRatio": input.get("aspectRatio").and_then(Value::as_str).unwrap_or("16:9"),
                        "resolution": "720p",
                        "generateAudio": false,
                        "sourceImageIds": [source_task_id],
                        "requestedDurationMs": duration_ms,
                        "credentialId": Value::Null
                    }),
                ))
            } else {
                let duration_sec = match duration_ms {
                    d if d <= 4_000 => 4,
                    d if d <= 6_000 => 6,
                    _ => 8,
                };
                Some((
                    "generate.video".to_owned(),
                    json!({
                        "prompt": input.get("prompt").and_then(Value::as_str).unwrap_or_default(),
                        "provider": "runningHub",
                        "productModel": "flovart:veo-3.1-lite",
                        "durationSec": duration_sec,
                        "aspectRatio": input.get("aspectRatio").and_then(Value::as_str).unwrap_or("16:9"),
                        "resolution": "720p",
                        "generateAudio": true,
                        "sourceImageIds": [source_task_id],
                        "requestedDurationMs": duration_ms,
                        "credentialId": Value::Null
                    }),
                ))
            }
        }
        "audio.tts" => Some(("audio.tts".to_owned(), input.clone())),
        "media.render" => {
            // Resolve each timeline stageKey and the narration stage into the
            // provider task IDs that own the finished artifacts.
            let task_for = |stage_key: &str| {
                run.stages
                    .iter()
                    .find(|item| item.stage_key == stage_key && item.status == "succeeded")
                    .and_then(|item| item.task_id.clone())
            };
            let mut timeline = Vec::new();
            for entry in input.get("timeline").and_then(Value::as_array)? {
                let stage_key = entry.get("stageKey").and_then(Value::as_str)?;
                let source_task_id = task_for(stage_key)?;
                let mut enriched = entry.clone();
                enriched["sourceTaskId"] = json!(source_task_id);
                timeline.push(enriched);
            }
            let narration_task_id = input
                .get("narrationStageKey")
                .and_then(Value::as_str)
                .and_then(task_for);
            Some((
                "media.render".to_owned(),
                json!({
                    "delivery": input.get("delivery").cloned().unwrap_or_else(|| json!({})),
                    "timeline": timeline,
                    "narrationTaskId": narration_task_id,
                    "captions": input.get("captions").cloned().unwrap_or_else(|| json!([]))
                }),
            ))
        }
        "media.verify" => {
            let source_stage_key = input.get("sourceStageKey").and_then(Value::as_str)?;
            let source_task_id = run
                .stages
                .iter()
                .find(|item| item.stage_key == source_stage_key && item.status == "succeeded")?
                .task_id
                .clone()?;
            Some((
                "media.verify".to_owned(),
                json!({
                    "delivery": input.get("delivery").cloned().unwrap_or_else(|| json!({})),
                    "sourceTaskId": source_task_id,
                    "expectAudio": true
                }),
            ))
        }
        _ => None,
    }
}

/// Durable production.run scheduler. Owns the run task while stages execute as
/// child tasks; recovers by re-reading StageRun state, so a crashed scheduler
/// resumes instead of resubmitting (child submits are idempotent per stage).
fn run_production_execution(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    task: &ClaimedTask,
) {
    let run_id = match task.args.get("runId").and_then(Value::as_str) {
        Some(run_id) => run_id.to_owned(),
        None => {
            fail(
                store,
                task,
                worker_id,
                "INVALID_ARGUMENT",
                "production.run requires runId",
            );
            return;
        }
    };
    // Move queued -> running (recovering re-entry is also accepted).
    match store.update_run_status(
        &run_id,
        &["queued", "running", "recovering"],
        "running",
        None,
    ) {
        Ok(true) => {}
        Ok(false) => {
            fail(
                store,
                task,
                worker_id,
                "PRECONDITION_FAILED",
                "ProductionRun is not approved for execution (expected status queued).",
            );
            return;
        }
        Err(error) => {
            fail(store, task, worker_id, &error.code, &error.message);
            return;
        }
    }

    loop {
        if stopping.load(Ordering::Acquire) {
            // Leave the run in `running`; a restarted worker reclaims this task
            // after lease expiry and resumes from persisted StageRun state.
            return;
        }
        if cancellation_requested(store, task, worker_id) {
            let _ = store.update_run_status(&run_id, &["running"], "canceled", None);
            return;
        }
        if !store
            .renew_lease(&task.id, worker_id, LEASE_MS)
            .unwrap_or(false)
        {
            return;
        }
        let run = match store.load_run_execution(&run_id) {
            Ok(run) => run,
            Err(error) => {
                fail(store, task, worker_id, &error.code, &error.message);
                return;
            }
        };

        let mut progressed = false;
        let mut waiting = 0usize;
        let mut failed_stage = None;
        for stage in &run.stages {
            match stage.status.as_str() {
                "ready" => {
                    let required_gates = required_stage_gates(stage);
                    let rejected_gate = required_gates
                        .iter()
                        .find(|gate| run.gates.get(**gate).map(String::as_str) == Some("rejected"));
                    if let Some(gate) = rejected_gate {
                        let _ = store.update_stage(
                            &run_id,
                            &stage.stage_key,
                            &["ready"],
                            "blocked",
                            None,
                            None,
                            Some(&json!({
                                "code": "DIRECTOR_GATE_REJECTED",
                                "message": format!("Director gate {gate} was rejected."),
                                "gateType": gate
                            })),
                            &[],
                        );
                        failed_stage = Some(stage.stage_key.clone());
                        progressed = true;
                        continue;
                    }
                    if required_gates.iter().any(|gate| {
                        !matches!(
                            run.gates.get(*gate).map(String::as_str),
                            Some("approved" | "waived")
                        )
                    }) {
                        waiting += 1;
                        continue;
                    }
                    let Some((command, args)) = stage_child_command(stage, &run) else {
                        let _ = store.update_stage(
                            &run_id,
                            &stage.stage_key,
                            &["ready"],
                            "failed",
                            None,
                            None,
                            Some(&json!({
                                "code": "CAPABILITY_UNAVAILABLE",
                                "message": "No executor is registered for this capability."
                            })),
                            &[],
                        );
                        failed_stage = Some(stage.stage_key.clone());
                        continue;
                    };
                    // Budget reservation before any provider submission.
                    let estimate = run.estimates.get(&stage.stage_key).copied().unwrap_or(0);
                    if let Some((hard_limit, _)) = run.budget {
                        let projected = run.reserved_micros + run.confirmed_micros + estimate;
                        if estimate > 0 && projected > hard_limit {
                            let _ = store.update_stage(
                                &run_id,
                                &stage.stage_key,
                                &["ready"],
                                "blocked",
                                None,
                                None,
                                Some(&json!({
                                    "code": "BUDGET_EXCEEDED",
                                    "message": "Reserving this stage would exceed the approved run budget.",
                                    "estimateMicros": estimate,
                                    "hardLimitMicros": hard_limit
                                })),
                                &[],
                            );
                            failed_stage = Some(stage.stage_key.clone());
                            continue;
                        }
                    }
                    match store.submit_stage_task(&run_id, &stage.stage_key, &command, &args) {
                        Ok(receipt) => {
                            let ledger: &[(&str, i64, &str)] = if estimate > 0 {
                                &[("reserve", estimate, "route-plan estimate")]
                            } else {
                                &[]
                            };
                            let _ = store.update_stage(
                                &run_id,
                                &stage.stage_key,
                                &["ready"],
                                "running",
                                Some(&receipt.task_id),
                                None,
                                None,
                                ledger,
                            );
                            progressed = true;
                        }
                        Err(error) => {
                            let _ = store.update_stage(
                                &run_id,
                                &stage.stage_key,
                                &["ready"],
                                "failed",
                                None,
                                None,
                                Some(&json!({ "code": error.code, "message": error.message })),
                                &[],
                            );
                            failed_stage = Some(stage.stage_key.clone());
                        }
                    }
                }
                "running" => {
                    let Some(task_id) = &stage.task_id else {
                        waiting += 1;
                        continue;
                    };
                    match store.get_task(task_id) {
                        Ok(child) => match child.status.as_str() {
                            "completed" => {
                                let estimate =
                                    run.estimates.get(&stage.stage_key).copied().unwrap_or(0);
                                let confirmed_micros = child
                                    .result
                                    .as_ref()
                                    .and_then(|result| result.get("priceQuote"))
                                    .and_then(|quote| quote.get("estimatedPrice"))
                                    .and_then(Value::as_f64)
                                    .map(|price| (price * 1_000_000.0).round() as i64)
                                    .unwrap_or(estimate);
                                let mut ledger: Vec<(&str, i64, &str)> = Vec::new();
                                if estimate > 0 {
                                    ledger.push(("release", estimate, "reservation released"));
                                }
                                if confirmed_micros > 0 {
                                    ledger.push(("confirm", confirmed_micros, "provider quote"));
                                }
                                let _ = store.update_stage(
                                    &run_id,
                                    &stage.stage_key,
                                    &["running"],
                                    "succeeded",
                                    None,
                                    child.result.as_ref(),
                                    None,
                                    &ledger,
                                );
                                progressed = true;
                            }
                            "failed" | "cancelled" | "input_required" => {
                                let estimate =
                                    run.estimates.get(&stage.stage_key).copied().unwrap_or(0);
                                let ledger: &[(&str, i64, &str)] = if estimate > 0 {
                                    &[("release", estimate, "reservation released on failure")]
                                } else {
                                    &[]
                                };
                                let _ = store.update_stage(
                                    &run_id,
                                    &stage.stage_key,
                                    &["running"],
                                    "failed",
                                    None,
                                    None,
                                    Some(&json!({
                                        "code": "STAGE_TASK_FAILED",
                                        "taskStatus": child.status,
                                        "taskError": child.error
                                    })),
                                    ledger,
                                );
                                failed_stage = Some(stage.stage_key.clone());
                            }
                            _ => waiting += 1,
                        },
                        Err(_) => waiting += 1,
                    }
                }
                "pending" => {
                    let dependencies_met = stage.dependencies.iter().all(|dependency| {
                        run.stages
                            .iter()
                            .any(|item| &item.stage_key == dependency && item.status == "succeeded")
                    });
                    let dependency_failed = stage.dependencies.iter().any(|dependency| {
                        run.stages.iter().any(|item| {
                            &item.stage_key == dependency
                                && ["failed", "canceled", "blocked", "skipped"]
                                    .contains(&item.status.as_str())
                        })
                    });
                    if dependency_failed {
                        let _ = store.update_stage(
                            &run_id,
                            &stage.stage_key,
                            &["pending"],
                            "skipped",
                            None,
                            None,
                            Some(&json!({
                                "code": "DEPENDENCY_FAILED",
                                "message": "An upstream stage failed or is blocked."
                            })),
                            &[],
                        );
                        progressed = true;
                    } else if dependencies_met {
                        let _ = store.update_stage(
                            &run_id,
                            &stage.stage_key,
                            &["pending"],
                            "ready",
                            None,
                            None,
                            None,
                            &[],
                        );
                        progressed = true;
                    } else {
                        waiting += 1;
                    }
                }
                "blocked" => {
                    failed_stage = Some(stage.stage_key.clone());
                }
                _ => {}
            }
        }

        let all_terminal = run.stages.iter().all(|stage| {
            ["succeeded", "failed", "skipped", "canceled", "blocked"]
                .contains(&stage.status.as_str())
        }) && !progressed;
        if all_terminal && waiting == 0 {
            let succeeded = run
                .stages
                .iter()
                .filter(|stage| stage.status == "succeeded")
                .count();
            let final_status = if failed_stage.is_none()
                && run.stages.iter().all(|stage| stage.status == "succeeded")
            {
                "completed"
            } else if succeeded > 0 {
                "completed_with_warnings"
            } else {
                "failed"
            };
            let _ = store.update_run_status(&run_id, &["running"], final_status, None);
            let stage_summary = run
                .stages
                .iter()
                .map(|stage| {
                    json!({
                        "stageKey": stage.stage_key,
                        "status": stage.status,
                        "taskId": stage.task_id
                    })
                })
                .collect::<Vec<_>>();
            let result = json!({
                "runId": run_id,
                "status": final_status,
                "stages": stage_summary,
                "confirmedMicros": run.confirmed_micros,
                "unitCode": "CNY"
            });
            if final_status == "failed" {
                let _ = store.fail_task(
                    &task.id,
                    worker_id,
                    &json!({
                        "code": "PRODUCTION_RUN_FAILED",
                        "message": "Every provider stage failed; see production.status for details.",
                        "retryable": false,
                        "details": result
                    }),
                );
            } else {
                let _ = store.complete_task(&task.id, worker_id, &result);
            }
            return;
        }

        if !progressed {
            let wait_started = Instant::now();
            while wait_started.elapsed() < SCHEDULER_POLL {
                if stopping.load(Ordering::Acquire)
                    || cancellation_requested(store, task, worker_id)
                {
                    if cancellation_requested(store, task, worker_id) {
                        let _ = store.update_run_status(&run_id, &["running"], "canceled", None);
                    }
                    return;
                }
                if !store
                    .renew_lease(&task.id, worker_id, LEASE_MS)
                    .unwrap_or(false)
                {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn run_delay(store: &RuntimeStore, worker_id: &str, stopping: &AtomicBool, task: &ClaimedTask) {
    let delay_ms = task
        .args
        .get("delayMs")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let started = Instant::now();
    let delay = Duration::from_millis(delay_ms);
    let mut last_renewal = Instant::now();
    while started.elapsed() < delay {
        if stopping.load(Ordering::Acquire) {
            return;
        }
        if cancellation_requested(store, task, worker_id) {
            return;
        }
        if last_renewal.elapsed() >= Duration::from_millis(LEASE_MS as u64 / 2) {
            if !store
                .renew_lease(&task.id, worker_id, LEASE_MS)
                .unwrap_or(false)
            {
                return;
            }
            last_renewal = Instant::now();
        }
        std::thread::sleep(SAFE_POINT.min(delay.saturating_sub(started.elapsed())));
    }
    if !stopping.load(Ordering::Acquire) && !cancellation_requested(store, task, worker_id) {
        let _ = store.complete_task(&task.id, worker_id, &json!({ "delayedMs": delay_ms }));
    }
}

fn run_fixture_image(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    artifact_root: Option<&Path>,
    task: &ClaimedTask,
) {
    if stopping.load(Ordering::Acquire) || cancellation_requested(store, task, worker_id) {
        return;
    }
    let Some(artifact_root) = artifact_root else {
        fail(
            store,
            task,
            worker_id,
            "ARTIFACT_STORAGE_UNAVAILABLE",
            "Runtime artifact storage is unavailable.",
        );
        return;
    };
    match persist_media(
        artifact_root,
        &task.id,
        "image",
        "png",
        RESOLVE_R1_FIXTURE_IMAGE,
    ) {
        Ok((store_relpath, sha256, byte_size)) => {
            let artifact_id = format!("sha256:{sha256}");
            let _ = store.complete_task(
                &task.id,
                worker_id,
                &json!({
                    "fixture": "resolve-r1-image-v1",
                    "providerCalled": false,
                    "costMicros": 0,
                    "artifact": {
                        "artifactId": artifact_id,
                        "kind": "image",
                        "mimeType": "image/png",
                        "storeRelpath": store_relpath,
                        "sha256": sha256,
                        "byteSize": byte_size
                    }
                }),
            );
        }
        Err(_) => fail(
            store,
            task,
            worker_id,
            "ARTIFACT_WRITE_FAILED",
            "Runtime could not persist the deterministic image fixture.",
        ),
    }
}

fn run_video(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    artifact_root: Option<&Path>,
    task: &ClaimedTask,
) {
    let Some(artifact_root) = artifact_root else {
        fail(
            store,
            task,
            worker_id,
            "RUNTIME_UNAVAILABLE",
            "Artifact store is unavailable.",
        );
        return;
    };
    match task
        .args
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("google")
    {
        "google" => run_google_video(store, worker_id, stopping, artifact_root, task),
        "runningHub" => run_runninghub_video(store, worker_id, stopping, artifact_root, task),
        _ => fail(
            store,
            task,
            worker_id,
            "ROUTE_UNAVAILABLE",
            "The selected video provider is not available.",
        ),
    }
}

fn run_google_video(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    artifact_root: &Path,
    task: &ClaimedTask,
) {
    let credential_id = task
        .args
        .get("credentialId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| store.default_credential_id("google").ok().flatten());
    let Some(credential_id) = credential_id else {
        fail(
            store,
            task,
            worker_id,
            "ROUTE_UNAVAILABLE",
            "No Google credential is available in the operating-system keyring.",
        );
        return;
    };
    let secret = match crate::keyring::read_secret("google", &credential_id) {
        Ok(Some(secret)) => secret,
        Ok(None) => {
            fail(
                store,
                task,
                worker_id,
                "ROUTE_UNAVAILABLE",
                "The selected Google credential is not available.",
            );
            return;
        }
        Err(_) => {
            fail(
                store,
                task,
                worker_id,
                "RUNTIME_UNAVAILABLE",
                "The operating-system keyring could not be read.",
            );
            return;
        }
    };
    let client = match GoogleVeoClient::new() {
        Ok(client) => client,
        Err(_) => {
            fail(
                store,
                task,
                worker_id,
                "RUNTIME_UNAVAILABLE",
                "The Google Veo client could not be initialized.",
            );
            return;
        }
    };

    let operation_name = match task
        .progress
        .as_ref()
        .and_then(|progress| progress.get("phase"))
        .and_then(Value::as_str)
    {
        Some("polling") | Some("downloading") => task
            .progress
            .as_ref()
            .and_then(|progress| progress.get("operationName"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        Some("submitting") => {
            require_submission_reconciliation(store, task, worker_id);
            return;
        }
        _ => {
            // R6-H01: Check cancellation before committing to submission.
            if cancellation_requested(store, task, worker_id) {
                return;
            }
            let submitting = json!({
                "phase": "submitting",
                "provider": "google",
                "model": VEO_LITE_MODEL
            });
            if !store
                .update_progress(&task.id, worker_id, &submitting)
                .unwrap_or(false)
            {
                return;
            }
            let prompt = task
                .args
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let duration_sec = task
                .args
                .get("durationSec")
                .and_then(Value::as_u64)
                .unwrap_or(8);
            let aspect_ratio = task
                .args
                .get("aspectRatio")
                .and_then(Value::as_str)
                .unwrap_or("16:9");
            let resolution = task
                .args
                .get("resolution")
                .and_then(Value::as_str)
                .unwrap_or("720p");
            match client.submit(&secret, prompt, duration_sec, aspect_ratio, resolution) {
                Ok(operation_name) => {
                    let polling = json!({
                        "phase": "polling",
                        "provider": "google",
                        "model": VEO_LITE_MODEL,
                        "operationName": operation_name
                    });
                    if !store
                        .update_progress(&task.id, worker_id, &polling)
                        .unwrap_or(false)
                    {
                        return;
                    }
                    Some(operation_name)
                }
                Err(GoogleVeoError::SubmissionUnknown) => {
                    require_submission_reconciliation(store, task, worker_id);
                    return;
                }
                Err(error) => {
                    fail_google(store, task, worker_id, error);
                    return;
                }
            }
        }
    };
    let Some(operation_name) = operation_name else {
        require_submission_reconciliation(store, task, worker_id);
        return;
    };

    let mut transient_errors = 0_u8;
    loop {
        if stopping.load(Ordering::Acquire) || cancellation_requested(store, task, worker_id) {
            return;
        }
        let _ = store.renew_lease(&task.id, worker_id, LEASE_MS);
        match client.poll(&secret, &operation_name) {
            Ok(GooglePollResult::Pending) => transient_errors = 0,
            Ok(GooglePollResult::Failed) => {
                fail(
                    store,
                    task,
                    worker_id,
                    "PROVIDER_FAILED",
                    "Google Veo reported that the generation failed.",
                );
                return;
            }
            Ok(GooglePollResult::Succeeded { download_url }) => {
                let downloading = json!({
                    "phase": "downloading",
                    "provider": "google",
                    "model": VEO_LITE_MODEL,
                    "operationName": operation_name
                });
                let _ = store.update_progress(&task.id, worker_id, &downloading);
                match client.download(&secret, &download_url).and_then(|bytes| {
                    persist_video(artifact_root, &task.id, &bytes)
                        .map_err(|_| GoogleVeoError::Transport)
                }) {
                    Ok((store_relpath, sha256, byte_size)) => {
                        let duration_sec = task
                            .args
                            .get("durationSec")
                            .and_then(Value::as_u64)
                            .unwrap_or(8);
                        let _ = store.complete_task(
                            &task.id,
                            worker_id,
                            &json!({
                                "provider": "google",
                                "model": VEO_LITE_MODEL,
                                "artifact": {
                                    "kind": "video",
                                    "mimeType": "video/mp4",
                                    "storeRelpath": store_relpath,
                                    "sha256": sha256,
                                    "byteSize": byte_size,
                                    "durationSec": duration_sec
                                }
                            }),
                        );
                    }
                    Err(error) => fail_google(store, task, worker_id, error),
                }
                return;
            }
            Err(GoogleVeoError::Transport) if transient_errors < 12 => {
                transient_errors += 1;
            }
            Err(error) => {
                fail_google(store, task, worker_id, error);
                return;
            }
        }
        let wait_started = Instant::now();
        while wait_started.elapsed() < VIDEO_POLL {
            if stopping.load(Ordering::Acquire) || cancellation_requested(store, task, worker_id) {
                return;
            }
            if !store
                .renew_lease(&task.id, worker_id, LEASE_MS)
                .unwrap_or(false)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

struct RunningHubPlan {
    route_id: &'static str,
    product_model: &'static str,
    media_kind: RunningHubMediaKind,
    body: Value,
    artifact_kind: &'static str,
    duration_sec: Option<u64>,
    source_image_task_ids: Vec<String>,
}

fn run_runninghub_image(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    artifact_root: Option<&Path>,
    task: &ClaimedTask,
) {
    let Some(artifact_root) = artifact_root else {
        fail(
            store,
            task,
            worker_id,
            "RUNTIME_UNAVAILABLE",
            "Artifact store is unavailable.",
        );
        return;
    };
    let prompt = task
        .args
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let aspect_ratio = task
        .args
        .get("aspectRatio")
        .and_then(Value::as_str)
        .unwrap_or("16:9");
    let resolution = task
        .args
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or("1k");
    let source_image_task_ids = task
        .args
        .get("sourceImageIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let image_to_image = !source_image_task_ids.is_empty();
    run_runninghub_generation(
        store,
        worker_id,
        stopping,
        artifact_root,
        task,
        RunningHubPlan {
            route_id: if image_to_image {
                GPT_IMAGE_2_EDIT_ROUTE
            } else {
                GPT_IMAGE_2_ROUTE
            },
            product_model: "flovart:gpt-image-2",
            media_kind: RunningHubMediaKind::Image,
            body: json!({
                "prompt": prompt,
                "aspectRatio": aspect_ratio,
                "resolution": resolution
            }),
            artifact_kind: "image",
            duration_sec: None,
            source_image_task_ids,
        },
    );
}

fn run_runninghub_video(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    artifact_root: &Path,
    task: &ClaimedTask,
) {
    let prompt = task
        .args
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let duration_sec = task
        .args
        .get("durationSec")
        .and_then(Value::as_u64)
        .unwrap_or(8);
    let aspect_ratio = task
        .args
        .get("aspectRatio")
        .and_then(Value::as_str)
        .unwrap_or("16:9");
    let resolution = task
        .args
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or("720p");
    let product_model = task
        .args
        .get("productModel")
        .and_then(Value::as_str)
        .unwrap_or("flovart:veo-3.1-lite");
    let source_image_task_ids = task
        .args
        .get("sourceImageIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let plan = match product_model {
        "flovart:grok-imagine-video-1.5" if !source_image_task_ids.is_empty() => RunningHubPlan {
            route_id: GROK_VIDEO_IMAGE_ROUTE,
            product_model: "flovart:grok-imagine-video-1.5",
            media_kind: RunningHubMediaKind::Video,
            body: image_to_video_body(prompt, duration_sec, aspect_ratio, resolution, &[]),
            artifact_kind: "video",
            duration_sec: Some(duration_sec),
            source_image_task_ids,
        },
        "flovart:grok-imagine-video-1.5" => RunningHubPlan {
            route_id: GROK_VIDEO_ROUTE,
            product_model: "flovart:grok-imagine-video-1.5",
            media_kind: RunningHubMediaKind::Video,
            body: json!({
                "prompt": prompt,
                "aspectRatio": aspect_ratio,
                "resolution": resolution,
                "duration": duration_sec
            }),
            artifact_kind: "video",
            duration_sec: Some(duration_sec),
            source_image_task_ids: Vec::new(),
        },
        "flovart:veo-3.1-lite" => RunningHubPlan {
            route_id: VEO_LITE_ROUTE,
            product_model: "flovart:veo-3.1-lite",
            media_kind: RunningHubMediaKind::Video,
            body: json!({
                "prompt": prompt,
                "aspectRatio": aspect_ratio,
                "resolution": resolution,
                "duration": duration_sec.to_string()
            }),
            artifact_kind: "video",
            duration_sec: Some(duration_sec),
            source_image_task_ids: Vec::new(),
        },
        other => {
            fail(
                store,
                task,
                worker_id,
                "ROUTE_UNAVAILABLE",
                &format!(
                    "The requested video Product Model has no trusted RunningHub route: {other}"
                ),
            );
            return;
        }
    };
    run_runninghub_generation(store, worker_id, stopping, artifact_root, task, plan);
}

fn run_runninghub_generation(
    store: &RuntimeStore,
    worker_id: &str,
    stopping: &AtomicBool,
    artifact_root: &Path,
    task: &ClaimedTask,
    mut plan: RunningHubPlan,
) {
    let credential_id = task
        .args
        .get("credentialId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| store.default_credential_id("runningHub").ok().flatten());
    let Some(credential_id) = credential_id else {
        fail(
            store,
            task,
            worker_id,
            "ROUTE_UNAVAILABLE",
            "No RunningHub credential is available in the operating-system keyring.",
        );
        return;
    };
    let secret = match crate::keyring::read_secret("runningHub", &credential_id) {
        Ok(Some(secret)) => secret,
        Ok(None) => {
            fail(
                store,
                task,
                worker_id,
                "ROUTE_UNAVAILABLE",
                "The selected RunningHub credential is not available.",
            );
            return;
        }
        Err(_) => {
            fail(
                store,
                task,
                worker_id,
                "RUNTIME_UNAVAILABLE",
                "The operating-system keyring could not be read.",
            );
            return;
        }
    };
    let client = match RunningHubClient::new() {
        Ok(client) => client,
        Err(_) => {
            fail(
                store,
                task,
                worker_id,
                "RUNTIME_UNAVAILABLE",
                "The RunningHub client could not be initialized.",
            );
            return;
        }
    };
    if !plan.source_image_task_ids.is_empty() {
        let preparing = json!({
            "phase": "preparing_inputs",
            "provider": "runningHub",
            "routeId": plan.route_id,
            "productModel": plan.product_model,
            "sourceImageIds": plan.source_image_task_ids
        });
        if !store
            .update_progress(&task.id, worker_id, &preparing)
            .unwrap_or(false)
        {
            return;
        }
        let mut image_urls = Vec::with_capacity(plan.source_image_task_ids.len());
        for source_task_id in &plan.source_image_task_ids {
            let source_task = match store.get_task(source_task_id) {
                Ok(source_task) => source_task,
                Err(_) => {
                    fail(
                        store,
                        task,
                        worker_id,
                        "SOURCE_ARTIFACT_UNAVAILABLE",
                        &format!("Source image task is unavailable: {source_task_id}"),
                    );
                    return;
                }
            };
            let artifact = source_task
                .result
                .as_ref()
                .and_then(|result| result.get("artifact"));
            let store_relpath = artifact
                .and_then(|artifact| artifact.get("storeRelpath"))
                .and_then(Value::as_str);
            let mime_type = artifact
                .and_then(|artifact| artifact.get("mimeType"))
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            if source_task.status != "completed"
                || artifact
                    .and_then(|artifact| artifact.get("kind"))
                    .and_then(Value::as_str)
                    != Some("image")
                || store_relpath.is_none()
            {
                fail(
                    store,
                    task,
                    worker_id,
                    "SOURCE_ARTIFACT_UNAVAILABLE",
                    &format!("Source task is not a completed image Artifact: {source_task_id}"),
                );
                return;
            }
            let source_path = match validate_store_relpath(store_relpath.unwrap(), artifact_root) {
                Ok(path) => path,
                Err(message) => {
                    fail(
                        store,
                        task,
                        worker_id,
                        "SOURCE_ARTIFACT_UNAVAILABLE",
                        &format!("Source image Artifact path is invalid: {message}"),
                    );
                    return;
                }
            };
            let bytes = match fs::read(&source_path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    fail(
                        store,
                        task,
                        worker_id,
                        "SOURCE_ARTIFACT_UNAVAILABLE",
                        &format!("Source image Artifact cannot be read: {source_task_id}"),
                    );
                    return;
                }
            };
            let extension = source_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("png");
            let file_name = format!("{source_task_id}.{extension}");
            match client.upload_binary(&secret, bytes, &file_name, mime_type) {
                Ok(url) => image_urls.push(url),
                Err(error) => {
                    fail_runninghub(store, task, worker_id, error);
                    return;
                }
            }
        }
        plan.body["imageUrls"] = json!(image_urls);
    }
    let mut price_quote = task
        .progress
        .as_ref()
        .and_then(|progress| progress.get("priceQuote"))
        .cloned();

    let provider_task_id = match task
        .progress
        .as_ref()
        .and_then(|progress| progress.get("phase"))
        .and_then(Value::as_str)
    {
        Some("polling") | Some("downloading") => task
            .progress
            .as_ref()
            .and_then(|progress| progress.get("providerTaskId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        Some("submitting") => {
            require_submission_reconciliation(store, task, worker_id);
            return;
        }
        _ => {
            let preflight = json!({
                "phase": "preflight",
                "provider": "runningHub",
                "routeId": plan.route_id,
                "productModel": plan.product_model
            });
            if !store
                .update_progress(&task.id, worker_id, &preflight)
                .unwrap_or(false)
            {
                return;
            }
            let quote = match client.price_preview_route(&secret, plan.route_id, &plan.body) {
                Ok(quote) => quote,
                Err(error) => {
                    fail_runninghub(store, task, worker_id, error);
                    return;
                }
            };
            price_quote = serde_json::to_value(&quote).ok();
            if cancellation_requested(store, task, worker_id) {
                return;
            }
            let submitting = json!({
                "phase": "submitting",
                "provider": "runningHub",
                "routeId": plan.route_id,
                "productModel": plan.product_model,
                "priceQuote": price_quote
            });
            if !store
                .update_progress(&task.id, worker_id, &submitting)
                .unwrap_or(false)
            {
                return;
            }
            match client.submit_route(&secret, plan.route_id, &plan.body) {
                Ok(provider_task_id) => {
                    let polling = json!({
                        "phase": "polling",
                        "provider": "runningHub",
                        "routeId": plan.route_id,
                        "productModel": plan.product_model,
                        "providerTaskId": provider_task_id,
                        "priceQuote": price_quote
                    });
                    if !store
                        .update_progress(&task.id, worker_id, &polling)
                        .unwrap_or(false)
                    {
                        return;
                    }
                    Some(provider_task_id)
                }
                Err(RunningHubError::SubmissionUnknown) => {
                    require_submission_reconciliation(store, task, worker_id);
                    return;
                }
                Err(error) => {
                    fail_runninghub(store, task, worker_id, error);
                    return;
                }
            }
        }
    };
    let Some(provider_task_id) = provider_task_id else {
        require_submission_reconciliation(store, task, worker_id);
        return;
    };

    let mut transient_errors = 0_u8;
    loop {
        if stopping.load(Ordering::Acquire) || cancellation_requested(store, task, worker_id) {
            return;
        }
        let _ = store.renew_lease(&task.id, worker_id, LEASE_MS);
        match client.poll_media(&secret, &provider_task_id, plan.media_kind) {
            Ok(RunningHubPollResult::Pending) => transient_errors = 0,
            Ok(RunningHubPollResult::Failed { code }) => {
                fail(
                    store,
                    task,
                    worker_id,
                    "PROVIDER_FAILED",
                    &format!(
                        "RunningHub reported that the generation failed{}.",
                        code.map(|code| format!(" ({code})")).unwrap_or_default()
                    ),
                );
                return;
            }
            Ok(RunningHubPollResult::Succeeded {
                download_url,
                extension,
                mime_type,
            }) => {
                let downloading = json!({
                    "phase": "downloading",
                    "provider": "runningHub",
                    "routeId": plan.route_id,
                    "productModel": plan.product_model,
                    "providerTaskId": provider_task_id,
                    "priceQuote": price_quote
                });
                let _ = store.update_progress(&task.id, worker_id, &downloading);
                match client.download(&download_url).and_then(|bytes| {
                    persist_media(
                        artifact_root,
                        &task.id,
                        plan.artifact_kind,
                        &extension,
                        &bytes,
                    )
                    .map_err(|_| RunningHubError::Transport)
                }) {
                    Ok((store_relpath, sha256, byte_size)) => {
                        let _ = store.complete_task(
                            &task.id,
                            worker_id,
                            &json!({
                                "provider": "runningHub",
                                "productModel": plan.product_model,
                                "routeId": plan.route_id,
                                "providerTaskId": provider_task_id,
                                "priceQuote": price_quote,
                                "artifact": {
                                    "kind": plan.artifact_kind,
                                    "mimeType": mime_type,
                                    "storeRelpath": store_relpath,
                                    "sha256": sha256,
                                    "byteSize": byte_size,
                                    "durationSec": plan.duration_sec
                                }
                            }),
                        );
                    }
                    Err(error) => fail_runninghub(store, task, worker_id, error),
                }
                return;
            }
            Err(RunningHubError::Transport) if transient_errors < 12 => {
                transient_errors += 1;
            }
            Err(error) => {
                fail_runninghub(store, task, worker_id, error);
                return;
            }
        }
        let wait_started = Instant::now();
        while wait_started.elapsed() < VIDEO_POLL {
            if stopping.load(Ordering::Acquire) || cancellation_requested(store, task, worker_id) {
                return;
            }
            if !store
                .renew_lease(&task.id, worker_id, LEASE_MS)
                .unwrap_or(false)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

fn persist_video(
    artifact_root: &Path,
    task_id: &str,
    bytes: &[u8],
) -> std::io::Result<(String, String, usize)> {
    persist_media(artifact_root, task_id, "video", "mp4", bytes)
}

fn persist_media(
    artifact_root: &Path,
    task_id: &str,
    kind: &str,
    extension: &str,
    bytes: &[u8],
) -> std::io::Result<(String, String, usize)> {
    let directory_name = if kind == "image" { "images" } else { "videos" };
    let directory = artifact_root.join(directory_name);
    fs::create_dir_all(&directory)?;
    let filename = format!("{task_id}.{extension}");
    let final_path = directory.join(&filename);
    let temporary_path = directory.join(format!("{filename}.part"));
    let mut file = File::create(&temporary_path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary_path, &final_path)?;
    Ok((
        format!("runtime-artifacts/{directory_name}/{filename}"),
        hex::encode(Sha256::digest(bytes)),
        bytes.len(),
    ))
}

fn cancellation_requested(store: &RuntimeStore, task: &ClaimedTask, worker_id: &str) -> bool {
    if store
        .cancellation_requested(&task.id, worker_id)
        .unwrap_or(false)
    {
        let _ = store.cancel_task(&task.id, worker_id);
        true
    } else {
        false
    }
}

fn require_submission_reconciliation(store: &RuntimeStore, task: &ClaimedTask, worker_id: &str) {
    let _ = store.require_input(
        &task.id,
        worker_id,
        &json!({
            "code": "PROVIDER_SUBMISSION_UNKNOWN",
            "message": "The provider submission outcome is unknown; automatic resubmission is disabled.",
            "retryable": false
        }),
    );
}

fn fail(store: &RuntimeStore, task: &ClaimedTask, worker_id: &str, code: &str, message: &str) {
    let _ = store.fail_task(
        &task.id,
        worker_id,
        &json!({
            "code": code,
            "message": message,
            "retryable": false
        }),
    );
}

fn fail_google(store: &RuntimeStore, task: &ClaimedTask, worker_id: &str, error: GoogleVeoError) {
    let (code, message) = match error {
        GoogleVeoError::SubmissionUnknown => (
            "PROVIDER_SUBMISSION_UNKNOWN",
            "The provider submission outcome is unknown.",
        ),
        GoogleVeoError::ProviderRejected(status) => {
            return fail(
                store,
                task,
                worker_id,
                "PROVIDER_REJECTED",
                &format!("Google Veo rejected the request with HTTP {status}."),
            )
        }
        GoogleVeoError::PollFailed(status) => {
            return fail(
                store,
                task,
                worker_id,
                "PROVIDER_POLL_FAILED",
                &format!("Google Veo polling failed with HTTP {status}."),
            )
        }
        GoogleVeoError::DownloadFailed(status) => {
            return fail(
                store,
                task,
                worker_id,
                "ARTIFACT_DOWNLOAD_FAILED",
                &format!("Google Veo artifact download failed with HTTP {status}."),
            )
        }
        GoogleVeoError::InvalidResponse(part) => {
            return fail(
                store,
                task,
                worker_id,
                "PROVIDER_RESPONSE_INVALID",
                &format!("Google Veo returned an invalid {part}."),
            )
        }
        GoogleVeoError::Transport => (
            "PROVIDER_UNAVAILABLE",
            "Google Veo could not be reached or the artifact could not be stored.",
        ),
    };
    fail(store, task, worker_id, code, message);
}

fn fail_runninghub(
    store: &RuntimeStore,
    task: &ClaimedTask,
    worker_id: &str,
    error: RunningHubError,
) {
    let with_code = |base: &str, code: Option<String>| {
        format!(
            "{base}{}.",
            code.map(|code| format!(" ({code})")).unwrap_or_default()
        )
    };
    match error {
        RunningHubError::SubmissionUnknown => {
            require_submission_reconciliation(store, task, worker_id)
        }
        RunningHubError::PreflightRejected(status, code) => fail(
            store,
            task,
            worker_id,
            "PROVIDER_PREFLIGHT_REJECTED",
            &with_code(
                &format!("RunningHub price preview was rejected with HTTP {status}"),
                code,
            ),
        ),
        RunningHubError::ProviderRejected(status, code) => fail(
            store,
            task,
            worker_id,
            "PROVIDER_REJECTED",
            &with_code(
                &format!("RunningHub rejected the request with HTTP {status}"),
                code,
            ),
        ),
        RunningHubError::PollFailed(status, code) => fail(
            store,
            task,
            worker_id,
            "PROVIDER_POLL_FAILED",
            &with_code(
                &format!("RunningHub polling failed with HTTP {status}"),
                code,
            ),
        ),
        RunningHubError::GenerationFailed(code) => fail(
            store,
            task,
            worker_id,
            "PROVIDER_FAILED",
            &with_code("RunningHub reported that the generation failed", code),
        ),
        RunningHubError::InvalidResponse(part) => fail(
            store,
            task,
            worker_id,
            "PROVIDER_RESPONSE_INVALID",
            &format!("RunningHub returned an invalid {part}."),
        ),
        RunningHubError::DownloadFailed(status) => fail(
            store,
            task,
            worker_id,
            "ARTIFACT_DOWNLOAD_FAILED",
            &format!("RunningHub artifact download failed with HTTP {status}."),
        ),
        RunningHubError::UploadFailed(status, code) => fail(
            store,
            task,
            worker_id,
            "SOURCE_UPLOAD_FAILED",
            &with_code(
                &format!("RunningHub source upload was rejected with HTTP {status}"),
                code,
            ),
        ),
        RunningHubError::Transport => fail(
            store,
            task,
            worker_id,
            "PROVIDER_UNAVAILABLE",
            "RunningHub could not be reached or the artifact could not be stored.",
        ),
    }
}

impl Drop for RuntimeWorker {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(thread) = self.scheduler_thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.executor_thread.take() {
            let _ = thread.join();
        }
    }
}
