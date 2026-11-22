// 异步任务层（libtv-vs-iris-agent-tools §G：task_start / get(afterSeq) / cancel）。
// 外部 Agent 的长命令（agent.turn、生成、导出…）在本机 Agent 会话里后台执行：
// start 立即返回 taskId，get 轮询状态与增量事件，cancel 协作式取消。
//
// 持久化（任务台账）：传入 store 时，每个任务的记录（命令、规范化参数哈希、状态、提交状态、
// 关联的画布节点与供应商任务 ID、费用预估、时间戳）写入台账；页面刷新 / 本机 Agent 重启后
// 新的任务层实例从同一台账恢复，get 不再返回 NOT_FOUND。
// 生成本身的事实来源仍是画布节点（status / generationProviderTaskId / generationBillableState）与
// 用量台账：任务台账只存引用，恢复时通过 inspect 读节点状态对账，不另起一套生成状态。
//
// 不重复扣费：子命令开始前先把「提交中」写入台账；恢复后无法确认是否已提交的任务标为
// unknown_submit。同一调用方对同一命令、同一规范化参数再次 start 时，若台账里有在途或
// 提交状态未知的任务，直接返回该任务（resubmitRequiresConfirmation），不会再次提交；
// 只有调用方带 resubmit:true（内置 Agent 在用户确认后）或先取消旧任务才会重新提交。

export const AGENT_TASK_COMMANDS = Object.freeze(['agent.task.start', 'agent.task.get', 'agent.task.cancel']);
export const AGENT_TASK_COMMAND_SET = new Set(AGENT_TASK_COMMANDS);

/** 可以作为后台任务启动的命令（都是可能超过 60 秒的命令）。 */
export const TASKABLE_COMMANDS = Object.freeze([
  'agent.turn',
  'workflow.node.run',
  // 整组执行：多个视频镜头可能跑十几分钟，最需要后台化。
  'workflow.group.run',
  'workflow.generate',
  'workflow.node.tool',
  'workflow.image.tool',
  'workflow.video.tool',
  'workflow.audio.tool',
  'workflow.media.import',
  'workflow.export',
]);
const TASKABLE_COMMAND_SET = new Set(TASKABLE_COMMANDS);

/** 中断后可以安全重跑的命令（不调用付费模型）。其余命令中断后提交状态未知时一律不自动重跑。 */
const NON_BILLABLE_COMMANDS = new Set(['workflow.media.import', 'workflow.export']);

export const AGENT_TASK_TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);
const TERMINAL = new Set(AGENT_TASK_TERMINAL_STATES);
/** 恢复后无法确认子命令是否已提交给供应商（可能已扣费）。不是终态：节点状态出现后会继续对账。 */
export const AGENT_TASK_UNKNOWN_SUBMIT = 'unknown_submit';
/** 在途：同参数重复 start 不得再次提交。 */
const IN_FLIGHT = new Set(['queued', 'running', AGENT_TASK_UNKNOWN_SUBMIT]);

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_TASKS = 200;
const DEFAULT_POLL_MS = 5_000;
const MAX_EVENTS = 200;
const MAX_PERSISTED_EVENTS = 50;
const LEDGER_VERSION = 1;

export class AgentTaskError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentTaskError';
    this.code = code;
    this.details = details;
  }
}

function plainError(error) {
  if (!error) return { code: 'TASK_FAILED', message: '任务失败' };
  if (typeof error === 'string') return { code: 'TASK_FAILED', message: error };
  return {
    code: String(error.code || 'TASK_FAILED'),
    message: String(error.message || '任务失败'),
    ...(error.details && typeof error.details === 'object' ? { details: error.details } : {}),
  };
}

function nodeIdsOf(command, args = {}) {
  if (command !== 'workflow.node.run' && command !== 'workflow.generate') return [];
  const ids = [];
  if (typeof args.nodeId === 'string' && args.nodeId) ids.push(args.nodeId);
  const list = Array.isArray(args.nodeIds) ? args.nodeIds : typeof args.nodeIds === 'string' ? args.nodeIds.split(',') : [];
  for (const id of list) if (String(id).trim()) ids.push(String(id).trim());
  return [...new Set(ids)];
}

