// @vitest-environment node
// Iris Link 中继（worker/linkRelay.ts）在 Miniflare（真实 workerd + Durable Object + WebSocket Hibernation）里的行为测试。
// CLI 一侧用真实的 WebLinkClient（Node 全局 WebSocket），标签页一侧用 ws（能带 Origin 头）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';
import { LINK_MAX_FRAME_BYTES, LINK_WS_BEARER_PREFIX, LINK_WS_SUBPROTOCOL } from '../tools/iris/link/protocol.js';
import { pollPairing, saveLinkTokens, startPairing, WebLinkClient } from '../tools/iris/link/web-link-client.js';
import { readLink } from '../tools/iris/link/link-store.js';
import { expectOwnerOnlyFile } from './helpers/fileMode';

const TAB_ORIGIN = 'http://tab.test';
let mf: Miniflare;
let base: string;
let dir: string;
let ipSeq = 0;

function headers(extra: Record<string, string> = {}) {
  ipSeq += 1;
  return { 'content-type': 'application/json', 'cf-connecting-ip': `10.0.${Math.floor(ipSeq / 200)}.${ipSeq % 200}`, ...extra };
}

async function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: headers(extra), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

/** 发起配对并在「页面」上批准，返回 CLI 的令牌和标签页令牌。 */
async function pairAndApprove(scopes = ['agent.read', 'agent.run'], grant = scopes) {
  const pairing = await startPairing({ baseUrl: base, clientName: 'test-cli', scopes });
  const info = await fetch(base + '/api/link/pair/info?code=' + pairing.code, { headers: { origin: TAB_ORIGIN } }).then(r => r.json() as any);
  expect(info.ok).toBe(true);
  const decided = await post('/api/link/pair/decide', { code: pairing.code, approve: true, scopes: grant }, { origin: TAB_ORIGIN });
  expect(decided.body.ok).toBe(true);
  const tokens = await pollPairing(pairing, { intervalMs: 10, timeoutMs: 5000 });
  return { pairing, info, tabToken: decided.body.tabToken as string, tokens };
}

function openTab(tabToken: string, origin = TAB_ORIGIN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/link/ws?role=tab', [LINK_WS_SUBPROTOCOL, LINK_WS_BEARER_PREFIX + tabToken], { headers: { origin } });
    ws.once('message', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
  });
}

/** 假标签页：收到 req 就按 handler 回 res。 */
function serveTab(ws: WebSocket, handler: (frame: any) => unknown) {
  ws.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t !== 'req') return;
    const result = handler(frame);
    ws.send(JSON.stringify({ t: 'res', id: frame.id, ...(result as object) }));
  });
}

