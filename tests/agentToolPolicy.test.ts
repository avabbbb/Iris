import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_MODE,
  migrateApprovalMode,
  normalizeApprovalDecision,
  readApprovalMode,
  readUserToolPolicy,
  resolveToolApproval,
  sessionGrantKey,
  toolApprovalFor,
  writeApprovalMode,
  writeUserToolPolicy,
  type ApprovalMode,
  type ToolApprovalDecision,
  type UserToolPolicyMap,
} from '../services/agentToolPolicy';
import { workflowCommandNeedsConfirmation } from '../services/workflowDispatcher';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const resolve = (mode: ApprovalMode, decision: ToolApprovalDecision | unknown, extra: {
  userPolicy?: UserToolPolicyMap; granted?: boolean; spendCovered?: boolean; headless?: boolean; tool?: string;
} = {}) => resolveToolApproval({
  mode,
  tool: extra.tool ?? 'tool.x',
  decision,
  userPolicy: extra.userPolicy,
  isGranted: extra.granted ? () => true : undefined,
  spendCovered: extra.spendCovered,
  headless: extra.headless,
});

const spend = { tier: 'exec', override: true, hardGate: 'spend', reason: '可能产生费用' } as const;
const del = { tier: 'exec', override: true, hardGate: 'delete', reason: '删除内容' } as const;

describe('tool approval declarations', () => {
  it('classifies Iris commands by tier with safety overrides for spend and delete', () => {
    expect(toolApprovalFor('workflow.inspect')).toEqual({ tier: 'read' });
    expect(toolApprovalFor('iris_workflow_media_view')).toEqual({ tier: 'read' });
    expect(toolApprovalFor('iris_web_search')).toEqual({ tier: 'read' });
    expect(toolApprovalFor('iris_grep')).toEqual({ tier: 'read' });
    expect(toolApprovalFor('workflow.node.stop')).toEqual({ tier: 'read' });
    expect(toolApprovalFor('workflow.focus.nodes')).toEqual({ tier: 'read' });
    expect(toolApprovalFor('workflow.apply', { operations: [{ type: 'update_node', id: 'n1', patch: { title: 'x' } }] })).toEqual({ tier: 'write' });
    expect(toolApprovalFor('workflow.apply', { operations: [{ type: 'delete_nodes', ids: ['n1'] }] })).toMatchObject({ tier: 'exec', override: true, hardGate: 'delete', reason: '删除内容' });
    expect(toolApprovalFor('workflow.apply', { ops: [{ type: 'delete_connections', ids: ['c1'] }] })).toMatchObject({ hardGate: 'delete' });
    expect(toolApprovalFor('workflow.node.run')).toMatchObject({ tier: 'exec', override: true, hardGate: 'spend', reason: '可能产生费用' });
    expect(toolApprovalFor('workflow.node.delete')).toMatchObject({ hardGate: 'delete' });
    expect(toolApprovalFor('workflow.project.delete')).toMatchObject({ hardGate: 'delete' });
    expect(toolApprovalFor('workflow.node.create')).toEqual({ tier: 'write' });
    expect(toolApprovalFor('workflow.connect')).toEqual({ tier: 'write' });
  });

  it('marks paid node tools as spend overrides and local transforms as writes', () => {
    expect(toolApprovalFor('workflow.node.tool', { tool: 'upscale' })).toMatchObject({ tier: 'exec', hardGate: 'spend' });
    expect(toolApprovalFor('workflow.node.tool', { tool: 'video-extract-frame' })).toEqual({ tier: 'write' });
  });

  it('defaults unknown commands and malformed decisions to exec', () => {
    expect(toolApprovalFor('plugin.unknown')).toEqual({ tier: 'exec' });
    expect(normalizeApprovalDecision(undefined)).toEqual({ tier: 'exec' });
    expect(normalizeApprovalDecision('nope')).toEqual({ tier: 'exec' });
    expect(normalizeApprovalDecision({ tier: 'weird', policy: ' ALLOW ' })).toEqual({ tier: 'exec', policy: 'allow' });
    expect(resolve('write', undefined).action).toBe('prompt');
  });

  it('keeps the policy layer aligned with the commands that confirm themselves', () => {
    expect(workflowCommandNeedsConfirmation('workflow.apply', { operations: [{ type: 'delete_nodes', ids: ['n'] }] })).toBe(true);
    expect(workflowCommandNeedsConfirmation('workflow.apply', { operations: [{ type: 'update_node', id: 'n', patch: { title: 'x' } }] })).toBe(false);
    expect(workflowCommandNeedsConfirmation('workflow.node.run', { nodeId: 'n' })).toBe(true);
    expect(workflowCommandNeedsConfirmation('workflow.inspect', {})).toBe(false);
    // 命令面自己确认的都是安全覆盖，所以不会出现「审批层放行、命令面又问」或反过来的漏问。
    for (const [command, args] of [['workflow.node.run', { nodeId: 'n' }], ['workflow.node.delete', { nodeId: 'n' }], ['workflow.apply', { operations: [{ type: 'delete_nodes', ids: ['n'] }] }]] as const) {
      expect(toolApprovalFor(command, args as Record<string, unknown>).override).toBe(true);
    }
  });
});