/**
 * 稳定序列化：对象键排序、跳过 undefined / 函数，NaN/Infinity 记为 null，Date 走 toJSON。
 * 同一份参数无论键顺序如何都得到同一个字符串（JSON.stringify 依赖插入顺序）。
 */
export function stableStringify(value) {
  const seen = new Set();
  const walk = input => {
    let current = input;
    if (current && typeof current === 'object' && typeof current.toJSON === 'function') current = current.toJSON();
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') return undefined;
    if (typeof current === 'bigint') return JSON.stringify(String(current));
    if (typeof current === 'number') return Number.isFinite(current) ? JSON.stringify(current) : 'null';
    if (current === null || typeof current !== 'object') return JSON.stringify(current);
    if (seen.has(current)) throw new TypeError('stableStringify: circular structure');
    seen.add(current);
    let out;
    if (Array.isArray(current)) {
      out = '[' + current.map(item => walk(item) ?? 'null').join(',') + ']';
    } else {
      const parts = [];
      for (const key of Object.keys(current).sort()) {
        const encoded = walk(current[key]);
        if (encoded !== undefined) parts.push(JSON.stringify(key) + ':' + encoded);
      }
      out = '{' + parts.join(',') + '}';
    }
    seen.delete(current);
    return out;
  };
  return walk(value) ?? 'null';
}

// cyrb53：同步、无依赖（浏览器与 Node 同一份）；两个种子拼成 106 位，足够做幂等键。
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** 规范化参数：nodeIds 的逗号字符串与数组视为同一份参数。 */
export function normalizeTaskArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const normalized = { ...args };
  if (typeof normalized.nodeIds === 'string') normalized.nodeIds = normalized.nodeIds.split(',').map(item => item.trim()).filter(Boolean);
  return normalized;
}

/** 命令 + 规范化参数的稳定哈希（与键顺序无关）。 */
export function taskArgsHash(command, args = {}) {
  const text = String(command || '') + '\u0000' + stableStringify(normalizeTaskArgs(args));
  return 'h' + cyrb53(text, 0) + cyrb53(text, 0x9e3779b9);
}

/** 内存台账：测试与没有持久化的宿主使用；同一实例可被多个任务层共享（模拟重启）。 */
export function createMemoryTaskStore() {
  const records = new Map();
  return {
    async load() { return [...records.values()].map(record => structuredClone(record)); },
    async put(record) { records.set(record.taskId, structuredClone(record)); },
    async remove(taskId) { records.delete(taskId); },
    /** 测试用：直接读写原始记录。 */
    records,
  };
}

/**
 * 按画布节点状态对账一个任务（纯函数）。nodes: [{ id, metadata: { status, generationProviderTaskId, generationBillableState } }]
 * 返回 { status, providerJobs, error?, result? }；节点信息不足时 status 为 null（保持原状态）。
 */
