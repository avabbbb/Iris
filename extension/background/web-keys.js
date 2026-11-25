// 网页画布 ⇄ 插件双向同步的 API Key（BYOK）。
// - 按画布 origin 分区存放，密文写 chrome.storage.local，明文只在内存中短暂存在。
// - AES-GCM 密钥由插件生成且不可导出，以 CryptoKey 对象形式存在 IndexedDB；拷走 storage 导出也解不开。
// - 每次写入带 revision；delta 的 baseRevision 对不上就拒绝，网页侧会改发全量 snapshot。
// - 配对被撤销或拒绝时清空该 origin 的全部 Key。
// - 插件内编辑（设置页）：先写本地并把 revision +1，变更进该 origin 的 outbox（同样加密）；
//   画布在线就经 iris-web Port 发 keys.ext.changes，离线则排队，下次画布连上（发来 snapshot/delta）后再推。
// - 冲突规则（两端同一套）：按 Key id 后写者胜，比较 updatedAt（毫秒）；
//   · 编辑/新增：updatedAt 严格更新才覆盖对方；
//   · 删除：带删除时间的墓碑，墓碑时间 ≥ 对方 updatedAt 才删；
//   · 插件里“编辑”一个画布已删除的 Key：丢弃（删除胜，画布不记删除时间）；插件里“新增”的 Key 照常加入。
// - 画布开启「退出时清除」时发来 syncDisabled：本地清空、outbox 丢弃，两个方向都不再同步。
import { PAIRINGS_KEY, readPairings } from './web-pairings.js';
import { ensureRenamedExtensionStorage } from './storage-migration.js';

export const WEB_KEYS_KEY = 'irisWebKeys';
export const REVISION_MISMATCH = 'keys.revision-mismatch';
const MAX_KEYS = 200;
// 插件设置页 / popup 与 service worker 之间的消息（只在本扩展内部，不对网页开放）。
export const VAULT_MESSAGES = {
  list: 'IRIS_VAULT_LIST',
  summary: 'IRIS_VAULT_SUMMARY',
  upsert: 'IRIS_VAULT_UPSERT',
  remove: 'IRIS_VAULT_REMOVE',
};
export const SYNC_DISABLED = 'keys.sync-disabled';
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const DB_NAME = 'iris-extension';
// 更名前的库：只读，用来取回旧的不可导出 AES-GCM 密钥（否则旧密文解不开）。
const LEGACY_DB_NAME = 'flovart-extension';
const DB_STORE = 'crypto';
const CRYPTO_ID = 'web-keys-aes-gcm';

function limitedString(value, max) {
  return typeof value === 'string' && value && value.length <= max ? value : null;
}

// 只保留插件真正用得到的字段，其余一律丢弃。网页侧 services/extensionKeySync.ts 的
// sanitizeExtensionKeyEntry 用同一份白名单（测试对拍）：id provider key name baseUrl defaultModel capabilities updatedAt。
export const KEY_ENTRY_FIELDS = ['id', 'provider', 'key', 'name', 'baseUrl', 'defaultModel', 'capabilities', 'updatedAt'];

export function sanitizeKeyEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = limitedString(entry.id, 128);
  const provider = limitedString(entry.provider, 64);
  const key = limitedString(entry.key, 4096);
  if (!id || !provider || !key) return null;
  const clean = { id, provider, key };
  const name = limitedString(entry.name, 128);
  if (name) clean.name = name;
  const baseUrl = limitedString(entry.baseUrl, 2048);
  if (baseUrl) clean.baseUrl = baseUrl;
  const defaultModel = limitedString(entry.defaultModel, 256);
  if (defaultModel) clean.defaultModel = defaultModel;
  if (Array.isArray(entry.capabilities)) {
    clean.capabilities = entry.capabilities.filter(item => limitedString(item, 64)).slice(0, 16);
  }
  if (Number.isSafeInteger(entry.updatedAt) && entry.updatedAt > 0) clean.updatedAt = entry.updatedAt;
  return clean;
}