describe('resolveToolApproval — order matches oh-my-pi', () => {
  it('1. a tool deny always denies, even in yolo with a user allow', () => {
    for (const mode of ['always-ask', 'write', 'yolo'] as const) {
      expect(resolve(mode, { tier: 'read', policy: 'deny', reason: 'blocked' }, { userPolicy: { 'tool.x': 'allow' } })).toEqual({ action: 'deny', tier: 'read', reason: 'blocked' });
    }
  });

  it('2. a user deny always denies', () => {
    for (const mode of ['always-ask', 'write', 'yolo'] as const) {
      expect(resolve(mode, 'read', { userPolicy: { 'tool.x': 'deny' } }).action).toBe('deny');
    }
    expect(resolve('yolo', spend, { userPolicy: { 'tool.x': 'deny' }, spendCovered: true }).action).toBe('deny');
  });

  it('3. yolo: everything allowed, explicit tool / user prompt still prompts, without session grants', () => {
    expect(resolve('yolo', 'exec')).toEqual({ action: 'allow', tier: 'exec' });
    expect(resolve('yolo', { tier: 'exec', policy: 'allow' }, { userPolicy: { 'tool.x': 'prompt' } }).action).toBe('allow');
    expect(resolve('yolo', { tier: 'write', policy: 'prompt' })).toMatchObject({ action: 'prompt', grantable: false });
    expect(resolve('yolo', 'write', { userPolicy: { 'tool.x': 'prompt' } })).toMatchObject({ action: 'prompt', grantable: false });
    expect(resolve('yolo', 'write', { userPolicy: { 'tool.x': 'allow' } }).action).toBe('allow');
  });

  it('3. yolo ignores a bare override (OMP) but keeps the Iris spend/delete hard gates', () => {
    expect(resolve('yolo', { tier: 'exec', override: true, reason: 'critical' }).action).toBe('allow');
    expect(resolve('yolo', del)).toMatchObject({ action: 'prompt', grantable: false, hardGate: 'delete', reason: '删除内容' });
    expect(resolve('yolo', del, { userPolicy: { 'tool.x': 'allow' } }).action).toBe('prompt');
    expect(resolve('yolo', { ...del, policy: 'allow' }).action).toBe('prompt');
    expect(resolve('yolo', spend)).toMatchObject({ action: 'prompt', grantable: false, hardGate: 'spend' });
    expect(resolve('yolo', spend, { spendCovered: true }).action).toBe('allow');
    expect(resolve('yolo', spend, { spendCovered: true, userPolicy: { 'tool.x': 'prompt' } }).action).toBe('prompt');
  });

  it('4. non-yolo override prompts unless the tool itself allows; a user allow cannot bypass it', () => {
    for (const mode of ['always-ask', 'write'] as const) {
      expect(resolve(mode, { tier: 'exec', override: true, reason: 'critical' })).toMatchObject({ action: 'prompt', grantable: false, reason: 'critical' });
      expect(resolve(mode, { tier: 'exec', override: true, policy: 'allow' }).action).toBe('allow');
      expect(resolve(mode, del, { userPolicy: { 'tool.x': 'allow' }, granted: true }).action).toBe('prompt');
    }
  });

  it('4. an active spend mandate covers paid runs in write mode only', () => {
    expect(resolve('write', spend, { spendCovered: true }).action).toBe('allow');
    expect(resolve('write', spend, { spendCovered: true, userPolicy: { 'tool.x': 'prompt' } }).action).toBe('prompt');
    expect(resolve('always-ask', spend, { spendCovered: true }).action).toBe('prompt');
    expect(resolve('write', del, { spendCovered: true }).action).toBe('prompt');
  });

  it('5. explicit tool allow / prompt beats the user policy and the mode', () => {
    expect(resolve('always-ask', { tier: 'exec', policy: 'allow' }, { userPolicy: { 'tool.x': 'prompt' } }).action).toBe('allow');
    expect(resolve('write', { tier: 'read', policy: 'prompt' }, { userPolicy: { 'tool.x': 'allow' } })).toMatchObject({ action: 'prompt', grantable: false });
  });

  it('6. user allow / prompt beats the mode, and its prompts are not grantable', () => {
    expect(resolve('always-ask', 'exec', { userPolicy: { 'tool.x': 'allow' } }).action).toBe('allow');
    expect(resolve('write', 'read', { userPolicy: { 'tool.x': 'prompt' }, granted: true })).toMatchObject({ action: 'prompt', grantable: false });
    // policyKey 优先，缺失或非法时回落到工具名。
    expect(resolve('write', { tier: 'read', policyKey: 'sub' }, { userPolicy: { sub: 'prompt', 'tool.x': 'allow' } }).action).toBe('prompt');
    expect(resolve('write', { tier: 'read', policyKey: 'sub' }, { userPolicy: { sub: 'bogus' as never, 'tool.x': 'prompt' } }).action).toBe('prompt');
  });

  it('7. the mode decides by tier', () => {
    expect(resolve('always-ask', 'read').action).toBe('allow');
    expect(resolve('always-ask', 'write')).toEqual({ action: 'prompt', tier: 'write', grantable: true });
    expect(resolve('always-ask', 'exec')).toEqual({ action: 'prompt', tier: 'exec', grantable: true });
    expect(resolve('write', 'read').action).toBe('allow');
    expect(resolve('write', 'write').action).toBe('allow');
    expect(resolve('write', 'exec')).toEqual({ action: 'prompt', tier: 'exec', grantable: true });
  });

  it('7. a session grant covers later calls of the same tool at the same tier', () => {
    const grants = new Set([sessionGrantKey('workflow.apply', 'write')]);
    const isGranted = (tool: string, tier: 'read' | 'write' | 'exec') => grants.has(sessionGrantKey(tool, tier));
    expect(resolveToolApproval({ mode: 'always-ask', tool: 'workflow.apply', decision: 'write', isGranted }).action).toBe('allow');
    expect(resolveToolApproval({ mode: 'always-ask', tool: 'workflow.apply', decision: 'exec', isGranted }).action).toBe('prompt');
    expect(resolveToolApproval({ mode: 'always-ask', tool: 'workflow.node.tool', decision: 'write', isGranted }).action).toBe('prompt');
  });

  it('headless turns turn every prompt into a deny with a clear reason', () => {
    expect(resolve('write', 'exec', { headless: true })).toMatchObject({ action: 'deny', reason: expect.stringContaining('无人值守') });
    expect(resolve('yolo', del, { headless: true }).action).toBe('deny');
    expect(resolve('write', 'write', { headless: true }).action).toBe('allow');
    expect(resolve('always-ask', 'write', { headless: true, granted: true }).action).toBe('deny');
  });
});

