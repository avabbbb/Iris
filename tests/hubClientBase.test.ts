// Hub base URL: same-origin /api/v1 by default (Cloudflare Pages Functions), VITE_HUB_BASE_URL overrides.
import { describe, expect, it } from 'vitest';
import { LEGACY_LOCAL_HUB_BASE, resolveHubBaseUrl, SAME_ORIGIN_HUB_BASE } from '../services/hubClient';

describe('resolveHubBaseUrl', () => {
  it('defaults to same-origin /api/v1 on http(s)', () => {
    expect(resolveHubBaseUrl(null, 'https:')).toBe('/api/v1');
    expect(resolveHubBaseUrl(null, 'http:')).toBe(SAME_ORIGIN_HUB_BASE);
  });
  it('honours the override and strips trailing slashes', () => {
    expect(resolveHubBaseUrl('https://hub.example.com/api/v1/', 'https:')).toBe('https://hub.example.com/api/v1');
  });
  it('falls back to an absolute URL where there is no same-origin Function (Tauri / file)', () => {
    expect(resolveHubBaseUrl(null, 'tauri:')).toBe(LEGACY_LOCAL_HUB_BASE);
    expect(resolveHubBaseUrl(null, undefined)).toBe(LEGACY_LOCAL_HUB_BASE);
  });
});
