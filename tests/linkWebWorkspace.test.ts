// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeLink } from '../tools/iris/link/link-store.js';
import { LINK_ERROR } from '../tools/iris/link/protocol.js';
import { LinkClientError } from '../tools/iris/link/web-link-client.js';
import {
  buildWebLinkToolInvocation,
  downloadExportOverTransport,
  executeWorkspaceCommandOverWebLink,
  hasSavedWebLink,
  probeWebLinkStatus,
  uploadLocalMediaOverTransport,
} from '../tools/iris/link/web-workspace.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('CLI workflow commands over Iris Link web transport (zero S3/R2)', () => {
  it('coerces CLI flags into browser tool args and keeps projectId on the outer invoke payload', () => {
    const inspect = buildWebLinkToolInvocation('workflow.inspect', {
      summary: true,
      'project-id': 'proj-1',
      'agent-identity': 'codex',
      json: true,
    });
    expect(inspect).toEqual({ projectId: 'proj-1', toolArgs: { summary: true } });

    const apply = buildWebLinkToolInvocation('workflow.apply', {
      projectId: 'proj-1',
      'expected-revision': '4',
      'mutation-id': 'mut-1',
      operations: '[{"type":"move_node","nodeId":"n1","x":10,"y":20}]',
      'idempotency-key': 'idem-1',
      target: 'web',
    });
    expect(apply).toEqual({
      projectId: 'proj-1',
      toolArgs: {
        expectedRevision: 4,
        mutationId: 'mut-1',
        operations: [{ type: 'move_node', nodeId: 'n1', x: 10, y: 20 }],
      },
    });
  });

  it('routes read-only commands through workflow.read and transparently reassembles chunked large JSON', async () => {
    const bigPayload = { ok: true, result: { projectId: 'p1', nodes: Array.from({ length: 120 }, (_, i) => ({ id: 'n' + i, title: 'x'.repeat(200) })) } };
    const encoded = Buffer.from(JSON.stringify(bigPayload), 'utf8');
    const sha256 = createHash('sha256').update(encoded).digest('hex');
    const chunkSize = 4096;
    const totalChunks = Math.ceil(encoded.length / chunkSize);

    const transport = {
      kind: 'web' as const,
      scopes: ['agent.read'],
      close: vi.fn(),
      async describe() { return { transport: 'web', url: 'https://iris.avabbbb.com' }; },
      async request(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === 'workflow.read') {
          expect(args).toMatchObject({ command: 'workflow.inspect', args: { summary: false } });
          return { chunked: true, downloadId: 'dl-big', bytes: encoded.length, sha256, chunkBytes: chunkSize, totalChunks };
        }
        if (cmd === 'media.download.chunk') {
          const idx = Number(args.index);
          const slice = encoded.subarray(idx * chunkSize, Math.min(encoded.length, (idx + 1) * chunkSize));
          return { downloadId: 'dl-big', index: idx, totalChunks, bytes: slice.length, dataBase64: slice.toString('base64'), done: idx === totalChunks - 1 };
        }
        throw new Error('unexpected ' + cmd);
      },
    };

    const result = await executeWorkspaceCommandOverWebLink('workflow.inspect', { summary: false }, { transport });
    expect(result).toEqual(bigPayload);
  });

  it('executes workflow.apply via workflow.exec, handles approval progress, and falls back for legacy tabs', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown>; opts: Record<string, unknown> }> = [];
    const progress = vi.fn();
    let traceCalls = 0;
    const transport = {
      kind: 'web' as const,
      scopes: ['agent.read', 'agent.run', 'tools.invoke'],
      close: vi.fn(),
      async describe() { return { transport: 'web', url: 'https://iris.avabbbb.com' }; },
      async request(cmd: string, args: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
        calls.push({ cmd, args, opts });
        if (cmd === 'workflow.exec') {
          return { mode: 'execute', runId: 'run-42', phase: 'running' };
        }
        if (cmd === 'agent.trace') {
          traceCalls += 1;
          if (traceCalls === 1) {
            return {
              runId: 'run-42',
              phase: 'awaitingApproval',
              seq: 1,
              done: false,
              events: [{ seq: 1, type: 'approval.pending', summary: '应用 1 个画布操作', cliApprovable: true }],
            };
          }
          return {
            runId: 'run-42',
            phase: 'done',
            seq: 2,
            done: true,
            events: [{
              seq: 2,
              type: 'done',
              phase: 'done',
              result: { ok: true, commandId: 'cmd-1', result: { projectId: 'proj-1', draftVersion: 5 } },
            }],
          };
        }
        if (cmd === 'link.status') {
          return { tab: { projectId: 'proj-1', projectTitle: 'Demo', nodes: 2 } };
        }
        throw new Error('unexpected cmd ' + cmd);
      },
    };

    const applied = await executeWorkspaceCommandOverWebLink('workflow.apply', {
      projectId: 'proj-1',
      expectedRevision: '4',
      mutationId: 'mut-1',
      operations: '[{"type":"move_node","nodeId":"n1","x":10,"y":20}]',
    }, { transport, idempotencyKey: 'idem-apply', progress, followOptions: { waitMs: 0, pollMs: 1 } });

    expect(applied).toEqual({ ok: true, commandId: 'cmd-1', result: { projectId: 'proj-1', draftVersion: 5 } });
    expect(calls[0]).toMatchObject({
      cmd: 'workflow.exec',
      args: {
        command: 'workflow.apply',
        projectId: 'proj-1',
        args: { expectedRevision: 4, mutationId: 'mut-1', operations: [{ type: 'move_node', nodeId: 'n1', x: 10, y: 20 }] },
      },
      opts: { idempotencyKey: 'idem-apply' },
    });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('等待批准'));

    const status = await executeWorkspaceCommandOverWebLink('workspace.status', {}, { transport });
    expect(status).toMatchObject({ authority: 'iris-link-web', state: 'ready', tab: { projectId: 'proj-1', nodes: 2 } });
    expect(transport.close).not.toHaveBeenCalled();
  });

  it('streams local files in chunks over WebSocket with SHA-256 and RATE_LIMITED retry without S3/R2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-upload-'));
    tempDirs.push(dir);
    const sample = Buffer.alloc(210 * 1024, 0xab);
    const localFile = join(dir, 'hero.png');
    writeFileSync(localFile, sample);
    const received = new Map<number, Buffer>();
    let throttledOnce = false;
    let startedMeta: Record<string, unknown> | null = null;

    const transport = {
      kind: 'web' as const,
      scopes: ['agent.read', 'agent.run', 'tools.invoke'],
      close: vi.fn(),
      async request(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === 'media.upload.start') {
          startedMeta = args;
          return { uploadId: 'upl-1', fileName: args.fileName, mimeType: args.mimeType, bytes: args.bytes, chunkBytes: 64 * 1024, totalChunks: Math.ceil(Number(args.bytes) / (64 * 1024)) };
        }
        if (cmd === 'media.upload.chunk') {
          if (!throttledOnce && args.index === 1) {
            throttledOnce = true;
            throw new LinkClientError(LINK_ERROR.RATE_LIMITED, 'rate limited', { retryable: true });
          }
          received.set(Number(args.index), Buffer.from(String(args.dataBase64), 'base64'));
          return { uploadId: 'upl-1', index: args.index };
        }
        if (cmd === 'media.upload.finish') {
          const assembled = Buffer.concat([...received.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf));
          expect(assembled.equals(sample)).toBe(true);
          return { immediate: true, result: { ok: true, result: { projectId: 'p1', nodeId: 'media-1', type: 'image' } } };
        }
        throw new Error('unexpected ' + cmd);
      },
    };

    const result = await uploadLocalMediaOverTransport(transport, { file: localFile, projectId: 'p1', title: 'Hero' }, { idempotencyKey: 'k-up' });
    expect(startedMeta).toMatchObject({ fileName: 'hero.png', mimeType: 'image/png', bytes: sample.length });
    expect(throttledOnce).toBe(true);
    expect(result).toEqual({ ok: true, result: { projectId: 'p1', nodeId: 'media-1', type: 'image' } });
  });

  it('downloads exported canvas media in chunks directly to local disk with SHA-256 verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-download-'));
    tempDirs.push(dir);
    const payload = Buffer.from('FAKE-PNG-BYTES-'.repeat(12000), 'utf8');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const chunkBytes = 32 * 1024;
    const totalChunks = Math.ceil(payload.length / chunkBytes);
    const outPath = join(dir, 'nested', 'exported.png');

    const transport = {
      kind: 'web' as const,
      scopes: ['agent.read'],
      close: vi.fn(),
      async request(cmd: string, args: Record<string, unknown> = {}) {
        if (cmd === 'media.download.start') {
          return { downloadId: 'dl-1', projectId: 'p1', fileName: 'shot1.png', mimeType: 'image/png', bytes: payload.length, sha256, chunkBytes, totalChunks, mode: 'single', files: [], skipped: [] };
        }
        if (cmd === 'media.download.chunk') {
          const idx = Number(args.index);
          const slice = payload.subarray(idx * chunkBytes, Math.min(payload.length, (idx + 1) * chunkBytes));
          return { downloadId: 'dl-1', index: idx, totalChunks, bytes: slice.length, dataBase64: slice.toString('base64'), done: idx === totalChunks - 1 };
        }
        throw new Error('unexpected ' + cmd);
      },
    };

    const result = await downloadExportOverTransport(transport, { nodeIds: 'n1', output: outPath });
    expect(result).toMatchObject({ ok: true, result: { fileName: 'shot1.png', bytes: payload.length, sha256, saved: true, savedTo: outPath } });
    expect(readFileSync(outPath).equals(payload)).toBe(true);
  });

  it('detects saved Iris Link files and probes tab readiness without exposing tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-link-detect-'));
    tempDirs.push(dir);
    const file = join(dir, 'link.json');
    expect(hasSavedWebLink({ storeOptions: { file } })).toBe(false);
    expect(await probeWebLinkStatus({ storeOptions: { file } })).toBeNull();
    writeLink({
      baseUrl: 'https://iris.avabbbb.com',
      roomId: 'a'.repeat(32),
      accessToken: 'ilk_a_' + 'a'.repeat(32) + '_' + 'x'.repeat(40),
      refreshToken: 'ilk_r_' + 'a'.repeat(32) + '_' + 'y'.repeat(40),
      accessExpiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      scopes: ['agent.read', 'agent.run', 'tools.invoke'],
    }, { file });
    expect(hasSavedWebLink({ storeOptions: { file } })).toBe(true);

    const probed = await probeWebLinkStatus({
      storeOptions: { file },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, tabOnline: true, scopes: ['agent.read', 'agent.run', 'tools.invoke'], tab: { projectId: 'p-live', title: 'Live' } }), { status: 200 }),
    });
    expect(probed).toMatchObject({ ok: true, linked: true, url: 'https://iris.avabbbb.com', tabOnline: true, tab: { projectId: 'p-live', title: 'Live' } });
    expect(JSON.stringify(probed)).not.toContain('ilk_a_');
  });
});
