/**
 * Same-origin LLM proxy core (shared by the Cloudflare Worker entry worker/index.ts and the
 * Vite dev middleware).
 *
 * Why: some OpenAI-compatible gateways (OpenCode Go / Zen at opencode.ai) do
 * not answer the browser's CORS preflight (OPTIONS → 404, no
 * Access-Control-Allow-Origin), so the hosted Web build cannot call them
 * directly. The browser instead calls `/api/llm-proxy/<host>/<path>` on its own
 * origin and this handler forwards the request server-side.
 *
 * Guard rails — this must never become an open relay:
 * - upstream host + path prefix allowlist (UPSTREAMS below);
 * - same-origin only (Origin / Sec-Fetch-Site checked);
 * - GET/POST only, Authorization (or provider key header) required;
 * - request body size cap;
 * - only a fixed set of request headers is forwarded (no cookies);
 * - nothing about the request (keys, prompts) is logged.
 *
 * Timeouts (magpie #8): there is deliberately NO total-duration timeout — a
 * long reasoning stream is healthy as long as bytes keep arriving. Instead an
 * upstream that makes no progress (no response headers, or no body bytes while
 * we are waiting for the next chunk) for `idleTimeoutMs` is aborted. For SSE
 * responses we also emit `: keepalive` comment lines while the upstream is
 * silent, so idle-connection reapers between the browser and the edge do not
 * drop a stream that is merely thinking (see relayUpstreamBody).
 *
 * BYOK note: the user's API key passes through this proxy in transit (TLS on
 * both legs). It is never stored or logged.
 */

export const LLM_PROXY_PREFIX = '/api/llm-proxy/';

/** host → allowed path prefixes. Keep this list short and explicit. */
export const LLM_PROXY_UPSTREAMS: Record<string, readonly string[]> = {
  'opencode.ai': ['/inference/', '/zen/'],
  'www.runninghub.cn': ['/runninghub-api-doc-cn/'],
  'www.runninghub.ai': ['/runninghub-api-doc-en/'],
};

/**
 * Public, key-less documentation upstreams (RunningHub API docs: llms.txt + per-API markdown).
 * These are GET-only, need no API key, and only `.md` / `llms.txt` resources are reachable.
 * Iris reads them to build RunningHub route schemas dynamically (the docs are not CORS-enabled).
 */
export const LLM_PROXY_PUBLIC_DOC_UPSTREAMS: Record<string, readonly string[]> = {
  'www.runninghub.cn': ['/runninghub-api-doc-cn/'],
  'www.runninghub.ai': ['/runninghub-api-doc-en/'],
};

/** True when the upstream is a public doc resource that may be fetched without an API key. */
export function isPublicDocUpstream(upstream: URL): boolean {
  const prefixes = LLM_PROXY_PUBLIC_DOC_UPSTREAMS[upstream.hostname.toLowerCase()];
  if (!prefixes) return false;
  const path = upstream.pathname;
  if (!prefixes.some((p) => path.startsWith(p))) return false;
  const leaf = path.slice(path.lastIndexOf('/') + 1);
  return leaf === 'llms.txt' || /^[A-Za-z0-9_-]+\.md$/.test(leaf);
}

const FORWARDED_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version',
  'anthropic-beta',
  'x-opencode-session',
  'x-session-id',
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'x-request-id',
  'x-opencode-log-id',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
] as const;

export const LLM_PROXY_MAX_BODY_BYTES = 32 * 1024 * 1024;
/**
 * No-progress timeout: abort when the upstream sends nothing (headers or body
 * bytes) for this long. Generous because non-streaming requests to reasoning
 * models legitimately stay silent until the whole answer is ready.
 */
export const LLM_PROXY_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** SSE keepalive interval while the upstream is silent. Keepalives do not count as upstream progress. */
export const LLM_PROXY_SSE_KEEPALIVE_MS = 15 * 1000;
/**
 * SSE comment line (spec: lines starting with ':' are ignored by EventSource
 * and by every OpenAI-compatible stream parser; OpenRouter sends the same kind).
 */
const SSE_KEEPALIVE = new TextEncoder().encode(': keepalive\n\n');
export const LLM_PROXY_USER_AGENT = 'iris-web/0.3 (+https://github.com/avabbbb/Iris)';

