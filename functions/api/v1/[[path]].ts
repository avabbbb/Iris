// Cloudflare Pages Function: Flovart Hub API (/api/v1/*), the TS port of the Go
// backend/. All logic lives in server/hub/app.ts; this file only binds env.
import { handleHubRequest } from '../../../server/hub/app';
import type { HubEnv } from '../../../server/hub/types';

export const onRequest = (context: { request: Request; env: HubEnv }): Promise<Response> =>
  handleHubRequest(context.request, context.env);