// 插件内编辑的额外校验：Provider 只能是标识符，Base URL 只能是 http(s)。
export function validateLocalEntry(entry) {
  const clean = sanitizeKeyEntry(entry);
  if (!clean) throw new Error('缺少 Provider 或 Key');
  if (!PROVIDER_ID_PATTERN.test(clean.provider)) throw new Error('无效的 Provider');
  if (clean.baseUrl) {
    let url;
    try {
      url = new URL(clean.baseUrl);
    } catch {
      throw new Error('Base URL 无效');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL 只支持 http(s)');
  }
  return clean;
}

// 掩码：只露最后 4 位；太短的 Key 一位都不露。
export function maskKey(key) {
  const value = String(key || '');
  return value.length >= 12 ? '•••• ' + value.slice(-4) : '••••';
}

function sanitizeOutbox(value) {
  if (!Array.isArray(value)) return [];
  const byId = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.at)) continue;
    if (item.op === 'remove' && limitedString(item.id, 128)) byId.set(item.id, { op: 'remove', id: item.id, at: item.at });
    if (item.op === 'upsert') {
      const entry = sanitizeKeyEntry(item.entry);
      if (entry) byId.set(entry.id, { op: 'upsert', id: entry.id, entry, created: item.created === true, at: item.at });
    }
  }
  return [...byId.values()].slice(0, MAX_KEYS);
}

// 把尚未被画布确认的本地编辑叠加到画布发来的列表上（冲突规则见文件头）。
export function applyOutbox(keys, outbox) {
  const byId = new Map(keys.map(entry => [entry.id, entry]));
  for (const change of outbox) {
    const existing = byId.get(change.id);
    const theirs = existing?.updatedAt || 0;
    if (change.op === 'remove') {
      if (existing && theirs <= change.at) byId.delete(change.id);
      continue;
    }
    if (existing ? theirs < change.at : change.created) byId.set(change.id, change.entry);
  }
  return [...byId.values()].slice(0, MAX_KEYS);
}

export function sanitizeKeys(entries) {
  if (!Array.isArray(entries)) return [];
  const byId = new Map();
  for (const entry of entries) {
    const clean = sanitizeKeyEntry(entry);
    if (clean) byId.set(clean.id, clean);
  }
  return [...byId.values()].slice(0, MAX_KEYS);
}

function revisionOf(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('无效的 revision');
  return value;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// 读取旧库里的密钥；旧库不存在时不创建空库。
function legacyCryptoKey() {
  return new Promise(resolve => {
    let created = false;
    const open = indexedDB.open(LEGACY_DB_NAME);
    open.onupgradeneeded = () => {
      created = true;
      open.transaction?.abort();
    };
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      if (created || !db.objectStoreNames.contains(DB_STORE)) {
        db.close();
        resolve(null);
        return;
      }
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(CRYPTO_ID);
      request.onsuccess = () => { resolve(request.result || null); db.close(); };
      request.onerror = () => { resolve(null); db.close(); };
    };
  });
}

function idb(run, mode) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
      request.onsuccess = () => {
        resolve(request.result);
        db.close();
      };
      request.onerror = () => {
        reject(request.error);
        db.close();
      };
    };
  });
}

let defaultKeyPromise = null;

