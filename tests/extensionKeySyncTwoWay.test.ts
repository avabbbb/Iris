// @vitest-environment node
// 画布侧的双向同步：插件回写的校验（与插件同一份字段白名单）、后写者胜合并、「退出时清除」与 revision 下限。
import { describe, expect, it } from 'vitest';
import { KEY_ENTRY_FIELDS } from '../extension/background/web-keys.js';
import {
  EXTENSION_KEY_FIELDS,
  createExtensionKeySync,
  mergeExtensionKeyChanges,
  sanitizeExtensionKeyEntry,
  type KeySyncBridge,
} from '../services/extensionKeySync';

interface Key { id: string; provider: string; key: string; updatedAt?: number; createdAt?: number; models?: string[]; baseUrl?: string; name?: string }
const normalize = (item: Record<string, unknown>) => item as unknown as Key;

function recordingBridge() {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bridge: KeySyncBridge = {
    getState: () => ({ status: 'approved' }),
    subscribe: () => () => {},
    async request(type, payload) {
      calls.push({ type, payload });
      return {};
    },
  };
  return { bridge, calls };
}

describe('field whitelist', () => {
  it('matches the extension sanitizer exactly', () => {
    expect([...EXTENSION_KEY_FIELDS]).toEqual(KEY_ENTRY_FIELDS);
  });

  it('drops unknown fields, unknown providers and non-http base URLs', () => {
    expect(sanitizeExtensionKeyEntry({ id: 'a', provider: 'google', key: 'k', extraConfig: { x: 1 }, routeMappings: [], updatedAt: 5 }))
      .toEqual({ id: 'a', provider: 'google', key: 'k', updatedAt: 5 });
    expect(sanitizeExtensionKeyEntry({ id: 'a', provider: 'evil', key: 'k' })).toBeNull();
    expect(sanitizeExtensionKeyEntry({ id: 'a', provider: 'custom', key: 'k', baseUrl: 'javascript:alert(1)' })).toBeNull();
    expect(sanitizeExtensionKeyEntry({ id: 'a', provider: 'custom', key: 'k', capabilities: ['text', 'root', 'text'] }))
      .toEqual({ id: 'a', provider: 'custom', key: 'k', capabilities: ['text'] });
  });
});

describe('mergeExtensionKeyChanges (last writer wins by updatedAt)', () => {
  const current: Key[] = [
    { id: 'k1', provider: 'google', key: 'old', updatedAt: 1000, models: ['m1'] },
    { id: 'k2', provider: 'openai', key: 'two', updatedAt: 3000 },
  ];

  it('applies newer edits, keeps canvas-only fields, ignores older edits', () => {
    const result = mergeExtensionKeyChanges(current, {
      upsert: [
        { id: 'k1', provider: 'google', key: 'new', updatedAt: 2000 },
        { id: 'k2', provider: 'openai', key: 'stale', updatedAt: 2500 },
      ],
    }, normalize);
    expect(result.applied).toEqual(['k1']);
    expect(result.ignored).toEqual(['k2']);
    expect(result.next[0]).toMatchObject({ id: 'k1', key: 'new', updatedAt: 2000, models: ['m1'] });
    expect(result.next[1].key).toBe('two');
  });

  it('adds keys created in the extension but drops edits of keys the canvas deleted', () => {
    const result = mergeExtensionKeyChanges(current, {
      upsert: [
        { id: 'ext_new', provider: 'runningHub', key: 'rh', updatedAt: 4000 },
        { id: 'deleted', provider: 'google', key: 'x', updatedAt: 4000 },
      ],
      created: ['ext_new'],
    }, normalize);
    expect(result.next.map(item => item.id)).toEqual(['k1', 'k2', 'ext_new']);
    expect(result.next[2].createdAt).toBe(4000);
    expect(result.ignored).toEqual(['deleted']);
  });

  it('deletes only when the tombstone is not older than the canvas copy', () => {
    const result = mergeExtensionKeyChanges(current, {
      remove: [{ id: 'k1', updatedAt: 1000 }, { id: 'k2', updatedAt: 2000 }, { id: 'nope', updatedAt: 1 }],
    }, normalize);
    expect(result.next.map(item => item.id)).toEqual(['k2']);
    expect(result.applied).toEqual(['k1']);
    expect(result.ignored).toEqual(['k2', 'nope']);
  });

  it('returns an unchanged copy for garbage input', () => {
    const result = mergeExtensionKeyChanges(current, { upsert: 'x', remove: [null, 5] }, normalize);
    expect(result.changed).toBe(false);
    expect(result.next).toEqual(current);
  });
});

describe('createExtensionKeySync (two-way additions)', () => {
  it('tells the extension to stop syncing when clear-on-exit is on, once', async () => {
    const { bridge, calls } = recordingBridge();
    const sync = createExtensionKeySync(bridge);
    await sync.update([{ id: 'k1', provider: 'google', key: 'a' }]);
    await sync.update([], { syncDisabled: true });
    await sync.update([], { syncDisabled: true });
    await sync.update([{ id: 'k1', provider: 'google', key: 'a' }]);
    expect(calls.map(call => [call.type, call.payload.revision, call.payload.syncDisabled ?? false])).toEqual([
      ['keys.snapshot', 1, false],
      ['keys.snapshot', 2, true],
      ['keys.snapshot', 3, false],
    ]);
  });

  it('continues above the revision the extension reported and resends a full snapshot', async () => {
    const { bridge, calls } = recordingBridge();
    const sync = createExtensionKeySync(bridge);
    const k1 = { id: 'k1', provider: 'google', key: 'a', updatedAt: 1 };
    await sync.update([k1]);
    sync.noteRemoteRevision(7);
    await sync.update([k1]);
    expect(calls.at(-1)).toEqual({ type: 'keys.snapshot', payload: { revision: 8, keys: [k1] } });
  });
});
