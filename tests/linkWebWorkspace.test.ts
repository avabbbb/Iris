// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeLink } from '../tools/iris/link/link-store.js';
import { buildWebLinkToolInvocation, executeWorkspaceCommandOverWebLink, hasSavedWebLink } from '../tools/iris/link/web-workspace.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('CLI workflow commands over Iris Link web transport', () => {
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

  it('executes workflow.inspect and workflow.apply via agent.tools.invoke and unwraps structured details', async () => {
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
        if (cmd === 'agent.tools.invoke') {
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
              result: {
                text: '{"ok":true}',
                details: { ok: true, commandId: 'cmd-1', result: { projectId: 'proj-1', draftVersion: 5 } },
              },
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
      cmd: 'agent.tools.invoke',
      args: {
        tool: 'workflow.apply',
        projectId: 'proj-1',
        execute: true,
        args: { expectedRevision: 4, mutationId: 'mut-1', operations: [{ type: 'move_node', nodeId: 'n1', x: 10, y: 20 }] },
      },
      opts: { idempotencyKey: 'idem-apply' },
    });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('等待批准'));

    const status = await executeWorkspaceCommandOverWebLink('workspace.status', {}, { transport });
    expect(status).toMatchObject({ authority: 'iris-link-web', state: 'ready', tab: { projectId: 'proj-1', nodes: 2 } });
    expect(transport.close).not.toHaveBeenCalled();
  });

  it('detects whether a saved Iris Link credential file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-link-detect-'));
    tempDirs.push(dir);
    const file = join(dir, 'link.json');
    expect(hasSavedWebLink({ storeOptions: { file } })).toBe(false);
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
  });
});
