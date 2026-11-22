import { invoke, isTauri } from '@tauri-apps/api/core';
import { displayError } from './displayError';

export interface RuntimeStatus {
  protocolVersion: '1';
  runtimeVersion: string;
  runtimeInstanceId: string;
  registryHash: string;
  authority: 'desktop-runtime';
  state: 'ready' | 'starting' | 'degraded' | 'stopping';
}

export interface RuntimeCommandError {
  code?: string;
  message?: string;
}

export interface RuntimeCommandResult {
  ok?: boolean;
  error?: RuntimeCommandError | string;
  [key: string]: unknown;
}

export interface RuntimeCommandEnvelope {
  protocolVersion: '1';
  commandId: string;
  command: string;
  args: Record<string, unknown>;
  actor: {
    kind: 'ui';
    instanceId: string;
  };
  idempotencyKey?: string;
}

export interface IrisRuntimeApi {
  status(): Promise<RuntimeStatus>;
  execute(envelope: RuntimeCommandEnvelope): Promise<unknown>;
  /**
   * 长轮询：任务 updatedAt 与 sinceUpdatedAt 不同或已到终态时返回，否则最多等 timeoutMs（上限 25 秒）。
   * 只有桌面 IPC 提供；缺失时调用方退回定时 task.get。
   */
  waitTask?(taskId: string, sinceUpdatedAt: number | undefined, timeoutMs: number): Promise<unknown>;
}

const tauriRuntime: IrisRuntimeApi = {
  status: () => invoke<RuntimeStatus>('runtime_status'),
  execute: envelope => invoke('runtime_execute', { envelope }),
  waitTask: (taskId, sinceUpdatedAt, timeoutMs) => invoke('runtime_task_wait', { taskId, sinceUpdatedAt: sinceUpdatedAt ?? null, timeoutMs }),
};

export function isTauriRuntimeSurface(): boolean {
  return typeof window !== 'undefined' && isTauri();
}

export function getIrisRuntimeApi(): IrisRuntimeApi | null {
  return isTauriRuntimeSurface() ? tauriRuntime : null;
}

/**
 * RuntimeCommandResult.error → 上屏文案。
 * 统一经过 displayError jargon 层，避免把 sidecar 的英文/内部错原样弹进 Toast。
 */
export function getRuntimeErrorMessage(
  result: RuntimeCommandResult | null | undefined,
  fallback: string,
): string {
  const error = result?.error;
  const raw = typeof error === 'string' && error.trim()
    ? error
    : error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()
      ? error.message
      : '';
  return raw ? displayError(raw, fallback) : fallback;
}
