// 会话预算 + 暂停 + dry-run 计划卡（P1）。
// 预算是「硬上限」而不是「免确认」：浏览器里的人工确认门保持不变，预算只决定会话还能发起多少次付费生成；
// 暂停后新的付费命令一律拒绝，已在跑的任务不受影响（取消用 task.cancel）。
import { AGENT_SESSION_CONTROL_COMMANDS } from '../tools/iris/agent-surface.js';

export const PAID_COMMANDS = new Set(['workflow.node.run', 'workflow.generate', 'workflow.shortcut.apply', 'workflow.group.run', 'production.run', 'generate.image', 'generate.video']);
// 命令名单定义在 agent-surface（CLI 与 Agent 共用），这里只转成 Set。
export const SESSION_CONTROL_COMMANDS = new Set(AGENT_SESSION_CONTROL_COMMANDS);
export const MAX_BUDGET_RUNS = 200;
export const DEFAULT_BUDGET_TTL_MS = 7_200_000; // 2 小时
export const MAX_BUDGET_TTL_MS = 86_400_000; // 24 小时

// 结果里出现这些错误码时，请求可能已经发到供应商：预留不释放，按已用计（宁可少放一单也不多花）。
export const UNCERTAIN_SUBMIT_CODES = new Set(['COMMAND_TIMEOUT', 'UNKNOWN_SUBMIT', 'SUBMIT_UNKNOWN', 'PROVIDER_SUBMIT_UNKNOWN', 'TASK_SUBMIT_UNKNOWN']);

// 抛出这些错误码时请求还没离开 Agent（租约 / 写入者 / 项目校验失败），可以安全退回预留。
export const PRE_SUBMIT_ERROR_CODES = new Set(['AGENT_WRITER_INACTIVE', 'AGENT_HOST_REQUIRED', 'AGENT_HOST_SESSION_MISMATCH', 'AGENT_PROJECT_INACTIVE', 'LEASE_EXPIRED', 'LEASE_TARGET_CHANGED', 'REVISION_CONFLICT', 'WORKSPACE_UNAVAILABLE', 'INVALID_ARGUMENT', 'UNKNOWN_COMMAND']);

const control = (code, message, details = {}) => ({ ok: false, error: { code, message, retryable: false, ...details } });

function listArg(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item);
  if (typeof value === 'string' && value) return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

// 一次命令会消耗几次付费生成：批量 nodeIds 按个数计，count / batchSize 取较大者。
export function paidUnits(command, args = {}) {
  if (!PAID_COMMANDS.has(command)) return 0;
  // workflow.generate 只写 Prompt Bar 时不花钱；run=true 才计一次（乘 count）。
  if ((command === 'workflow.generate' || command === 'workflow.shortcut.apply') && args.run !== true && args.run !== 'true') return 0;
  // 快捷工具永远一个节点、count=1。
  if (command === 'workflow.shortcut.apply') return 1;
  // 整组执行：成员数在浏览器里才知道，这里按调用方给的 count（缺省 1）计，浏览器端仍逐组确认。
  if (command === 'workflow.group.run') return args.dryRun === true ? 0 : Math.max(1, Math.floor(Number(args.count || 1)) || 1);
  const nodes = listArg(args.nodeIds).length || 1;
  const count = Math.max(1, Math.floor(Number(args.count || args.batchSize || 1)) || 1);
  return Math.imul(nodes, count);
}

