// 画布 Vault ⇄ 已配对的浏览器插件（双向）。
// 画布 → 插件：连接进入 approved 后先发 keys.snapshot（全量），之后每次 Key 变更只发 keys.delta（增量）。
// 插件拒绝 delta（revision 对不上）时回退为全量；发送失败时若期间又有变更则立即全量重试一次，否则在下次变更或重连时整份重发。
// 插件 → 画布：插件设置页里的编辑经同一 Port 发 keys.ext.changes（插件本地 revision 已 +1）。画布按
// mergeExtensionKeyChanges 合并后，把插件的 revision 记为下限、改发全量 snapshot，两端回到同一份列表。
// 冲突规则（与 extension/background/web-keys.js 一致）：按 Key id 后写者胜，比较 updatedAt；
// 插件删除带墓碑时间，墓碑时间 ≥ 画布 updatedAt 才删；插件“编辑”画布已删除的 Key 被忽略（删除胜），插件“新增”的 Key 照常加入。
// 「退出时清除」开启时画布发 syncDisabled snapshot，并拒绝插件回写：两个方向都不同步。

export interface ExtensionKeySource {
  id: string;
  provider: string;
  key: string;
  name?: string;
  baseUrl?: string;
  capabilities?: readonly string[];
  defaultModel?: string;
  updatedAt?: number;
}

export interface ExtensionKeyEntry {
  id: string;
  provider: string;
  key: string;
  name?: string;
  baseUrl?: string;
  capabilities?: string[];
  defaultModel?: string;
  updatedAt?: number;
}

/** 与插件 web-keys.js 的 KEY_ENTRY_FIELDS 相同的字段白名单（测试对拍）。 */
export const EXTENSION_KEY_FIELDS = ['id', 'provider', 'key', 'name', 'baseUrl', 'defaultModel', 'capabilities', 'updatedAt'] as const;
export const EXTENSION_KEY_SYNC_DISABLED = 'keys.sync-disabled';
const MAX_EXTENSION_KEYS = 200;
/** 插件回写时允许的 Provider（= types AIProvider）。 */
const KNOWN_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'qwen', 'deepseek', 'xai', 'siliconflow', 'keling', 'flux', 'midjourney',
  'runningHub', 'minimax', 'volcengine', 'openrouter', 'openai_compatible', 'custom',
]);
const KNOWN_CAPABILITIES = new Set(['text', 'image', 'video', 'agent']);

function limitedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value && value.length <= max ? value : null;
}

/** 校验插件发来的一条 Key：只留白名单字段；Provider / 能力必须是画布认识的，Base URL 只能是 http(s)。 */
export function sanitizeExtensionKeyEntry(raw: unknown): ExtensionKeyEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const id = limitedString(entry.id, 128);
  const provider = limitedString(entry.provider, 64);
  const key = limitedString(entry.key, 4096);
  if (!id || !provider || !key || !KNOWN_PROVIDERS.has(provider)) return null;
  const clean: ExtensionKeyEntry = { id, provider, key };
  const name = limitedString(entry.name, 128);
  if (name) clean.name = name;
  const baseUrl = limitedString(entry.baseUrl, 2048);
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    } catch {
      return null;
    }
    clean.baseUrl = baseUrl;
  }
  const defaultModel = limitedString(entry.defaultModel, 256);
  if (defaultModel) clean.defaultModel = defaultModel;
  if (Array.isArray(entry.capabilities)) {
    const capabilities = entry.capabilities.filter((item): item is string => typeof item === 'string' && KNOWN_CAPABILITIES.has(item)).slice(0, 16);
    if (capabilities.length) clean.capabilities = [...new Set(capabilities)];
  }
  if (Number.isSafeInteger(entry.updatedAt) && (entry.updatedAt as number) > 0) clean.updatedAt = entry.updatedAt as number;
  return clean;
}

interface MergeableKey {
  id: string;
  updatedAt?: number;
  createdAt?: number;
}

export interface ExtensionKeyMergeResult<T> {
  next: T[];
  changed: boolean;
  applied: string[];
  ignored: string[];
}

