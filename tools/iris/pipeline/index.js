// Agent 视频流水线：命令边界（docs/design/16-agent-video-pipeline.md §3 / §4）。
//
// 每个 pipeline 工具只包装一份业务实现；本文件是唯一入口，负责：
//   1. 参数与 run 状态校验；
//   2. mutationId 幂等（同 ID 同载荷 → 原结果；同 ID 不同载荷 → 拒绝）；
//   3. 自动记录 Step（tool / caller / argsDigest / status / artifacts / cost），模型不负责“记账”；
//   4. run 级预算（任务数 / 金额 / 最大评审轮数）；
//   5. 依赖缺失 → CAPABILITY_UNAVAILABLE，run 进入 blocked 并带诊断动作。
// CLI（tools/iris/cli.js）、本地 Agent 会话（agent/session.js）与内置工具集共用这一个 execute。
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, PipelineStore, sha256File, sha256Text } from './store.js';
import { applyPatch, clipsForFindings, emptySpec, lockedClipsUnchanged, SpecError, validateSpec } from './spec.js';
import { CapabilityError, extractFrame, mediaInfo, probeMedia, sideBySide } from './media.js';
import { renderWithFfmpeg, renderWithRemotion, RENDER_PRESETS } from './render.js';
import { alignLines, readEvidenceWords, synthesizeLine, toHypitTranscript, transcribeFile, ttsRoutes } from './voice.js';
import { findingsSignature, REVIEW_VERDICTS, validateFindings } from './review.js';
import { PIPELINE_COMMAND_NAMES, PIPELINE_COMMANDS, PIPELINE_WRITE_COMMANDS } from './commands.js';
import { normalizeCaptureArgs, runCapture } from './capture.js';
import { ApprovalStore, USER_CONFIRM_FIELDS } from './approvals.js';

export const PIPELINE_CALLERS = Object.freeze(['built-in', 'codex', 'claude-code', 'dsh', 'cli', 'mcp', 'user']);

class PipelineError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const fail = (code, message, options) => { throw new PipelineError(code, message, options); };
const toError = error => ({
  code: error?.code || 'PIPELINE_FAILED',
  message: error instanceof Error ? error.message : String(error),
  retryable: Boolean(error?.retryable),
  ...(error?.details ? { details: error.details } : {}),
});

const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };

function normalizeCaller(value) {
  const caller = String(value || 'built-in').trim().toLowerCase();
  if (PIPELINE_CALLERS.includes(caller)) return caller;
  if (/^[a-z0-9][a-z0-9._-]{0,40}$/.test(caller)) return `external:${caller}`;
  return 'external';
}

const requireString = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', `${name} 不能为空`);
  return value.trim();
};
const positiveInt = (value, name) => {
  if (!Number.isInteger(value) || value <= 0) fail('INVALID_ARGUMENT', `${name} 必须是正整数`);
  return value;
};

// ---------------- 工具表：write = 需要 mutationId；paid = 计入预算；tracked = 记 Step ----------------
export const PIPELINE_TOOL_DEFINITIONS = Object.freeze({
  'pipeline.run.start': { write: true, tracked: true, summary: '创建一次 Agent 视频制作 run：写入 brief artifact，并一次性确认 run 预算（任务数 / 金额 / 最大评审轮数）。' },
  'pipeline.run.get': { write: false, tracked: false, summary: '读取 run 的完整 trace：Step、版本、渲染、评审轮次、花费与卡点。' },
  'asset.import': { write: true, tracked: true, summary: '把授权本地文件（截图、录屏、外部 Agent 产物）导入 run，成为带 sha256 的 durable artifact。' },
  'capture.ui': { write: true, tracked: true, summary: '本机 Playwright 打开 localhost / 授权文件夹内的页面，按步骤截图或录屏，产出 durable artifact；启动浏览器前需 confirmed: true。' },
  'asset.list': { write: false, tracked: false, summary: '按 run / kind / tag 列出 durable artifact。' },
  'audio.tts': { write: true, tracked: true, paid: true, summary: '按口播稿（speechText）逐行配音，输出实测时长与声线参数快照；displayText 只给字幕。' },
  'audio.transcribe': { write: true, tracked: true, summary: '对音频 artifact 做词级转写（whisperx / hypit / fixture），产出 hypit.transcript@1 证据 artifact。' },
  'timeline.align': { write: false, tracked: true, summary: '脚本行 ↔ 词级证据对齐，返回每行与每个动作词在时间线上的毫秒时间。' },
  'composition.patch': { write: true, tracked: true, summary: '基于版本号修订合成 spec V2（画面 / 文字 / 字幕 / 音频轨），尊重锁；带 reviewRoundId 时只允许改 findings 指向的片段。' },
  'composition.render': { write: true, tracked: true, summary: '渲染某个版本：still（静态关键帧）/ draft（小样）/ final（成片，需该版评审通过）。' },
  'media.probe': { write: false, tracked: true, summary: '探测 artifact：时长、编码、分辨率、黑帧、静音、响度，并给出自动检查问题。' },
  'media.frames': { write: false, tracked: true, summary: '按秒抽取真实渲染帧（≤6 张），可与另一版本左右对比、可放大区域。' },
  'review.submit': { write: true, tracked: true, summary: '提交一轮结构化评审（时间点 / 层 / 问题 / 修法 / 结论 pass|revise|block）。' },
  'run.archive': { write: true, tracked: true, summary: '把成片、各版 spec、独立音轨、废片、评审归档到用户目录并生成 sha256 清单。' },
});

export { PIPELINE_COMMAND_NAMES, PIPELINE_COMMANDS, PIPELINE_WRITE_COMMANDS };
for (const name of PIPELINE_COMMAND_NAMES) {
  if (!PIPELINE_TOOL_DEFINITIONS[name]) throw new Error(`pipeline 命令缺少实现：${name}`);
  if (PIPELINE_TOOL_DEFINITIONS[name].write !== PIPELINE_WRITE_COMMANDS.has(name)) throw new Error(`pipeline 写命令清单不一致：${name}`);
}

// run 状态 → 允许的工具。blocked 时只能读与用户评审（解除卡点）。
const READ_TOOLS = new Set(['pipeline.run.get', 'asset.list', 'media.probe', 'media.frames', 'timeline.align']);

export class Pipeline {
  constructor({ home, store } = {}) {
    this.store = store || new PipelineStore({ home });
    this.approvals = new ApprovalStore(this.store.home);
  }

  close() { this.store.close(); }