export class SessionBudget {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.grantState = null;
    this.paused = false;
    this.pauseReason = '';
  }

  grant({ maxRuns, ttlMs, grantedBy } = {}) {
    const runs = Math.floor(Number(maxRuns));
    if (!Number.isFinite(runs) || runs < 1 || runs > MAX_BUDGET_RUNS) {
      throw new RangeError('maxRuns 必须是 1 到 ' + MAX_BUDGET_RUNS + ' 的整数。');
    }
    const ttl = ttlMs === undefined ? DEFAULT_BUDGET_TTL_MS : Math.floor(Number(ttlMs));
    if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > MAX_BUDGET_TTL_MS) {
      throw new RangeError('ttlMs 必须在 60000 到 ' + MAX_BUDGET_TTL_MS + ' 之间。');
    }
    // reserved：已原子预留、请求还没出结果的次数；keys：本授权内已预留 / 已计费的幂等键，同一键重试不重复扣。
    this.grantState = { maxRuns: runs, used: 0, reserved: 0, uncertain: 0, keys: new Map(), expiresAt: this.now() + ttl, grantedBy: String(grantedBy || 'unknown').slice(0, 80) };
    return this.snapshot();
  }

  revoke() {
    this.grantState = null;
    return this.snapshot();
  }

  pause(reason) {
    this.paused = true;
    this.pauseReason = typeof reason === 'string' ? reason.slice(0, 200) : '';
    return this.snapshot();
  }

  resume() {
    this.paused = false;
    this.pauseReason = '';
    return this.snapshot();
  }

  // 返回 null 表示放行；否则返回可直接回给调用方的失败结果。只读，不占额度（计划卡用）；真正执行用 reserve。
  check(command, args = {}) {
    const units = paidUnits(command, args);
    if (!units) return null;
    return this.blockedFor(units);
  }

  blockedFor(units) {
    if (this.paused) return control('SESSION_PAUSED', '会话已暂停，付费生成被拦截。请先 session.resume。', { pauseReason: this.pauseReason });
    if (!this.grantState) return null; // 未授权预算：保持原行为（每次在浏览器里确认）
    if (this.now() > this.grantState.expiresAt) return control('BUDGET_EXPIRED', '会话预算已过期，请重新授权。', { budget: this.snapshot().budget });
    const remaining = this.grantState.maxRuns - this.grantState.used - this.grantState.reserved;
    if (units > remaining) {
      return control('BUDGET_EXCEEDED', '本次需要 ' + units + ' 次付费生成，会话预算只剩 ' + remaining + ' 次。', { requiredRuns: units, budget: this.snapshot().budget });
    }
    return null;
  }

  /**
   * 在发出付费请求之前原子预留额度（check 与扣减在同一个同步步骤里，并发请求不会看到同一份剩余）。
   * 返回 { blocked } 或 { reservation }；reservation 为 null 表示不需要预留（非付费命令 / 未授权预算）。
   * 同一 idempotencyKey 在本授权内只扣一次：重试拿到 { reservation: null, duplicate: true }。
   * 键还在途（预留未结算）时额外带 inFlight = 那条预留：调用方必须合并到它的结果上（single-flight），
   * 不能再发一次——否则重试不占额度却又提交了一次，供应商侧会超支。合并只在这里判定，是唯一的规则来源。
   */
  reserve(command, args = {}, { key } = {}) {
    const units = paidUnits(command, args);
    if (!units) return { reservation: null };
    const grant = this.grantState;
    const dedupeKey = typeof key === 'string' && key ? key.slice(0, 200) : '';
    if (grant && dedupeKey && grant.keys.has(dedupeKey) && !this.paused && this.now() <= grant.expiresAt) {
      const state = grant.keys.get(dedupeKey);
      return state === 'used' ? { reservation: null, duplicate: true } : { reservation: null, duplicate: true, inFlight: state };
    }
    const blocked = this.blockedFor(units);
    if (blocked) return { blocked };
    if (!grant) return { reservation: null };
    grant.reserved += units;
    const reservation = { grant, units, key: dedupeKey, settled: false, pending: null };
    // 键的状态：在途时存预留本身（重试据此合并到 reservation.pending），结算后为 'used' 或删除。
    if (dedupeKey) grant.keys.set(dedupeKey, reservation);
    return { reservation };
  }

  /** 请求已被接受（或结果不确定）：预留转为已用。uncertain 只用于统计展示。 */
  commit(reservation, { uncertain = false } = {}) {
    if (!reservation || reservation.settled) return 0;
    reservation.settled = true;
    const { grant, units } = reservation;
    grant.reserved = Math.max(0, grant.reserved - units);
    grant.used = Math.min(grant.maxRuns, grant.used + units);
    if (uncertain) grant.uncertain += units;
    if (reservation.key) grant.keys.set(reservation.key, 'used');
    return units;
  }

  /** 明确没有提交（被拒、需人工确认、参数错误）：退回预留，键也释放，允许以同一键重试。 */
  release(reservation) {
    if (!reservation || reservation.settled) return 0;
    reservation.settled = true;
    const { grant, units } = reservation;
    grant.reserved = Math.max(0, grant.reserved - units);
    if (reservation.key && grant.keys.get(reservation.key) === reservation) grant.keys.delete(reservation.key);
    return units;
  }

  /** 兼容旧调用：不经预留直接计已用。 */
  consume(command, args = {}) {
    const units = paidUnits(command, args);
    if (units && this.grantState) this.grantState.used = Math.min(this.grantState.maxRuns, this.grantState.used + units);
    return units;
  }

  snapshot() {
    const grant = this.grantState;
    return {
      paused: this.paused,
      pauseReason: this.pauseReason || null,
      budget: grant ? {
        maxRuns: grant.maxRuns,
        used: grant.used,
        reserved: grant.reserved,
        uncertain: grant.uncertain,
        remaining: grant.maxRuns - grant.used - grant.reserved,
        expiresAt: grant.expiresAt,
        expired: this.now() > grant.expiresAt,
        grantedBy: grant.grantedBy,
      } : null,
    };
  }

  // session 系列控制命令在 Agent 本地处理，不进浏览器。
  handleControl(command, args = {}, caller) {
    try {
      if (command === 'session.budget.get') return { ok: true, result: this.snapshot() };
      if (command === 'session.budget.grant') {
        return { ok: true, result: this.grant({ maxRuns: args.maxRuns, ttlMs: args.ttlMs, grantedBy: caller?.agentIdentity || args.grantedBy }) };
      }
      if (command === 'session.budget.revoke') return { ok: true, result: this.revoke() };
      if (command === 'session.pause') return { ok: true, result: this.pause(args.reason) };
      if (command === 'session.resume') return { ok: true, result: this.resume() };
    } catch (error) {
      return control('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
    return control('UNKNOWN_COMMAND', '未知会话命令：' + command);
  }
}

// dry-run 计划卡：不进浏览器、不花钱，列出将要动哪些节点、消耗几次付费生成、预算会不会拦。
export function buildPlanCard(command, args = {}, { snapshot, budget } = {}) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const byId = new Map(nodes.filter(node => node && node.id).map(node => [node.id, node]));
  const describe = (nodeId, action) => {
    const node = byId.get(nodeId);
    return { nodeId, action, ...(node ? { title: node.title || '', type: node.type || '' } : { missing: true }) };
  };
  let steps = [];
  if (command === 'workflow.apply') {
    steps = (Array.isArray(args.operations) ? args.operations : []).slice(0, 50).map(op => {
      const nodeId = op?.node?.id || op?.nodeId || op?.toNodeId || '';
      return { action: String(op?.type || 'unknown'), ...(nodeId ? { nodeId } : {}), ...(op?.node?.type ? { type: op.node.type } : {}) };
    });
  } else {
    const ids = listArg(args.nodeIds);
    const single = typeof args.nodeId === 'string' && args.nodeId ? [args.nodeId] : [];
    steps = (ids.length ? ids : single).map(nodeId => describe(nodeId, command === 'workflow.node.run' ? 'run' : command));
    if (!steps.length) steps = [{ action: command }];
  }
  const units = paidUnits(command, args);
  const blocked = budget ? budget.check(command, args) : null;
  return {
    kind: 'plan-card',
    command,
    projectId: args.projectId || snapshot?.id || null,
    steps,
    paidRuns: units,
    requiresConfirmation: units > 0 || command === 'workflow.node.delete' || command === 'workflow.project.delete',
    missingNodeIds: steps.filter(step => step.missing).map(step => step.nodeId),
    budget: budget ? budget.snapshot() : null,
    wouldBlock: blocked ? blocked.error.code : null,
  };
}