/**
 * 把插件发来的 keys.ext.changes 合并进画布 Key 列表（冲突规则见文件头）。
 * 白名单字段整体替换，其余字段（模型列表、路由映射、脚本配置等）保留画布原值。
 */
export function mergeExtensionKeyChanges<T extends MergeableKey>(
  current: readonly T[],
  payload: unknown,
  normalize: (item: Record<string, unknown>) => T | null,
): ExtensionKeyMergeResult<T> {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const created = new Set(Array.isArray(body.created) ? body.created.filter((id): id is string => typeof id === 'string') : []);
  const upserts = (Array.isArray(body.upsert) ? body.upsert : []).slice(0, MAX_EXTENSION_KEYS);
  const removes = (Array.isArray(body.remove) ? body.remove : []).slice(0, MAX_EXTENSION_KEYS);
  const next = [...current];
  const applied: string[] = [];
  const ignored: string[] = [];
  for (const raw of upserts) {
    const entry = sanitizeExtensionKeyEntry(raw);
    const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    if (!entry || !entry.updatedAt) {
      if (typeof rawId === 'string') ignored.push(rawId);
      continue;
    }
    const index = next.findIndex(item => item.id === entry.id);
    if (index < 0) {
      if (!created.has(entry.id) || next.length >= MAX_EXTENSION_KEYS) {
        ignored.push(entry.id);
        continue;
      }
      const added = normalize({ ...entry, createdAt: entry.updatedAt });
      if (!added) {
        ignored.push(entry.id);
        continue;
      }
      next.push(added);
      applied.push(entry.id);
      continue;
    }
    const existing = next[index];
    if ((existing.updatedAt || 0) >= entry.updatedAt) {
      ignored.push(entry.id);
      continue;
    }
    const merged: Record<string, unknown> = { ...(existing as object) };
    for (const field of EXTENSION_KEY_FIELDS) merged[field] = entry[field];
    const normalized = normalize(merged);
    if (!normalized) {
      ignored.push(entry.id);
      continue;
    }
    next[index] = normalized;
    applied.push(entry.id);
  }
  for (const raw of removes) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, updatedAt } = raw as { id?: unknown; updatedAt?: unknown };
    if (typeof id !== 'string') continue;
    const index = next.findIndex(item => item.id === id);
    if (index < 0 || !Number.isSafeInteger(updatedAt) || (next[index].updatedAt || 0) > (updatedAt as number)) {
      ignored.push(id);
      continue;
    }
    next.splice(index, 1);
    applied.push(id);
  }
  return { next: applied.length ? next : [...current], changed: applied.length > 0, applied, ignored };
}

