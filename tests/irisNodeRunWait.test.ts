import { describe, expect, it, vi } from 'vitest';
import { executeIrisCommand, parseCliArgs, workflowRunWaitMs } from '../tools/iris/core.js';
import { IrisWorkspaceClient } from '../tools/iris/workspace-client.js';

function timeoutError() {
  return Object.assign(new Error('timeout'), { code: 'WORKSPACE_TIMEOUT', details: {} });
}

describe('workflow.node.run --wait-seconds / --no-wait', () => {
  it('only applies to node.run and validates the range', () => {
    expect(workflowRunWaitMs('workflow.node.run', { noWait: true })).toBe(20_000);
    expect(workflowRunWaitMs('workflow.node.run', { waitSeconds: '45' })).toBe(45_000);
    expect(workflowRunWaitMs('workflow.apply', { noWait: true })).toBe(0);
    expect(workflowRunWaitMs('workflow.node.run', {})).toBe(0);
    expect(() => workflowRunWaitMs('workflow.node.run', { waitSeconds: '0' })).toThrow(/between 1 and 960/);
  });

  it('returns a running receipt on timeout and does not forward the wait flag to the Workflow', async () => {
    const operation = vi.fn(async (_command: string, _args: Record<string, any>, _context: Record<string, any>): Promise<unknown> => { throw timeoutError(); });
    const result = await executeIrisCommand('workflow.node.run', {
      'project-id': 'p1', 'node-ids': 'n1,n2', 'idempotency-key': 'run-7', 'wait-seconds': '30',
    }, { operation, source: 'cli' });
    expect(result).toMatchObject({ ok: true, status: 'running', idempotencyKey: 'run-7', waitedSeconds: 30 });
    const [, forwarded, context] = operation.mock.calls[0];
    expect(context.timeoutMs).toBe(30_000);
    expect(forwarded).not.toHaveProperty('wait-seconds');
    expect(forwarded).not.toHaveProperty('waitSeconds');
    expect(forwarded.nodeIds).toEqual(['n1', 'n2']);
  });

  it('keeps the old behaviour without the flag: a timeout is still an error', async () => {
    const operation = vi.fn(async (_command: string, _args: Record<string, any>, _context: Record<string, any>): Promise<unknown> => { throw timeoutError(); });
    await expect(executeIrisCommand('workflow.node.run', {
      'project-id': 'p1', 'node-id': 'n1', 'idempotency-key': 'run-8',
    }, { operation, source: 'cli' })).rejects.toMatchObject({ code: 'WORKSPACE_TIMEOUT' });
    expect(operation.mock.calls[0][2]).not.toHaveProperty('timeoutMs');
  });

  it('parses --no-wait as a boolean flag', () => {
    const parsed = parseCliArgs(['workflow.node.run', '--node-id', 'n1', '--no-wait']);
    expect(JSON.stringify(parsed)).toMatch(/no-wait/);
  });

  it('the workspace client uses the per-call timeout', async () => {
    const fetch = vi.fn((_url: URL, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const client = new IrisWorkspaceClient({ config: { url: 'http://127.0.0.1:1', token: 't' }, fetch });
    const started = Date.now();
    await expect(client.execute('workflow.node.run', { nodeId: 'n1' }, 'cli', { idempotencyKey: 'k', timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'WORKSPACE_TIMEOUT', details: { idempotencyKey: 'k' } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