describe('approval persistence', () => {
  it('migrates the old manual / auto mode values', () => {
    expect(migrateApprovalMode('manual')).toBe('always-ask');
    expect(migrateApprovalMode('auto')).toBe('write');
    expect(migrateApprovalMode('yolo')).toBe('yolo');
    expect(migrateApprovalMode('garbage')).toBe(DEFAULT_APPROVAL_MODE);
    expect(DEFAULT_APPROVAL_MODE).toBe('write');

    const legacy = memoryStorage({ 'iris.agent.mode': 'manual' });
    expect(readApprovalMode(legacy)).toBe('always-ask');
    expect(legacy.data.get('iris.agent.approvalMode')).toBe('always-ask');
    expect(legacy.data.has('iris.agent.mode')).toBe(false);

    const stored = memoryStorage({ 'iris.agent.approvalMode': 'auto' });
    expect(readApprovalMode(stored)).toBe('write');
    writeApprovalMode('yolo', stored);
    expect(readApprovalMode(stored)).toBe('yolo');
    expect(readApprovalMode(memoryStorage())).toBe('write');
  });

  it('persists the per-tool user policy, ignoring invalid values', () => {
    const storage = memoryStorage();
    writeUserToolPolicy({ 'workflow.apply': 'allow', iris_web_search: 'DENY' as never, bogus: 'maybe' as never }, storage);
    expect(readUserToolPolicy(storage)).toEqual({ 'workflow.apply': 'allow', iris_web_search: 'deny' });
    writeUserToolPolicy({}, storage);
    expect(storage.data.has('iris.agent.toolApproval')).toBe(false);
  });

  it('migrates whole-command legacy "always allow" grants and drops sub-tool ones', () => {
    const storage = memoryStorage({ 'iris.agent.alwaysAllow': JSON.stringify(['workflow.apply:write', 'workflow.node.tool:video-trim:write']) });
    expect(readUserToolPolicy(storage)).toEqual({ 'workflow.apply': 'allow' });
    expect(storage.data.has('iris.agent.alwaysAllow')).toBe(false);
    expect(JSON.parse(storage.data.get('iris.agent.toolApproval')!)).toEqual({ 'workflow.apply': 'allow' });
  });
});

