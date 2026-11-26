// 同一幂等键的付费请求在途时再来一次（Agent 重试、双发）：合并到第一次的结果（single-flight），
// 不再预留额度、不再提交；第一次成功 / 失败 / 超时 / 抛错，重试拿到同一个结局，预算只按一次计。
import { describe, expect, it } from 'vitest';
import { WorkflowAgentSession } from '../agent/session.js';

function harness(maxRuns = 1) {
  const session = new WorkflowAgentSession();
  session.budget.grant({ maxRuns, grantedBy: 'in-flight-test' });
  const submissions = [];
  session.dispatchCommand = (command, args, _source, idempotencyKey) => {
    const sub = { command, args, key: idempotencyKey };
    sub.promise = new Promise((resolve, reject) => { sub.resolve = resolve; sub.reject = reject; });
    submissions.push(sub);
    return sub.promise;
  };
  const run = (key, nodeId = 'n1') => session.callCommand('workflow.node.run', { nodeIds: [nodeId] }, 'cli', key);
  const budget = () => session.budget.snapshot().budget;
  return { session, submissions, run, budget };
}

describe('in-flight idempotent retry merge (single-flight)', () => {
  it('resolves to the first call result, submits once and reserves nothing extra', async () => {
    const { submissions, run, budget } = harness(1);
    const first = run('k');
    const retry = run('k');
    expect(submissions).toHaveLength(1);
    expect(budget()).toMatchObject({ used: 0, reserved: 1, remaining: 0 });
    // 无键的新请求仍受预算约束：在途那一次占着最后的额度。
    await expect(run(undefined, 'other')).resolves.toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    submissions[0].resolve({ ok: true, result: {} });
    const [a, b] = await Promise.all([first, retry]);
    expect(b).toBe(a); // 同一个结果对象：重试拿到的就是第一次的结局
    expect(a).toMatchObject({ ok: true });
    expect(budget()).toMatchObject({ used: 1, reserved: 0, remaining: 0 });
  });

  it('gives the retry the same definite failure and frees the key and budget once', async () => {
    const { submissions, run, budget } = harness(1);
    const first = run('k');
    const retry = run('k');
    submissions[0].resolve({ ok: false, error: { code: 'NODE_NOT_FOUND' } });
    const [a, b] = await Promise.all([first, retry]);
    expect(b).toBe(a);
    expect(a).toMatchObject({ ok: false, error: { code: 'NODE_NOT_FOUND' } });
    expect(budget()).toMatchObject({ used: 0, reserved: 0, remaining: 1 });
    // 键已释放：以同一键重新提交是一次新的请求，正常预留。
    const again = run('k');
    expect(submissions).toHaveLength(2);
    expect(budget()).toMatchObject({ reserved: 1 });
    submissions[1].resolve({ ok: true, result: {} });
    await again;
    expect(budget()).toMatchObject({ used: 1, reserved: 0 });
  });

  it('gives the retry the same timeout and counts the uncertain submit exactly once', async () => {
    const { submissions, run, budget } = harness(2);
    const first = run('k');
    const retry = run('k');
    const timeout = Object.assign(new Error('timeout'), { code: 'COMMAND_TIMEOUT' });
    submissions[0].reject(timeout);
    await expect(first).rejects.toBe(timeout);
    await expect(retry).rejects.toBe(timeout);
    expect(submissions).toHaveLength(1);
    expect(budget()).toMatchObject({ used: 1, uncertain: 1, reserved: 0, remaining: 1 });
  });

  it('merges an uncertain-submit result and does not refund it', async () => {
    const { submissions, run, budget } = harness(1);
    const first = run('k');
    const retry = run('k');
    submissions[0].resolve({ ok: false, error: { code: 'UNKNOWN_SUBMIT' } });
    await expect(retry).resolves.toBe(await first);
    expect(budget()).toMatchObject({ used: 1, uncertain: 1, reserved: 0 });
  });

  it('gives the retry the same pre-submit rejection and refunds once', async () => {
    const { submissions, run, budget } = harness(1);
    const first = run('k');
    const retry = run('k');
    const lease = Object.assign(new Error('lease'), { code: 'LEASE_EXPIRED' });
    submissions[0].reject(lease);
    await expect(first).rejects.toBe(lease);
    await expect(retry).rejects.toBe(lease);
    expect(budget()).toMatchObject({ used: 0, reserved: 0, remaining: 1 });
  });

  it('still passes a retry of an already-settled key through without charging again', async () => {
    const { submissions, run, budget } = harness(1);
    const first = run('k');
    submissions[0].resolve({ ok: true, result: {} });
    await first;
    const retry = run('k');
    expect(submissions).toHaveLength(2); // 结算后的重试照旧下发，由浏览器的幂等缓存给结果
    submissions[1].resolve({ ok: true, result: {}, duplicate: true });
    await retry;
    expect(budget()).toMatchObject({ used: 1, reserved: 0 });
  });

  it('keeps pause stronger than the merge', async () => {
    const { session, submissions, run } = harness(1);
    run('k');
    session.budget.pause('stop');
    await expect(run('k')).resolves.toMatchObject({ ok: false, error: { code: 'SESSION_PAUSED' } });
    expect(submissions).toHaveLength(1);
  });
});
