import { describe, expect, it } from 'vitest';
import { buildPlanCard, paidUnits, SessionBudget } from '../agent/session-budget.js';
import { WorkflowAgentSession } from '../agent/session.js';

describe('session budget', () => {
  it('counts paid units per command', () => {
    expect(paidUnits('workflow.node.run', { nodeId: 'a' })).toBe(1);
    expect(paidUnits('workflow.node.run', { nodeIds: ['a', 'b', 'c'] })).toBe(3);
    expect(paidUnits('generate.image', { count: 4 })).toBe(4);
    expect(paidUnits('workflow.apply', {})).toBe(0);
  });

  it('enforces the ceiling, expiry and pause without touching non-paid commands', () => {
    let clock = 1_000;
    const budget = new SessionBudget({ now: () => clock });
    expect(budget.check('workflow.node.run', { nodeId: 'a' })).toBeNull();
    budget.grant({ maxRuns: 3, ttlMs: 60_000, grantedBy: 'codex' });
    expect(budget.check('workflow.node.run', { nodeIds: ['a', 'b'] })).toBeNull();
    budget.consume('workflow.node.run', { nodeIds: ['a', 'b'] });
    expect(budget.check('workflow.node.run', { nodeIds: ['c', 'd'] }).error.code).toBe('BUDGET_EXCEEDED');
    expect(budget.check('workflow.apply', {})).toBeNull();
    budget.pause('看一下中间结果');
    expect(budget.check('workflow.node.run', { nodeId: 'c' }).error.code).toBe('SESSION_PAUSED');
    budget.resume();
    clock += 61_000;
    expect(budget.check('workflow.node.run', { nodeId: 'c' }).error.code).toBe('BUDGET_EXPIRED');
    expect(() => budget.grant({ maxRuns: 0 })).toThrow(RangeError);
  });

  it('builds a plan card that flags missing nodes and budget blocks', () => {
    const budget = new SessionBudget();
    budget.grant({ maxRuns: 1 });
    const card = buildPlanCard('workflow.node.run', { nodeIds: ['n1', 'ghost'] }, { snapshot: { id: 'p1', nodes: [{ id: 'n1', title: '主图', type: 'image' }] }, budget });
    expect(card).toMatchObject({ kind: 'plan-card', projectId: 'p1', paidRuns: 2, requiresConfirmation: true, missingNodeIds: ['ghost'], wouldBlock: 'BUDGET_EXCEEDED' });
    expect(card.steps[0]).toEqual({ nodeId: 'n1', action: 'run', title: '主图', type: 'image' });
  });
});

describe('session wiring', () => {
  it('answers session controls, dry-runs and budget blocks locally without a browser', async () => {
    const session = new WorkflowAgentSession();
    const granted = await session.callCommand('session.budget.grant', { maxRuns: 1 }, 'cli', undefined, undefined, { agentIdentity: 'codex' });
    expect(granted.result.budget).toMatchObject({ maxRuns: 1, remaining: 1, grantedBy: 'codex' });
    const plan = await session.callCommand('workflow.node.run', { nodeIds: ['a', 'b'], dryRun: true }, 'cli');
    expect(plan.result).toMatchObject({ kind: 'plan-card', paidRuns: 2, wouldBlock: 'BUDGET_EXCEEDED' });
    const blocked = await session.callCommand('workflow.node.run', { nodeIds: ['a', 'b'] }, 'cli');
    expect(blocked).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED', requiredRuns: 2 } });
    await session.callCommand('session.pause', { reason: 'stop' }, 'cli');
    const paused = await session.callCommand('workflow.node.run', { nodeId: 'a' }, 'cli');
    expect(paused.error.code).toBe('SESSION_PAUSED');
    const state = await session.callCommand('session.budget.get', {}, 'cli');
    expect(state.result).toMatchObject({ paused: true, pauseReason: 'stop' });
  });
});

