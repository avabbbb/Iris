import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureIris, parseJsonOutput, resolveSourceDir, startArguments } from '../tools/iris/ensure.js';

describe('iris ensure', () => {
  it('parses the existing start JSON without leaking its transport details', () => {
    expect(parseJsonOutput(`starting\n${JSON.stringify({ ok: true, agent: { url: 'http://127.0.0.1:17373' } }, null, 2)}`)).toEqual({
      ok: true,
      agent: { url: 'http://127.0.0.1:17373' },
    });
  });

  it('reuses a ready session without starting another Runtime', async () => {
    const startRunner = vi.fn();
    const statusReader = vi.fn().mockResolvedValue({ ready: true, agent: { status: 'ready' }, browserConnected: true, frontend: { status: 'ready' }, projectId: 'project-1', revision: 4 });
    await expect(ensureIris({ statusReader, startRunner })).resolves.toMatchObject({ ok: true, state: 'ready', browser: 'ready', projectId: 'project-1', revision: 4 });
    expect(startRunner).not.toHaveBeenCalled();
  });

  it('starts through the existing source launcher and returns only public readiness', async () => {
    const statusReader = vi.fn()
      .mockResolvedValueOnce({ ready: false, agent: { status: 'offline' }, browserConnected: false, frontend: { status: 'offline' } })
      .mockResolvedValueOnce({ ready: true, agent: { status: 'ready', url: 'http://127.0.0.1:17373' }, browserConnected: true, frontend: { status: 'ready', url: 'http://127.0.0.1:2818' }, projectId: 'project-1', revision: 42 });
    const startRunner = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' });
    const result = await ensureIris({ statusReader, startRunner, cwd: process.cwd(), open: false });
    expect(result).toMatchObject({ ok: true, state: 'ready', frontend: 'ready', agent: 'ready', browser: 'ready' });
    expect(JSON.stringify(result)).not.toContain('17373');
    expect(startRunner).toHaveBeenCalledWith(expect.arrayContaining(['start', '--source', '--web', '--json', '--no-open']), expect.anything());
  });

  it('keeps the stable command separate from the developer command registry', () => {
    expect(startArguments(process.cwd(), true)).toEqual(['start', '--source', '--web', '--json', '--open']);
  });

  // 2026-11-15 评测：前端已在运行时 `ensure --web` 起不来 Agent，只能改用 `start --source`。
  describe('frontend already running', () => {
    const frontendUp = { ready: false, agent: { status: 'offline' }, browserConnected: false, frontend: { status: 'ready', url: 'http://127.0.0.1:40123' } };
    const allUp = { ready: true, agent: { status: 'ready', url: 'http://127.0.0.1:17373' }, browserConnected: true, frontend: { status: 'ready', url: 'http://127.0.0.1:40123' }, projectId: 'p', revision: 1 };

    it('resolves the CLI\'s own source checkout when run from another directory', () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'iris-ensure-'));
      expect(resolveSourceDir(elsewhere)).toBe(process.cwd());
      expect(resolveSourceDir(process.cwd())).toBe(process.cwd());
    });

    it('starts the source Agent from another directory and reuses the running WebUI port', async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'iris-ensure-'));
      const statusReader = vi.fn().mockResolvedValueOnce(frontendUp).mockResolvedValueOnce(allUp);
      const startRunner = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' });
      const result = await ensureIris({ statusReader, startRunner, cwd: elsewhere, open: false, web: true });
      expect(result).toMatchObject({ ok: true, agent: 'ready', frontend: 'ready' });
      const [args, options] = startRunner.mock.calls[0];
      // 旧实现：cwd 不是源码仓库 → `start --json --no-open` 走 toolkit 模式，Agent 起不来
      expect(args).toEqual(['start', '--source', '--web', '--web-port=40123', '--json', '--no-open']);
      expect(options.cwd).toBe(process.cwd());
    });

    it('honours --web even when no source checkout can be found', () => {
      expect(startArguments('/nowhere', false, { sourceDir: null, web: true })).toEqual(['start', '--source', '--web', '--json', '--no-open']);
      expect(startArguments('/nowhere', false, { sourceDir: null })).toEqual(['start', '--json', '--no-open']);
    });

    it('does not pass a non-loopback frontend port through', () => {
      expect(startArguments(process.cwd(), false, { status: { frontend: { status: 'ready', url: 'https://iris.example.com:8443' } } }))
        .toEqual(['start', '--source', '--web', '--json', '--no-open']);
    });
  });

  describe('hosted Iris Link web-first mode', () => {
    it('reuses an online paired Iris Link tab without starting local Vite', async () => {
      const startRunner = vi.fn();
      const statusReader = vi.fn().mockResolvedValue({ ready: false, agent: { status: 'offline' }, browserConnected: false, frontend: { status: 'offline' } });
      const webLinkReader = vi.fn().mockResolvedValue({ ok: true, linked: true, tabOnline: true, url: 'https://iris.avabbbb.com', tab: { projectId: 'p-web' } });
      const result = await ensureIris({ statusReader, webLinkReader, startRunner });
      expect(result).toMatchObject({ ok: true, state: 'ready', mode: 'web-link', browser: 'ready', projectId: 'p-web', url: 'https://iris.avabbbb.com' });
      expect(startRunner).not.toHaveBeenCalled();
    });

    it('returns needs_login with login web guidance when given an unpaired hosted URL', async () => {
      const startRunner = vi.fn();
      const statusReader = vi.fn().mockResolvedValue({ ready: false, agent: { status: 'offline' }, browserConnected: false, frontend: { status: 'offline' } });
      const webLinkReader = vi.fn().mockResolvedValue(null);
      const result = await ensureIris({ url: 'https://iris.avabbbb.com', statusReader, webLinkReader, startRunner });
      expect(result).toMatchObject({ ok: false, state: 'needs_login', mode: 'web-link' });
      expect(result.error.message).toContain('login web --open --url https://iris.avabbbb.com');
      expect(startRunner).not.toHaveBeenCalled();
    });
  });
});
