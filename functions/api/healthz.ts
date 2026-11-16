// Cloudflare Pages Function: GET /api/healthz (D1 reachability), same body as Go /healthz.
import { handleHubRequest } from '../../server/hub/app';
import type { HubEnv } from '../../server/hub/types';

export const onRequest = (context: { request: Request; env: HubEnv }): Promise<Response> =>
  handleHubRequest(context.request, context.env, {}, '/healthz');
