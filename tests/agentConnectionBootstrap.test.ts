import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBrowserWorkflowBinding } from '../services/browserWorkflowBinding';
import {
  agentBootstrapStorageKeys,
  bootstrapLocalAgentConnection,
  consumeBrowserWriterAutoActivation,
  resetAgentConnectionBootstrapForTests,
} from '../services/agentConnectionBootstrap';
import { useAgentConnectionStore } from '../stores/useAgentConnectionStore';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

afterEach(() => {
  setBrowserWorkflowBinding(null);
  useAgentConnectionStore.getState().reset();
  resetAgentConnectionBootstrapForTests();
});

describe('AgentConnectionBootstrap', () => {
  it('exchanges a one-time browser credential before authenticating and never stores the launcher token', async () => {
    const session = storage();
    const replaceState = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/bootstrap/exchange') {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({ 'x-flovart-bootstrap-token': 'one-time-bootstrap' });
        return response({ ok: true, sessionToken: 'short-lived-session', expiresAt: Date.now() + 60_000 });
      }
      if (url.pathname === '/health') return response({ ok: true, clients: 0 });
      expect(url.pathname).toBe('/hosts');
      expect(url.search).toBe('?includeVersion=false');
      expect(init?.headers).toMatchObject({ 'x-flovart-agent-token': 'short-lived-session' });
      return response({ ok: true, agents: [] });
    });
    const location = {
      href: 'http://127.0.0.1:37522/?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&bootstrapToken=one-time-bootstrap#/app',
      search: '?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&bootstrapToken=one-time-bootstrap',
      hash: '#/app',
      pathname: '/',
    };

    const result = await bootstrapLocalAgentConnection({ location, history: { replaceState }, sessionStorage: session, fetchImpl, maxAttempts: 1 });

    expect(result.state).toBe('ready');
    expect(result.connection?.token).toBe('short-lived-session');
    expect(session.getItem(agentBootstrapStorageKeys.token)).toBe('short-lived-session');
    expect(session.getItem(agentBootstrapStorageKeys.expiresAt)).toBeTruthy();
    expect(replaceState).toHaveBeenCalledWith(null, expect.any(String), '/#/app');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('authenticates from launcher parameters, binds the browser, and scrubs the URL', async () => {
    const session = storage();
    const replaceState = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return response({ ok: true, clients: 0 });
      expect(url.pathname).toBe('/hosts');
      expect(url.search).toBe('?includeVersion=false');
      expect(init?.headers).toMatchObject({ 'x-flovart-agent-token': 'bootstrap-secret' });
      return response({ ok: true, agents: [] });
    });
    const location = {
      href: 'http://127.0.0.1:37522/?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&agentToken=bootstrap-secret#/app',
      search: '?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&agentToken=bootstrap-secret',
      hash: '#/app',
      pathname: '/',
    };

    const result = await bootstrapLocalAgentConnection({ location, history: { replaceState }, sessionStorage: session, fetchImpl, maxAttempts: 1 });

    expect(result.state).toBe('ready');
    expect(replaceState).toHaveBeenCalledWith(null, expect.any(String), '/#/app');
    expect(session.getItem(agentBootstrapStorageKeys.url)).toBe('http://127.0.0.1:17373');
    expect(session.getItem(agentBootstrapStorageKeys.token)).toBe('bootstrap-secret');
    expect(consumeBrowserWriterAutoActivation(session)).toBe(false);
    expect(useAgentConnectionStore.getState()).toMatchObject({ status: 'connecting', url: 'http://127.0.0.1:17373' });
    expect(JSON.stringify(useAgentConnectionStore.getState())).not.toContain('bootstrap-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('arms only launcher pages for one-shot Browser Writer activation and scrubs the flag', async () => {
    const session = storage();
    const replaceState = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).pathname === '/health'
      ? response({ ok: true })
      : response({ ok: true, agents: [] }));
    const location = {
      href: 'http://127.0.0.1:37522/?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&agentToken=bootstrap-secret&activateBrowserWriter=1#/app',
      search: '?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&agentToken=bootstrap-secret&activateBrowserWriter=1',
      hash: '#/app',
      pathname: '/',
    };

    await expect(bootstrapLocalAgentConnection({ location, history: { replaceState }, sessionStorage: session, fetchImpl, maxAttempts: 1 })).resolves.toMatchObject({ state: 'ready' });
    expect(session.getItem(agentBootstrapStorageKeys.autoActivate)).toBe('1');
    expect(replaceState).toHaveBeenCalledWith(null, expect.any(String), '/#/app');
    expect(consumeBrowserWriterAutoActivation(session)).toBe(true);
    expect(session.getItem(agentBootstrapStorageKeys.autoActivate)).toBeNull();
    expect(consumeBrowserWriterAutoActivation(session)).toBe(false);
  });

  it('reports auth failure, clears bootstrap credentials, and does not create a binding', async () => {
    const session = storage();
    const replaceState = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === '/health' ? response({ ok: true }) : response({ ok: false, error: 'invalid token' }, 401);
    });
    const location = {
      href: 'http://127.0.0.1:37522/?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&agentToken=wrong#/app',
      search: '?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&agentToken=wrong',
      hash: '#/app',
      pathname: '/',
    };

    const result = await bootstrapLocalAgentConnection({ location, history: { replaceState }, sessionStorage: session, fetchImpl, maxAttempts: 1 });

    expect(result.state).toBe('auth_failed');
    expect(useAgentConnectionStore.getState().status).toBe('auth_failed');
    expect(session.getItem(agentBootstrapStorageKeys.token)).toBeNull();
    expect(session.getItem(agentBootstrapStorageKeys.autoActivate)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, expect.any(String), '/#/app');
  });

  it('retries transient network failures on /bootstrap/exchange without losing the one-time token', async () => {
    const session = storage();
    const replaceState = vi.fn();
    let exchangeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/bootstrap/exchange') {
        exchangeCalls += 1;
        if (exchangeCalls === 1) throw new TypeError('Failed to fetch');
        return response({ ok: true, sessionToken: 'recovered-session', expiresAt: Date.now() + 60_000 });
      }
      if (url.pathname === '/health') return response({ ok: true, clients: 0 });
      return response({ ok: true, agents: [] });
    });
    const location = {
      href: 'https://iris.avabbbb.com/?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&bootstrapToken=one-time-retry&activateBrowserWriter=1#/app',
      search: '?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&bootstrapToken=one-time-retry&activateBrowserWriter=1',
      hash: '#/app',
      pathname: '/',
    };

    const result = await bootstrapLocalAgentConnection({ location, history: { replaceState }, sessionStorage: session, fetchImpl, retryDelayMs: 1, maxAttempts: 3 });

    expect(result.state).toBe('ready');
    expect(exchangeCalls).toBe(2);
    expect(result.connection?.token).toBe('recovered-session');
    expect(consumeBrowserWriterAutoActivation(session)).toBe(true);
  });

  it('retains pending bootstrap credentials in memory across offline failure so force reconnect succeeds after permission grant', async () => {
    const session = storage();
    const replaceState = vi.fn();
    let allowNetwork = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!allowNetwork) throw new TypeError('Failed to fetch');
      if (url.pathname === '/bootstrap/exchange') {
        return response({ ok: true, sessionToken: 'post-permission-session', expiresAt: Date.now() + 60_000 });
      }
      if (url.pathname === '/health') return response({ ok: true, clients: 0 });
      return response({ ok: true, agents: [] });
    });
    const initialLocation = {
      href: 'https://iris.avabbbb.com/?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&bootstrapToken=pending-token&activateBrowserWriter=1#/app',
      search: '?agentUrl=http%3A%2F%2F127.0.0.1%3A17373&bootstrapToken=pending-token&activateBrowserWriter=1',
      hash: '#/app',
      pathname: '/',
    };

    const first = await bootstrapLocalAgentConnection({
      location: initialLocation,
      history: { replaceState },
      sessionStorage: session,
      fetchImpl,
      maxAttempts: 1,
      diagnose: async () => ({ kind: 'blocked_by_page', at: new Date().toISOString(), url: 'http://127.0.0.1:17373' }),
    });
    expect(first.state).toBe('offline');
    expect(session.getItem(agentBootstrapStorageKeys.token)).toBeNull();

    // URL 已被擦除；用户放行本地网络权限后点「重新连接」应能用内存暂存的一次性凭证完成换票。
    allowNetwork = true;
    const scrubbedLocation = { href: 'https://iris.avabbbb.com/#/app', search: '', hash: '#/app', pathname: '/' };
    const second = await bootstrapLocalAgentConnection({
      force: true,
      location: scrubbedLocation,
      history: { replaceState },
      sessionStorage: session,
      fetchImpl,
      maxAttempts: 1,
    });
    expect(second.state).toBe('ready');
    expect(second.connection?.token).toBe('post-permission-session');
    expect(session.getItem(agentBootstrapStorageKeys.token)).toBe('post-permission-session');
    expect(consumeBrowserWriterAutoActivation(session)).toBe(true);
  });
});
