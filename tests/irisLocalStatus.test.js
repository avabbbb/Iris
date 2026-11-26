import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLocalStatus } from '../tools/iris/local-status.js';

const tempDirs = [];

afterEach(() => {
  delete process.env.IRIS_WEB_URL;
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('iris status', () => {
  it('reports frontend, Agent, and visible browser Workflow readiness without secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-local-status-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'agent.json');
    writeFileSync(configPath, JSON.stringify({ url: 'http://127.0.0.1:17373', token: 'secret-token' }), 'utf8');
    process.env.IRIS_WEB_URL = 'http://127.0.0.1:37522';
    const fetchImpl = async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/') return new Response('<body data-flovart-webui="1"></body>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (pathname === '/health') return new Response(JSON.stringify({ ok: true, hasWorkflow: true, clients: 1, clientId: 'browser-a', activeProjectId: 'project-a', revision: 4 }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, protocolVersion: '1' }), { status: 200 });
    };

    const result = await getLocalStatus({ configPath, fetchImpl });

    expect(result).toMatchObject({ ready: true, browserConnected: true, clientId: 'browser-a', projectId: 'project-a', revision: 4 });
    expect(result.frontend).toEqual({ status: 'ready', url: 'http://127.0.0.1:37522' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  }, 20_000);

  it('reports ready when the local Agent has a connected browser canvas even without a local Vite server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-local-status-hosted-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'agent.json');
    writeFileSync(configPath, JSON.stringify({ url: 'http://127.0.0.1:17373', token: 'secret-token' }), 'utf8');
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.port === '17373' && url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, hasWorkflow: true, clients: 1, clientId: 'hosted-tab', activeProjectId: 'project-hosted', revision: 2 }), { status: 200 });
      }
      if (url.port === '17373' && url.pathname === '/crew/protocol') {
        return new Response(JSON.stringify({ ok: true, protocolVersion: '1' }), { status: 200 });
      }
      throw new Error('local frontend offline');
    };

    const result = await getLocalStatus({ configPath, fetchImpl });

    expect(result).toMatchObject({ ready: true, browserConnected: true, clientId: 'hosted-tab', projectId: 'project-hosted', revision: 2 });
    expect(result.frontend).toEqual({ status: 'offline', url: null });
  }, 20_000);
});