export function reconcileTaskFromNodes(record, nodes) {
  const ids = Array.isArray(record.nodeIds) ? record.nodeIds : [];
  if (!ids.length || !Array.isArray(nodes)) return { status: null, providerJobs: record.providerJobs || [] };
  const byId = new Map(nodes.filter(node => node && node.id).map(node => [String(node.id), node]));
  const providerJobs = [];
  const states = [];
  for (const nodeId of ids) {
    const node = byId.get(nodeId);
    const meta = node?.metadata && typeof node.metadata === 'object' ? node.metadata : {};
    const providerTaskId = typeof meta.generationProviderTaskId === 'string' && meta.generationProviderTaskId ? meta.generationProviderTaskId : undefined;
    const known = (record.providerJobs || []).find(job => job.nodeId === nodeId);
    const status = node ? String(meta.status || 'idle') : 'missing';
    // 恢复出来的任务在中断时是在途的：没成功的节点除非明确未计费 / 已退款，都按「可能已扣费」处理。
    const billingUnknown = status !== 'success' && status !== 'loading'
      && meta.generationBillableState !== 'not_billable' && meta.generationBillableState !== 'refunded';
    providerJobs.push({ nodeId, ...(providerTaskId || known?.providerTaskId ? { providerTaskId: providerTaskId || known.providerTaskId } : {}), status, ...(billingUnknown ? { billingUnknown: true } : {}) });
    if (status === 'loading') states.push(providerTaskId ? 'resuming' : 'pending');
    else if (status === 'success') states.push('done');
    else if (billingUnknown) states.push('unknown');
    else states.push('failed');
  }
  if (states.every(state => state === 'done')) {
    return { status: 'succeeded', providerJobs, result: { nodeIds: ids, recovered: true } };
  }
  if (states.includes('unknown') || (states.includes('pending') && !states.includes('resuming'))) {
    return { status: AGENT_TASK_UNKNOWN_SUBMIT, providerJobs };
  }
  if (states.includes('resuming') || states.includes('pending')) return { status: 'running', providerJobs };
  return {
    status: 'failed',
    providerJobs,
    error: { code: 'TASK_INTERRUPTED', message: '任务在刷新 / 重启时中断，部分节点没有完成。', details: { nodes: providerJobs } },
  };
}

/**
 * @param {object} options
 * @param {(command: string, args: object, source: string, idempotencyKey: string|undefined, signal: AbortSignal, caller: object|undefined, runOptions: {timeoutMs: number}) => Promise<any>} options.run
 * @param {(command: string, args: object, source: string, caller: object|undefined) => Promise<any>} [options.stop] 取消时尽力停止画布上的生成节点；也用于只读解析整组成员与费用预估
 * @param {{ load(): Promise<object[]>, put(record: object): Promise<void>, remove(taskId: string): Promise<void> }} [options.store] 任务台账
 * @param {(record: object) => Promise<object[]|null>|object[]|null} [options.inspect] 读取任务关联节点的当前状态（对账 / 恢复轮询）
 */
