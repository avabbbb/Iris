// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStatusDiagnostics as buildDiagnostics, maskSecret } from '../tools/iris/local-status.js';
import { applyStdinNodeIds, formatCliResponse, nodeIdsFromNdjson, waitForAgentTask } from '../tools/iris/cli-output.js';

const buildStatusDiagnostics = buildDiagnostics as unknown as (input: Record<string, unknown>) => any;
const files = (present: Record<string, string>) => (path: string) => (present[path] ? { exists: true, modifiedAt: present[path], bytes: 10 } : { exists: false });

describe('status diagnostics', () => {
  // 配置路径会被 path.resolve：Windows 上 '/x/agent.json' 变成 'D:\\x\\agent.json'，夹具按同一规则取路径。
  const agentJson = resolve('/x/agent.json');
  const env = { IRIS_AGENT_CONFIG: '/x/agent.json', IRIS_WEB_DISCOVERY: '/x/web.json' } as never;

  it('masks the token and reports credential source, binding and file times', () => {
    const diagnostics = buildStatusDiagnostics({
      env, connection: { url: 'http://127.0.0.1:1', token: 'secret-token-1234' }, agentState: 'ready',
      health: { clients: 1, hasWorkflow: true, activeProjectId: 'p1', clientId: 'c1', revision: '7', activeHostWriter: { agentIdentity: 'codex', hostSessionId: 'h', projectId: 'p1' } },
      statFile: files({ [agentJson]: '2026-11-16T03:00:00.000Z' }),
    });
    expect(diagnostics.credential).toEqual({ source: 'env:IRIS_AGENT_CONFIG', configPath: agentJson, token: '****1234', agentUrl: 'http://127.0.0.1:1' });
    expect(diagnostics.binding).toEqual({ projectId: 'p1', clientId: 'c1', revision: 7, writer: { agentIdentity: 'codex', hostSessionId: 'h', projectId: 'p1' } });
    expect(diagnostics.stateFiles.map(file => [file.name, file.exists, file.modifiedAt])).toEqual([['agent.json', true, '2026-11-16T03:00:00.000Z'], ['web.json', false, undefined]]);
    expect(diagnostics.workspaceUnavailableReason).toBeNull();
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
  });

  it('names the first reason WORKSPACE_UNAVAILABLE would happen', () => {
    const reason = (input: Record<string, unknown>) => buildStatusDiagnostics({ env, statFile: files({ [agentJson]: 't' }), ...input }).workspaceUnavailableReason?.code;
    expect(buildStatusDiagnostics({ env, statFile: files({}) }).workspaceUnavailableReason?.code).toBe('AGENT_CONFIG_MISSING');
    expect(reason({ agentState: 'auth_failed' })).toBe('AGENT_AUTH_FAILED');
    expect(reason({ agentState: 'offline' })).toBe('AGENT_OFFLINE');
    expect(reason({ agentState: 'ready', health: { clients: 0 } })).toBe('BROWSER_NOT_CONNECTED');
    expect(reason({ agentState: 'ready', health: { clients: 1, hasWorkflow: false } })).toBe('NO_ACTIVE_WORKFLOW');
    expect(maskSecret('')).toBeNull();
    expect(maskSecret('short')).toBe('****');
  });
});

describe('CLI pipe output', () => {
  it('prints one JSON object per line unless --pretty', () => {
    expect(formatCliResponse({ ok: true, data: { a: 1 } })).toBe('{"ok":true,"data":{"a":1}}');
    expect(formatCliResponse({ ok: true }, { pretty: true })).toContain('\n');
  });

  it('collects node ids from upstream NDJSON and bare ids, skipping failures', () => {
    const text = [
      JSON.stringify({ ok: true, command: 'workflow.generate', data: { result: { nodeId: 'img-1', run: { outputNodeIds: ['img-1', 'img-2'] } } } }),
      JSON.stringify({ ok: true, data: { result: { runs: [{ nodeId: 'a', ok: true }, { nodeId: 'b', ok: false }] } } }),
      JSON.stringify({ ok: false, data: { nodeId: 'never' } }),
      'raw-3, raw-4',
    ].join('\n');
    expect(nodeIdsFromNdjson(text)).toEqual(['img-1', 'a', 'raw-3', 'raw-4']);
  });

  it('turns --references - and --node-ids - into ids from stdin', async () => {
    const read = async () => '{"ok":true,"data":{"nodeId":"n1"}}\n{"ok":true,"data":{"nodeId":"n2"}}\n';
    expect(await applyStdinNodeIds('workflow.generate', { references: '-' }, read)).toEqual({ references: '[{"nodeId":"n1"},{"nodeId":"n2"}]' });
    expect(await applyStdinNodeIds('workflow.node.run', { 'node-ids': '-' }, read)).toEqual({ 'node-ids': 'n1,n2' });
    expect(await applyStdinNodeIds('workflow.node.run', { nodeId: 'x' }, read)).toEqual({ nodeId: 'x' });
    await expect(applyStdinNodeIds('workflow.node.run', { nodeIds: '-' }, async () => '')).rejects.toThrow('stdin');
  });

  it('waits for a task, streaming events to the progress sink', async () => {
    const views = [
      { ok: true, result: { status: 'running', seq: 2, events: [{ seq: 1, type: 'queued' }, { seq: 2, type: 'started' }] } },
      { ok: true, result: { status: 'succeeded', seq: 3, events: [{ seq: 3, type: 'succeeded' }], result: { x: 1 } } },
    ];
    const seen: number[] = [];
    const lines: string[] = [];
    const result = await waitForAgentTask('t1', async (_id, afterSeq) => { seen.push(afterSeq); return views.shift()!; }, { sleep: async () => {}, progress: line => lines.push(line) });
    expect(seen).toEqual([0, 2]);
    expect(lines).toEqual(['task t1 #1 queued', 'task t1 #2 started', 'task t1 #3 succeeded']);
    expect(result).toMatchObject({ result: { status: 'succeeded', result: { x: 1 } } });
  });
});