export interface KeySyncBridge {
  getState(): { status: string };
  subscribe(listener: (state: { status: string }) => void): () => void;
  request(type: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface ExtensionKeySync {
  /** syncDisabled：画布开启「退出时清除」，只告诉插件清空并停止双向同步。 */
  update(keys: readonly ExtensionKeySource[], options?: { syncDisabled?: boolean }): Promise<void>;
  /** 插件回写时带来的 revision：之后的 revision 从它之上递增，并改发全量。 */
  noteRemoteRevision(revision: unknown): void;
  dispose(): void;
}

const REVISION_MISMATCH = 'keys.revision-mismatch';

// 只发插件用得到的字段；字段顺序固定，便于用 JSON 字符串比较是否变化。
export function toExtensionKeyEntry(source: ExtensionKeySource): ExtensionKeyEntry {
  const entry: ExtensionKeyEntry = { id: source.id, provider: source.provider, key: source.key };
  if (source.name) entry.name = source.name;
  if (source.baseUrl) entry.baseUrl = source.baseUrl;
  if (source.capabilities?.length) entry.capabilities = [...source.capabilities];
  if (source.defaultModel) entry.defaultModel = source.defaultModel;
  if (source.updatedAt) entry.updatedAt = source.updatedAt;
  return entry;
}

export function diffExtensionKeys(previous: readonly ExtensionKeyEntry[], next: readonly ExtensionKeyEntry[]) {
  const before = new Map(previous.map(entry => [entry.id, JSON.stringify(entry)]));
  const nextIds = new Set(next.map(entry => entry.id));
  return {
    upsert: next.filter(entry => before.get(entry.id) !== JSON.stringify(entry)),
    remove: previous.filter(entry => !nextIds.has(entry.id)).map(entry => entry.id),
  };
}

function isRevisionMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes(REVISION_MISMATCH);
}

// idle：没有进行中的发送；draining：正在把 desired 推给插件；disposed：终态，忽略一切更新。
type KeySyncPhase = 'idle' | 'draining' | 'disposed';

export function createExtensionKeySync(bridge: KeySyncBridge): ExtensionKeySync {
  let desired: ExtensionKeyEntry[] = [];
  let desiredDisabled = false;
  let hasDesired = false;
  let acked: { revision: number; keys: ExtensionKeyEntry[]; disabled?: boolean } | null = null;
  // 插件本地编辑过的 revision 下限：画布之后发的 revision 不会比它小。
  let floor = 0;
  let phase: KeySyncPhase = 'idle';
  let running: Promise<void> | null = null;
  // draining 期间又有变更：本轮结束后再推一次。
  let dirty = false;
  let wasApproved = bridge.getState().status === 'approved';

  async function drain() {
    do {
      dirty = false;
      if (phase === 'disposed' || !hasDesired || bridge.getState().status !== 'approved') return;
      const target = desired;
      const revision = Math.max(acked?.revision ?? 0, floor) + 1;
      if (desiredDisabled) {
        if (acked?.disabled) continue;
        await bridge.request('keys.snapshot', { revision, keys: [], syncDisabled: true });
        acked = { revision, keys: [], disabled: true };
        continue;
      }
      if (acked?.disabled) acked = null;
      if (acked) {
        const { upsert, remove } = diffExtensionKeys(acked.keys, target);
        if (!upsert.length && !remove.length) continue;
        try {
          await bridge.request('keys.delta', { baseRevision: acked.revision, revision, upsert, remove });
          acked = { revision, keys: target };
          continue;
        } catch (error) {
          if (!isRevisionMismatch(error)) throw error;
        }
      }
      await bridge.request('keys.snapshot', { revision, keys: target });
      acked = { revision, keys: target };
    } while (dirty);
  }

  async function drainWithRetry() {
    let retried = false;
    for (;;) {
      try {
        await drain();
        return;
      } catch (error) {
        acked = null;
        const willRetry = dirty && !retried;
        console.warn('[ExtensionKeySync] 同步 Key 到插件失败', { error: error instanceof Error ? error.message : String(error), willRetry });
        // 失败那一轮里又有新变更：立即用全量重试一次，否则最新 Key 要等下次变更或重连才送达。
        if (!willRetry) return;
        retried = true;
      }
    }
  }

  function flush(): Promise<void> {
    if (phase === 'disposed') return Promise.resolve();
    if (phase === 'draining' && running) {
      dirty = true;
      return running;
    }
    phase = 'draining';
    running = drainWithRetry().finally(() => {
      running = null;
      if (phase === 'draining') phase = 'idle';
    });
    return running;
  }

  const unsubscribe = bridge.subscribe(state => {
    const approved = state.status === 'approved';
    // 每次重新进入 approved 都从全量开始：插件可能在断线期间被撤销并清空过。
    if (!approved || !wasApproved) acked = null;
    if (approved && !wasApproved) void flush();
    wasApproved = approved;
  });

  return {
    update(keys, options = {}) {
      desiredDisabled = options.syncDisabled === true;
      desired = desiredDisabled ? [] : keys.map(toExtensionKeyEntry);
      hasDesired = true;
      return flush();
    },
    noteRemoteRevision(revision) {
      if (Number.isSafeInteger(revision) && (revision as number) > floor) floor = revision as number;
      acked = null;
    },
    dispose() {
      phase = 'disposed';
      unsubscribe();
    },
  };
}