export function createAgentTaskLayer({
  run,
  stop,
  store,
  inspect,
  now = () => Date.now(),
  createId = () => 'atask_' + crypto.randomUUID(),
  taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  maxTasks = DEFAULT_MAX_TASKS,
  pollMs = DEFAULT_POLL_MS,
  onEvent,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createAgentTaskLayer requires run');
  const tasks = new Map();
  const byKey = new Map();
  let writeChain = Promise.resolve();
  let pollTimer = null;
  let closed = false;

  const iso = () => new Date(now()).toISOString();

  function serialize(task) {
    return {
      v: LEDGER_VERSION,
      taskId: task.taskId,
      command: task.command,
      args: task.args,
      argsHash: task.argsHash,
      dedupeKey: task.dedupeKey,
      childKey: task.childKey,
      owner: task.owner,
      status: task.status,
      submitState: task.submitState,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      seq: task.seq,
      events: task.events.slice(-MAX_PERSISTED_EVENTS),
      nodeIds: task.nodeIds,
      providerJobs: task.providerJobs,
      ...(task.costEstimate ? { costEstimate: task.costEstimate } : {}),
      ...(task.status === 'succeeded' ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.cancelRequested ? { cancelRequested: true, cancelReason: task.cancelReason } : {}),
      ...(task.recovered ? { recovered: true } : {}),
    };
  }

  function persist(task) {
    if (!store) return null;
    const record = serialize(task);
    writeChain = writeChain.then(() => store.put(record)).catch(error => {
      console.warn('[agent-task] 任务台账写入失败：' + (error?.message || error));
    });
    return writeChain;
  }

  function unpersist(taskId) {
    if (!store) return;
    writeChain = writeChain.then(() => store.remove(taskId)).catch(error => {
      console.warn('[agent-task] 任务台账清理失败：' + (error?.message || error));
    });
  }

  function push(task, type, extra = {}) {
    task.seq += 1;
    const event = { seq: task.seq, at: iso(), type, ...extra };
    task.events.push(event);
    if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    task.updatedAt = event.at;
    onEvent?.(task.taskId, event);
    return event;
  }

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [taskId, task] of tasks) {
      // 终态与长期未决的 unknown_submit 都只保留到保留期（默认 7 天）。
      const expirable = TERMINAL.has(task.status) || (task.status === AGENT_TASK_UNKNOWN_SUBMIT && !task.live);
      if (expirable && Date.parse(task.updatedAt) < cutoff) forget(taskId);
    }
    if (tasks.size < maxTasks) return;
    const finished = [...tasks.values()].filter(task => TERMINAL.has(task.status)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const task of finished) {
      if (tasks.size < maxTasks) break;
      forget(task.taskId);
    }
    if (tasks.size >= maxTasks) throw new AgentTaskError('TASK_LIMIT', '同时保留的任务已达上限 ' + maxTasks + '，请先等待或取消已有任务。');
  }

  function forget(taskId) {
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.delete(taskId);
    if (task.dedupeKey && byKey.get(task.dedupeKey) === taskId) byKey.delete(task.dedupeKey);
    unpersist(taskId);
  }

  function attentionFor(task) {
    if (task.status !== AGENT_TASK_UNKNOWN_SUBMIT) return null;
    return {
      code: 'UNKNOWN_SUBMIT',
      message: '刷新 / 重启前这个任务可能已经提交给模型服务（可能已扣费），当前无法确认结果。请让用户在画布与用量记录里核对；不要自动重跑。',
    };
  }

  function view(task, afterSeq = 0) {
    const events = task.events.filter(event => event.seq > afterSeq);
    const attention = attentionFor(task);
    return {
      taskId: task.taskId,
      command: task.command,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      seq: task.seq,
      events,
      done: TERMINAL.has(task.status),
      ...(task.status === 'succeeded' ? { result: task.result } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.cancelRequested && !TERMINAL.has(task.status) ? { cancelRequested: true } : {}),
      ...(task.nodeIds.length ? { nodeIds: task.nodeIds } : {}),
      ...(task.providerJobs.length ? { providerJobs: task.providerJobs } : {}),
      ...(task.costEstimate ? { costEstimate: task.costEstimate } : {}),
      ...(task.recovered ? { recovered: true } : {}),
      ...(attention ? { attention } : {}),
    };
  }

  function finish(task, status, payload) {
    if (TERMINAL.has(task.status)) return;
    task.status = status;
    task.finishedAt = iso();
    task.submitState = 'settled';
    if (status === 'succeeded') task.result = payload;
    else task.error = payload;
    push(task, status, status === 'succeeded' ? {} : { error: payload });
    persist(task);
    refreshPolling();
  }

  // 只读解析整组成员与费用预估：不阻塞子命令，结果写进台账（恢复时据此对账、取消时据此停止）。
  async function resolveRefs(task, { source, caller }) {
    if (!stop) return;
    const scope = task.args.projectId ? { projectId: task.args.projectId } : {};
    let estimateArgs = null;
    if (task.command === 'workflow.group.run' && task.args.groupId) estimateArgs = { groupId: task.args.groupId, ...scope };
    else if (task.nodeIds.length && (task.command === 'workflow.node.run' || task.command === 'workflow.generate')) estimateArgs = { nodeIds: task.nodeIds, ...scope };
    if (!estimateArgs) return;
    try {
      const response = await stop('workflow.cost.estimate', estimateArgs, source, caller);
      const result = response?.result;
      if (!result || response?.ok === false) return;
      if (!task.nodeIds.length && Array.isArray(result.nodeIds)) task.nodeIds = result.nodeIds.map(String);
      if (result.total && typeof result.total === 'object') task.costEstimate = result.total;
      persist(task);
      refreshPolling();
    } catch { /* 预估失败不影响任务；恢复时按未知处理 */ }
  }

  async function execute(task, { source, caller, idempotencyKey }) {
    if (TERMINAL.has(task.status)) return;
    task.status = 'running';
    task.startedAt = iso();
    task.submitState = 'submitting';
    push(task, 'started');
    // 先把「提交中」写进台账再调用子命令：重启后看到 submitting 就知道可能已经提交，不会重跑。
    const written = persist(task);
    if (written) await written;
    if (task.cancelRequested) {
      finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: task.cancelReason || '任务已取消' });
      return;
    }
    void resolveRefs(task, { source, caller });
    let response;
    try {
      response = await run(task.command, task.args, source, idempotencyKey, task.controller.signal, caller, { timeoutMs: taskTimeoutMs });
    } catch (error) {
      if (task.cancelRequested) finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: task.cancelReason || '任务已取消' });
      else finish(task, 'failed', plainError(error));
      return;
    }
    if (task.cancelRequested) {
      // 取消后才回来的结果不再当作成功交付，但记下来便于排查（生成可能已经扣费）。
      finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: task.cancelReason || '任务已取消', lateResult: true });
      return;
    }
    if (response && typeof response === 'object' && response.ok === false) {
      finish(task, 'failed', plainError(response.error));
      return;
    }
    if (response?.confirmation?.required) {
      finish(task, 'failed', { code: 'CONFIRMATION_REQUIRED', message: response.confirmation.summary || '需要用户在画布上确认后才能执行。' });
      return;
    }
    finish(task, 'succeeded', response && typeof response === 'object' && 'result' in response ? response.result : response);
  }

  function ownerOf(source, caller) {
    return caller?.agentIdentity || source || 'agent';
  }

  function validate(command, args) {
    const target = String(command || '').trim();
    if (!TASKABLE_COMMAND_SET.has(target)) {
      throw new AgentTaskError('INVALID_ARGUMENT', '不能作为后台任务启动的命令：' + (target || '(空)') + '。可用：' + TASKABLE_COMMANDS.join('、'), { taskable: TASKABLE_COMMANDS });
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new AgentTaskError('INVALID_ARGUMENT', 'args 必须是对象');
    return target;
  }

  /** 同一调用方、同一命令、同一规范化参数的在途 / 提交状态未知任务（最新的一个）。 */
  function findInflight(owner, command, argsHash) {
    let found = null;
    for (const task of tasks.values()) {
      if (task.owner !== owner || task.command !== command || task.argsHash !== argsHash || !IN_FLIGHT.has(task.status)) continue;
      if (!found || Date.parse(task.createdAt) >= Date.parse(found.createdAt)) found = task;
    }
    return found;
  }

  function inflight({ command, args = {}, source = 'agent', caller } = {}) {
    const target = validate(command, args);
    const task = findInflight(ownerOf(source, caller), target, taskArgsHash(target, args));
    return task ? duplicateView(task) : null;
  }

  function duplicateView(task) {
    // 本实例里正在跑的同参数任务：直接重放。恢复出来的在途 / 未知任务：需要用户确认才能重新提交。
    if (task.live && task.status !== AGENT_TASK_UNKNOWN_SUBMIT) return { ...view(task), replayed: true };
    return {
      ...view(task),
      replayed: true,
      resubmitRequiresConfirmation: true,
      message: '同样参数的任务（' + task.taskId + '）在刷新 / 重启前已经开始，可能已提交并扣费，没有重新提交。请先让用户核对画布；用户确认要重跑时，先 iris_task_cancel 这个任务再重新启动。',
    };
  }

  function start({ command, args = {}, idempotencyKey, source = 'agent', caller, resubmit = false } = {}) {
    const target = validate(command, args);
    const key = String(idempotencyKey || '').trim();
    const owner = ownerOf(source, caller);
    const dedupeKey = key ? [owner, target, key].join('\u0000') : '';
    if (dedupeKey && byKey.has(dedupeKey) && tasks.has(byKey.get(dedupeKey))) {
      const existing = tasks.get(byKey.get(dedupeKey));
      return existing.live || !IN_FLIGHT.has(existing.status) ? { ...view(existing), replayed: true } : duplicateView(existing);
    }
    const argsHash = taskArgsHash(target, args);
    const duplicate = findInflight(owner, target, argsHash);
    if (duplicate && !(resubmit && !duplicate.live)) return duplicateView(duplicate);
    if (duplicate) {
      // 用户已确认重新提交：旧任务标为被取代（保留「可能已扣费」的提示）。
      finish(duplicate, 'cancelled', { code: 'TASK_SUPERSEDED', message: '用户确认后已重新提交；旧任务的提交状态未知，可能已扣费。', details: { billingUnknown: true } });
    }
    prune();
    const createdAt = iso();
    const task = {
      taskId: createId(),
      command: target,
      args: { ...args },
      argsHash,
      status: 'queued',
      submitState: 'not_submitted',
      createdAt,
      updatedAt: createdAt,
      seq: 0,
      events: [],
      nodeIds: nodeIdsOf(target, args),
      providerJobs: [],
      controller: new AbortController(),
      cancelRequested: false,
      dedupeKey,
      owner,
      live: true,
    };
    // 子命令的幂等键从任务键派生：任务重放不会重复提交生成。
    task.childKey = key ? 'task:' + key : task.taskId;
    tasks.set(task.taskId, task);
    if (dedupeKey) byKey.set(dedupeKey, task.taskId);
    push(task, 'queued');
    persist(task);
    task.promise = Promise.resolve().then(() => execute(task, { source, caller, idempotencyKey: task.childKey }));
    refreshPolling();
    return view(task);
  }

  function lookup(taskId) {
    const task = tasks.get(String(taskId || ''));
    if (!task) throw new AgentTaskError('NOT_FOUND', '任务不存在或已过期：' + String(taskId || '(空)') + '（已完成的任务保留 ' + Math.round(retentionMs / 3_600_000) + ' 小时）');
    return task;
  }

  function get({ taskId, afterSeq } = {}) {
    const task = lookup(taskId);
    const after = Number.isFinite(Number(afterSeq)) ? Math.max(0, Number(afterSeq)) : 0;
    return view(task, after);
  }

  async function stopNodes(task, { source, caller }) {
    const stopped = [];
    if (stop && task.command === 'workflow.group.run' && !task.nodeIds.length && task.args.groupId) {
      // 整组任务启动时不知道成员：取消时按组解析一次（与 group.run 同一份执行清单），再逐个停止。
      try {
        const scope = task.args.projectId ? { projectId: task.args.projectId } : {};
        const response = await stop('workflow.cost.estimate', { groupId: task.args.groupId, ...scope }, source, caller);
        const ids = response?.result?.nodeIds;
        if (Array.isArray(ids)) task.nodeIds = ids.map(String);
      } catch { /* 解析失败时仍会 abort 等待中的请求 */ }
    }
    if (stop && task.nodeIds.length) {
      for (const nodeId of task.nodeIds) {
        try {
          // workflow.node.stop 走画布同一条停止路径：在途请求会被 abort，支持取消的供应商任务会被取消。
          const response = await stop('workflow.node.stop', { nodeId, ...(task.args.projectId ? { projectId: task.args.projectId } : {}) }, source, caller);
          if (!(response && response.ok === false)) stopped.push(nodeId);
        } catch { /* 节点可能已结束；以任务状态为准 */ }
      }
    }
    return stopped;
  }

  async function cancel({ taskId, reason, source = 'agent', caller } = {}) {
    const task = lookup(taskId);
    if (TERMINAL.has(task.status)) return { ...view(task), alreadyFinished: true };
    task.cancelRequested = true;
    task.cancelReason = typeof reason === 'string' && reason.trim() ? reason.trim() : '任务已取消';
    push(task, 'cancel_requested', { reason: task.cancelReason });
    persist(task);
    const stopped = await stopNodes(task, { source, caller });
    if (task.live) {
      task.controller.abort();
      // abort 会让等待中的会话请求立即以 CANCELLED 结束；这里不等它，直接给出当前视图。
      if (task.status === 'queued') finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: task.cancelReason });
    } else {
      // 恢复出来的任务没有在途请求可等：停止节点后直接结束；提交过的任务保留「可能已扣费」。
      const billingUnknown = task.submitState === 'submitting' || task.status === AGENT_TASK_UNKNOWN_SUBMIT;
      finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: task.cancelReason, ...(billingUnknown ? { details: { billingUnknown: true } } : {}) });
    }
    return { ...view(task), ...(stopped.length ? { stoppedNodeIds: stopped } : {}) };
  }

  function list() {
    return [...tasks.values()].map(task => ({ taskId: task.taskId, command: task.command, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt }));
  }

  /** 测试用：等待某个任务的执行 promise 结束。 */
  function settled(taskId) {
    return tasks.get(taskId)?.promise ?? Promise.resolve();
  }

  // ---- 恢复与对账 ----

  function revive(record) {
    const task = {
      taskId: String(record.taskId),
      command: String(record.command),
      args: record.args && typeof record.args === 'object' ? record.args : {},
      argsHash: record.argsHash || taskArgsHash(record.command, record.args),
      status: String(record.status || 'failed'),
      submitState: record.submitState || 'not_submitted',
      createdAt: record.createdAt || iso(),
      updatedAt: record.updatedAt || record.createdAt || iso(),
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      seq: Number(record.seq) || 0,
      events: Array.isArray(record.events) ? record.events : [],
      nodeIds: Array.isArray(record.nodeIds) ? record.nodeIds.map(String) : [],
      providerJobs: Array.isArray(record.providerJobs) ? record.providerJobs : [],
      ...(record.costEstimate ? { costEstimate: record.costEstimate } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
      cancelRequested: Boolean(record.cancelRequested),
      ...(record.cancelReason ? { cancelReason: record.cancelReason } : {}),
      dedupeKey: record.dedupeKey || '',
      childKey: record.childKey,
      owner: record.owner || 'agent',
      controller: new AbortController(),
      live: false,
      recovered: true,
    };
    return task;
  }

  // 重启后第一次看到的在途任务：queued 说明子命令还没开始（台账先写 submitting 才会调用），可以安全重跑；
  // running 可能已经提交，交给 reconcile 按节点状态判断，判断不了就是 unknown_submit。
  function settleOnLoad(task) {
    if (TERMINAL.has(task.status)) return;
    if (task.status === 'queued' || task.submitState === 'not_submitted') {
      finish(task, 'failed', { code: 'TASK_INTERRUPTED', message: '任务在开始执行前被刷新 / 重启中断，没有提交，可以重新启动。', details: { retryable: true, submitted: false } });
      return;
    }
    if (!task.nodeIds.length) {
      if (NON_BILLABLE_COMMANDS.has(task.command)) {
        finish(task, 'failed', { code: 'TASK_INTERRUPTED', message: '任务被刷新 / 重启中断（不涉及付费生成），可以重新启动。', details: { retryable: true } });
      } else {
        markUnknown(task);
      }
      return;
    }
    // 有关联节点：已知供应商任务 ID 时保持 running 并恢复轮询，否则先记为 unknown_submit，再由对账修正。
    if (task.providerJobs.some(job => job.providerTaskId)) {
      if (task.status !== 'running') task.status = 'running';
      push(task, 'recovered', { providerJobs: task.providerJobs });
      persist(task);
    } else {
      markUnknown(task);
    }
  }

  function markUnknown(task) {
    if (task.status === AGENT_TASK_UNKNOWN_SUBMIT) return;
    task.status = AGENT_TASK_UNKNOWN_SUBMIT;
    push(task, AGENT_TASK_UNKNOWN_SUBMIT, { attention: attentionFor(task) });
    persist(task);
  }

  function sameJobs(left, right) {
    return stableStringify(left || []) === stableStringify(right || []);
  }

  async function reconcileTask(task) {
    if (!inspect || TERMINAL.has(task.status) || !task.nodeIds.length) return;
    let nodes;
    try {
      nodes = await inspect(serialize(task));
    } catch {
      return;
    }
    if (!Array.isArray(nodes) || TERMINAL.has(task.status)) return;
    const outcome = reconcileTaskFromNodes(task, nodes);
    const jobsChanged = !sameJobs(task.providerJobs, outcome.providerJobs);
    task.providerJobs = outcome.providerJobs;
    if (task.live) {
      // 本实例在跑：只更新供应商任务引用，状态以子命令返回为准。
      if (jobsChanged) persist(task);
      return;
    }
    if (outcome.status === 'succeeded') return finish(task, 'succeeded', outcome.result);
    if (outcome.status === 'failed') return finish(task, task.cancelRequested ? 'cancelled' : 'failed', outcome.error);
    if (outcome.status === AGENT_TASK_UNKNOWN_SUBMIT) {
      if (task.status !== AGENT_TASK_UNKNOWN_SUBMIT) return markUnknown(task);
    } else if (outcome.status === 'running' && task.status !== 'running') {
      task.status = 'running';
      push(task, 'recovered', { providerJobs: task.providerJobs });
      return persist(task);
    }
    if (jobsChanged) persist(task);
  }

  /**
   * 按节点状态对账所有未结束任务（恢复轮询）；同时为在跑任务记下供应商任务 ID。
   * 单飞：上一轮还没结束时，新的调用复用同一个 promise，定时器不会叠出并发对账。
   */
  let reconciling = null;
  function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      await ready;
      for (const task of [...tasks.values()]) {
        if (!TERMINAL.has(task.status)) await reconcileTask(task);
      }
      refreshPolling();
      await writeChain;
    })().finally(() => { reconciling = null; });
    return reconciling;
  }

  function needsPolling() {
    if (!inspect || closed) return false;
    for (const task of tasks.values()) if (!TERMINAL.has(task.status) && task.nodeIds.length) return true;
    return false;
  }

  function refreshPolling() {
    if (needsPolling()) {
      if (pollTimer || !(pollMs > 0)) return;
      pollTimer = setInterval(() => { void reconcile(); }, pollMs);
      pollTimer?.unref?.();
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function load() {
    if (!store) return;
    let records = [];
    try {
      records = await store.load();
    } catch (error) {
      console.warn('[agent-task] 任务台账读取失败：' + (error?.message || error));
      return;
    }
    for (const record of records) {
      if (!record || typeof record !== 'object' || !record.taskId || tasks.has(String(record.taskId))) continue;
      if (!TASKABLE_COMMAND_SET.has(String(record.command))) continue;
      const task = revive(record);
      tasks.set(task.taskId, task);
      if (task.dedupeKey) byKey.set(task.dedupeKey, task.taskId);
      settleOnLoad(task);
    }
    try { prune(); } catch { /* 超限只影响新任务 */ }
    for (const task of [...tasks.values()]) if (!task.live) await reconcileTask(task);
    refreshPolling();
  }

  const ready = load();

  function close() {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    return writeChain;
  }

  /** 等台账写完（测试 / 退出前）。 */
  function flush() {
    return writeChain;
  }

  /** 会话命令入口：返回 { ok, result } / { ok:false, error }。 */
  async function handle(command, args = {}, { source = 'agent', idempotencyKey, caller } = {}) {
    try {
      await ready;
      if (command === 'agent.task.start') {
        const childArgs = args.args === undefined ? {} : typeof args.args === 'string' ? JSON.parse(args.args) : args.args;
        return { ok: true, result: start({ command: args.command, args: childArgs, idempotencyKey: idempotencyKey || args.idempotencyKey, source, caller }) };
      }
      if (command === 'agent.task.get') return { ok: true, result: get(args) };
      if (command === 'agent.task.cancel') return { ok: true, result: await cancel({ ...args, source, caller }) };
      return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: '未知任务命令：' + command } };
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'args 不是合法 JSON：' + error.message } };
      return { ok: false, error: plainError(error) };
    }
  }

  return { start, get, cancel, list, settled, handle, inflight, reconcile, ready, close, flush };
}