// 不可导出的 AES-GCM 密钥；首次使用时生成。若 IndexedDB 被清理，旧密文解不开，按空处理并等网页重发。
export function defaultCryptoKey() {
  defaultKeyPromise ||= (async () => {
    const existing = await idb(store => store.get(CRYPTO_ID), 'readonly');
    if (existing) return existing;
    const legacy = await legacyCryptoKey();
    if (legacy) {
      await idb(store => store.put(legacy, CRYPTO_ID), 'readwrite');
      return legacy;
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb(store => store.put(key, CRYPTO_ID), 'readwrite');
    return key;
  })().catch(error => {
    defaultKeyPromise = null;
    throw error;
  });
  return defaultKeyPromise;
}

export function createWebKeyStore({ storage, cryptoKey = defaultCryptoKey } = {}) {
  let chain = Promise.resolve();
  const area = () => {
    const resolved = storage || globalThis.chrome?.storage?.local;
    if (!resolved) throw new Error('chrome.storage.local 不可用');
    return resolved;
  };

  async function readAll() {
    await ensureRenamedExtensionStorage(area());
    const stored = await area().get(WEB_KEYS_KEY);
    const value = stored?.[WEB_KEYS_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  // 串行化读-改-写，避免两个画布标签页同时同步时互相覆盖。
  function mutate(mutator) {
    const run = chain.then(async () => {
      const all = await readAll();
      const result = await mutator(all);
      await area().set({ [WEB_KEYS_KEY]: all });
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  // 明文元数据只有 revision / 数量 / 待回写数 / syncDisabled；Key 与 outbox 都在密文里。
  async function encryptRecord(revision, keys, outbox = []) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(outbox.length ? { keys, outbox } : keys));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), plain);
    return {
      revision,
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(cipher)),
      count: keys.length,
      pending: outbox.length,
      updatedAt: Date.now(),
    };
  }

  async function decryptState(record) {
    const empty = { revision: 0, keys: [], outbox: [], syncDisabled: false };
    if (record?.syncDisabled === true) return { ...empty, revision: Number.isInteger(record.revision) ? record.revision : 0, syncDisabled: true };
    if (!record || typeof record.iv !== 'string' || typeof record.ct !== 'string') return empty;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
        await cryptoKey(),
        base64ToBytes(record.ct),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plain));
      // 1.6 及以前密文里只有数组；1.7 起有 outbox 时是 { keys, outbox }。
      const keys = sanitizeKeys(Array.isArray(parsed) ? parsed : parsed?.keys);
      const outbox = Array.isArray(parsed) ? [] : sanitizeOutbox(parsed?.outbox);
      return { revision: Number.isInteger(record.revision) ? record.revision : 0, keys, outbox, syncDisabled: false };
    } catch {
      return empty;
    }
  }

  async function decryptRecord(record) {
    const { revision, keys } = await decryptState(record);
    return { revision, keys };
  }

  async function writeState(all, origin, revision, keys, outbox) {
    if (keys.length || outbox.length) all[origin] = await encryptRecord(revision, keys, outbox);
    else delete all[origin];
  }

  return {
    async load(origin) {
      return decryptRecord((await readAll())[origin]);
    },

    // 合并所有已同步画布的 Key，供反推等插件内能力使用。
    async allKeys() {
      const all = await readAll();
      const merged = [];
      for (const origin of Object.keys(all)) merged.push(...(await decryptRecord(all[origin])).keys);
      return merged;
    },

    // 含 outbox 与 syncDisabled 的完整状态（只给 service worker 内部用）。
    async state(origin) {
      return decryptState((await readAll())[origin]);
    },

    // syncDisabled：画布开启了「退出时清除」，清空本地并丢弃排队的编辑，之后两个方向都不同步。
    snapshot(origin, revision, keys, options = {}) {
      const nextRevision = revisionOf(revision);
      return mutate(async all => {
        if (options.syncDisabled === true) {
          all[origin] = { revision: nextRevision, syncDisabled: true, count: 0, pending: 0, updatedAt: Date.now() };
          return { revision: nextRevision, count: 0, pending: 0, syncDisabled: true };
        }
        const { outbox } = await decryptState(all[origin]);
        const merged = applyOutbox(sanitizeKeys(keys), outbox);
        await writeState(all, origin, nextRevision, merged, outbox);
        return { revision: nextRevision, count: merged.length, pending: outbox.length };
      });
    },

    delta(origin, baseRevision, revision, upsert, remove) {
      const base = revisionOf(baseRevision);
      const nextRevision = revisionOf(revision);
      return mutate(async all => {
        const current = await decryptState(all[origin]);
        if (current.syncDisabled || current.revision !== base) throw new Error(REVISION_MISMATCH);
        const removed = new Set(Array.isArray(remove) ? remove.filter(id => typeof id === 'string') : []);
        const byId = new Map(current.keys.filter(entry => !removed.has(entry.id)).map(entry => [entry.id, entry]));
        for (const entry of sanitizeKeys(upsert)) byId.set(entry.id, entry);
        const keys = applyOutbox([...byId.values()].slice(0, MAX_KEYS), current.outbox);
        await writeState(all, origin, nextRevision, keys, current.outbox);
        return { revision: nextRevision, count: keys.length, pending: current.outbox.length };
      });
    },

    // 插件内新增 / 编辑。input.key 为空表示沿用原 Key（设置页从不拿到明文）。
    localUpsert(origin, input, now = Date.now()) {
      return mutate(async all => {
        const current = await decryptState(all[origin]);
        if (current.syncDisabled) throw new Error(SYNC_DISABLED);
        const id = typeof input?.id === 'string' && input.id ? input.id : 'ext_' + crypto.randomUUID();
        const existing = current.keys.find(entry => entry.id === id);
        if (input?.id && !existing) throw new Error('Key 不存在或已被画布删除');
        const updatedAt = Math.max(now, (existing?.updatedAt || 0) + 1);
        const entry = validateLocalEntry({
          id,
          provider: input?.provider,
          key: typeof input?.key === 'string' && input.key.trim() ? input.key.trim() : existing?.key,
          name: typeof input?.name === 'string' ? input.name.trim() : undefined,
          baseUrl: typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : undefined,
          defaultModel: typeof input?.defaultModel === 'string' ? input.defaultModel.trim() : undefined,
          capabilities: Array.isArray(input?.capabilities) ? input.capabilities : undefined,
          updatedAt,
        });
        const previous = current.outbox.find(change => change.id === id);
        const created = !existing || (previous?.op === 'upsert' && previous.created);
        const outbox = [...current.outbox.filter(change => change.id !== id), { op: 'upsert', id, entry, created, at: updatedAt }];
        const keys = existing ? current.keys.map(item => (item.id === id ? entry : item)) : [...current.keys, entry];
        if (keys.length > MAX_KEYS) throw new Error('Key 数量已达上限');
        const revision = current.revision + 1;
        await writeState(all, origin, revision, keys, outbox);
        return { id, revision, pending: outbox.length };
      });
    },

    localRemove(origin, id, now = Date.now()) {
      return mutate(async all => {
        const current = await decryptState(all[origin]);
        if (current.syncDisabled) throw new Error(SYNC_DISABLED);
        const existing = current.keys.find(entry => entry.id === id);
        if (!existing) return { id, revision: current.revision, pending: current.outbox.length };
        const previous = current.outbox.find(change => change.id === id);
        const at = Math.max(now, (existing.updatedAt || 0) + 1);
        // 插件里新建、还没回写到画布就删掉：直接撤销，不必通知画布。
        const outbox = current.outbox.filter(change => change.id !== id);
        if (!(previous?.op === 'upsert' && previous.created)) outbox.push({ op: 'remove', id, at });
        const keys = current.keys.filter(entry => entry.id !== id);
        const revision = current.revision + 1;
        await writeState(all, origin, revision, keys, outbox);
        return { id, revision, pending: outbox.length };
      });
    },

    // 画布确认后移除 outbox 中对应条目；只移除发送时那一版（之后又改过的继续排队）。
    ackOutbox(origin, sent) {
      return mutate(async all => {
        const current = await decryptState(all[origin]);
        if (current.syncDisabled) return { pending: 0 };
        const outbox = current.outbox.filter(change => !(sent.has(change.id) && change.at <= sent.get(change.id)));
        if (outbox.length !== current.outbox.length) await writeState(all, origin, current.revision, current.keys, outbox);
        return { pending: outbox.length };
      });
    },

    // 每个 origin 的掩码视图：设置页只拿得到这个，拿不到明文。
    async listMasked() {
      const all = await readAll();
      const result = {};
      for (const origin of Object.keys(all)) {
        const state = await decryptState(all[origin]);
        const pendingIds = new Set(state.outbox.map(change => change.id));
        result[origin] = {
          revision: state.revision,
          syncDisabled: state.syncDisabled,
          pending: state.outbox.length,
          keys: state.keys.map(entry => ({
            id: entry.id,
            provider: entry.provider,
            name: entry.name || '',
            baseUrl: entry.baseUrl || '',
            defaultModel: entry.defaultModel || '',
            capabilities: entry.capabilities || [],
            updatedAt: entry.updatedAt || 0,
            masked: maskKey(entry.key),
            pending: pendingIds.has(entry.id),
          })),
        };
      }
      return result;
    },

    // popup 用：只给数量，不解密。
    async summary() {
      const all = await readAll();
      const result = {};
      for (const [origin, record] of Object.entries(all)) {
        result[origin] = {
          count: Number.isInteger(record?.count) ? record.count : 0,
          pending: Number.isInteger(record?.pending) ? record.pending : 0,
          syncDisabled: record?.syncDisabled === true,
        };
      }
      return result;
    },

    clear(origin) {
      return mutate(all => {
        delete all[origin];
        return { revision: 0, count: 0 };
      });
    },

    // 只保留仍处于已批准状态的 origin（启动时兜底，应对 Service Worker 休眠期间发生的撤销）。
    prune(approvedOrigins) {
      return mutate(all => {
        for (const origin of Object.keys(all)) if (!approvedOrigins.has(origin)) delete all[origin];
      });
    },
  };
}

