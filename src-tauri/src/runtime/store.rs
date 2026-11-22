use parking_lot::{Condvar, Mutex};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

use super::{
    agent_text::AgentTextRoute,
    events::{RuntimeEntityRef, RuntimeEvent, RuntimeEventPage},
    production::{build_workflow_projection, ProductionPlanDraft},
    tasks::{RuntimeTask, RuntimeTaskPage, TaskLinks, TaskReceipt},
    ProductionRuntime, RuntimeContractError, RuntimeError,
};

const MIGRATION_0001: &str = include_str!("migrations/0001_runtime_ledger.sql");
const MIGRATION_0002: &str = include_str!("migrations/0002_production_plan.sql");
const MIGRATION_0003: &str = include_str!("migrations/0003_production_execution.sql");
const MIGRATION_0004: &str = include_str!("migrations/0004_agent_text_routes.sql");
// Agent 视频流水线表与 Node `tools/iris/pipeline/store.js` 共用同一份 SQL 与 runtime_migrations 账本。
const MIGRATION_0005: &str =
    include_str!("../../../tools/iris/contracts/runtime/migrations/0005_agent_pipeline.sql");

pub struct RuntimeStore {
    connection: Mutex<Connection>,
    /// 入队唤醒：新任务写入后递增代数并唤醒空闲 worker，worker 不必等到下一次退避轮询。
    work_generation: Mutex<u64>,
    work_signal: Condvar,
}

pub struct ClaimedTask {
    pub id: String,
    pub kind: String,
    pub args: Value,
    pub progress: Option<Value>,
}

// 执行快照契约字段：由 worker 写入，供未来 UI / 断点恢复读取；
// rustc 暂未见 crate 内读取方，保留为持久化/输出契约。
#[allow(dead_code)]
pub struct StageExec {
    pub id: String,
    pub stage_key: String,
    pub capability_id: String,
    pub status: String,
    pub input: Value,
    pub task_id: Option<String>,
    pub result: Option<Value>,
    pub dependencies: Vec<String>,
}

#[allow(dead_code)]
pub struct RunExecution {
    pub status: String,
    pub review_policy: String,
    pub stages: Vec<StageExec>,
    pub gates: std::collections::HashMap<String, String>,
    pub gate_decisions: std::collections::HashMap<String, Value>,
    pub budget: Option<(i64, String)>,
    pub reserved_micros: i64,
    pub confirmed_micros: i64,
    pub estimates: std::collections::HashMap<String, i64>,
}

impl RuntimeStore {
    pub fn in_memory() -> Result<Self, RuntimeContractError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    pub fn open(path: &Path) -> Result<Self, RuntimeContractError> {
        Self::from_connection(Connection::open(path)?)
    }