function cliFor(tokens: any) {
  const file = join(dir, `link-${Math.random().toString(16).slice(2)}.json`);
  saveLinkTokens(base, tokens, { file });
  return { client: new WebLinkClient({ storeOptions: { file } }), file };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'iris-link-relay-'));
  const outfile = join(dir, 'worker.mjs');
  await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile, external: ['node:*', 'cloudflare:*'], logLevel: 'silent' });
  mf = new Miniflare({
    modules: true,
    // modulesRoot 必须包含 scriptPath：否则模块名按 cwd 求相对路径，脚本在系统临时目录时会带 `..`
    // （Windows 上临时目录与仓库常不在同一盘符），workerd 拒绝启动（77ba337 的 Windows CI 失败）。
    modulesRoot: dir,
    scriptPath: outfile,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { IRIS_LINK: { className: 'IrisLinkRelay', useSQLite: true } },
    bindings: { LINK_ALLOWED_ORIGINS: TAB_ORIGIN },
    serviceBindings: { ASSETS: () => new Response('asset') },
  });
  base = (await mf.ready).origin;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('Iris Link relay (Durable Object)', () => {
  it('pairs: start → page sees client + scopes → approve → CLI poll gets tokens once', async () => {
    const pairing = await startPairing({ baseUrl: base, clientName: 'sandbox-cli', scopes: ['agent.read', 'agent.run', 'agent.approve'], mode: 'device' });
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pairing.verificationUrlComplete).toBe(base + '/link?code=' + encodeURIComponent(pairing.code));
    const pending = await post('/api/link/pair/poll', { pollToken: pairing.pollToken });
    expect(pending.status).toBe(202);
    const info = await fetch(base + '/api/link/pair/info?code=' + pairing.code.replace('-', '').toLowerCase(), { headers: { origin: TAB_ORIGIN } }).then(r => r.json() as any);
    expect(info).toMatchObject({ ok: true, clientName: 'sandbox-cli', requestedScopes: ['agent.read', 'agent.run', 'agent.approve'], mode: 'device' });
    expect(info.source.ip).toMatch(/x\.x$/);
    // 页面只授予一部分（不给 agent.approve）。
    const decided = await post('/api/link/pair/decide', { code: pairing.code, approve: true, scopes: ['agent.run', 'tools.invoke'] }, { origin: TAB_ORIGIN });
    expect(decided.body).toMatchObject({ ok: true, approved: true, scopes: ['agent.read', 'agent.run'] });
    const tokens = await pollPairing(pairing, { intervalMs: 10 });
    expect(tokens.accessToken).toMatch(/^ilk_a_/);
    expect(tokens.refreshToken).toMatch(/^ilk_r_/);
    expect(tokens.scopes).toEqual(['agent.read', 'agent.run']);
    const again = await post('/api/link/pair/poll', { pollToken: pairing.pollToken });
    expect(again.status).toBe(401);
    // 配对码一次性。
    const reuse = await fetch(base + '/api/link/pair/info?code=' + pairing.code, { headers: { origin: TAB_ORIGIN } });
    expect(reuse.status).toBe(404);
  });

  it('rejects page endpoints without an allowed Origin, and CLI endpoints from foreign pages', async () => {
    const pairing = await startPairing({ baseUrl: base });
    expect((await fetch(base + '/api/link/pair/info?code=' + pairing.code)).status).toBe(403);
    expect((await fetch(base + '/api/link/pair/info?code=' + pairing.code, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    // 浏览器对同源 GET 不带 Origin，只带 Sec-Fetch-Site: same-origin。
    expect((await fetch(base + '/api/link/pair/info?code=' + pairing.code, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await fetch(base + '/api/link/pair/info?code=' + pairing.code, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const forged = await post('/api/link/pair/decide', { code: pairing.code, approve: true }, { origin: 'https://evil.example' });
    expect(forged.status).toBe(403);
    const foreignStart = await post('/api/link/pair/start', { clientName: 'x' }, { origin: 'https://evil.example' });
    expect(foreignStart.status).toBe(403);
  });

  it('denied pairing tells the CLI PAIR_DENIED', async () => {
    const pairing = await startPairing({ baseUrl: base });
    await post('/api/link/pair/decide', { code: pairing.code, approve: false }, { origin: TAB_ORIGIN });
    await expect(pollPairing(pairing, { intervalMs: 10 })).rejects.toMatchObject({ code: 'PAIR_DENIED' });
  });

  it('rate-limits pairing per source IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(base + '/api/link/pair/start', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.77' }, body: '{}' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('relays CLI requests to the tab and back; TAB_OFFLINE when no tab; scope checked at the relay', async () => {
    const { tabToken, tokens } = await pairAndApprove();
    const { client, file } = cliFor(tokens);
    expectOwnerOnlyFile(file);
    await client.connect();
    expect(client.tabOnline).toBe(false);
    await expect(client.request('agent.sessions', {})).rejects.toMatchObject({ code: 'TAB_OFFLINE' });

    const tab = await openTab(tabToken);
    const seen: any[] = [];
    serveTab(tab, frame => { seen.push(frame); return { ok: true, data: { echo: frame.cmd, args: frame.args } }; });
    await wait(150);
    expect(client.tabOnline).toBe(true);
    const data = await client.request('agent.send', { prompt: 'hi' }, { idempotencyKey: 'k1' });
    expect(data).toEqual({ echo: 'agent.send', args: { prompt: 'hi' } });
    expect(seen[0]).toMatchObject({ cmd: 'agent.send', idem: 'k1', grant: { scopes: ['agent.read', 'agent.run'], clientName: 'test-cli' } });
    // agent.approve 没授予：中继直接拒绝，标签页看不到。
    await expect(client.request('agent.approve', { runId: 'r', approvalId: 'a' }, { idempotencyKey: 'k2' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(client.request('agent.tools.invoke', { tool: 'iris_note_write', execute: true }, { idempotencyKey: 'k3' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(client.request('workflow.apply', {})).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND' });
    expect(seen.map(frame => frame.cmd)).toEqual(['agent.send']);

    // 标签页关掉：CLI 收到 TAB_OFFLINE，在途请求立即失败。
    tab.removeAllListeners('message');
    const silent = new Promise(resolve => tab.once('message', resolve));
    const inflight = client.request('agent.trace', { runId: 'x' });
    await silent;
    tab.close();
    await expect(inflight).rejects.toMatchObject({ code: 'TAB_OFFLINE' });
    client.close();
  });

  it('rejects oversize frames and rate-limits a chatty CLI', async () => {
    const { tabToken, tokens } = await pairAndApprove();
    const tab = await openTab(tabToken);
    serveTab(tab, () => ({ ok: true, data: 1 }));
    const { client } = cliFor(tokens);
    await client.connect();
    await expect(client.request('agent.sessions', { blob: 'x'.repeat(LINK_MAX_FRAME_BYTES) })).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' });
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => client.request('agent.sessions', {})));
    const limited = results.filter(item => item.status === 'rejected' && (item.reason as any).code === 'RATE_LIMITED');
    expect(limited.length).toBeGreaterThan(5);
    client.close();
    tab.close();
  });

  it('refresh rotates tokens; the old refresh and tokens from other rooms are rejected', async () => {
    const a = await pairAndApprove();
    const b = await pairAndApprove();
    const { client, file } = cliFor(a.tokens);
    const before = readLink({ file })!;
    await client.refresh();
    const after = readLink({ file })!;
    expect(after.refreshToken).not.toBe(before.refreshToken);
    const stale = await post('/api/link/token/refresh', { refreshToken: before.refreshToken });
    expect(stale.status).toBe(401);
    // 令牌与房间绑定：把 A 的访问令牌换成 B 的房间号不能用。
    const swapped = after.accessToken.replace(a.tokens.roomId, b.tokens.roomId);
    const status = await fetch(base + '/api/link/status', { headers: { authorization: 'Bearer ' + swapped } });
    expect(status.status).toBe(401);
    const ok = await client.status();
    expect(ok).toMatchObject({ ok: true, clientName: 'test-cli', tabOnline: false });
  });

  it('revoke from the CLI closes the tab socket and kills every token', async () => {
    const { tabToken, tokens } = await pairAndApprove();
    const tab = await openTab(tabToken);
    const closed = new Promise<string>(resolve => tab.on('message', raw => { const frame = JSON.parse(String(raw)); if (frame.t === 'sys') resolve(frame.code); }));
    const { client } = cliFor(tokens);
    await client.revoke();
    expect(await closed).toBe('REVOKED');
    const status = await fetch(base + '/api/link/status', { headers: { authorization: 'Bearer ' + tokens.accessToken } });
    expect(status.status).toBe(401);
    await expect(openTab(tabToken)).rejects.toThrow(/401/);
  });

  it('revoke from the tab (page) drops the CLI with REVOKED', async () => {
    const { tabToken, tokens } = await pairAndApprove();
    const { client } = cliFor(tokens);
    await client.connect();
    const systems: string[] = [];
    client.onSystem(frame => systems.push(frame.code));
    const res = await post('/api/link/revoke', {}, { authorization: 'Bearer ' + tabToken, origin: TAB_ORIGIN });
    expect(res.body).toMatchObject({ ok: true, by: 'tab' });
    await wait(150);
    expect(systems).toContain('REVOKED');
    await expect(client.request('agent.sessions', {})).rejects.toBeTruthy();
  });

  it('tab sockets need an allowed Origin; a second tab replaces the first', async () => {
    const { tabToken, tokens } = await pairAndApprove();
    await expect(openTab(tabToken, 'https://evil.example')).rejects.toThrow(/403/);
    const first = await openTab(tabToken);
    const replaced = new Promise<string>(resolve => first.on('message', raw => { const frame = JSON.parse(String(raw)); if (frame.t === 'sys') resolve(frame.code); }));
    const second = await openTab(tabToken);
    expect(await replaced).toBe('REPLACED');
    serveTab(second, () => ({ ok: true, data: 'second' }));
    const { client } = cliFor(tokens);
    expect(await client.request('link.status', {})).toBe('second');
    client.close();
    second.close();
  });
});
