// @vitest-environment node
// llm-proxy streaming: no total timeout, a no-progress (idle) timeout, and SSE keepalive comments.
import { describe, expect, it } from 'vitest';
import { handleLlmProxy, relayUpstreamBody, UpstreamIdleTimeoutError } from '../server/llmProxy';

const ORIGIN = 'https://iris.avabbbb.com';
const CHAT = `${ORIGIN}/api/llm-proxy/opencode.ai/inference/go/openai/v1/chat/completions`;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function req() {
  return new Request(CHAT, { method: 'POST', body: '{}', headers: { origin: ORIGIN, authorization: 'Bearer sk-test', 'content-type': 'application/json' } });
}

/** Upstream stream whose chunks we push by hand. */
function manualStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled: unknown = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctl = c; },
    cancel(reason) { cancelled = reason ?? true; },
  });
  return { stream, push: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close(), cancelled: () => cancelled };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('relayUpstreamBody', () => {
  it('has no total timeout: a slow but steadily progressing stream survives far past idleTimeoutMs', async () => {
    const up = manualStream();
    const out = relayUpstreamBody(up.stream, { sse: true, idleTimeoutMs: 60, keepAliveMs: 0, abortUpstream: () => {} });
    const text = readAll(out);
    for (let i = 0; i < 6; i++) {
      up.push(`data: ${i}\n\n`);
      await sleep(30); // total ≈ 180ms = 3× the idle timeout, but never 60ms of silence
    }
    up.close();
    expect(await text).toBe('data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\ndata: 5\n\n');
  });

  it('aborts after idleTimeoutMs without upstream bytes and errors the client stream', async () => {
    const up = manualStream();
    let aborted: unknown = null;
    const out = relayUpstreamBody(up.stream, { sse: true, idleTimeoutMs: 40, keepAliveMs: 0, abortUpstream: (r) => { aborted = r; } });
    up.push('data: first\n\n');
    await expect(readAll(out)).rejects.toBeInstanceOf(UpstreamIdleTimeoutError);
    expect(aborted).toBeInstanceOf(UpstreamIdleTimeoutError);
    expect(up.cancelled()).toBeTruthy();
  });

  it('sends `: keepalive` comments while silent, only between events, and they do not reset the idle timer', async () => {
    const up = manualStream();
    const out = relayUpstreamBody(up.stream, { sse: true, idleTimeoutMs: 200, keepAliveMs: 25, abortUpstream: () => {} });
    const text = readAll(out);
    up.push('data: {"a":');          // half an event: no keepalive may be injected here
    await sleep(70);
    up.push('1}\n\n');               // event complete → keepalives allowed
    await sleep(70);
    up.push('data: [DONE]\n\n');
    up.close();
    const body = await text;
    expect(body.startsWith('data: {"a":1}\n\n')).toBe(true);
    expect(body).toContain(': keepalive\n\n');
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
    // strip keepalives → exactly the upstream bytes
    expect(body.replaceAll(': keepalive\n\n', '')).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');

    const silent = manualStream();
    const out2 = relayUpstreamBody(silent.stream, { sse: true, idleTimeoutMs: 80, keepAliveMs: 15, abortUpstream: () => {} });
    await expect(readAll(out2)).rejects.toBeInstanceOf(UpstreamIdleTimeoutError);
  });

  it('never injects keepalives into non-SSE bodies', async () => {
    const up = manualStream();
    const out = relayUpstreamBody(up.stream, { sse: false, idleTimeoutMs: 200, keepAliveMs: 10, abortUpstream: () => {} });
    const text = readAll(out);
    await sleep(50);
    up.push('{"ok":true}');
    up.close();
    expect(await text).toBe('{"ok":true}');
  });
});

describe('handleLlmProxy idle handling', () => {
  it('returns 504 when the upstream sends no response headers within the idle timeout', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const res = await handleLlmProxy(req(), { fetchImpl, idleTimeoutMs: 30 });
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe('upstream_idle_timeout');
  });

  it('streams SSE with keepalives and passes the upstream bytes through', async () => {
    const up = manualStream();
    const fetchImpl = (async () => new Response(up.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const res = await handleLlmProxy(req(), { fetchImpl, idleTimeoutMs: 500, sseKeepAliveMs: 20 });
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    const text = res.text();
    await sleep(60);
    up.push('data: [DONE]\n\n');
    up.close();
    const body = await text;
    expect(body).toMatch(/^(: keepalive\n\n)+data: \[DONE\]\n\n$/);
  });

  it('client cancel aborts the upstream fetch', async () => {
    const up = manualStream();
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(up.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const res = await handleLlmProxy(req(), { fetchImpl, sseKeepAliveMs: 0 });
    await res.body!.cancel('stop');
    expect(signal?.aborted).toBe(true);
    expect(up.cancelled()).toBeTruthy();
  });
});