  async execute(command, rawArgs = {}, context = {}) {
    let gate;
    let result;
    try {
      gate = this.#confirmationGate(command, rawArgs, context);
      result = await this.#execute(command, gate.args, gate.context);
    } catch (error) {
      result = { ok: false, error: toError(error) };
    }
    if (gate?.pending && result?.ok === false && result.error?.code === 'CONFIRMATION_REQUIRED') {
      const approval = this.approvals.request({ ...gate.pending, summary: result.error.message });
      result = {
        ...result,
        error: {
          ...result.error,
          message: `${result.error.message}。确认必须由用户在 Iris 界面批准（approvalId=${approval.id}），批准后用相同参数重试；调用方自行填写的确认字段不生效。`,
          details: { ...(result.error.details || {}), approval: { approvalId: approval.id, status: approval.status, expiresAt: approval.expiresAt } },
        },
      };
    }
    return result;
  }

  /**
   * 用户确认闸：USER_CONFIRM_FIELDS 中的确认字段只有可信入口（人在终端的 CLI，context.trustedConfirmation）才直接生效。
   * 内置 Agent 与 MCP 等模型驱动入口填的值被丢弃，改为消费一条用户批准的、绑定 command + runId + 参数摘要的一次性审批。
   * 参数摘要不含确认字段与 mutationId，所以“未确认 → 用户批准 → 同参数重试”可沿用同一个 mutationId。
   */
  #confirmationGate(command, rawArgs, context) {
    const field = USER_CONFIRM_FIELDS[command];
    const args = { ...(rawArgs || {}) };
    if (!field) return { args, context };
    if (context.trustedConfirmation === true) return { args, context: { ...context, userApproved: args[field] === true } };
    delete args[field];
    const { mutationId: _mutation, caller: _caller, idempotencyKey: _key, ...bound } = args;
    const runId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : null;
    const argsDigest = approvalDigest(command, bound);
    const approved = this.approvals.consume({ command, runId, argsDigest });
    return {
      args,
      context: { ...context, userApproved: Boolean(approved) },
      pending: approved ? null : { command, runId, argsDigest, caller: normalizeCaller(context.caller ?? rawArgs?.caller) },
    };
  }

  /** 宿主 UI 专用（不在 Agent 工具面上）：列出 / 批准 / 拒绝待确认操作。 */
  listApprovals(filter) { return this.approvals.listPending(filter); }
  grantApproval(approvalId) {
    const record = this.approvals.grant(approvalId);
    if (!record) fail('APPROVAL_NOT_FOUND', `找不到待批准的操作或已过期：${approvalId}`);
    return record;
  }
  denyApproval(approvalId) {
    const record = this.approvals.deny(approvalId);
    if (!record) fail('APPROVAL_NOT_FOUND', `找不到待批准的操作或已过期：${approvalId}`);
    return record;
  }

  async #execute(command, rawArgs, context) {
    const definition = PIPELINE_TOOL_DEFINITIONS[command];
    if (!definition) fail('UNKNOWN_COMMAND', `未知 pipeline 命令：${command}`);
    const args = { ...(rawArgs || {}) };
    const mutationId = String(args.mutationId ?? context.mutationId ?? context.idempotencyKey ?? '').trim() || null;
    const caller = normalizeCaller(context.caller ?? args.caller);
    delete args.mutationId;
    delete args.caller;
    delete args.idempotencyKey;
    if (definition.write && !mutationId) fail('INVALID_ARGUMENT', `${command} 需要 mutationId，重试才不会重复执行`);

    if (command === 'pipeline.run.start') return this.#startRun(args, { caller, mutationId, userApproved: context.userApproved === true });
    if (command === 'pipeline.run.get') return { ok: true, result: this.trace(requireString(args.runId, 'runId'), args.since) };
    if (command === 'asset.list') {
      return {
        ok: true,
        result: {
          artifacts: this.store.listArtifacts({ runId: args.runId, kind: args.kind, tags: args.tags || [] }).map(publicArtifact),
        },
      };
    }

    const run = this.store.getRun(requireString(args.runId, 'runId'));
    if (!run) fail('RUN_NOT_FOUND', `找不到 run：${args.runId}`);
    this.#gate(run, command, args, caller);

    const argsDigest = sha256Text(canonicalJson({ command, args }));
    let step = mutationId ? this.store.findStepByMutation(run.id, command, mutationId) : null;
    if (step) {
      if (step.argsDigest !== argsDigest) {
        fail('IDEMPOTENCY_CONFLICT', `mutationId ${mutationId} 已用于不同参数的 ${command}`, { details: { stepId: step.id } });
      }
      if (step.status === 'succeeded') {
        return { ok: true, result: step.result, step: stepReceipt(step, { replayed: true }) };
      }
      // 付费调用中断（running）或已判定结果未知（unknown_submit）时，不知道 Provider 是否已收单：
      // 每次重试都要求显式 confirmResubmit，未知状态不会因为“再试一次”被静默清除。
      const livePaid = definition.paid && args.voice?.route !== 'fake';
      if (livePaid && (step.status === 'running' || step.status === 'unknown_submit') && context.confirmResubmit !== true) {
        if (step.status === 'running') {
          step = this.store.finishStep(step.id, { status: 'unknown_submit', error: { code: 'UNKNOWN_SUBMIT', message: '上次提交结果未知' } });
        }
        fail('UNKNOWN_SUBMIT', '上次付费提交中断，结果未知（可能已扣费）；先核对 Provider 账单 / 任务，确认后用 confirmResubmit 重提', { details: { stepId: step.id, ...(step.error?.providerRequestId ? { providerRequestId: step.error.providerRequestId } : {}) } });
      }
      // 本地确定性步骤（或失败 / 未知后经确认）：在原 Step 上恢复执行，不新增 Step。
      step = this.store.restartStep(step.id);
    } else {
      step = this.store.startStep({ runId: run.id, tool: command, caller, mutationId, argsDigest, args, paid: definition.paid });
    }

    let reservation = null;
    if (definition.paid) reservation = this.#reserve(run, step, command, args);

    try {
      const outcome = await this.#handlers[command].call(this, run, args, { step, caller, signal: context.signal, userApproved: context.userApproved === true });
      const costMicros = outcome.costMicros ?? 0;
      if (reservation) this.store.ledger(run.id, { stepId: step.id, kind: 'confirm', amountMicros: costMicros, tasks: reservation.tasks, note: command });
      const finished = this.store.finishStep(step.id, { status: 'succeeded', result: outcome.result, artifactIds: outcome.artifactIds || [], costMicros });
      const current = this.store.getRun(run.id);
      if (current.status === 'blocked' && current.blocker?.code === 'CAPABILITY_UNAVAILABLE' && current.blocker.tool === command) {
        this.store.updateRun(run.id, { status: 'active', blocker: null });
      }
      return { ok: true, result: outcome.result, step: stepReceipt(finished) };
    } catch (error) {
      // Provider 已收单但结果未知（超时、断网）：保留预留额度并标 unknown_submit，重试必须走 confirmResubmit。
      const unknownSubmit = Boolean(definition.paid) && (error?.code === 'PROVIDER_UNKNOWN_SUBMIT' || error?.code === 'UNKNOWN_SUBMIT');
      if (reservation && !unknownSubmit) this.store.ledger(run.id, { stepId: step.id, kind: 'release', amountMicros: reservation.amountMicros, tasks: reservation.tasks, note: error?.code || 'failed' });
      const status = unknownSubmit ? 'unknown_submit' : error?.code === 'CANCELED' ? 'canceled' : 'failed';
      const stepError = { ...toError(error), ...(error?.providerRequestId ? { providerRequestId: String(error.providerRequestId) } : {}) };
      const finished = this.store.finishStep(step.id, { status, error: stepError });
      if (error instanceof CapabilityError || error?.code === 'CAPABILITY_UNAVAILABLE') {
        this.store.updateRun(run.id, {
          status: 'blocked',
          blocker: { code: 'CAPABILITY_UNAVAILABLE', tool: command, stepId: step.id, message: error.message, diagnose: error.details?.diagnose, capability: error.details?.capability },
        });
      }
      return { ok: false, error: toError(error), step: stepReceipt(finished) };
    }
  }

  #gate(run, command, args, caller) {
    if (READ_TOOLS.has(command)) return;
    if (run.status === 'archived' || run.status === 'stopped') fail('RUN_CLOSED', `run 已${run.status === 'archived' ? '归档' : '停止'}，只能读取`);
    if (run.status === 'blocked') {
      const userReview = command === 'review.submit' && (args.reviewer === 'user' || caller === 'user');
      const retryingCapability = run.blocker?.code === 'CAPABILITY_UNAVAILABLE' && run.blocker.tool === command;
      if (!userReview && !retryingCapability) {
        fail('RUN_BLOCKED', `run 卡住了：${run.blocker?.message || '等待用户'}；需要用户确认（review.submit reviewer=user）`, { details: run.blocker });
      }
    }
  }

  #reserve(run, step, command, args) {
    const tasks = command === 'audio.tts' ? (Array.isArray(args.lines) ? args.lines.length : 0) : 1;
    const estimate = 0; // 预估金额由 Provider 路由给出；fake 为 0，MiniMax 在确认时按实际字数记账。
    const spend = this.store.spend(run.id);
    const maxTasks = run.budget.maxTasks;
    if (Number.isFinite(maxTasks) && spend.confirmedTasks + spend.pendingTasks + tasks > maxTasks) {
      this.store.finishStep(step.id, { status: 'failed', error: { code: 'BUDGET_EXCEEDED', message: '超出 run 任务数预算' } });
      fail('BUDGET_EXCEEDED', `超出 run 预算：已用 ${spend.confirmedTasks} / ${maxTasks} 个付费任务，本次需要 ${tasks} 个；扩大范围需要用户重新确认`, {
        details: { maxTasks, usedTasks: spend.confirmedTasks, requestedTasks: tasks },
      });
    }
    const maxCost = run.budget.maxCostMicros;
    if (Number.isFinite(maxCost) && spend.confirmedMicros + spend.pendingMicros + estimate > maxCost) {
      this.store.finishStep(step.id, { status: 'failed', error: { code: 'BUDGET_EXCEEDED', message: '超出 run 金额预算' } });
      fail('BUDGET_EXCEEDED', '超出 run 金额预算；扩大范围需要用户重新确认', { details: { maxCostMicros: maxCost, usedMicros: spend.confirmedMicros } });
    }
    this.store.ledger(run.id, { stepId: step.id, kind: 'reserve', amountMicros: estimate, tasks, note: command });
    return { tasks, amountMicros: estimate };
  }

  // ---------------- pipeline.run.start ----------------
  #startRun(args, { caller, mutationId, userApproved }) {
    const argsDigest = sha256Text(canonicalJson({ command: 'pipeline.run.start', args }));
    const existing = this.store.findStartStep(mutationId);
    if (existing) {
      if (existing.argsDigest !== argsDigest) fail('IDEMPOTENCY_CONFLICT', `mutationId ${mutationId} 已用于不同的 run`);
      return { ok: true, result: existing.result, step: stepReceipt(existing, { replayed: true }) };
    }
    const projectId = requireString(args.projectId, 'projectId');
    const brief = args.brief;
    if (!brief || typeof brief !== 'object') fail('INVALID_ARGUMENT', 'brief 必须是对象');
    requireString(brief.keyLine, 'brief.keyLine（看完要记住的一句话）');
    const aspect = brief.aspect || '9:16';
    if (!ASPECTS[aspect]) fail('INVALID_ARGUMENT', `brief.aspect 只支持 ${Object.keys(ASPECTS).join(' / ')}`);
    const budgetInput = args.budget || {};
    const budget = {
      maxTasks: positiveInt(budgetInput.maxTasks, 'budget.maxTasks'),
      maxRounds: positiveInt(budgetInput.maxRounds ?? 3, 'budget.maxRounds'),
      ...(budgetInput.maxCostMicros !== undefined ? { maxCostMicros: positiveInt(budgetInput.maxCostMicros, 'budget.maxCostMicros') } : {}),
    };
    if (!userApproved) {
      return {
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: '创建 run 前需要用户一次性确认预算（任务数 / 金额 / 最大评审轮数）；确认后带 budgetConfirmed: true 重试',
          retryable: false,
          details: { budget },
        },
      };
    }
    const [width, height] = ASPECTS[aspect];
    const normalizedBrief = {
      audience: brief.audience || '',
      channel: brief.channel || '',
      keyLine: brief.keyLine,
      aspect,
      language: brief.language || 'zh-CN',
      durationSec: brief.durationSec ?? 20,
      notes: brief.notes || '',
      output: { width, height, fps: brief.fps || 30 },
    };
    const run = this.store.createRun({
      projectId,
      title: String(args.title || brief.keyLine).slice(0, 80),
      brief: normalizedBrief,
      budget,
      reference: args.reference,
      createdBy: caller,
    });
    const step = this.store.startStep({ runId: run.id, tool: 'pipeline.run.start', caller, mutationId, argsDigest, args, paid: false });
    const briefArtifact = this.store.putText(JSON.stringify(normalizedBrief, null, 2), 'brief.json', { runId: run.id, stepId: step.id, kind: 'brief', tags: ['brief'] });
    this.store.updateRun(run.id, { briefArtifactId: briefArtifact.id });
    const result = { runId: run.id, briefArtifactId: briefArtifact.id, budget, output: normalizedBrief.output };
    const finished = this.store.finishStep(step.id, { status: 'succeeded', result, artifactIds: [briefArtifact.id] });
    return { ok: true, result, step: stepReceipt(finished) };
  }

  // ---------------- trace ----------------
  /** run 摘要列表：最新版本、最新评审结论、Step 数，供 UI 分组。 */
  listRuns({ projectId, limit } = {}) {
    return this.store.listRuns({ projectId, limit }).map(run => {
      const reviews = this.store.listReviews(run.id);
      const last = reviews.at(-1);
      const steps = this.store.listSteps(run.id);
      return {
        runId: run.id, projectId: run.projectId, title: run.title, status: run.status, headVersion: run.headVersion,
        blocker: run.blocker, stepCount: steps.length, failedSteps: steps.filter(step => step.status === 'failed').length,
        lastVerdict: last ? { round: last.round, version: last.version, verdict: last.verdict, reviewer: last.reviewer } : null,
        createdAt: run.createdAt, updatedAt: run.updatedAt,
      };
    });
  }

  /** 只读取本 run 产物的文件（UI 预览）；不接受任意路径。 */
  artifactFile(artifactId) {
    const artifact = this.store.requireArtifact(artifactId);
    return { path: artifact.path, mime: artifact.mime || 'application/octet-stream', bytes: artifact.bytes, runId: artifact.runId };
  }

  trace(runId, since = 0) {
    const run = this.store.getRun(runId);
    if (!run) fail('RUN_NOT_FOUND', `找不到 run：${runId}`);
    const steps = this.store.listSteps(runId, Number(since) || 0);
    const renders = this.store.listRenders(runId);
    const reviews = this.store.listReviews(runId);
    const spend = this.store.spend(runId);
    const versions = this.store.listVersions(runId).map(version => ({
      version: version.version,
      parentVersion: version.parentVersion,
      specSha256: version.specSha256,
      durationMs: version.spec.output.durationMs,
      locked: Object.values(version.spec.tracks).flat().filter(clip => clip.locked).map(clip => clip.id),
      diff: version.diff,
      stepId: version.stepId,
      renders: renders.filter(render => render.version === version.version).map(render => ({
        renderId: render.id, preset: render.preset, atSec: render.atSec, engine: render.engine, artifactId: render.artifactId,
        rejected: Boolean(this.store.getArtifact(render.artifactId)?.rejected),
        issues: render.probe?.issues || [],
      })),
      reviews: reviews.filter(review => review.version === version.version).map(review => review.round),
    }));
    const artifacts = this.store.listArtifacts({ runId });
    const unfinished = steps.find(step => step.status === 'running' || step.status === 'unknown_submit');
    return {
      run,
      steps: steps.map(step => ({
        seq: step.seq, stepId: step.id, tool: step.tool, caller: step.caller, status: step.status, mutationId: step.mutationId,
        attempts: step.attempts, artifactIds: step.artifactIds, costMicros: step.costMicros,
        ...(step.error ? { error: { code: step.error.code, message: step.error.message } } : {}),
        startedAt: step.startedAt, finishedAt: step.finishedAt,
      })),
      versions,
      rounds: reviews,
      spend: {
        confirmedMicros: spend.confirmedMicros,
        confirmedTasks: spend.confirmedTasks,
        pendingTasks: spend.pendingTasks,
        maxTasks: run.budget.maxTasks,
        maxRounds: run.budget.maxRounds,
        ...(run.budget.maxCostMicros !== undefined ? { maxCostMicros: run.budget.maxCostMicros } : {}),
      },
      artifacts: Object.entries(artifacts.reduce((counts, artifact) => ({ ...counts, [artifact.kind]: (counts[artifact.kind] || 0) + 1 }), {}))
        .map(([kind, count]) => ({ kind, count })),
      blocker: run.blocker,
      resumeFrom: unfinished ? { seq: unfinished.seq, stepId: unfinished.id, tool: unfinished.tool, status: unfinished.status, mutationId: unfinished.mutationId } : null,
    };
  }

  // ---------------- handlers ----------------
  #handlers = {
    'asset.import': async function importAssets(run, args, { step }) {
      const paths = Array.isArray(args.paths) ? args.paths : [args.path];
      if (!paths.length || paths.some(path => typeof path !== 'string' || !path)) fail('INVALID_ARGUMENT', '需要 path 或 paths[]');
      const roots = (process.env.IRIS_PIPELINE_ALLOWED_ROOTS || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).map(root => resolve(root));
      const kind = args.kind || 'capture';
      const imported = [];
      for (const input of paths) {
        const absolute = resolve(input);
        if (roots.length && !roots.some(root => absolute === root || absolute.startsWith(root + sep))) {
          fail('PATH_NOT_AUTHORIZED', `${absolute} 不在授权文件夹内`, { details: { allowedRoots: roots } });
        }
        if (!existsSync(absolute)) fail('ASSET_MISSING', `文件不存在：${absolute}`);
        let media = null;
        try { media = await mediaInfo(absolute); } catch (error) { if (!(error instanceof CapabilityError)) throw error; }
        const artifact = this.store.putFile(absolute, {
          runId: run.id, stepId: step.id, kind, tags: [...new Set([...(args.tags || []), kind])], media,
          source: { type: 'import', caller: step.caller, originalName: absolute.split(/[\\/]/).at(-1) },
        });
        imported.push(publicArtifact(artifact));
      }
      return { result: { artifacts: imported }, artifactIds: imported.map(item => item.artifactId) };
    },

    'capture.ui': async function captureUi(run, args, { step, signal, userApproved }) {
      const plan = normalizeCaptureArgs(args);
      if (!userApproved) {
        fail('CONFIRMATION_REQUIRED', `capture.ui 会在本机启动无头浏览器打开 ${plan.url}；用户确认后带 confirmed: true 重试`);
      }
      const outputs = await runCapture(plan, { scratchPath: name => this.store.scratchPath(name), signal });
      const captured = [];
      for (const output of outputs) {
        let media = null;
        try { media = await mediaInfo(output.path); } catch (error) { if (!(error instanceof CapabilityError)) throw error; }
        const artifact = this.store.putFile(output.path, {
          runId: run.id, stepId: step.id, kind: 'capture', tags: [...new Set(['capture', output.kind, output.label, ...(args.tags || [])])], media,
          source: { type: 'capture.ui', caller: step.caller, url: plan.url, mode: plan.mode, label: output.label },
        });
        captured.push({ ...publicArtifact(artifact), label: output.label, captureKind: output.kind });
      }
      return { result: { url: plan.url, mode: plan.mode, artifacts: captured }, artifactIds: captured.map(item => item.artifactId) };
    },

    'audio.tts': async function tts(run, args, { step, signal }) {
      const lines = args.lines;
      if (!Array.isArray(lines) || !lines.length) fail('INVALID_ARGUMENT', 'lines 不能为空');
      const ids = new Set();
      for (const line of lines) {
        requireString(line?.id, 'lines[].id');
        if (ids.has(line.id)) fail('INVALID_ARGUMENT', `行 id 重复：${line.id}`);
        ids.add(line.id);
        requireString(line.speechText, `lines[${line.id}].speechText（送 TTS 的口播稿）`);
        requireString(line.displayText, `lines[${line.id}].displayText（字幕显示稿）`);
      }
      const voice = { route: 'fake', speed: 1, pitch: 0, ...(args.voice || {}) };
      if (!ttsRoutes().includes(voice.route)) fail('INVALID_ARGUMENT', `voice.route 只支持 ${ttsRoutes().join(' / ')}`);
      requireString(voice.voiceId, 'voice.voiceId');
      const variant = args.variant || 'A';
      const out = [];
      let costMicros = 0;
      for (const line of lines) {
        const dir = dirname(this.store.scratchPath('voice'));
        const synth = await synthesizeLine({ speechText: line.speechText, voice, outDir: dir, signal });
        const media = await mediaInfo(synth.path);
        costMicros += synth.costMicros;
        const params = {
          lineId: line.id, speechText: line.speechText, displayText: line.displayText,
          route: voice.route, voiceId: voice.voiceId, speed: voice.speed, pitch: voice.pitch, model: voice.model || null, emotion: voice.emotion || null, variant,
        };
        const artifact = this.store.putFile(synth.path, {
          runId: run.id, stepId: step.id, kind: 'voice', move: true, media,
          tags: ['voice', `line:${line.id}`, `variant:${variant}`],
          source: { route: voice.route, providerRequestId: synth.providerRequestId },
          params,
        });
        out.push({ lineId: line.id, artifactId: artifact.id, durationMs: media.durationMs, sha256: artifact.sha256 });
      }
      return {
        result: { variant, voice: { route: voice.route, voiceId: voice.voiceId, speed: voice.speed, pitch: voice.pitch }, lines: out, totalMs: out.reduce((sum, line) => sum + line.durationMs, 0), costMicros },
        artifactIds: out.map(line => line.artifactId),
        costMicros,
      };
    },

    'audio.transcribe': async function transcribe(run, args, { step, signal }) {
      const source = this.store.requireArtifact(requireString(args.artifactId, 'artifactId'));
      const engine = args.engine || 'whisperx';
      const outDir = dirname(this.store.scratchPath('transcribe'));
      const { words, source: evidenceSource, engineVersion } = await transcribeFile({
        path: source.path, engine, language: args.language, outDir, signal,
        speechText: source.params?.speechText, durationMs: source.media?.durationMs,
      });
      if (!words.length) fail('EMPTY_TRANSCRIPT', '转写没有得到任何词');
      const evidence = toHypitTranscript(words, { language: args.language, source: evidenceSource });
      const lineTag = source.tags.find(tag => tag.startsWith('line:'));
      const artifact = this.store.putText(JSON.stringify(evidence, null, 2), 'transcript.json', {
        runId: run.id, stepId: step.id, kind: 'evidence',
        tags: ['evidence', ...(lineTag ? [lineTag] : [])],
        media: { durationMs: source.media?.durationMs ?? null },
        params: { sourceArtifactId: source.id, sourceSha256: source.sha256, engine, engineVersion, language: args.language || null },
      });
      return {
        result: { evidenceArtifactId: artifact.id, format: evidence.format, words: words.length, source: evidenceSource, durationMs: source.media?.durationMs ?? null },
        artifactIds: [artifact.id],
      };
    },

    'timeline.align': async function align(run, args, { step }) {
      const lines = args.lines;
      if (!Array.isArray(lines) || !lines.length) fail('INVALID_ARGUMENT', 'lines 不能为空');
      let segments;
      if (Array.isArray(args.segments)) {
        segments = args.segments.map(segment => this._segment(segment.evidenceArtifactId, segment.lineId, segment.offsetMs || 0));
      } else if (Array.isArray(args.evidenceArtifactIds)) {
        if (args.evidenceArtifactIds.length !== lines.length) fail('INVALID_ARGUMENT', 'evidenceArtifactIds 需要与 lines 一一对应');
        // 每行一段干声：按顺序铺到时间线上，行间留 gapMs。
        let cursor = args.startMs || 0;
        segments = lines.map((line, index) => {
          const segment = this._segment(args.evidenceArtifactIds[index], line.id, cursor);
          cursor += (segment.durationMs ?? 0) + (args.gapMs ?? 250);
          return segment;
        });
      } else fail('INVALID_ARGUMENT', '需要 evidenceArtifactIds[] 或 segments[]');
      const aligned = alignLines(lines, segments);
      const last = aligned.lines.at(-1);
      const result = { ...aligned, totalMs: last ? last.voiceEndMs : 0 };
      const artifact = this.store.putText(JSON.stringify(result, null, 2), 'alignment.json', { runId: run.id, stepId: step.id, kind: 'alignment', tags: ['alignment'] });
      return { result: { ...result, alignmentArtifactId: artifact.id }, artifactIds: [artifact.id] };
    },

    'composition.patch': async function patch(run, args, { step }) {
      if (!Number.isInteger(args.baseVersion) || args.baseVersion < 0) fail('INVALID_ARGUMENT', 'baseVersion 必须是非负整数（第一版用 0）');
      if (args.baseVersion !== run.headVersion) {
        fail('VERSION_CONFLICT', `baseVersion ${args.baseVersion} 不是最新版本 v${run.headVersion}；先 pipeline.run.get 重读`, { details: { headVersion: run.headVersion } });
      }
      const base = args.baseVersion === 0 ? emptySpec(run.brief.output) : this.store.getVersion(run.id, args.baseVersion).spec;
      let scope = null;
      let round = null;
      if (args.reviewRoundId) {
        round = this.store.listReviews(run.id).find(item => item.id === args.reviewRoundId || item.round === args.reviewRoundId);
        if (!round) fail('INVALID_ARGUMENT', `找不到评审轮：${args.reviewRoundId}`);
        if (round.version !== args.baseVersion || round.verdict !== 'revise') fail('INVALID_ARGUMENT', '只能按“针对 baseVersion 且结论为 revise”的评审轮修补');
        if (!args.allowOutOfScope) scope = clipsForFindings(base, round.findings);
      }
      for (const op of args.ops || []) {
        const artifactId = op?.clip?.artifactId || op?.set?.artifactId;
        if (artifactId) {
          const artifact = this.store.getArtifact(artifactId);
          if (!artifact || (artifact.runId && artifact.runId !== run.id)) fail('ARTIFACT_NOT_FOUND', `spec 引用了不属于本 run 的 artifact：${artifactId}`);
        }
      }
      let applied;
      try {
        applied = applyPatch(base, args.ops, { scope, lockAfter: args.locks || [] });
      } catch (error) {
        if (error instanceof SpecError) fail(error.code, error.message, { details: error.details });
        throw error;
      }
      const violations = lockedClipsUnchanged(base, applied.spec).filter(id => !(id in applied.diff.unlocked));
      if (violations.length) fail('CLIP_LOCKED', `锁定片段被改动：${violations.join(', ')}`);
      const version = run.headVersion + 1;
      const saved = this.store.insertVersion({ runId: run.id, version, parentVersion: args.baseVersion || null, spec: applied.spec, diff: { ...applied.diff, reviewRound: round?.round ?? null, note: args.note || null }, stepId: step.id });
      const specArtifact = this.store.putText(JSON.stringify(applied.spec, null, 2), `spec-v${version}.json`, { runId: run.id, stepId: step.id, version, kind: 'spec', tags: ['spec', `v${version}`] });
      this.store.updateRun(run.id, { headVersion: version, ...(run.status === 'passed' ? { status: 'active' } : {}) });
      if (round) this.store.markReviewFixed(run.id, round.version, version);
      return {
        result: {
          version, parentVersion: args.baseVersion || null, specSha256: saved.specSha256, specArtifactId: specArtifact.id,
          durationMs: applied.spec.output.durationMs, diff: applied.diff, scope: scope ? [...scope] : null,
        },
        artifactIds: [specArtifact.id],
      };
    },

    'composition.render': async function render(run, args, { step, signal }) {
      const version = args.version ?? run.headVersion;
      const saved = this.store.getVersion(run.id, version);
      if (!saved) fail('VERSION_NOT_FOUND', `没有 v${version}；先 composition.patch`);
      const preset = args.preset || 'draft';
      if (!RENDER_PRESETS[preset]) fail('INVALID_ARGUMENT', `preset 只支持 ${Object.keys(RENDER_PRESETS).join(' / ')}`);
      if (preset === 'still' && !Number.isFinite(args.atSec)) fail('INVALID_ARGUMENT', 'still 需要 atSec');
      if (preset === 'final' && !args.force) {
        const latest = this.store.listReviews(run.id).filter(review => review.version === version).at(-1);
        if (latest?.verdict !== 'pass') fail('REVIEW_REQUIRED', `v${version} 还没有评审通过，不能出成片`);
      }
      const errors = validateSpec(saved.spec);
      if (errors.length) fail('INVALID_SPEC', errors.join('; '));
      if (preset !== 'still' && !(saved.spec.output.durationMs > 0)) fail('INVALID_SPEC', 'spec 时长为 0');
      const engine = args.engine || 'ffmpeg';
      const existing = this.store.listRenders(run.id).find(item => item.version === version && item.preset === preset && item.engine === engine
        && (preset !== 'still' || item.atSec === args.atSec));
      if (existing && existsSync(this.store.getArtifact(existing.artifactId)?.path || '')) {
        // (version, preset, atSec) 是渲染的天然幂等键：同一版不重复渲染。
        return { result: { ...renderResult(existing, this.store.getArtifact(existing.artifactId)), reused: true }, artifactIds: [existing.artifactId] };
      }
      const outPath = this.store.scratchPath(preset === 'still' ? `v${version}-${args.atSec}s.png` : `v${version}-${preset}.mp4`);
      const resolveArtifact = id => this.store.requireArtifact(id);
      const options = { runId: run.id, preset, atSec: args.atSec, outPath, resolveArtifact, scratchPath: name => this.store.scratchPath(name), signal };
      const meta = engine === 'remotion' ? await renderWithRemotion(saved.spec, options) : await renderWithFfmpeg(saved.spec, options);
      let probe = null;
      let media = null;
      if (preset !== 'still') {
        probe = await probeMedia(outPath);
        probe.issues = autoIssues(saved.spec, probe);
        media = { ...probe };
      } else media = await mediaInfo(outPath);
      const artifact = this.store.putFile(outPath, {
        runId: run.id, stepId: step.id, version, kind: preset === 'still' ? 'still' : 'render', move: true, media,
        tags: [preset, `v${version}`], source: { engine: meta.engine }, params: { preset, atSec: args.atSec ?? null, specSha256: saved.specSha256 },
      });
      const renderId = this.store.insertRender({ runId: run.id, version, preset, atSec: args.atSec, engine: meta.engine, artifactId: artifact.id, probe, stepId: step.id });
      const record = this.store.listRenders(run.id).find(item => item.id === renderId);
      return { result: renderResult(record, artifact), artifactIds: [artifact.id] };
    },

    'media.probe': async function probe(run, args) {
      const artifact = this.store.requireArtifact(requireString(args.artifactId, 'artifactId'));
      const result = await probeMedia(artifact.path);
      const spec = artifact.version ? this.store.getVersion(artifact.runId, artifact.version)?.spec : null;
      const issues = spec ? autoIssues(spec, result) : [];
      this.store.updateArtifactMedia(artifact.id, { ...(artifact.media || {}), ...result, issues });
      return { result: { artifactId: artifact.id, ...result, issues }, artifactIds: [] };
    },

    'media.frames': async function frames(run, args, { step }) {
      const target = this._renderTarget(run, args.artifactId, args.version);
      const times = args.times;
      if (!Array.isArray(times) || !times.length || times.some(time => !Number.isFinite(time))) fail('INVALID_ARGUMENT', 'times 必须是秒数数组');
      if (times.length > 6) fail('INVALID_ARGUMENT', '单次最多 6 帧');
      const compare = args.compareWith ? this._renderTarget(run, args.compareWith.artifactId, args.compareWith.version) : null;
      const out = [];
      const artifactIds = [];
      for (const atSec of times) {
        const framePath = await extractFrame(target.path, atSec, this.store.scratchPath(`frame-${atSec}.jpg`), { zoom: args.zoom });
        const frame = this.store.putFile(framePath, { runId: run.id, stepId: step.id, version: target.version, kind: 'frame', move: true, tags: ['frame', `v${target.version}`, `t:${atSec}`], params: { sourceArtifactId: target.id, atSec, zoom: args.zoom || null } });
        artifactIds.push(frame.id);
        const item = { atSec, artifactId: frame.id, path: frame.path, version: target.version };
        if (compare) {
          const otherPath = await extractFrame(compare.path, atSec, this.store.scratchPath(`frame-cmp-${atSec}.jpg`), { zoom: args.zoom });
          const pairPath = await sideBySide(frame.path, otherPath, this.store.scratchPath(`compare-${atSec}.jpg`));
          const pair = this.store.putFile(pairPath, { runId: run.id, stepId: step.id, version: target.version, kind: 'frame-compare', move: true, tags: ['frame-compare', `v${target.version}`, `vs:v${compare.version}`, `t:${atSec}`], params: { left: target.id, right: compare.id, atSec } });
          artifactIds.push(pair.id);
          Object.assign(item, { compareArtifactId: pair.id, comparePath: pair.path, compareVersion: compare.version, layout: `左 v${target.version} | 右 v${compare.version}` });
        }
        out.push(item);
      }
      return { result: { sourceArtifactId: target.id, version: target.version, frames: out }, artifactIds };
    },

    'review.submit': async function review(run, args, { step, caller }) {
      const version = args.version ?? run.headVersion;
      const saved = this.store.getVersion(run.id, version);
      if (!saved) fail('VERSION_NOT_FOUND', `没有 v${version}`);
      const verdict = args.verdict;
      if (!REVIEW_VERDICTS.includes(verdict)) fail('INVALID_ARGUMENT', `verdict 只能是 ${REVIEW_VERDICTS.join(' / ')}`);
      const reviewer = args.reviewer === 'user' || caller === 'user' ? 'user' : 'agent';
      const findings = args.findings || [];
      const errors = validateFindings(findings, { verdict, durationMs: saved.spec.output.durationMs });
      if (errors.length) fail('INVALID_FINDINGS', errors.join('; '), { details: { errors } });
      if (reviewer === 'agent') {
        // Agent 评审必须看过这一版的真实渲染帧（可审计：trace 里要有对应的 media.frames Step）。
        const renders = this.store.listRenders(run.id).filter(item => item.version === version && item.preset !== 'still').map(item => item.artifactId);
        const looked = this.store.listSteps(run.id).some(item => item.tool === 'media.frames' && item.status === 'succeeded' && renders.includes(item.result?.sourceArtifactId));
        if (!looked) fail('FRAMES_REQUIRED', `Agent 评审 v${version} 前必须先对它的渲染调用 media.frames 看真实帧`);
      }
      const previous = this.store.listReviews(run.id).at(-1);
      const saved_round = this.store.insertReview({ runId: run.id, version, reviewer, caller, verdict, findings, stepId: step.id });
      const rounds = this.store.listReviews(run.id);
      let status = run.status;
      let blocker = run.blocker;
      if (verdict === 'pass') {
        status = 'passed';
        blocker = null;
      } else if (verdict === 'block') {
        status = 'blocked';
        blocker = { code: 'REVIEW_BLOCK', round: saved_round.round, message: findings.map(item => item.issue).join('；') || '评审要求停下等待用户' };
      } else {
        const renderIds = this.store.listRenders(run.id).filter(item => item.version === version).map(item => item.artifactId);
        this.store.rejectArtifacts(renderIds, `review round ${saved_round.round}: ${findings.map(item => item.issue).join('; ')}`.slice(0, 500));
        if (reviewer === 'user' && run.status === 'blocked') { status = 'active'; blocker = null; }
        else if (previous && previous.verdict === 'revise' && previous.version < version && findingsSignature(previous.findings) === findingsSignature(findings)) {
          status = 'blocked';
          blocker = { code: 'REPEATED_FINDINGS', round: saved_round.round, message: '连续两轮评审发现相同问题，修补没有生效；停下等待用户' };
        } else if (reviewer === 'agent' && rounds.length >= run.budget.maxRounds) {
          status = 'blocked';
          blocker = { code: 'MAX_ROUNDS', round: saved_round.round, message: `已达到最大评审轮数 ${run.budget.maxRounds}；停下等待用户` };
        } else if (status === 'passed') status = 'active';
      }
      this.store.updateRun(run.id, { status, blocker });
      return {
        result: {
          roundId: saved_round.id, round: saved_round.round, version, reviewer, verdict, runStatus: status, blocker,
          scopeClipIds: verdict === 'revise' ? [...clipsForFindings(saved.spec, findings)] : [],
        },
        artifactIds: [],
      };
    },

    'run.archive': async function archive(run, args, { step, userApproved }) {
      const outputDir = requireString(args.outputDir, 'outputDir');
      if (!isAbsolute(outputDir)) fail('INVALID_ARGUMENT', 'outputDir 必须是绝对路径');
      if (!userApproved) {
        return Promise.reject(new PipelineError('CONFIRMATION_REQUIRED', `归档会写入 ${outputDir}；用户确认后带 confirmed: true 重试`));
      }
      const include = new Set(args.include || ['final', 'spec', 'stems', 'rejected', 'reviews']);
      const root = join(outputDir, `${safeName(run.title)}-${run.id.slice(4, 12)}`);
      mkdirSync(root, { recursive: true });
      const files = [];
      const place = (artifact, folder, name) => {
        const target = join(root, folder, name || `${artifact.id}${artifact.path.match(/\.[^.\\/]+$/)?.[0] || ''}`);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(artifact.path, target);
        files.push({ path: relative(root, target).split(sep).join('/'), sha256: sha256File(target), artifactId: artifact.id, kind: artifact.kind });
      };
      const renders = this.store.listRenders(run.id);
      const reviews = this.store.listReviews(run.id);
      if (include.has('final')) {
        const passed = reviews.filter(review => review.verdict === 'pass').map(review => review.version);
        const pick = renders.filter(item => item.preset === 'final').at(-1)
          || renders.filter(item => item.preset === 'draft' && passed.includes(item.version)).at(-1)
          || renders.filter(item => item.preset !== 'still').at(-1);
        if (!pick) fail('NOTHING_TO_ARCHIVE', 'run 还没有任何渲染');
        place(this.store.getArtifact(pick.artifactId), 'final', `v${pick.version}-${pick.preset}.mp4`);
      }
      if (include.has('spec')) {
        for (const version of this.store.listVersions(run.id)) {
          const target = join(root, 'spec', `v${version.version}.json`);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, JSON.stringify(version.spec, null, 2));
          files.push({ path: `spec/v${version.version}.json`, sha256: sha256File(target), kind: 'spec' });
        }
      }
      if (include.has('stems')) {
        for (const artifact of this.store.listArtifacts({ runId: run.id }).filter(item => ['voice', 'music', 'sfx'].includes(item.kind) || item.tags.includes('music') || item.tags.includes('sfx'))) {
          const role = artifact.kind === 'voice' ? 'voice' : artifact.tags.includes('music') ? 'music' : 'sfx';
          const line = artifact.tags.find(tag => tag.startsWith('line:'))?.slice(5);
          const variant = artifact.tags.find(tag => tag.startsWith('variant:'))?.slice(8);
          place(artifact, `stems/${role}`, line ? `${line}-${variant || 'A'}-${artifact.id.slice(4, 16)}${artifact.path.match(/\.[^.\\/]+$/)?.[0]}` : undefined);
        }
      }
      if (include.has('rejected')) {
        for (const artifact of this.store.listArtifacts({ runId: run.id }).filter(item => item.rejected)) place(artifact, 'rejected');
      }
      if (include.has('reviews')) {
        const markdown = [`# ${run.title} · 评审记录`, '', ...reviews.flatMap(review => [
          `## 第 ${review.round} 轮 · v${review.version} · ${review.reviewer}（${review.caller}）· ${review.verdict}${review.fixedByVersion ? ` → 由 v${review.fixedByVersion} 修补` : ''}`,
          ...review.findings.map(finding => `- [${finding.severity}] ${Number.isFinite(finding.atSec) ? `${finding.atSec}s` : finding.range ? `${finding.range[0]}–${finding.range[1]}s` : finding.clipId} · ${finding.layer}：${finding.issue}${finding.fix ? `（修法：${finding.fix}）` : ''}`),
          '',
        ])].join('\n');
        const target = join(root, 'reviews.md');
        writeFileSync(target, markdown);
        files.push({ path: 'reviews.md', sha256: sha256File(target), kind: 'reviews' });
      }
      const manifest = { format: 'flovart.pipeline-archive@1', runId: run.id, title: run.title, brief: run.brief, headVersion: run.headVersion, createdAt: new Date().toISOString(), files };
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const artifact = this.store.putText(JSON.stringify(manifest, null, 2), 'manifest.json', { runId: run.id, stepId: step.id, kind: 'archive', tags: ['archive'] });
      this.store.updateRun(run.id, { status: 'archived', blocker: null });
      return { result: { directory: root, manifestArtifactId: artifact.id, files: files.length }, artifactIds: [artifact.id] };
    },
  };

  _segment(evidenceArtifactId, lineId, offsetMs) {
    const evidence = this.store.requireArtifact(requireString(evidenceArtifactId, 'evidenceArtifactId'));
    if (evidence.kind !== 'evidence') fail('INVALID_ARGUMENT', `${evidenceArtifactId} 不是转写证据`);
    return { lineId, offsetMs, durationMs: evidence.media?.durationMs ?? null, words: readEvidenceWords(evidence.path) };
  }

  _renderTarget(run, artifactId, version) {
    if (artifactId) {
      const artifact = this.store.requireArtifact(artifactId);
      return { ...artifact, version: artifact.version };
    }
    if (!Number.isInteger(version)) fail('INVALID_ARGUMENT', '需要 artifactId 或 version');
    const render = this.store.listRenders(run.id).filter(item => item.version === version && item.preset !== 'still').at(-1);
    if (!render) fail('RENDER_NOT_FOUND', `v${version} 还没有渲染`);
    return { ...this.store.requireArtifact(render.artifactId), version };
  }
}

