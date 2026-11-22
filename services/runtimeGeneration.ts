import { getIrisRuntimeApi, type IrisRuntimeApi } from './irisRuntime';
import { loadRuntimeArtifactBlob } from './runtimeArtifacts';

export interface RuntimeMediaResult {
  blob: Blob;
  mimeType: string;
  taskId: string;
  priceQuote?: { estimatedPrice?: number; currency?: string };
}

interface RuntimeTaskView {
  status?: string;
  updatedAt?: number;
  result?: { artifact?: { mimeType?: string }; priceQuote?: { estimatedPrice?: number; currency?: string } };
  error?: unknown;
}

const GENERATION_COMMANDS = ['generate.image', 'generate.video'] as const;
type GenerationCommand = typeof GENERATION_COMMANDS[number];

const RUNTIME_POLL_TIMEOUT_MS = 600_000; // 与 aiGateway 各 provider 一致的 10 分钟硬上限
const RUNTIME_POLL_INTERVAL_MS = 2000;

async function waitForNextPoll(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, RUNTIME_POLL_INTERVAL_MS);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new DOMException('已停止等待 Runtime 任务', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await promise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Runtime 任务状态 → 显式阶段。未知状态按进行中处理，由轮询超时兜底。 */
export type RuntimeTaskPhase = 'pending' | 'succeeded' | 'failed' | 'cancelled';
export function runtimeTaskPhase(status: string | undefined): RuntimeTaskPhase {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

type RuntimePollOutcome = { kind: 'settled'; task: RuntimeTaskView } | { kind: 'timeout' };

const RUNTIME_WAIT_MS = 15_000;

/** 等待 promise 或 signal 取消，先到者为准；被放弃的长轮询在 Runtime 侧自然超时，不影响状态。 */
async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason ?? new DOMException('已停止等待 Runtime 任务', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function pollRuntimeTask(runtime: IrisRuntimeApi, taskId: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<RuntimePollOutcome> {
  const pollStart = Date.now();
  let task: RuntimeTaskView | undefined;
  for (;;) {
    // 保留 signal.reason（默认是 AbortError），下游 isAbort 才能把停止和失败区分开。
    signal?.throwIfAborted();
    const elapsed = Date.now() - pollStart;
    if (elapsed > RUNTIME_POLL_TIMEOUT_MS) return { kind: 'timeout' };
    if (task && runtime.waitTask) {
      // 桌面 Runtime：长轮询，任务一变化就返回，不再固定每 2 秒往返一次。
      const timeoutMs = Math.max(1, Math.min(RUNTIME_WAIT_MS, RUNTIME_POLL_TIMEOUT_MS - elapsed));
      task = await untilAborted(runtime.waitTask(taskId, task.updatedAt, timeoutMs), signal) as RuntimeTaskView;
    } else {
      if (task) await waitForNextPoll(signal);
      task = await runtime.execute({
        protocolVersion: '1',
        commandId: crypto.randomUUID(),
        command: 'task.get',
        args: { taskId },
        actor: { kind: 'ui', instanceId: 'workflow-generation' },
      }) as RuntimeTaskView;
    }
    if (runtimeTaskPhase(task?.status) !== 'pending') return { kind: 'settled', task };
    onProgress?.(task?.status === 'queued' ? '已提交给 Runtime，排队中…' : 'Runtime 生成中…');
  }
}

/** 让 Runtime 取消上游任务，否则它会继续跑并计费。取消失败不能掩盖原始错误。 */
async function cancelRuntimeTask(runtime: IrisRuntimeApi, taskId: string, reason: 'user_abort' | 'poll_timeout'): Promise<void> {
  await runtime.execute({
    protocolVersion: '1',
    commandId: crypto.randomUUID(),
    command: 'task.cancel',
    // Runtime 端 task.cancel 强制要求 idempotencyKey；同一任务重复停止只产生一次取消请求。
    idempotencyKey: 'cancel:' + taskId,
    args: { taskId, reason },
    actor: { kind: 'ui', instanceId: 'workflow-generation' },
  }).catch(cancelError => console.warn('[Runtime] task.cancel failed', { taskId, reason, cancelError }));
}

/**
 * 通过 Desktop Production Runtime 执行一次媒体生成（用于 `runtimeManaged` 的
 * 「Runtime 托管」网页 Key）。明文 Key 只存在系统 Keyring，浏览器只提交
 * 非敏感参数并轮询任务，最终经受控 IPC 读回产物 Blob。
 */
export async function runRuntimeMediaGeneration(params: {
  command: GenerationCommand;
  args: Record<string, unknown>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<RuntimeMediaResult> {
  const runtime = getIrisRuntimeApi();
  if (!runtime) throw new Error('Runtime 媒体生成需要桌面应用');
  const idempotencyKey = crypto.randomUUID();
  const submitted = await runtime.execute({
    protocolVersion: '1',
    commandId: idempotencyKey,
    command: params.command,
    args: { ...params.args, idempotencyKey },
    actor: { kind: 'ui', instanceId: 'workflow-generation' },
  }) as { taskId?: string; error?: unknown };
  const taskId = submitted?.taskId;
  if (!taskId) {
    const message = submitted?.error && typeof submitted.error === 'object' && 'message' in submitted.error
      ? String((submitted.error as { message?: unknown }).message)
      : 'Runtime 未返回任务 ID';
    throw new Error(`提交失败：${message}`);
  }
  let outcome: RuntimePollOutcome;
  try {
    outcome = await pollRuntimeTask(runtime, taskId, params.onProgress, params.signal);
  } catch (error) {
    // 用户停止：除了不再轮询，还要让 Runtime 取消上游任务。
    if (params.signal?.aborted) await cancelRuntimeTask(runtime, taskId, 'user_abort');
    throw error;
  }
  if (outcome.kind === 'timeout') {
    // 超时同样会留下仍在计费的上游任务，先取消再报错。
    await cancelRuntimeTask(runtime, taskId, 'poll_timeout');
    throw new Error('Runtime 生成超时（已等待超过 10 分钟）');
  }
  const task = outcome.task;
  const phase = runtimeTaskPhase(task.status);
  if (phase === 'cancelled') throw new Error('Runtime 任务已被取消：' + JSON.stringify(task?.error ?? null));
  if (phase !== 'succeeded') throw new Error('Runtime 生成失败：' + JSON.stringify(task?.error));
  const blob = await loadRuntimeArtifactBlob(taskId, task.result?.artifact?.mimeType);
  return { blob, mimeType: blob.type, taskId, priceQuote: task.result?.priceQuote };
}

export function isGenerationCommand(value: string): value is GenerationCommand {
  return (GENERATION_COMMANDS as readonly string[]).includes(value);
}