function jsonError(status: number, message: string, code: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'iris_proxy_error', code } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Parse `/api/llm-proxy/<host>/<path>?<query>` into an allowlisted upstream URL. */
export function resolveUpstreamUrl(requestUrl: URL): URL | null {
  if (!requestUrl.pathname.startsWith(LLM_PROXY_PREFIX)) return null;
  const rest = requestUrl.pathname.slice(LLM_PROXY_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const host = rest.slice(0, slash).toLowerCase();
  const path = rest.slice(slash);
  const prefixes = LLM_PROXY_UPSTREAMS[host];
  if (!prefixes) return null;
  // Reject traversal / encoded tricks before matching the prefix.
  if (path.includes('..') || /%2e|%2f|%5c|\\/i.test(path)) return null;
  if (!prefixes.some((p) => path.startsWith(p))) return null;
  const upstream = new URL(`https://${host}${path}`);
  if (upstream.hostname !== host) return null;
  upstream.search = requestUrl.search;
  return upstream;
}

function isSameOrigin(request: Request, requestUrl: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === requestUrl.origin;
  const site = request.headers.get('sec-fetch-site');
  // Same-origin GETs may omit Origin; browsers always send Sec-Fetch-Site.
  return site === 'same-origin';
}

export interface LlmProxyOptions {
  /** Extra allowed origins (e.g. a preview domain). */
  allowedOrigins?: readonly string[];
  fetchImpl?: typeof fetch;
  /** Override LLM_PROXY_IDLE_TIMEOUT_MS (tests / env). */
  idleTimeoutMs?: number;
  /** Override LLM_PROXY_SSE_KEEPALIVE_MS (tests); 0 disables keepalives. */
  sseKeepAliveMs?: number;
}

/** Abort when either the client goes away or our idle timer fires. */
function linkedAbort(clientSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort(clientSignal.reason);
    else clientSignal.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true });
  }
  return controller;
}

/** True when the bytes forwarded so far end on an SSE event boundary (blank line). */
function endsOnEventBoundary(tail: number[]): boolean {
  const n = tail.length;
  if (n >= 2 && tail[n - 1] === 0x0a && tail[n - 2] === 0x0a) return true;
  if (n >= 4 && tail[n - 1] === 0x0a && tail[n - 2] === 0x0d && tail[n - 3] === 0x0a && tail[n - 4] === 0x0d) return true;
  return false;
}

export class UpstreamIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`Upstream made no progress for ${Math.round(ms / 1000)}s`);
    this.name = 'UpstreamIdleTimeoutError';
  }
}

/**
 * Pass the upstream body through unchanged, with a no-progress timeout and SSE
 * keepalives. Timers only run while we are waiting on the upstream (inside
 * pull), so a slow *client* (backpressure) never counts as upstream silence.
 * A keepalive is only inserted on an event boundary so it can never split an
 * event the upstream is halfway through sending.
 */
export function relayUpstreamBody(
  body: ReadableStream<Uint8Array>,
  opts: { sse: boolean; idleTimeoutMs: number; keepAliveMs: number; abortUpstream: (reason: unknown) => void },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let tail: number[] = [];
  let sentAny = false;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let keepTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<'idle'>((resolve) => { idleTimer = setTimeout(() => resolve('idle'), opts.idleTimeoutMs); });
      if (opts.sse && opts.keepAliveMs > 0) {
        const tick = () => {
          if (finished) return;
          if (!sentAny || endsOnEventBoundary(tail)) controller.enqueue(SSE_KEEPALIVE);
          keepTimer = setTimeout(tick, opts.keepAliveMs);
        };
        keepTimer = setTimeout(tick, opts.keepAliveMs);
      }
      try {
        const result = await Promise.race([reader.read(), idle]);
        if (result === 'idle') {
          finished = true;
          const err = new UpstreamIdleTimeoutError(opts.idleTimeoutMs);
          opts.abortUpstream(err);
          reader.cancel(err).catch(() => {});
          controller.error(err);
          return;
        }
        if (result.done) {
          finished = true;
          controller.close();
          return;
        }
        const chunk = result.value;
        if (chunk.byteLength > 0) {
          sentAny = true;
          tail = [...tail, ...chunk.subarray(Math.max(0, chunk.byteLength - 4))].slice(-4);
        }
        controller.enqueue(chunk);
      } catch (err) {
        finished = true;
        controller.error(err);
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(keepTimer);
      }
    },
    cancel(reason) {
      finished = true;
      opts.abortUpstream(reason);
      return reader.cancel(reason).catch(() => {});
    },
  });
}