function bodyOf(message) {
  return message?.payload && typeof message.payload === 'object' ? message.payload : message || {};
}

// 把某个 origin 的 outbox 推给在线的画布；画布不在线就留着等下次连接。
export function createOutboxPusher(store, { portFor, request } = {}) {
  const inFlight = new Map();
  async function pushOnce(origin) {
    const port = portFor?.(origin);
    if (!port || !request) return { pushed: false };
    const state = await store.state(origin);
    if (state.syncDisabled || !state.outbox.length) return { pushed: false };
    const sent = new Map(state.outbox.map(change => [change.id, change.at]));
    const upsert = state.outbox.filter(change => change.op === 'upsert').map(change => change.entry);
    const created = state.outbox.filter(change => change.op === 'upsert' && change.created).map(change => change.id);
    const remove = state.outbox.filter(change => change.op === 'remove').map(change => ({ id: change.id, updatedAt: change.at }));
    const result = await request(port, { type: 'keys.ext.changes', revision: state.revision, upsert, created, remove });
    const resolved = new Set([
      ...(Array.isArray(result?.applied) ? result.applied : []),
      ...(Array.isArray(result?.ignored) ? result.ignored : []),
    ].filter(id => typeof id === 'string'));
    for (const id of [...sent.keys()]) if (!resolved.has(id)) sent.delete(id);
    await store.ackOutbox(origin, sent);
    return { pushed: true, resolved: resolved.size };
  }
  return function push(origin) {
    // 同一 origin 串行推送；推送期间又有新编辑时，结束后再推一次。
    const previous = inFlight.get(origin) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => pushOnce(origin));
    inFlight.set(origin, next);
    next.finally(() => {
      if (inFlight.get(origin) === next) inFlight.delete(origin);
    }).catch(() => {});
    return next;
  };
}