describe('budget reservation under concurrency', () => {
  it('lets only one of two concurrent requests through when one run is left', () => {
    const budget = new SessionBudget();
    budget.grant({ maxRuns: 1 });
    const first = budget.reserve('workflow.node.run', { nodeId: 'a' });
    const second = budget.reserve('workflow.node.run', { nodeId: 'b' });
    expect(first.reservation).toBeTruthy();
    expect(second.blocked.error.code).toBe('BUDGET_EXCEEDED');
    expect(budget.snapshot().budget).toMatchObject({ used: 0, reserved: 1, remaining: 0 });
    budget.commit(first.reservation);
    expect(budget.snapshot().budget).toMatchObject({ used: 1, reserved: 0, remaining: 0 });
  });

  it('returns the reservation when nothing was submitted and keeps it when the outcome is unknown', () => {
    const budget = new SessionBudget();
    budget.grant({ maxRuns: 2 });
    const rejected = budget.reserve('workflow.node.run', { nodeId: 'a' });
    budget.release(rejected.reservation);
    expect(budget.snapshot().budget.remaining).toBe(2);
    const unknown = budget.reserve('workflow.node.run', { nodeId: 'b' });
    budget.commit(unknown.reservation, { uncertain: true });
    expect(budget.snapshot().budget).toMatchObject({ used: 1, uncertain: 1, remaining: 1 });
    // 重复结算无效。
    budget.release(unknown.reservation);
    budget.commit(unknown.reservation);
    expect(budget.snapshot().budget.used).toBe(1);
  });

  it('charges a retried idempotency key once and frees the key after a definite rejection', () => {
    const budget = new SessionBudget();
    budget.grant({ maxRuns: 3 });
    const first = budget.reserve('workflow.node.run', { nodeId: 'a' }, { key: 'k1' });
    expect(budget.reserve('workflow.node.run', { nodeId: 'a' }, { key: 'k1' })).toEqual({ reservation: null, duplicate: true, inFlight: first.reservation });
    budget.commit(first.reservation);
    expect(budget.reserve('workflow.node.run', { nodeId: 'a' }, { key: 'k1' }).duplicate).toBe(true);
    expect(budget.snapshot().budget.used).toBe(1);
    const second = budget.reserve('workflow.node.run', { nodeId: 'b' }, { key: 'k2' });
    budget.release(second.reservation);
    expect(budget.reserve('workflow.node.run', { nodeId: 'b' }, { key: 'k2' }).reservation).toBeTruthy();
  });

  it('settles a reservation against the grant it was taken from', () => {
    const budget = new SessionBudget();
    budget.grant({ maxRuns: 1 });
    const old = budget.reserve('workflow.node.run', { nodeId: 'a' });
    budget.grant({ maxRuns: 5 });
    budget.commit(old.reservation);
    expect(budget.snapshot().budget).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
  });

  it('reserves before dispatch inside the session so concurrent calls cannot both spend the last run', async () => {
    const session = new WorkflowAgentSession();
    session.budget.grant({ maxRuns: 1 });
    const pending = [];
    session.dispatchCommand = () => new Promise(resolve => pending.push(resolve));
    const a = session.callCommand('workflow.node.run', { nodeId: 'a' });
    const b = session.callCommand('workflow.node.run', { nodeId: 'b' });
    expect((await b).error.code).toBe('BUDGET_EXCEEDED');
    pending[0]({ ok: true, result: {} });
    expect((await a).ok).toBe(true);
    expect(session.budget.snapshot().budget).toMatchObject({ used: 1, reserved: 0 });
  });

  it('gives the run back when the browser rejects it and keeps it on a timeout', async () => {
    const session = new WorkflowAgentSession();
    session.budget.grant({ maxRuns: 2 });
    session.dispatchCommand = async (_command, args) => (args.nodeId === 'bad'
      ? { ok: false, error: { code: 'NODE_NOT_FOUND' } }
      : { ok: false, error: { code: 'COMMAND_TIMEOUT' } });
    await session.callCommand('workflow.node.run', { nodeId: 'bad' });
    expect(session.budget.snapshot().budget.used).toBe(0);
    await session.callCommand('workflow.node.run', { nodeId: 'slow' });
    expect(session.budget.snapshot().budget).toMatchObject({ used: 1, uncertain: 1 });
    session.dispatchCommand = async () => { throw Object.assign(new Error('lease'), { code: 'LEASE_EXPIRED' }); };
    await expect(session.callCommand('workflow.node.run', { nodeId: 'c' })).rejects.toThrow('lease');
    expect(session.budget.snapshot().budget.used).toBe(1);
  });
});