describe('Cut tool approvals', () => {
  const ctx = { mode: 'write' as ApprovalMode };
  it('reads freely, writes by mode, and asks every time for deletes', () => {
    for (const tool of ['iris_cut_get_timeline', 'iris_cut_get_assets', 'iris_cut_get_inspector', 'iris_cut_get_subtitles', 'iris_cut_snapshot_frame']) {
      expect(toolApprovalFor(tool).tier).toBe('read');
    }
    expect(toolApprovalFor('iris_cut_playback', { action: 'seek', time: 1 }).tier).toBe('read');
    expect(toolApprovalFor('iris_cut_playback', { action: 'undo' }).tier).toBe('write');
    expect(toolApprovalFor('iris_cut_subtitles', { action: 'export_srt' }).tier).toBe('read');
    expect(toolApprovalFor('iris_cut_subtitles', { action: 'add', start: 0, end: 1, text: 'a' }).tier).toBe('write');
    expect(toolApprovalFor('iris_cut_edit', { operations: [{ op: 'move_clip', clipId: 'c', start: 1 }] }).tier).toBe('write');
    expect(toolApprovalFor('iris_cut_export', {}).tier).toBe('write');
    expect(toolApprovalFor('iris_cut_unknown').tier).toBe('exec');

    const deletes: Array<[string, Record<string, unknown>]> = [
      ['iris_cut_edit', { operations: [{ op: 'move_clip' }, { op: 'delete_clips', clipIds: ['c'] }] }],
      ['iris_cut_edit', { operations: [{ op: 'delete_side', time: 1, side: 'left' }] }],
      ['iris_cut_edit', { operations: [{ op: 'remove_track', trackId: 't' }] }],
      ['iris_cut_subtitles', { action: 'delete', clipIds: ['s'] }],
      ['iris_cut_subtitles', { action: 'replace_all', cues: [] }],
      ['iris_cut_subtitles', { action: 'import_srt', content: '' }],
    ];
    for (const [tool, args] of deletes) {
      const decision = toolApprovalFor(tool, args);
      expect(decision).toMatchObject({ tier: 'exec', hardGate: 'delete' });
      // yolo 也不放过删除；会话授权不能跳过逐次确认。
      expect(resolveToolApproval({ mode: 'yolo', tool, decision }).action).toBe('prompt');
      expect(resolveToolApproval({ ...ctx, isGranted: () => true, tool, decision })).toMatchObject({ action: 'prompt', grantable: false });
    }
    expect(resolveToolApproval({ ...ctx, tool: 'iris_cut_edit', decision: toolApprovalFor('iris_cut_edit', { operations: [{ op: 'split', time: 1 }] }) }).action).toBe('allow');
    expect(resolveToolApproval({ mode: 'always-ask', tool: 'iris_cut_edit', decision: toolApprovalFor('iris_cut_edit', { operations: [{ op: 'split', time: 1 }] }) }).action).toBe('prompt');
  });
});