function autoIssues(spec, probe) {
  const issues = [];
  for (const interval of probe.blackIntervals || []) {
    if (interval.endSec - interval.startSec >= 0.2) issues.push({ code: 'BLACK_FRAMES', range: [interval.startSec, interval.endSec], layer: 'visual', message: `${interval.startSec}–${interval.endSec}s 黑帧` });
  }
  for (const clip of spec.tracks.audio.filter(item => item.role === 'voice')) {
    const start = clip.startMs / 1000;
    const end = (clip.startMs + (clip.durationMs ?? 0)) / 1000;
    for (const interval of probe.silenceIntervals || []) {
      const overlap = Math.min(end, interval.endSec) - Math.max(start, interval.startSec);
      if (clip.durationMs && overlap > 0.6) issues.push({ code: 'VOICE_DROPOUT', clipId: clip.id, range: [interval.startSec, interval.endSec], layer: 'audio', message: `人声片段 ${clip.id} 内有 ${overlap.toFixed(2)}s 静音` });
    }
  }
  if (Number.isFinite(probe.durationMs) && Math.abs(probe.durationMs - spec.output.durationMs) > 200) {
    issues.push({ code: 'DURATION_MISMATCH', layer: 'composition', message: `渲染时长 ${probe.durationMs}ms 与 spec ${spec.output.durationMs}ms 不一致` });
  }
  return issues;
}

