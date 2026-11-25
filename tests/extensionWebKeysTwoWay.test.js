// @vitest-environment node
// 插件 → 画布回写：本地编辑进加密 outbox、revision +1；画布 snapshot/delta 后叠加未确认编辑（后写者胜）；
// 「退出时清除」双向停止；设置页只拿到掩码；outbox 经 Port 推给画布并在确认后移除。
import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_DISABLED,
  WEB_KEYS_KEY,
  applyOutbox,
  createOutboxPusher,
  createWebKeyStore,
  maskKey,
  validateLocalEntry,
} from '../extension/background/web-keys.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) {
      return { [key]: data[key] === undefined ? undefined : structuredClone(data[key]) };
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
  };
}

function setup() {
  const storage = memoryStorage();
  const keyPromise = crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { storage, store: createWebKeyStore({ storage, cryptoKey: () => keyPromise }) };
}

const ORIGIN = 'http' + '://localhost:37522';
const web = { id: 'k1', provider: 'google', key: 'web-secret-0001', updatedAt: 1000 };

describe('extension-side edits', () => {
  it('encrypts the outbox, bumps the revision and reports only counts in plaintext', async () => {
    const { storage, store } = setup();
    await store.snapshot(ORIGIN, 3, [web]);
    const created = await store.localUpsert(ORIGIN, { provider: 'runningHub', key: 'rh-plain-secret-9876', baseUrl: 'https://www.runninghub.cn/openapi/v2' }, 2000);
    expect(created.revision).toBe(4);
    expect(created.id).toMatch(/^ext_/);
    const raw = JSON.stringify(storage.data);
    expect(raw).not.toContain('rh-plain-secret-9876');
    expect(raw).not.toContain('web-secret-0001');
    expect(storage.data[WEB_KEYS_KEY][ORIGIN]).toMatchObject({ revision: 4, count: 2, pending: 1 });
    expect(await store.summary()).toEqual({ [ORIGIN]: { count: 2, pending: 1, syncDisabled: false } });
  });

  it('keeps the existing key when the edit leaves the key field empty, and never lists plaintext', async () => {
    const { store } = setup();
    await store.snapshot(ORIGIN, 1, [web]);
    await store.localUpsert(ORIGIN, { id: 'k1', provider: 'google', key: '', defaultModel: 'gemini-x' }, 5000);
    const state = await store.state(ORIGIN);
    expect(state.keys[0]).toMatchObject({ id: 'k1', key: 'web-secret-0001', defaultModel: 'gemini-x', updatedAt: 5000 });
    const listed = await store.listMasked();
    expect(JSON.stringify(listed)).not.toContain('web-secret-0001');
    expect(listed[ORIGIN].keys[0]).toMatchObject({ id: 'k1', masked: '•••• 0001', pending: true });
  });

  it('rejects invalid input from the options page', async () => {
    const { store } = setup();
    await store.snapshot(ORIGIN, 1, [web]);
    await expect(store.localUpsert(ORIGIN, { provider: 'google', key: 'x', baseUrl: 'javascript:alert(1)' })).rejects.toThrow();
    await expect(store.localUpsert(ORIGIN, { provider: 'bad provider', key: 'x' })).rejects.toThrow();
    await expect(store.localUpsert(ORIGIN, { id: 'gone', provider: 'google', key: 'x' })).rejects.toThrow();
    expect(() => validateLocalEntry({ id: 'a', provider: 'google', key: 'k', baseUrl: 'https://ok.example/v1' })).not.toThrow();
  });

  it('re-applies unacknowledged edits on top of a canvas snapshot (last writer wins by updatedAt)', async () => {
    const { store } = setup();
    await store.snapshot(ORIGIN, 1, [web, { id: 'k2', provider: 'openai', key: 'two-secret-2222', updatedAt: 1000 }]);
    await store.localUpsert(ORIGIN, { id: 'k1', provider: 'google', key: 'ext-newer-key-1111' }, 2000);
    await store.localRemove(ORIGIN, 'k2', 2000);
    // 画布在插件编辑之后又改了 k1（更新）→ 画布胜；k2 画布没再改 → 插件的删除胜。
    await store.snapshot(ORIGIN, 2, [{ ...web, key: 'canvas-latest-3333', updatedAt: 3000 }, { id: 'k2', provider: 'openai', key: 'two-secret-2222', updatedAt: 1000 }]);
    const after = await store.state(ORIGIN);
    expect(after.keys.map(entry => [entry.id, entry.key])).toEqual([['k1', 'canvas-latest-3333']]);
    expect(after.outbox.map(change => change.op + ':' + change.id)).toEqual(['upsert:k1', 'remove:k2']);
  });

  it('drops an extension edit of a key the canvas deleted, but keeps keys created in the extension', () => {
    const outbox = [
      { op: 'upsert', id: 'edited', entry: { id: 'edited', provider: 'google', key: 'a', updatedAt: 5 }, created: false, at: 5 },
      { op: 'upsert', id: 'fresh', entry: { id: 'fresh', provider: 'google', key: 'b', updatedAt: 5 }, created: true, at: 5 },
    ];
    expect(applyOutbox([], outbox).map(entry => entry.id)).toEqual(['fresh']);
  });

  it('a created-then-deleted key never reaches the canvas', async () => {
    const { store } = setup();
    await store.snapshot(ORIGIN, 1, [web]);
    const { id } = await store.localUpsert(ORIGIN, { provider: 'google', key: 'temp-key-0000000' });
    await store.localRemove(ORIGIN, id);
    expect((await store.state(ORIGIN)).outbox).toEqual([]);
  });

  it('clear-on-exit: syncDisabled snapshot wipes keys and queued edits and blocks local edits', async () => {
    const { storage, store } = setup();
    await store.snapshot(ORIGIN, 1, [web]);
    await store.localUpsert(ORIGIN, { provider: 'google', key: 'queued-secret-77' });
    await store.snapshot(ORIGIN, 2, [], { syncDisabled: true });
    expect(storage.data[WEB_KEYS_KEY][ORIGIN]).toMatchObject({ syncDisabled: true, count: 0, pending: 0 });
    expect(JSON.stringify(storage.data)).not.toContain('ct');
    expect(await store.allKeys()).toEqual([]);
    await expect(store.localUpsert(ORIGIN, { provider: 'google', key: 'x-secret-key-00' })).rejects.toThrow(SYNC_DISABLED);
    await expect(store.delta(ORIGIN, 2, 3, [web], [])).rejects.toThrow();
    // 关掉「退出时清除」后画布重发全量，恢复正常同步。
    await store.snapshot(ORIGIN, 3, [web]);
    expect((await store.state(ORIGIN)).syncDisabled).toBe(false);
  });

  it('masks keys to the last 4 characters only, and hides short keys entirely', () => {
    expect(maskKey('sk-abcdefghijkl1234')).toBe('•••• 1234');
    expect(maskKey('short')).toBe('••••');
  });
});

