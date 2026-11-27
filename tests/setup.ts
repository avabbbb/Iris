import { mkdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { resolveTestTempRoot } from '../scripts/test-temp-root.mjs';

// Keep Vitest's mkdtemp/tmpdir fixtures off the system drive. Local Windows
// runs accept any non-C: drive (or pin via IRIS_TEST_DRIVE), while GitHub Actions uses RUNNER_TEMP.
const testTempRoot = resolveTestTempRoot(process.cwd(), 'vitest');
mkdirSync(testTempRoot, { recursive: true });
process.env.TEMP = testTempRoot;
process.env.TMP = testTempRoot;
process.env.TMPDIR = testTempRoot;
// 测试进程（及其子进程）不迁移真实用户目录里的 ~/.flovart（tools/iris/legacy-bootstrap.js）。
process.env.IRIS_SKIP_LEGACY_COMPAT = '1';

// Node 25+ exposes a stub localStorage without methods unless --localstorage-file is passed.
// Provide a compliant in-memory Storage polyfill when methods are missing so Zustand persist & tests work cleanly.
function ensureMemoryStorage(target: Record<string, unknown>, key: 'localStorage' | 'sessionStorage') {
  const existing = target[key] as Partial<Storage> | undefined;
  if (existing && typeof existing.getItem === 'function' && typeof existing.setItem === 'function') return;
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, value: string) { store.set(String(k), String(value)); },
  };
  Object.defineProperty(target, key, { value: memoryStorage, configurable: true, writable: true });
}
ensureMemoryStorage(globalThis as unknown as Record<string, unknown>, 'localStorage');
ensureMemoryStorage(globalThis as unknown as Record<string, unknown>, 'sessionStorage');
if (typeof window !== 'undefined') {
  ensureMemoryStorage(window as unknown as Record<string, unknown>, 'localStorage');
  ensureMemoryStorage(window as unknown as Record<string, unknown>, 'sessionStorage');
}

// Polyfill WebCrypto for jsdom (Node 18+)
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto as unknown as Crypto,
    writable: true,
  });
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class TestResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: TestResizeObserver, writable: true });
}

// Mock URL.createObjectURL / revokeObjectURL (jsdom does not implement them)
let _blobCounter = 0;
const _activeUrls = new Set<string>();

// Override unconditionally — jsdom's stubs don't track object URLs
URL.createObjectURL = (blob: Blob | MediaSource): string => {
  const url = `blob:test/${++_blobCounter}`;
  _activeUrls.add(url);
  return url;
};

URL.revokeObjectURL = (url: string): void => {
  _activeUrls.delete(url);
};

/** Helper: return currently active blob URLs (for leak assertions). */
export function getActiveBlobUrls(): ReadonlySet<string> {
  return _activeUrls;
}

/** Helper: clear all tracked blob URLs between tests. */
export function resetBlobUrls(): void {
  _activeUrls.clear();
  _blobCounter = 0;
}

// Suites assert the Chinese UI; pin the locale so detectWorkspaceLanguage() picks Chinese under jsdom (en-US).
if (typeof window !== 'undefined') {
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
}