function renderResult(record, artifact) {
  return {
    renderId: record.id, version: record.version, preset: record.preset, atSec: record.atSec, engine: record.engine,
    artifactId: artifact.id, sha256: artifact.sha256, path: artifact.path, bytes: artifact.bytes,
    ...(record.probe ? { durationMs: record.probe.durationMs, issues: record.probe.issues || [] } : {}),
  };
}

function publicArtifact(artifact) {
  return {
    artifactId: artifact.id, kind: artifact.kind, sha256: artifact.sha256, path: artifact.path, bytes: artifact.bytes,
    tags: artifact.tags, media: artifact.media, version: artifact.version, rejected: artifact.rejected,
    ...(artifact.deduplicated ? { deduplicated: true } : {}),
  };
}

function stepReceipt(step, extra = {}) {
  return { stepId: step.id, seq: step.seq, tool: step.tool, caller: step.caller, status: step.status, attempts: step.attempts, ...extra };
}

function safeName(text) {
  return String(text || 'run').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
}

// 进程内按 home 复用一个 Pipeline（CLI 每次调用一个进程；Agent 会话常驻）。
const instances = new Map();
function approvalDigest(command, args) {
  return sha256Text(canonicalJson({ command, args }));
}

export function getPipeline(home) {
  const key = home || '';
  if (!instances.has(key)) instances.set(key, new Pipeline({ home }));
  return instances.get(key);
}

export function executePipelineCommand(command, args, context = {}) {
  return getPipeline(context.home).execute(command, args, context);
}
