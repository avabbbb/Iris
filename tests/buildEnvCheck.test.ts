// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IRIS_SIDELOAD_EXTENSION_ID } from '../services/extensionBridge';
import { checkBuildEnv, extensionIdFromManifestKey } from '../scripts/check-build-env.mjs';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')) as { key?: string };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 只含检查需要的三个文件的最小仓库。 */
function fakeRoot(bridgeSource: string) {
  const dir = mkdtempSync(join(tmpdir(), 'iris-build-env-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'services'));
  mkdirSync(join(dir, 'extension'));
  writeFileSync(join(dir, 'services', 'extensionBridge.ts'), bridgeSource);
  writeFileSync(join(dir, 'extension', 'manifest.json'), JSON.stringify({ key: manifest.key }));
  writeFileSync(join(dir, 'vite-env.d.ts'), readFileSync(join(root, 'vite-env.d.ts'), 'utf8'));
  return dir;
}

describe('extension sideload ID', () => {
  it('IRIS_SIDELOAD_EXTENSION_ID is the ID Chrome derives from extension/manifest.json `key`', () => {
    expect(manifest.key, 'manifest.json must carry the public key that pins the sideload ID').toBeTruthy();
    expect(IRIS_SIDELOAD_EXTENSION_ID).toBe(extensionIdFromManifestKey(manifest.key!));
  });
});

describe('production build env check', () => {
  it('passes for this repo with no VITE_* set (sideload ID is the default)', () => {
    expect(checkBuildEnv({ env: {}, root })).toEqual([]);
  });

  it('B1: fails when no extension ID would reach production (06d1647^ shape)', () => {
    const dir = fakeRoot("const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;\n");
    expect(checkBuildEnv({ env: {}, root: dir }).map(f => f.rule)).toEqual(['B1']);
    expect(checkBuildEnv({ env: { VITE_IRIS_EXTENSION_IDS: IRIS_SIDELOAD_EXTENSION_ID }, root: dir })).toEqual([]);
  });

  it('B2: rejects malformed IDs instead of silently dropping them', () => {
    expect(checkBuildEnv({ env: { VITE_IRIS_EXTENSION_IDS: `${IRIS_SIDELOAD_EXTENSION_ID}, not-an-id` }, root }).map(f => f.rule)).toEqual(['B2']);
  });

  it('B3: fails when the constant drifts from the manifest key', () => {
    const dir = fakeRoot("export const IRIS_SIDELOAD_EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n");
    expect(checkBuildEnv({ env: {}, root: dir }).map(f => f.rule)).toEqual(['B3']);
  });

  it('B4: flags undeclared VITE_IRIS_* names (typos are otherwise ignored)', () => {
    expect(checkBuildEnv({ env: { VITE_IRIS_EXTENSION_ID: IRIS_SIDELOAD_EXTENSION_ID }, root }).map(f => f.rule)).toEqual(['B4']);
    expect(checkBuildEnv({ env: { VITE_APP_VERSION: '1', VITE_SOMETHING_ELSE: 'x' }, root })).toEqual([]);
  });
});