    fn from_connection(mut connection: Connection) -> Result<Self, RuntimeContractError> {
        connection.busy_timeout(Duration::from_millis(250))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS runtime_migrations (
               version INTEGER PRIMARY KEY,
               applied_at INTEGER NOT NULL
             );",
        )?;
        for (version, sql) in [
            (1, MIGRATION_0001),
            (2, MIGRATION_0002),
            (3, MIGRATION_0003),
            (4, MIGRATION_0004),
            (5, MIGRATION_0005),
        ] {
            let applied = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM runtime_migrations WHERE version = ?1)",
                [version],
                |row| row.get::<_, bool>(0),
            )?;
            if !applied {
                let migration =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                migration.execute_batch(sql)?;
                migration.execute(
                    "INSERT INTO runtime_migrations(version, applied_at) VALUES(?1, ?2)",
                    params![version, chrono::Utc::now().timestamp_millis()],
                )?;
                migration.commit()?;
            }
        }
        Ok(Self {
            connection: Mutex::new(connection),
            work_generation: Mutex::new(0),
            work_signal: Condvar::new(),
        })
    }

    /// 当前的入队代数。worker 先读代数再领单，领不到时用同一代数等待，避免丢失领单与等待之间的唤醒。
    pub fn work_generation(&self) -> u64 {
        *self.work_generation.lock()
    }

    /// 有可领取的新任务时调用：递增代数并唤醒所有等待中的 worker。
    pub fn signal_work(&self) {
        let mut generation = self.work_generation.lock();
        *generation = generation.wrapping_add(1);
        self.work_signal.notify_all();
    }

    /// 代数仍为 `seen` 时最多等待 `timeout`（退避轮询作为兜底）；返回等待后的代数。
    pub fn wait_for_work(&self, seen: u64, timeout: Duration) -> u64 {
        let mut generation = self.work_generation.lock();
        if *generation == seen {
            let _ = self.work_signal.wait_for(&mut generation, timeout);
        }
        *generation
    }

    pub fn submit_delay(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        self.submit_task(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            "runtime.test.delay",
            args,
            100,
        )
    }

    pub fn submit_fixture_image(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        self.submit_task(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            "runtime.test.fixture-image",
            args,
            100,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_image(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        self.submit_task(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            "generate.image",
            args,
            2_000,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_video(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        self.submit_task(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            "generate.video",
            args,
            2_000,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_production_plan(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        self.submit_task(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            "production.dry-run",
            args,
            100,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_production_run(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        let run_id = args.get("runId").and_then(Value::as_str).ok_or_else(|| {
            RuntimeError::new("INVALID_ARGUMENT", "production.run requires runId")
        })?;
        self.submit_task_with_entity(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            "production.run",
            args,
            Some(("production_run", run_id)),
            2_000,
        )
    }

    /// Approve or reject one production gate. System gates carry side effects:
    /// `route-plan` confirms the proposed Route Plan; `run-budget` persists the
    /// approved hard limit. When no `required` system gates remain and the run is
    /// still `action_required`, the run advances to `queued`. Idempotent via
    /// command receipts: same key + payload replays the stored result.
    #[allow(clippy::too_many_arguments)]
    pub fn approve_production_gate(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        run_id: &str,
        gate_type: &str,
        decision: &str,
        hard_limit_micros: Option<i64>,
        note: Option<&str>,
        approved_stage_key: Option<&str>,
    ) -> Result<Value, RuntimeError> {
        if !["approved", "rejected"].contains(&decision) {
            return Err(RuntimeError::new(
                "INVALID_ARGUMENT",
                "production.approve decision must be approved or rejected",
            ));
        }
        let approved_by = format!("{actor_kind}:{actor_instance_id}");
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let existing = transaction
            .query_row(
                "SELECT payload_hash, receipt_json
                   FROM command_receipts
                  WHERE actor_kind = ?1
                    AND actor_instance_id = ?2
                    AND idempotency_key = ?3",
                params![actor_kind, actor_instance_id, idempotency_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(store_unavailable)?;
        if let Some((existing_hash, receipt_json)) = existing {
            if existing_hash != payload_hash {
                return Err(idempotency_conflict(&existing_hash, payload_hash));
            }
            return serde_json::from_str(&receipt_json).map_err(store_unavailable);
        }
        let now = chrono::Utc::now().timestamp_millis();
        let run_status = transaction
            .query_row(
                "SELECT status FROM production_runs WHERE id = ?1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    format!("ProductionRun not found: {run_id}"),
                )
            })?;
        let gate = transaction
            .query_row(
                "SELECT id, gate_kind, status FROM production_gates
                  WHERE run_id = ?1 AND gate_type = ?2",
                params![run_id, gate_type],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    format!("Production gate not found: {gate_type}"),
                )
            })?;
        let (gate_id, gate_kind, gate_status) = gate;
        if !["action_required", "queued"].contains(&run_status.as_str())
            && !(run_status == "running" && gate_kind == "director")
        {
            return Err(RuntimeError::new(
                "PRECONDITION_FAILED",
                format!("ProductionRun gates are frozen in status {run_status}"),
            ));
        }
        if gate_status != "required" {
            return Err(RuntimeError::new(
                "PRECONDITION_FAILED",
                format!("Production gate {gate_type} is already {gate_status}"),
            ));
        }
        if gate_kind == "system" && gate_type == "run-budget" && decision == "approved" {
            let hard_limit = hard_limit_micros.ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    "Approving the run-budget gate requires hardLimitMicros",
                )
            })?;
            if hard_limit <= 0 {
                return Err(RuntimeError::new(
                    "INVALID_ARGUMENT",
                    "hardLimitMicros must be a positive integer",
                ));
            }
            transaction
                .execute(
                    "INSERT INTO run_budgets(run_id, hard_limit_micros, unit_code, approved_by, created_at)
                     VALUES(?1, ?2, 'CNY', ?3, ?4)
                     ON CONFLICT(run_id) DO NOTHING",
                    params![run_id, hard_limit, approved_by, now],
                )
                .map_err(store_unavailable)?;
        }
        if gate_kind == "system" && gate_type == "route-plan" && decision == "approved" {
            transaction
                .execute(
                    "UPDATE run_route_plans SET status = 'confirmed', updated_at = ?1
                      WHERE run_id = ?2 AND status = 'proposed'",
                    params![now, run_id],
                )
                .map_err(store_unavailable)?;
        }
        if gate_kind == "director" && gate_type == "style-reference" && decision == "approved" {
            let selected_stage = approved_stage_key.ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    "Approving the style-reference gate requires approvedStageKey",
                )
            })?;
            let valid_reference = transaction
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM stage_runs
                        WHERE run_id = ?1
                          AND stage_key = ?2
                          AND stage_key LIKE 'style:bakeoff:%'
                          AND capability_id = 'image.generate'
                          AND status = 'succeeded'
                          AND task_id IS NOT NULL
                     )",
                    params![run_id, selected_stage],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(store_unavailable)?;
            if !valid_reference {
                return Err(RuntimeError::new(
                    "PRECONDITION_FAILED",
                    "approvedStageKey must identify a succeeded style bake-off Artifact in this run",
                ));
            }
        } else if gate_kind == "director"
            && ["keyframe-review", "ocr"].contains(&gate_type)
            && decision == "approved"
        {
            let (total, incomplete) = transaction
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 0 ELSE 1 END), 0)
                       FROM stage_runs
                      WHERE run_id = ?1 AND stage_key LIKE 'shot:%:keyframe'",
                    [run_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(store_unavailable)?;
            if total == 0 || incomplete > 0 {
                return Err(RuntimeError::new(
                    "PRECONDITION_FAILED",
                    format!(
                        "{gate_type} can be approved only after every keyframe Artifact succeeds"
                    ),
                ));
            }
        } else if approved_stage_key.is_some() {
            return Err(RuntimeError::new(
                "INVALID_ARGUMENT",
                "approvedStageKey is only valid for the style-reference gate",
            ));
        }
        let decision_record = json!({
            "decision": decision,
            "approvedBy": approved_by,
            "note": note,
            "hardLimitMicros": hard_limit_micros,
            "approvedStageKey": approved_stage_key,
            "decidedAt": now
        });
        transaction
            .execute(
                "UPDATE production_gates
                    SET status = ?1, decision_json = ?2, updated_at = ?3
                  WHERE id = ?4",
                params![decision, decision_record.to_string(), now, gate_id],
            )
            .map_err(store_unavailable)?;

        // Recompute blockers from remaining required gates and blocked capabilities.
        let mut blockers = Vec::new();
        {
            let mut statement = transaction
                .prepare(
                    "SELECT gate_kind, gate_type FROM production_gates
                      WHERE run_id = ?1 AND status = 'required'
                      ORDER BY gate_type",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(store_unavailable)?;
            for row in rows {
                let (kind, gate) = row.map_err(store_unavailable)?;
                if kind == "system" {
                    blockers.push(match gate.as_str() {
                        "route-plan" => "ROUTE_PLAN_REQUIRED".to_owned(),
                        "run-budget" => "RUN_BUDGET_REQUIRED".to_owned(),
                        other => format!("GATE_REQUIRED:{other}"),
                    });
                } else {
                    blockers.push(format!("DIRECTOR_GATE_REQUIRED:{gate}"));
                }
            }
        }
        let has_blocked_capability = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM stage_runs WHERE run_id = ?1 AND status = 'blocked')",
                [run_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(store_unavailable)?;
        if has_blocked_capability {
            blockers.push("CAPABILITY_UNAVAILABLE".to_owned());
        }
        let rejected = decision == "rejected";
        let system_gates_clear = !blockers
            .iter()
            .any(|blocker| blocker.starts_with("ROUTE_PLAN") || blocker.starts_with("RUN_BUDGET"));
        let next_status = if rejected && run_status != "running" {
            "failed"
        } else if system_gates_clear && run_status == "action_required" {
            "queued"
        } else {
            run_status.as_str()
        };
        transaction
            .execute(
                "UPDATE production_runs SET status = ?1, blockers_json = ?2 WHERE id = ?3",
                params![
                    next_status,
                    serde_json::to_string(&blockers).map_err(store_unavailable)?,
                    run_id
                ],
            )
            .map_err(store_unavailable)?;
        transaction
            .execute(
                "INSERT INTO runtime_events(
                    event_version, entity_type, entity_id, event_type, payload_json, created_at
                 ) VALUES('1', 'production_run', ?1, 'production.gate.decided', ?2, ?3)",
                params![
                    run_id,
                    json!({
                        "gateType": gate_type,
                        "gateKind": gate_kind,
                        "decision": decision,
                        "runStatus": next_status,
                        "blockers": blockers
                    })
                    .to_string(),
                    now
                ],
            )
            .map_err(store_unavailable)?;
        let result = json!({
            "runId": run_id,
            "gateType": gate_type,
            "gateKind": gate_kind,
            "decision": decision,
            "runStatus": next_status,
            "blockers": blockers
        });
        // R6-L05: Guard against command_id collision.
        check_command_id_conflict(&transaction, command_id, idempotency_key)?;
        transaction
            .execute(
                "INSERT INTO command_receipts(
                    command_id, actor_kind, actor_instance_id, idempotency_key,
                    command_name, payload_hash, task_id, receipt_json, created_at
                 ) VALUES(?1, ?2, ?3, ?4, 'production.approve', ?5, '', ?6, ?7)",
                params![
                    command_id,
                    actor_kind,
                    actor_instance_id,
                    idempotency_key,
                    payload_hash,
                    result.to_string(),
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction.commit().map_err(store_unavailable)?;
        Ok(result)
    }

    /// Snapshot everything the production.run scheduler needs in one read.
    pub fn load_run_execution(&self, run_id: &str) -> Result<RunExecution, RuntimeError> {
        let connection = self.connection.lock();
        let (status, review_policy) = connection
            .query_row(
                "SELECT status, review_policy FROM production_runs WHERE id = ?1",
                [run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    format!("ProductionRun not found: {run_id}"),
                )
            })?;
        let mut gates = std::collections::HashMap::new();
        let mut gate_decisions = std::collections::HashMap::new();
        {
            let mut statement = connection
                .prepare("SELECT gate_type, status, decision_json FROM production_gates WHERE run_id = ?1")
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(store_unavailable)?;
            for row in rows {
                let (gate_type, gate_status, decision) = row.map_err(store_unavailable)?;
                if let Some(decision) = decision.and_then(|value| serde_json::from_str(&value).ok())
                {
                    gate_decisions.insert(gate_type.clone(), decision);
                }
                gates.insert(gate_type, gate_status);
            }
        }
        let budget = connection
            .query_row(
                "SELECT hard_limit_micros, unit_code FROM run_budgets WHERE run_id = ?1",
                [run_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(store_unavailable)?;
        let (reserved_micros, confirmed_micros) = connection
            .query_row(
                "SELECT
                    COALESCE(SUM(CASE WHEN entry_kind = 'reserve' THEN amount_micros
                                      WHEN entry_kind = 'release' THEN -amount_micros
                                      ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN entry_kind = 'confirm' THEN amount_micros ELSE 0 END), 0)
                   FROM usage_ledger WHERE run_id = ?1",
                [run_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(store_unavailable)?;
        let mut estimates = std::collections::HashMap::new();
        if let Some(plan_json) = connection
            .query_row(
                "SELECT plan_json FROM run_route_plans WHERE run_id = ?1 AND status = 'confirmed'",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(store_unavailable)?
        {
            if let Ok(plan) = serde_json::from_str::<Value>(&plan_json) {
                for entry in plan
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let (Some(stage_key), Some(estimate)) = (
                        entry.get("stageKey").and_then(Value::as_str),
                        entry.get("estimateMicros").and_then(Value::as_i64),
                    ) {
                        estimates.insert(stage_key.to_owned(), estimate);
                    }
                }
            }
        }
        let mut stage_ids = std::collections::HashMap::new();
        let mut stages = Vec::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT id, stage_key, capability_id, status, input_json, task_id, result_json
                       FROM stage_runs
                      WHERE run_id = ?1
                      ORDER BY created_at, stage_key",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                })
                .map_err(store_unavailable)?;
            for row in rows {
                let (id, stage_key, capability_id, stage_status, input_json, task_id, result_json) =
                    row.map_err(store_unavailable)?;
                stage_ids.insert(id.clone(), stage_key.clone());
                stages.push(StageExec {
                    id,
                    stage_key,
                    capability_id,
                    status: stage_status,
                    input: input_json
                        .and_then(|value| serde_json::from_str(&value).ok())
                        .unwrap_or(Value::Null),
                    task_id,
                    result: result_json.and_then(|value| serde_json::from_str(&value).ok()),
                    dependencies: Vec::new(),
                });
            }
        }
        {
            let mut statement = connection
                .prepare(
                    "SELECT d.stage_run_id, d.depends_on_stage_run_id
                       FROM stage_dependencies d
                       JOIN stage_runs stage ON stage.id = d.stage_run_id
                      WHERE stage.run_id = ?1",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(store_unavailable)?;
            let mut dependency_map = std::collections::HashMap::<String, Vec<String>>::new();
            for row in rows {
                let (stage_run_id, depends_on_id) = row.map_err(store_unavailable)?;
                if let Some(dependency_key) = stage_ids.get(&depends_on_id) {
                    dependency_map
                        .entry(stage_run_id)
                        .or_default()
                        .push(dependency_key.clone());
                }
            }
            for stage in &mut stages {
                if let Some(dependencies) = dependency_map.remove(&stage.id) {
                    stage.dependencies = dependencies;
                }
            }
        }
        Ok(RunExecution {
            status,
            review_policy,
            stages,
            gates,
            gate_decisions,
            budget,
            reserved_micros,
            confirmed_micros,
            estimates,
        })
    }

    pub fn update_run_status(
        &self,
        run_id: &str,
        expected: &[&str],
        next: &str,
        blockers: Option<&[String]>,
    ) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let placeholders = expected
            .iter()
            .map(|status| format!("'{status}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let started = if next == "running" {
            ", started_at = COALESCE(started_at, :now)"
        } else if ["completed", "completed_with_warnings", "failed", "canceled"].contains(&next) {
            ", finished_at = COALESCE(finished_at, :now)"
        } else {
            ""
        };
        let blockers_clause = if blockers.is_some() {
            ", blockers_json = :blockers"
        } else {
            ""
        };
        let sql = format!(
            "UPDATE production_runs SET status = :next{started}{blockers_clause}
              WHERE id = :run_id AND status IN ({placeholders})"
        );
        let blockers_json = blockers
            .map(serde_json::to_string)
            .transpose()
            .map_err(store_unavailable)?;
        let mut statement = transaction.prepare(&sql).map_err(store_unavailable)?;
        let updated = if let Some(blockers_json) = &blockers_json {
            statement
                .execute(rusqlite::named_params! {
                    ":next": next,
                    ":now": now,
                    ":blockers": blockers_json,
                    ":run_id": run_id,
                })
                .map_err(store_unavailable)?
        } else {
            statement
                .execute(rusqlite::named_params! {
                    ":next": next,
                    ":now": now,
                    ":run_id": run_id,
                })
                .map_err(store_unavailable)?
        };
        drop(statement);
        if updated == 1 {
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, entity_type, entity_id, event_type, payload_json, created_at
                     ) VALUES('1', 'production_run', ?1, 'production.run.status', ?2, ?3)",
                    params![run_id, json!({ "status": next }).to_string(), now],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)?;
        Ok(updated == 1)
    }

    /// Transition one stage and optionally record its provider task, result, and
    /// usage-ledger entries, in a single transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn update_stage(
        &self,
        run_id: &str,
        stage_key: &str,
        expected: &[&str],
        next: &str,
        task_id: Option<&str>,
        result: Option<&Value>,
        blocked_reason: Option<&Value>,
        ledger: &[(&str, i64, &str)],
    ) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let stage_run_id = transaction
            .query_row(
                "SELECT id FROM stage_runs WHERE run_id = ?1 AND stage_key = ?2",
                params![run_id, stage_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    format!("StageRun not found: {stage_key}"),
                )
            })?;
        let placeholders = expected
            .iter()
            .map(|status| format!("'{status}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let updated = transaction
            .execute(
                &format!(
                    "UPDATE stage_runs
                        SET status = ?1,
                            task_id = COALESCE(?2, task_id),
                            result_json = COALESCE(?3, result_json),
                            blocked_reason_json = ?4,
                            started_at = CASE WHEN ?1 = 'running'
                                THEN COALESCE(started_at, ?5) ELSE started_at END,
                            finished_at = CASE WHEN ?1 IN ('succeeded', 'failed', 'skipped', 'canceled')
                                THEN COALESCE(finished_at, ?5) ELSE finished_at END
                      WHERE id = ?6 AND status IN ({placeholders})"
                ),
                params![
                    next,
                    task_id,
                    result.map(Value::to_string),
                    blocked_reason.map(Value::to_string),
                    now,
                    stage_run_id
                ],
            )
            .map_err(store_unavailable)?;
        if updated == 1 {
            for (entry_kind, amount_micros, note) in ledger {
                transaction
                    .execute(
                        "INSERT INTO usage_ledger(
                            run_id, stage_run_id, entry_kind, amount_micros, unit_code, note, created_at
                         ) VALUES(?1, ?2, ?3, ?4, 'CNY', ?5, ?6)",
                        params![run_id, stage_run_id, entry_kind, amount_micros, note, now],
                    )
                    .map_err(store_unavailable)?;
            }
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, entity_type, entity_id, event_type, payload_json, created_at
                     ) VALUES('1', 'production_run', ?1, 'production.stage.status', ?2, ?3)",
                    params![
                        run_id,
                        json!({
                            "stageKey": stage_key,
                            "stageRunId": stage_run_id,
                            "status": next,
                            "taskId": task_id
                        })
                        .to_string(),
                        now
                    ],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)?;
        Ok(updated == 1)
    }

    /// Submit a stage child task from the scheduler (system actor). The
    /// idempotency key is derived from run + stage so recovery never duplicates.
    pub fn submit_stage_task(
        &self,
        run_id: &str,
        stage_key: &str,
        command_name: &str,
        args: &Value,
    ) -> Result<TaskReceipt, RuntimeError> {
        let payload_hash = super::ProductionRuntime::hash_payload(&json!({
            "command": command_name,
            "args": args,
        }))
        .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
        self.submit_task(
            &super::ProductionRuntime::new_id("cmd"),
            "system",
            "production_scheduler",
            &format!("stage:{run_id}:{stage_key}"),
            &payload_hash,
            command_name,
            args,
            2_000,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn submit_task(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        command_name: &str,
        args: &Value,
        poll_interval_ms: u64,
    ) -> Result<TaskReceipt, RuntimeError> {
        self.submit_task_with_entity(
            command_id,
            actor_kind,
            actor_instance_id,
            idempotency_key,
            payload_hash,
            command_name,
            args,
            None,
            poll_interval_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn submit_task_with_entity(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        command_name: &str,
        args: &Value,
        entity: Option<(&str, &str)>,
        poll_interval_ms: u64,
    ) -> Result<TaskReceipt, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;

        let existing = transaction
            .query_row(
                "SELECT payload_hash, receipt_json
                   FROM command_receipts
                  WHERE actor_kind = ?1
                    AND actor_instance_id = ?2
                    AND idempotency_key = ?3",
                params![actor_kind, actor_instance_id, idempotency_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(store_unavailable)?;
        if let Some((existing_hash, receipt_json)) = existing {
            if existing_hash != payload_hash {
                return Err(RuntimeError {
                    code: "IDEMPOTENCY_CONFLICT".to_owned(),
                    message: "Idempotency key was already used with a different payload."
                        .to_owned(),
                    retryable: false,
                    details: Some(json!({
                        "existingPayloadHash": existing_hash,
                        "receivedPayloadHash": payload_hash,
                    })),
                    action_url: None,
                });
            }
            return serde_json::from_str(&receipt_json).map_err(store_unavailable);
        }

        let task_id = super::ProductionRuntime::new_id("task");
        let now = chrono::Utc::now().timestamp_millis();
        transaction
            .execute(
                "INSERT INTO runtime_tasks(
                    id, command_id, kind, status, entity_type, entity_id,
                    args_json, created_at, updated_at
                 ) VALUES(?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?7)",
                params![
                    task_id,
                    command_id,
                    command_name,
                    entity.map(|(kind, _)| kind),
                    entity.map(|(_, id)| id),
                    args.to_string(),
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction
            .execute(
                "INSERT INTO runtime_events(
                    event_version, task_id, event_type, payload_json, created_at
                 ) VALUES('1', ?1, 'task.queued', ?2, ?3)",
                params![task_id, json!({ "status": "queued" }).to_string(), now],
            )
            .map_err(store_unavailable)?;
        let event_id = transaction.last_insert_rowid();
        let receipt = TaskReceipt {
            kind: "task".to_owned(),
            command_id: command_id.to_owned(),
            task_id: task_id.clone(),
            status: "queued".to_owned(),
            poll_interval_ms,
            event_id,
            links: TaskLinks {
                task: format!("/v1/tasks/{task_id}"),
                events: format!("/v1/events?taskId={task_id}"),
            },
        };
        // R6-L05: Guard against command_id PRIMARY KEY collision with a
        // different idempotency key (would otherwise surface as a raw
        // SQLite constraint error).
        check_command_id_conflict(&transaction, command_id, idempotency_key)?;
        transaction
            .execute(
                "INSERT INTO command_receipts(
                    command_id, actor_kind, actor_instance_id, idempotency_key,
                    command_name, payload_hash, task_id, receipt_json, created_at
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    command_id,
                    actor_kind,
                    actor_instance_id,
                    idempotency_key,
                    command_name,
                    payload_hash,
                    task_id,
                    serde_json::to_string(&receipt).map_err(store_unavailable)?,
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction.commit().map_err(store_unavailable)?;
        drop(connection);
        self.signal_work();
        Ok(receipt)
    }

    pub fn list_provider_credentials(
        &self,
        provider: Option<&str>,
    ) -> Result<Vec<Value>, RuntimeError> {
        let connection = self.connection.lock();
        let has_kv = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(store_unavailable)?;
        if !has_kv {
            return Ok(Vec::new());
        }
        let prefix = provider
            .map(|provider| format!("keyring:meta:{provider}:"))
            .unwrap_or_else(|| "keyring:meta:".to_owned());
        let mut statement = connection
            .prepare(
                "SELECT key, value
                   FROM kv
                  WHERE key LIKE ?1
                  ORDER BY updated_at DESC",
            )
            .map_err(store_unavailable)?;
        let rows = statement
            .query_map([format!("{prefix}%")], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(store_unavailable)?;
        let mut credentials = Vec::new();
        for row in rows {
            let (key, value) = row.map_err(store_unavailable)?;
            let Some(account) = key.strip_prefix("keyring:meta:") else {
                continue;
            };
            let Some((provider, credential_id)) = account.split_once(':') else {
                continue;
            };
            let metadata = serde_json::from_str::<Value>(&value).unwrap_or(Value::Null);
            credentials.push(json!({
                "provider": provider,
                "credentialId": credential_id,
                "label": metadata.get("label").and_then(Value::as_str),
                "updatedAt": metadata.get("updated_at").and_then(Value::as_i64).unwrap_or_default(),
                "available": true
            }));
        }
        Ok(credentials)
    }

    pub fn replace_agent_text_routes(&self, routes: &[AgentTextRoute]) -> Result<(), RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        transaction
            .execute("DELETE FROM agent_text_routes", [])
            .map_err(store_unavailable)?;
        for route in routes {
            transaction
                .execute(
                    "INSERT INTO agent_text_routes(
                       order_index, provider, credential_id, model, base_url, protocol
                     ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        route.order,
                        route.provider,
                        route.credential_id,
                        route.model,
                        route.base_url,
                        route.protocol
                    ],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)
    }

    pub fn list_agent_text_routes(&self) -> Result<Vec<AgentTextRoute>, RuntimeError> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT provider, credential_id, model, base_url, protocol, order_index
                   FROM agent_text_routes
                  ORDER BY order_index ASC",
            )
            .map_err(store_unavailable)?;
        let routes = statement
            .query_map([], |row| {
                Ok(AgentTextRoute {
                    provider: row.get(0)?,
                    credential_id: row.get(1)?,
                    model: row.get(2)?,
                    base_url: row.get(3)?,
                    protocol: row.get(4)?,
                    order: row.get(5)?,
                })
            })
            .map_err(store_unavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store_unavailable)?;
        Ok(routes)
    }

    pub fn default_credential_id(&self, provider: &str) -> Result<Option<String>, RuntimeError> {
        Ok(self
            .list_provider_credentials(Some(provider))?
            .into_iter()
            .find_map(|credential| {
                credential
                    .get("credentialId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }))
    }

    pub fn get_task(&self, task_id: &str) -> Result<RuntimeTask, RuntimeError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT id, command_id, kind, status, progress_json, lease_owner,
                        lease_expires_at, cancel_requested_at, result_json, error_json,
                        created_at, updated_at
                   FROM runtime_tasks
                  WHERE id = ?1",
                [task_id],
                task_from_row,
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new("TASK_NOT_FOUND", format!("Task not found: {task_id}"))
            })
    }

    pub fn find_production_run_task(
        &self,
        run_id: &str,
    ) -> Result<Option<RuntimeTask>, RuntimeError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT id, command_id, kind, status, progress_json, lease_owner,
                        lease_expires_at, cancel_requested_at, result_json, error_json,
                        created_at, updated_at
                   FROM runtime_tasks
                  WHERE kind = 'production.run'
                    AND entity_type = 'production_run' AND entity_id = ?1
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1",
                [run_id],
                task_from_row,
            )
            .optional()
            .map_err(store_unavailable)
    }

    pub fn list_tasks(
        &self,
        status: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<RuntimeTaskPage, RuntimeError> {
        let connection = self.connection.lock();
        if let Some(cursor) = cursor {
            let exists = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM runtime_tasks WHERE id = ?1)",
                    [cursor],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(store_unavailable)?;
            if !exists {
                return Err(RuntimeError::new(
                    "INVALID_ARGUMENT",
                    "task.list cursor is invalid",
                ));
            }
        }
        let mut statement = connection
            .prepare(
                "SELECT id, command_id, kind, status, progress_json, lease_owner,
                        lease_expires_at, cancel_requested_at, result_json, error_json,
                        created_at, updated_at
                   FROM runtime_tasks
                  WHERE (?1 IS NULL OR status = ?1)
                    AND (
                      ?2 IS NULL
                      OR created_at < (SELECT created_at FROM runtime_tasks WHERE id = ?2)
                      OR (
                        created_at = (SELECT created_at FROM runtime_tasks WHERE id = ?2)
                        AND id < ?2
                      )
                    )
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?3",
            )
            .map_err(store_unavailable)?;
        let rows = statement
            .query_map(params![status, cursor, limit + 1], task_from_row)
            .map_err(store_unavailable)?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(store_unavailable)?);
        }
        let has_more = tasks.len() > limit as usize;
        tasks.truncate(limit as usize);
        let next_cursor = has_more
            .then(|| tasks.last().map(|task| task.id.clone()))
            .flatten();
        Ok(RuntimeTaskPage { tasks, next_cursor })
    }

    /// 对外便捷包装（内部调度用 claim_next_task_filtered 区分任务类型）；
    /// 保留给未来外部调用方（tauri command / CLI）。
    #[allow(dead_code)]
    pub fn claim_next_task(
        &self,
        worker_id: &str,
        lease_ms: i64,
    ) -> Result<Option<ClaimedTask>, RuntimeError> {
        self.claim_next_task_filtered(worker_id, lease_ms, None)
    }

    /// Claim the next runnable task, optionally restricted to scheduler tasks
    /// (`Some(true)` = only `production.run`, `Some(false)` = everything else).
    /// The split lets the scheduler thread block on child tasks that a second
    /// executor thread claims, without the two competing for the same work.
    pub fn claim_next_task_filtered(
        &self,
        worker_id: &str,
        lease_ms: i64,
        scheduler_only: Option<bool>,
    ) -> Result<Option<ClaimedTask>, RuntimeError> {
        let kind_clause = match scheduler_only {
            Some(true) => " AND kind = 'production.run'",
            Some(false) => " AND kind != 'production.run'",
            None => "",
        };
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let candidate = transaction
            .query_row(
                &format!(
                    "SELECT id, kind, args_json, progress_json
                       FROM runtime_tasks
                      WHERE (status = 'queued'
                         OR (status = 'working' AND lease_expires_at <= ?1)){kind_clause}
                      ORDER BY created_at, id
                      LIMIT 1"
                ),
                [now],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(store_unavailable)?;
        let Some((task_id, kind, args_json, progress_json)) = candidate else {
            transaction.commit().map_err(store_unavailable)?;
            return Ok(None);
        };
        let lease_expires_at = now + lease_ms;
        let claimed = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET status = 'working',
                        lease_owner = ?2,
                        lease_expires_at = ?3,
                        updated_at = ?1
                  WHERE id = ?4
                    AND (
                      status = 'queued'
                      OR (status = 'working' AND lease_expires_at <= ?1)
                    )",
                params![now, worker_id, lease_expires_at, task_id],
            )
            .map_err(store_unavailable)?;
        if claimed == 0 {
            transaction.commit().map_err(store_unavailable)?;
            return Ok(None);
        }
        transaction
            .execute(
                "INSERT INTO runtime_events(
                    event_version, task_id, event_type, payload_json, created_at
                 ) VALUES('1', ?1, 'task.working', ?2, ?3)",
                params![task_id, json!({ "status": "working" }).to_string(), now],
            )
            .map_err(store_unavailable)?;
        transaction.commit().map_err(store_unavailable)?;
        Ok(Some(ClaimedTask {
            id: task_id,
            kind,
            args: serde_json::from_str(&args_json).map_err(store_unavailable)?,
            progress: progress_json.and_then(|value| serde_json::from_str(&value).ok()),
        }))
    }

    pub fn update_progress(
        &self,
        task_id: &str,
        worker_id: &str,
        progress: &Value,
    ) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let updated = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET progress_json = ?1, updated_at = ?2
                  WHERE id = ?3 AND status = 'working' AND lease_owner = ?4",
                params![progress.to_string(), now, task_id, worker_id],
            )
            .map_err(store_unavailable)?;
        if updated == 1 {
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, task_id, event_type, payload_json, created_at
                     ) VALUES('1', ?1, 'task.progress', ?2, ?3)",
                    params![task_id, progress.to_string(), now],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)?;
        Ok(updated == 1)
    }

    pub fn fail_task(
        &self,
        task_id: &str,
        worker_id: &str,
        error: &Value,
    ) -> Result<bool, RuntimeError> {
        self.finish_with_error(task_id, worker_id, "failed", "task.failed", error)
    }

    pub fn require_input(
        &self,
        task_id: &str,
        worker_id: &str,
        error: &Value,
    ) -> Result<bool, RuntimeError> {
        self.finish_with_error(
            task_id,
            worker_id,
            "input_required",
            "task.input_required",
            error,
        )
    }

    fn finish_with_error(
        &self,
        task_id: &str,
        worker_id: &str,
        status: &str,
        event_type: &str,
        error: &Value,
    ) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let updated = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET status = ?1,
                        error_json = ?2,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        updated_at = ?3
                  WHERE id = ?4 AND status = 'working' AND lease_owner = ?5",
                params![status, error.to_string(), now, task_id, worker_id],
            )
            .map_err(store_unavailable)?;
        if updated == 1 {
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, task_id, event_type, payload_json, created_at
                     ) VALUES('1', ?1, ?2, ?3, ?4)",
                    params![
                        task_id,
                        event_type,
                        json!({
                            "status": status,
                            "code": error.get("code").and_then(Value::as_str)
                        })
                        .to_string(),
                        now
                    ],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)?;
        Ok(updated == 1)
    }

    pub fn renew_lease(
        &self,
        task_id: &str,
        worker_id: &str,
        lease_ms: i64,
    ) -> Result<bool, RuntimeError> {
        let now = chrono::Utc::now().timestamp_millis();
        let connection = self.connection.lock();
        connection
            .execute(
                "UPDATE runtime_tasks
                    SET lease_expires_at = ?1, updated_at = ?2
                  WHERE id = ?3 AND status = 'working' AND lease_owner = ?4",
                params![now + lease_ms, now, task_id, worker_id],
            )
            .map(|updated| updated == 1)
            .map_err(store_unavailable)
    }

    pub fn complete_task(
        &self,
        task_id: &str,
        worker_id: &str,
        result: &Value,
    ) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let completed = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET status = 'completed',
                        result_json = ?1,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        updated_at = ?2
                  WHERE id = ?3 AND status = 'working' AND lease_owner = ?4",
                params![result.to_string(), now, task_id, worker_id],
            )
            .map_err(store_unavailable)?;
        if completed == 1 {
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, task_id, event_type, payload_json, created_at
                     ) VALUES('1', ?1, 'task.completed', ?2, ?3)",
                    params![task_id, json!({ "status": "completed" }).to_string(), now],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)?;
        Ok(completed == 1)
    }

    pub fn complete_production_plan(
        &self,
        task_id: &str,
        worker_id: &str,
        draft: &ProductionPlanDraft,
    ) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let owns_task = transaction
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM runtime_tasks
                    WHERE id = ?1 AND status = 'working' AND lease_owner = ?2
                 )",
                params![task_id, worker_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(store_unavailable)?;
        if !owns_task {
            transaction.commit().map_err(store_unavailable)?;
            return Ok(false);
        }

        let now = chrono::Utc::now().timestamp_millis();
        let session_id = super::ProductionRuntime::new_id("production_session");
        let spec_revision_id = super::ProductionRuntime::new_id("spec_revision");
        let production_run_id = super::ProductionRuntime::new_id("production_run");
        let projection_id = super::ProductionRuntime::new_id("workflow_projection");
        transaction
            .execute(
                "INSERT INTO production_sessions(
                    id, project_id, title, review_policy, primary_skill_snapshot_json,
                    status, created_at, updated_at
                 ) VALUES(?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
                params![
                    session_id,
                    draft.project_id,
                    draft.title,
                    draft.review_policy,
                    draft.director.to_string(),
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction
            .execute(
                "INSERT INTO production_spec_revisions(
                    id, session_id, revision_no, parent_revision_id, schema_version,
                    core_json, extension_json, spec_hash, created_by, created_at
                 ) VALUES(?1, ?2, 1, NULL, ?3, ?4, ?5, ?6, 'director_skill', ?7)",
                params![
                    spec_revision_id,
                    session_id,
                    draft.schema_version,
                    draft.core.to_string(),
                    draft.extensions.to_string(),
                    draft.spec_hash,
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction
            .execute(
                "INSERT INTO production_runs(
                    id, session_id, spec_revision_id, review_policy, status,
                    blockers_json, created_at
                 ) VALUES(?1, ?2, ?3, ?4, 'action_required', ?5, ?6)",
                params![
                    production_run_id,
                    session_id,
                    spec_revision_id,
                    draft.review_policy,
                    serde_json::to_string(&draft.blockers).map_err(store_unavailable)?,
                    now
                ],
            )
            .map_err(store_unavailable)?;

        let mut stage_run_ids = Vec::with_capacity(draft.stages.len());
        for stage in &draft.stages {
            let stage_run_id = super::ProductionRuntime::new_id("stage_run");
            transaction
                .execute(
                    "INSERT INTO stage_runs(
                        id, run_id, stage_key, capability_id, spec_path, title, summary,
                        status, input_hash, input_json, blocked_reason_json, created_at
                     ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        stage_run_id,
                        production_run_id,
                        stage.stage_key,
                        stage.capability_id,
                        stage.spec_path,
                        stage.title,
                        stage.summary,
                        stage.status,
                        stage.input_hash,
                        stage.input.to_string(),
                        stage.blocked_reason.as_ref().map(Value::to_string),
                        now
                    ],
                )
                .map_err(store_unavailable)?;
            stage_run_ids.push((stage.stage_key.clone(), stage_run_id));
        }
        for gate in &draft.gates {
            let gate_id = super::ProductionRuntime::new_id("production_gate");
            transaction
                .execute(
                    "INSERT INTO production_gates(
                        id, run_id, gate_kind, gate_type, status, created_at, updated_at
                     ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![
                        gate_id,
                        production_run_id,
                        gate.get("gateKind")
                            .and_then(Value::as_str)
                            .unwrap_or("director"),
                        gate.get("gateType")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        gate.get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("required"),
                        now
                    ],
                )
                .map_err(store_unavailable)?;
        }
        let route_plan = super::production::build_route_plan(
            &draft
                .stages
                .iter()
                .map(|stage| {
                    (
                        stage.stage_key.clone(),
                        stage.capability_id.clone(),
                        stage.input.clone(),
                    )
                })
                .collect::<Vec<_>>(),
        );
        transaction
            .execute(
                "INSERT INTO run_route_plans(run_id, status, plan_json, created_at, updated_at)
                 VALUES(?1, 'proposed', ?2, ?3, ?3)",
                params![production_run_id, route_plan.to_string(), now],
            )
            .map_err(store_unavailable)?;
        let stage_id = |stage_key: &str| {
            stage_run_ids
                .iter()
                .find_map(|(key, id)| (key == stage_key).then_some(id.as_str()))
        };
        for stage in &draft.stages {
            let stage_run_id = stage_id(&stage.stage_key).ok_or_else(|| {
                RuntimeError::new("RUNTIME_UNAVAILABLE", "Compiled StageRun ID is missing.")
            })?;
            for dependency in &stage.dependencies {
                let dependency_id = stage_id(dependency).ok_or_else(|| {
                    RuntimeError::new(
                        "RUNTIME_UNAVAILABLE",
                        format!("Compiled stage dependency is missing: {dependency}"),
                    )
                })?;
                transaction
                    .execute(
                        "INSERT INTO stage_dependencies(
                            stage_run_id, depends_on_stage_run_id, dependency_kind
                         ) VALUES(?1, ?2, 'artifact')",
                        params![stage_run_id, dependency_id],
                    )
                    .map_err(store_unavailable)?;
            }
        }

        let projection = build_workflow_projection(
            draft,
            &projection_id,
            &session_id,
            &spec_revision_id,
            &production_run_id,
            &stage_run_ids,
        )?;
        let projection_hash = projection["projectionHash"]
            .as_str()
            .ok_or_else(|| {
                RuntimeError::new(
                    "RUNTIME_UNAVAILABLE",
                    "Compiled Workflow Projection is missing its hash.",
                )
            })?
            .to_owned();
        transaction
            .execute(
                "INSERT INTO workflow_plan_projections(
                    id, project_id, session_id, spec_revision_id, run_id,
                    projection_version, projection_json, projection_hash, created_at
                 ) VALUES(?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8)",
                params![
                    projection_id,
                    draft.project_id,
                    session_id,
                    spec_revision_id,
                    production_run_id,
                    projection.to_string(),
                    projection_hash,
                    now
                ],
            )
            .map_err(store_unavailable)?;

        let result = json!({
            "productionSessionId": session_id,
            "specRevisionId": spec_revision_id,
            "productionRunId": production_run_id,
            "projectionId": projection_id,
            "projectionHash": projection_hash,
            "stageCount": draft.stages.len(),
            "status": "action_required",
            "blockers": draft.blockers,
            "routePlan": route_plan,
            "gates": draft.gates
        });
        let completed = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET status = 'completed',
                        entity_type = 'production_run',
                        entity_id = ?1,
                        result_json = ?2,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        updated_at = ?3
                  WHERE id = ?4 AND status = 'working' AND lease_owner = ?5",
                params![
                    production_run_id,
                    result.to_string(),
                    now,
                    task_id,
                    worker_id
                ],
            )
            .map_err(store_unavailable)?;
        if completed != 1 {
            return Err(RuntimeError::new(
                "RUNTIME_UNAVAILABLE",
                "Production plan task lease was lost before commit.",
            ));
        }
        transaction
            .execute(
                "INSERT INTO runtime_events(
                    event_version, entity_type, entity_id, task_id,
                    event_type, payload_json, created_at
                 ) VALUES('1', 'production_run', ?1, ?2, 'production.plan.compiled', ?3, ?4)",
                params![
                    production_run_id,
                    task_id,
                    json!({
                        "status": "action_required",
                        "stageCount": draft.stages.len(),
                        "projectionId": projection_id,
                        "blockers": draft.blockers
                    })
                    .to_string(),
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction
            .execute(
                "INSERT INTO runtime_events(
                    event_version, entity_type, entity_id, task_id,
                    event_type, payload_json, created_at
                 ) VALUES('1', 'production_run', ?1, ?2, 'task.completed', ?3, ?4)",
                params![
                    production_run_id,
                    task_id,
                    json!({ "status": "completed" }).to_string(),
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction.commit().map_err(store_unavailable)?;
        Ok(true)
    }

    pub fn get_production_status(&self, run_id: &str) -> Result<Value, RuntimeError> {
        let connection = self.connection.lock();
        let run = connection
            .query_row(
                "SELECT r.id, r.session_id, r.spec_revision_id, r.review_policy,
                        r.status, r.blockers_json, s.project_id, s.title, revision.extension_json,
                        r.created_at, COALESCE(r.finished_at, r.started_at, r.created_at)
                   FROM production_runs r
                   JOIN production_sessions s ON s.id = r.session_id
                   JOIN production_spec_revisions revision ON revision.id = r.spec_revision_id
                  WHERE r.id = ?1",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new(
                    "INVALID_ARGUMENT",
                    format!("ProductionRun not found: {run_id}"),
                )
            })?;
        let mut dependencies = std::collections::HashMap::<String, Vec<String>>::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT stage.stage_key, dependency.stage_key
                       FROM stage_dependencies d
                       JOIN stage_runs stage ON stage.id = d.stage_run_id
                       JOIN stage_runs dependency ON dependency.id = d.depends_on_stage_run_id
                      WHERE stage.run_id = ?1
                      ORDER BY stage.stage_key, dependency.stage_key",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(store_unavailable)?;
            for row in rows {
                let (stage_key, dependency) = row.map_err(store_unavailable)?;
                dependencies.entry(stage_key).or_default().push(dependency);
            }
        }
        let mut stages = Vec::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT id, stage_key, capability_id, spec_path, title, summary,
                            status, blocked_reason_json, input_json, task_id, result_json
                       FROM stage_runs
                      WHERE run_id = ?1
                      ORDER BY created_at, stage_key",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                    ))
                })
                .map_err(store_unavailable)?;
            for row in rows {
                let (
                    id,
                    stage_key,
                    capability_id,
                    spec_path,
                    title,
                    summary,
                    status,
                    blocked_reason,
                    input,
                    task_id,
                    result,
                ) = row.map_err(store_unavailable)?;
                let artifact = result
                    .and_then(|value| serde_json::from_str::<Value>(&value).ok())
                    .and_then(|value| super::production_task::artifact_reference(&value));
                stages.push(json!({
                    "id": id,
                    "stageKey": stage_key,
                    "capabilityId": capability_id,
                    "specPath": spec_path,
                    "title": title,
                    "summary": summary,
                    "status": status,
                    "input": input.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "taskId": task_id,
                    "artifact": artifact,
                    "blockedReason": blocked_reason
                        .and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "dependsOn": dependencies.remove(&stage_key).unwrap_or_default()
                }));
            }
        }
        let mut gates = Vec::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT gate_kind, gate_type, status, decision_json
                       FROM production_gates
                      WHERE run_id = ?1
                      ORDER BY gate_kind, gate_type",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map([run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(store_unavailable)?;
            for row in rows {
                let (gate_kind, gate_type, status, decision) = row.map_err(store_unavailable)?;
                gates.push(json!({
                    "gateKind": gate_kind,
                    "gateType": gate_type,
                    "status": status,
                    "decision": decision.and_then(|value| serde_json::from_str::<Value>(&value).ok())
                }));
            }
        }
        let draft_binding = serde_json::from_str::<Value>(&run.8)
            .ok()
            .and_then(|extensions| extensions.get("flovart.workflow-draft").cloned());
        Ok(json!({
            "id": run.0,
            "productionSessionId": run.1,
            "specRevisionId": run.2,
            "reviewPolicy": run.3,
            "status": run.4,
            "blockers": serde_json::from_str::<Value>(&run.5).map_err(store_unavailable)?,
            "projectId": run.6,
            "title": run.7,
            "draftBinding": draft_binding,
            "createdAt": run.9,
            "updatedAt": run.10,
            "stages": stages,
            "gates": gates
        }))
    }

    pub fn get_production_task(&self, task_id: &str) -> Result<Value, RuntimeError> {
        let run = self.get_production_status(task_id)?;
        let runtime_task = self
            .find_production_run_task(task_id)?
            .map(|task| serde_json::to_value(task).map_err(store_unavailable))
            .transpose()?;
        Ok(super::production_task::from_run(
            &run,
            runtime_task.as_ref(),
        ))
    }

    pub fn resume_production_task(&self, task_id: &str) -> Result<Value, RuntimeError> {
        let task = self.get_production_task(task_id)?;
        let state = task
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !["planned", "running", "recovering"].contains(&state) {
            return Err(RuntimeError {
                code: "PRECONDITION_FAILED".to_owned(),
                message: format!("ProductionTask cannot resume from state {state}."),
                retryable: false,
                details: Some(json!({ "task": task })),
                action_url: None,
            });
        }
        let runtime_task = self.find_production_run_task(task_id)?.ok_or_else(|| {
            RuntimeError::new(
                "PRECONDITION_FAILED",
                "ProductionTask has not been submitted to the Runtime scheduler.",
            )
        })?;
        if !["queued", "working"].contains(&runtime_task.status.as_str()) {
            return Err(RuntimeError {
                code: "RECOVERY_REQUIRED".to_owned(),
                message: format!(
                    "The ProductionTask scheduler record is {} and cannot be resumed safely.",
                    runtime_task.status
                ),
                retryable: false,
                details: Some(json!({
                    "runtimeTaskId": runtime_task.id,
                    "runtimeTaskStatus": runtime_task.status,
                    "task": task
                })),
                action_url: None,
            });
        }
        Ok(super::production_task::resume_result(
            &task,
            &serde_json::to_value(runtime_task).map_err(store_unavailable)?,
        ))
    }

    pub fn get_pipeline_run(&self, run_id: &str, since: i64) -> Result<Value, RuntimeError> {
        let connection = self.connection.lock();
        super::pipeline_trace::read_trace(&connection, run_id, since)
    }

    pub fn get_workflow_projection(&self, project_id: &str) -> Result<Value, RuntimeError> {
        let connection = self.connection.lock();
        let projection = connection
            .query_row(
                "SELECT projection_version, projection_json
                   FROM workflow_plan_projections
                  WHERE project_id = ?1
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1",
                [project_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(store_unavailable)?;
        match projection {
            Some((version, projection)) => {
                let mut projection =
                    serde_json::from_str::<Value>(&projection).map_err(store_unavailable)?;
                if let Some(run_id) = projection.get("productionRunId").and_then(Value::as_str) {
                    let mut stages = std::collections::HashMap::<
                        String,
                        (String, Option<String>, Option<Value>),
                    >::new();
                    {
                        let mut statement = connection
                            .prepare(
                                "SELECT stage_key, status, task_id, result_json
                                   FROM stage_runs
                                  WHERE run_id = ?1",
                            )
                            .map_err(store_unavailable)?;
                        let rows = statement
                            .query_map([run_id], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, Option<String>>(2)?,
                                    row.get::<_, Option<String>>(3)?,
                                ))
                            })
                            .map_err(store_unavailable)?;
                        for row in rows {
                            let (stage_key, status, task_id, result_json) =
                                row.map_err(store_unavailable)?;
                            stages.insert(
                                stage_key,
                                (
                                    status,
                                    task_id,
                                    result_json.and_then(|value| serde_json::from_str(&value).ok()),
                                ),
                            );
                        }
                    }
                    if let Some(nodes) = projection.get_mut("nodes").and_then(Value::as_array_mut) {
                        for node in nodes {
                            let Some(stage_key) = node
                                .get("metadata")
                                .and_then(|value| value.get("productionProjection"))
                                .and_then(|value| value.get("stageKey"))
                                .and_then(Value::as_str)
                            else {
                                continue;
                            };
                            let Some((status, task_id, result)) = stages.get(stage_key) else {
                                continue;
                            };
                            let mut media_kind = None;
                            {
                                let Some(metadata) =
                                    node.get_mut("metadata").and_then(Value::as_object_mut)
                                else {
                                    continue;
                                };
                                metadata.insert(
                                    "status".to_owned(),
                                    json!(match status.as_str() {
                                        "running" | "queued" | "ready" => "loading",
                                        "succeeded" => "success",
                                        "failed" | "blocked" => "error",
                                        _ => "idle",
                                    }),
                                );
                                if let Some(artifact) = result
                                    .as_ref()
                                    .and_then(|value| value.get("artifact"))
                                    .and_then(Value::as_object)
                                {
                                    let Some(kind) = artifact.get("kind").and_then(Value::as_str)
                                    else {
                                        continue;
                                    };
                                    if !matches!(kind, "image" | "video" | "audio") {
                                        continue;
                                    }
                                    let Some(task_id) = task_id.as_deref() else {
                                        continue;
                                    };
                                    let mime_type = artifact
                                        .get("mimeType")
                                        .and_then(Value::as_str)
                                        .unwrap_or("application/octet-stream");
                                    let mut artifact_ref = json!({
                                        "taskId": task_id,
                                        "kind": kind,
                                        "mimeType": mime_type
                                    });
                                    for (source, target) in [
                                        ("sha256", "sha256"),
                                        ("byteSize", "byteSize"),
                                        ("durationSec", "durationSec"),
                                    ] {
                                        if let Some(value) = artifact.get(source) {
                                            artifact_ref[target] = value.clone();
                                        }
                                    }
                                    metadata.insert("artifactRef".to_owned(), artifact_ref);
                                    metadata.insert("mimeType".to_owned(), json!(mime_type));
                                    if let Some(value) = artifact.get("byteSize") {
                                        metadata.insert("bytes".to_owned(), value.clone());
                                    }
                                    if let Some(duration) =
                                        artifact.get("durationSec").and_then(Value::as_f64)
                                    {
                                        metadata.insert(
                                            "durationMs".to_owned(),
                                            json!(duration * 1000.0),
                                        );
                                    }
                                    media_kind = Some(kind.to_owned());
                                }
                            }
                            if let Some(kind) = media_kind {
                                node["type"] = json!(kind);
                            }
                        }
                    }
                }
                if let Some(object) = projection.as_object_mut() {
                    object.remove("projectionHash");
                }
                let projection_hash = ProductionRuntime::hash_payload(&projection)
                    .map_err(|error| RuntimeError::new("RUNTIME_UNAVAILABLE", error.to_string()))?;
                projection["projectionHash"] = json!(projection_hash);
                Ok(json!({
                    "projectId": project_id,
                    "projectionVersion": version,
                    "projection": projection
                }))
            }
            None => Ok(json!({
                "projectId": project_id,
                "projectionVersion": 0,
                "projection": null
            })),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn request_cancel(
        &self,
        command_id: &str,
        actor_kind: &str,
        actor_instance_id: &str,
        idempotency_key: &str,
        payload_hash: &str,
        task_id: &str,
        reason: Option<&str>,
    ) -> Result<RuntimeTask, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let existing = transaction
            .query_row(
                "SELECT payload_hash, receipt_json
                   FROM command_receipts
                  WHERE actor_kind = ?1
                    AND actor_instance_id = ?2
                    AND idempotency_key = ?3",
                params![actor_kind, actor_instance_id, idempotency_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(store_unavailable)?;
        if let Some((existing_hash, receipt_json)) = existing {
            if existing_hash != payload_hash {
                return Err(idempotency_conflict(&existing_hash, payload_hash));
            }
            return serde_json::from_str(&receipt_json).map_err(store_unavailable);
        }

        let now = chrono::Utc::now().timestamp_millis();
        let updated = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET cancel_requested_at = COALESCE(cancel_requested_at, ?1),
                        updated_at = ?1
                  WHERE id = ?2
                    AND status IN ('queued', 'working', 'input_required')",
                params![now, task_id],
            )
            .map_err(store_unavailable)?;
        let task = transaction
            .query_row(
                "SELECT id, command_id, kind, status, progress_json, lease_owner,
                        lease_expires_at, cancel_requested_at, result_json, error_json,
                        created_at, updated_at
                   FROM runtime_tasks
                  WHERE id = ?1",
                [task_id],
                task_from_row,
            )
            .optional()
            .map_err(store_unavailable)?
            .ok_or_else(|| {
                RuntimeError::new("TASK_NOT_FOUND", format!("Task not found: {task_id}"))
            })?;
        if updated == 1 {
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, task_id, event_type, payload_json, created_at
                     ) VALUES('1', ?1, 'task.cancel_requested', ?2, ?3)",
                    params![
                        task_id,
                        json!({
                            "status": task.status,
                            "reasonCode": reason.map(|_| "REQUESTED")
                        })
                        .to_string(),
                        now
                    ],
                )
                .map_err(store_unavailable)?;
        }
        // R6-L05: Guard against command_id collision.
        check_command_id_conflict(&transaction, command_id, idempotency_key)?;
        transaction
            .execute(
                "INSERT INTO command_receipts(
                    command_id, actor_kind, actor_instance_id, idempotency_key,
                    command_name, payload_hash, task_id, receipt_json, created_at
                 ) VALUES(?1, ?2, ?3, ?4, 'task.cancel', ?5, ?6, ?7, ?8)",
                params![
                    command_id,
                    actor_kind,
                    actor_instance_id,
                    idempotency_key,
                    payload_hash,
                    task_id,
                    serde_json::to_string(&task).map_err(store_unavailable)?,
                    now
                ],
            )
            .map_err(store_unavailable)?;
        transaction.commit().map_err(store_unavailable)?;
        Ok(task)
    }

    pub fn cancellation_requested(
        &self,
        task_id: &str,
        worker_id: &str,
    ) -> Result<bool, RuntimeError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT cancel_requested_at IS NOT NULL
                   FROM runtime_tasks
                  WHERE id = ?1 AND status = 'working' AND lease_owner = ?2",
                params![task_id, worker_id],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.unwrap_or(false))
            .map_err(store_unavailable)
    }

    pub fn cancel_task(&self, task_id: &str, worker_id: &str) -> Result<bool, RuntimeError> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_unavailable)?;
        let now = chrono::Utc::now().timestamp_millis();
        let cancelled = transaction
            .execute(
                "UPDATE runtime_tasks
                    SET status = 'cancelled',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        updated_at = ?1
                  WHERE id = ?2
                    AND status = 'working'
                    AND lease_owner = ?3
                    AND cancel_requested_at IS NOT NULL",
                params![now, task_id, worker_id],
            )
            .map_err(store_unavailable)?;
        if cancelled == 1 {
            transaction
                .execute(
                    "INSERT INTO runtime_events(
                        event_version, task_id, event_type, payload_json, created_at
                     ) VALUES('1', ?1, 'task.cancelled', ?2, ?3)",
                    params![task_id, json!({ "status": "cancelled" }).to_string(), now],
                )
                .map_err(store_unavailable)?;
        }
        transaction.commit().map_err(store_unavailable)?;
        Ok(cancelled == 1)
    }

    pub fn list_events(
        &self,
        after_event_id: i64,
        task_id: Option<&str>,
        limit: u32,
    ) -> Result<RuntimeEventPage, RuntimeError> {
        let connection = self.connection.lock();
        let mut events = Vec::new();
        if let Some(task_id) = task_id {
            let mut statement = connection
                .prepare(
                    "SELECT event_id, event_version, event_type, entity_type, entity_id,
                            task_id, created_at, payload_json
                       FROM runtime_events
                      WHERE event_id > ?1 AND task_id = ?2
                      ORDER BY event_id
                      LIMIT ?3",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map(params![after_event_id, task_id, limit], event_from_row)
                .map_err(store_unavailable)?;
            for row in rows {
                events.push(row.map_err(store_unavailable)?);
            }
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT event_id, event_version, event_type, entity_type, entity_id,
                            task_id, created_at, payload_json
                       FROM runtime_events
                      WHERE event_id > ?1
                      ORDER BY event_id
                      LIMIT ?2",
                )
                .map_err(store_unavailable)?;
            let rows = statement
                .query_map(params![after_event_id, limit], event_from_row)
                .map_err(store_unavailable)?;
            for row in rows {
                events.push(row.map_err(store_unavailable)?);
            }
        }
        let next_event_id = events
            .last()
            .map(|event| event.event_id)
            .unwrap_or(after_event_id);
        Ok(RuntimeEventPage {
            events,
            next_event_id,
        })
    }
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeTask> {
    Ok(RuntimeTask {
        id: row.get(0)?,
        command_id: row.get(1)?,
        kind: row.get(2)?,
        status: row.get(3)?,
        progress: parse_optional_json(row.get(4)?),
        lease_owner: row.get(5)?,
        lease_expires_at: row.get(6)?,
        cancel_requested_at: row.get(7)?,
        result: parse_optional_json(row.get(8)?),
        error: parse_optional_json(row.get(9)?),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn parse_optional_json(value: Option<String>) -> Option<Value> {
    value.and_then(|value| serde_json::from_str(&value).ok())
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RuntimeEvent> {
    let entity_type: Option<String> = row.get(3)?;
    let entity_id: Option<String> = row.get(4)?;
    let payload: String = row.get(7)?;
    Ok(RuntimeEvent {
        event_id: row.get(0)?,
        event_version: row.get(1)?,
        event_type: row.get(2)?,
        entity: entity_type
            .zip(entity_id)
            .map(|(kind, id)| RuntimeEntityRef { kind, id }),
        task_id: row.get(5)?,
        occurred_at: row.get(6)?,
        data: serde_json::from_str(&payload).unwrap_or(Value::Null),
    })
}

fn store_unavailable(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError {
        code: "RUNTIME_UNAVAILABLE".to_owned(),
        message: format!("Runtime ledger unavailable: {error}"),
        retryable: true,
        details: None,
        action_url: None,
    }
}

fn idempotency_conflict(existing_hash: &str, received_hash: &str) -> RuntimeError {
    RuntimeError {
        code: "IDEMPOTENCY_CONFLICT".to_owned(),
        message: "Idempotency key was already used with a different payload.".to_owned(),
        retryable: false,
        details: Some(json!({
            "existingPayloadHash": existing_hash,
            "receivedPayloadHash": received_hash,
        })),
        action_url: None,
    }
}

/// R6-L05: Check whether `command_id` already exists in command_receipts
/// with a *different* idempotency key.  The table's PRIMARY KEY is
/// `command_id`, so a duplicate would cause a raw SQLite constraint error
/// instead of a clean IDEMPOTENCY_CONFLICT.  This check ensures the caller
/// gets a structured error before the INSERT is attempted.
///
/// `existing_key` is the idempotency key the caller is about to use, so that
/// a legitimate replay (same key) is not flagged.
fn check_command_id_conflict(
    transaction: &rusqlite::Transaction<'_>,
    command_id: &str,
    existing_key: &str,
) -> Result<(), RuntimeError> {
    let conflict = transaction
        .query_row(
            "SELECT idempotency_key FROM command_receipts WHERE command_id = ?1",
            [command_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(store_unavailable)?;
    if let Some(key) = conflict {
        if key != existing_key {
            return Err(RuntimeError {
                code: "IDEMPOTENCY_CONFLICT".to_owned(),
                message: "Command ID was already used with a different idempotency key.".to_owned(),
                retryable: false,
                details: Some(json!({
                    "commandId": command_id,
                    "existingIdempotencyKey": key,
                    "receivedIdempotencyKey": existing_key,
                })),
                action_url: None,
            });
        }
    }
    Ok(())
}