export async function handleLlmProxy(request: Request, options: LlmProxyOptions = {}): Promise<Response> {
  const requestUrl = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    // Same-origin callers never preflight; answering cross-origin ones would only widen access.
    return new Response(null, { status: 204, headers: { allow: 'GET, POST' } });
  }
  if (method !== 'GET' && method !== 'POST') {
    return jsonError(405, 'Method not allowed', 'method_not_allowed');
  }

  const origin = request.headers.get('origin');
  const allowedExtra = origin && options.allowedOrigins?.includes(origin);
  if (!allowedExtra && !isSameOrigin(request, requestUrl)) {
    return jsonError(403, 'Cross-origin use of the Iris LLM proxy is not allowed', 'forbidden_origin');
  }

  const upstream = resolveUpstreamUrl(requestUrl);
  if (!upstream) {
    return jsonError(400, 'Upstream is not on the Iris LLM proxy allowlist', 'upstream_not_allowed');
  }

  // Doc hosts are only reachable for their public .md / llms.txt resources, and only via GET.
  const publicDoc = isPublicDocUpstream(upstream);
  if (LLM_PROXY_PUBLIC_DOC_UPSTREAMS[upstream.hostname] && (!publicDoc || method !== 'GET')) {
    return jsonError(400, 'Upstream is not on the Iris LLM proxy allowlist', 'upstream_not_allowed');
  }

  const headers = new Headers();
  if (publicDoc) {
    // Never forward credentials to the public doc host.
    headers.set('accept', 'text/markdown, text/plain, */*');
  } else for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!publicDoc && !headers.has('authorization') && !headers.has('x-api-key') && !headers.has('x-goog-api-key')) {
    return jsonError(401, 'Missing API key', 'missing_api_key');
  }
  headers.set('user-agent', LLM_PROXY_USER_AGENT);
  // OpenCode Go rejects requests without a session id (400 MissingSessionID).
  // The Web shim always sends a stable one; this is only a last-resort fallback.
  if (upstream.hostname === 'opencode.ai' && !headers.has('x-opencode-session')) {
    headers.set('x-opencode-session', `ses_iris_${crypto.randomUUID().replace(/-/g, '')}`);
  }

  let body: ArrayBuffer | undefined;
  if (method === 'POST') {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > LLM_PROXY_MAX_BODY_BYTES) return jsonError(413, 'Request body too large', 'body_too_large');
    body = await request.arrayBuffer();
    if (body.byteLength > LLM_PROXY_MAX_BODY_BYTES) return jsonError(413, 'Request body too large', 'body_too_large');
  }

  const doFetch = options.fetchImpl ?? fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? LLM_PROXY_IDLE_TIMEOUT_MS;
  // Client abort (stop button / tab close) and the no-progress timer both cancel the upstream call.
  const upstreamAbort = linkedAbort(request.signal);
  let headersTimedOut = false;
  const headersTimer = setTimeout(() => {
    headersTimedOut = true;
    upstreamAbort.abort(new UpstreamIdleTimeoutError(idleTimeoutMs));
  }, idleTimeoutMs);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await doFetch(upstream.toString(), {
      method,
      headers,
      body,
      signal: upstreamAbort.signal,
      redirect: 'manual',
    });
  } catch (error) {
    if (request.signal?.aborted) return jsonError(499, 'Client closed request', 'client_closed');
    if (headersTimedOut) return jsonError(504, 'Upstream did not respond in time', 'upstream_idle_timeout');
    return jsonError(502, 'Upstream request failed', 'upstream_unreachable');
  } finally {
    clearTimeout(headersTimer);
  }

  const responseHeaders = new Headers({ 'cache-control': 'no-store', 'x-flovart-proxy': '1' });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const sse = (upstreamResponse.headers.get('content-type') || '').includes('text/event-stream');
  if (sse) {
    responseHeaders.set('cache-control', 'no-cache, no-transform');
    responseHeaders.set('x-accel-buffering', 'no');
  }
  // Body bytes are streamed through untouched (SSE chunks and error JSON both pass as-is);
  // the only addition is `: keepalive` comment lines between SSE events while the upstream is silent.
  const relayed = upstreamResponse.body
    ? relayUpstreamBody(upstreamResponse.body, {
      sse,
      idleTimeoutMs,
      keepAliveMs: options.sseKeepAliveMs ?? LLM_PROXY_SSE_KEEPALIVE_MS,
      abortUpstream: (reason) => upstreamAbort.abort(reason),
    })
    : null;
  return new Response(relayed, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
