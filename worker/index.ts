// Cloudflare Workers entry for iris.avabbbb.com (Workers + static assets, see wrangler.jsonc).
// Only /api/* reaches this Worker (assets.run_worker_first = ["/api/*"]); every other path is
// served straight from the asset layer with the COOP/COEP headers from public/_headers, so
// static traffic costs no Worker invocations.
//   /api/llm-proxy/*  → server/llmProxy.ts (stateless same-origin CORS proxy for allowlisted gateways)
//   /api/link/*       → worker/linkRelay.ts (Iris Link relay: CLI ↔ browser tab, Durable Object per pairing;
//                       forwards frames only — never stores canvas content or touches model keys)
//   other /api/*      → 404 JSON (there is no other server API; the web app is fully static)
import { handleLlmProxy, LLM_PROXY_PREFIX } from '../server/llmProxy';
import { handleLinkRequest, LINK_PREFIX, type LinkEnv } from './linkRelay';

export { IrisLinkRelay } from './linkRelay';

export interface Env extends LinkEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Optional comma-separated extra origins, e.g. a preview domain. */
  LLM_PROXY_ALLOWED_ORIGINS?: string;
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(LLM_PROXY_PREFIX)) {
      return handleLlmProxy(request, { allowedOrigins: parseAllowedOrigins(env.LLM_PROXY_ALLOWED_ORIGINS) });
    }
    if (pathname.startsWith(LINK_PREFIX)) return handleLinkRequest(request, env);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