function isExtensionPage(sender, chromeApi) {
  const runtime = chromeApi?.runtime;
  if (!runtime || sender?.id !== runtime.id) return false;
  const base = typeof runtime.getURL === 'function' ? runtime.getURL('') : '';
  return Boolean(base) && typeof sender.url === 'string' && sender.url.startsWith(base);
}

export function registerWebKeyHandlers(onWebMessage, store, chromeApi = globalThis.chrome, transport = {}) {
  const push = createOutboxPusher(store, transport);
  // 画布发来 snapshot / delta 即视为已连上：回复后把排队的插件内编辑推回去。
  const pushLater = origin => {
    setTimeout(() => {
      push(origin).catch(error => console.warn('[Iris Web Keys] 回写画布失败，稍后重试', error instanceof Error ? error.message : String(error)));
    }, 0);
  };
  onWebMessage('keys.snapshot', async (message, { origin }) => {
    const body = bodyOf(message);
    const result = await store.snapshot(origin, body.revision, body.keys, { syncDisabled: body.syncDisabled === true });
    if (result.pending) pushLater(origin);
    return result;
  });
  onWebMessage('keys.delta', async (message, { origin }) => {
    const body = bodyOf(message);
    const result = await store.delta(origin, body.baseRevision, body.revision, body.upsert, body.remove);
    if (result.pending) pushLater(origin);
    return result;
  });
  onWebMessage('keys.clear', (_message, { origin }) => store.clear(origin));

  // 插件设置页 / popup → service worker。只接受本扩展自己的页面；返回值永远是掩码。
  chromeApi?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (!Object.values(VAULT_MESSAGES).includes(type)) return undefined;
    if (!isExtensionPage(sender, chromeApi)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return undefined;
    }
    const run = async () => {
      if (type === VAULT_MESSAGES.summary) return store.summary();
      if (type === VAULT_MESSAGES.list) return store.listMasked();
      const origin = typeof message.origin === 'string' ? message.origin : '';
      if ((await readPairings())[origin]?.status !== 'approved') throw new Error('该画布未配对');
      const result = type === VAULT_MESSAGES.upsert
        ? await store.localUpsert(origin, message.entry)
        : await store.localRemove(origin, String(message.id || ''));
      pushLater(origin);
      return result;
    };
    run()
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  chromeApi?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes[PAIRINGS_KEY]) return;
    const after = changes[PAIRINGS_KEY].newValue || {};
    const before = changes[PAIRINGS_KEY].oldValue || {};
    for (const origin of Object.keys(before)) {
      if (after[origin]?.status !== 'approved') void store.clear(origin);
    }
  });

  return readPairings()
    .then(pairings => store.prune(new Set(Object.keys(pairings).filter(origin => pairings[origin]?.status === 'approved'))))
    .catch(error => console.error('[Iris Web Keys]', error));
}