describe('outbox push to the canvas', () => {
  it('sends queued changes on the origin port and acknowledges what the canvas resolved', async () => {
    const { store } = setup();
    await store.snapshot(ORIGIN, 1, [web]);
    const { id } = await store.localUpsert(ORIGIN, { provider: 'runningHub', key: 'rh-key-abcdef-1234' }, 2000);
    await store.localRemove(ORIGIN, 'k1', 2000);
    const port = { name: 'port' };
    const request = vi.fn(async (_port, message) => ({ applied: [id], ignored: message.remove.map(item => item.id) }));
    const push = createOutboxPusher(store, { portFor: origin => (origin === ORIGIN ? port : null), request });
    await push(ORIGIN);
    const [, message] = request.mock.calls[0];
    expect(message).toMatchObject({ type: 'keys.ext.changes', revision: 3, created: [id], remove: [{ id: 'k1', updatedAt: 2000 }] });
    expect(message.upsert).toEqual([expect.objectContaining({ id, provider: 'runningHub', updatedAt: 2000 })]);
    expect((await store.state(ORIGIN)).outbox).toEqual([]);
  });

  it('keeps the queue when the canvas is offline or the push fails', async () => {
    const { store } = setup();
    await store.snapshot(ORIGIN, 1, [web]);
    await store.localUpsert(ORIGIN, { id: 'k1', provider: 'google', key: 'new-key-value-55' });
    await createOutboxPusher(store, { portFor: () => null, request: vi.fn() })(ORIGIN);
    const failing = createOutboxPusher(store, { portFor: () => ({}), request: async () => { throw new Error('timeout'); } });
    await expect(failing(ORIGIN)).rejects.toThrow('timeout');
    expect((await store.state(ORIGIN)).outbox).toHaveLength(1);
  });
});

describe('registerWebKeyHandlers', () => {
  it('serves vault messages only to extension pages and pushes queued edits after a canvas snapshot', async () => {
    const { registerWebKeyHandlers } = await import('../extension/background/web-keys.js');
    const { store } = setup();
    const handlers = new Map();
    let runtimeListener;
    const chromeApi = {
      runtime: { id: 'abc', getURL: path => 'chrome-extension://abc/' + path, onMessage: { addListener: fn => { runtimeListener = fn; } } },
      storage: { onChanged: { addListener() {} } },
    };
    const request = vi.fn(async (_port, message) => ({ applied: message.upsert.map(entry => entry.id), ignored: [] }));
    const pairingStorage = memoryStorage();
    // registerWebKeyHandlers 读取的是全局 chrome.storage.local 里的配对；这里只验证 sender 校验与推送。
    globalThis.chrome = { storage: { local: pairingStorage } };
    await registerWebKeyHandlers((type, handler) => handlers.set(type, handler), store, chromeApi, { portFor: () => ({}), request });

    const reply = vi.fn();
    runtimeListener({ type: 'IRIS_VAULT_LIST' }, { id: 'abc', url: 'https://evil.example/' }, reply);
    expect(reply).toHaveBeenCalledWith({ ok: false, error: 'forbidden' });

    const listed = await new Promise(resolve => runtimeListener({ type: 'IRIS_VAULT_LIST' }, { id: 'abc', url: 'chrome-extension://abc/options/options.html' }, resolve));
    expect(listed).toEqual({ ok: true, result: {} });

    const refused = await new Promise(resolve => runtimeListener(
      { type: 'IRIS_VAULT_UPSERT', origin: ORIGIN, entry: { provider: 'google', key: 'k-secret-123456' } },
      { id: 'abc', url: 'chrome-extension://abc/options/options.html' },
      resolve,
    ));
    expect(refused).toMatchObject({ ok: false });

    await store.snapshot(ORIGIN, 1, [web]);
    await store.localUpsert(ORIGIN, { provider: 'google', key: 'queued-secret-xyz' });
    await handlers.get('keys.snapshot')({ revision: 5, keys: [web] }, { origin: ORIGIN });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await store.state(ORIGIN)).outbox).toEqual([]));
    delete globalThis.chrome;
  });
});
