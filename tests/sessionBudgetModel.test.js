// 会话预算的模型 / 属性测试（审计 PR-6，C3/C4）。
// 随机生成「发起付费调用 / 供应商给出结果」的交错序列，真实地走 WorkflowAgentSession.callCommand，
// 用一个按幂等键去重的假供应商记账，断言两条与钱有关的性质：
//   1. 永不超支：已计费 + 已发出且结果未定的生成次数，任何时刻都不超过批准的 maxRuns；
//   2. 不重复扣：会话记的 used 恰好等于供应商实际（或可能）扣费的次数，同一幂等键只记一次，结果未知的不漏记。
// 能抓到的历史错误：19ea7fd^ 的 check-then-consume（两条并发请求都看到「还剩最后一次」，重试再扣一次，超时不计）。
// 证明命令写在引入本测试的 commit 正文里。
// 假供应商不合并在途请求（每次提交都单独扣费），所以同键在途重试的合并由真实代码负责：
// SessionBudget.reserve 对在途键返回 inFlight，callCommand 直接复用第一次的 promise（single-flight），不预留、不再提交。
// 修复前（179669f2）fast-check 给出 [maxRuns=1, call k2, call k2, call 无键] → 步骤 1 超支 2 > 1；证明写在修复 commit 正文里。
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WorkflowAgentSession } from '../agent/session.js';

const KEYS = ['k0', 'k1', 'k2', 'k3'];
// 同一幂等键是同一次请求的重试，参数（以及扣费次数）必须相同。
const UNITS_BY_KEY = { k0: 1, k1: 2, k2: 1, k3: 3 };

// 供应商 / 浏览器侧的结果：charged 表示可能已经扣费（成功、或结果不确定），按最坏情况计。
const OUTCOMES = {
  ok: { charged: true, settle: d => d.resolve({ ok: true, result: {} }) },
  timeout: { charged: true, settle: d => d.resolve({ ok: false, error: { code: 'COMMAND_TIMEOUT' } }) },
  unknownSubmit: { charged: true, settle: d => d.resolve({ ok: false, error: { code: 'UNKNOWN_SUBMIT' } }) },
  thrownAfterSend: { charged: true, settle: d => d.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) },
  rejected: { charged: false, settle: d => d.resolve({ ok: false, error: { code: 'NODE_NOT_FOUND' } }) },
  needsConfirmation: { charged: false, settle: d => d.resolve({ ok: true, confirmation: { required: true } }) },
  thrownBeforeSend: { charged: false, settle: d => d.reject(Object.assign(new Error('lease'), { code: 'LEASE_EXPIRED' })) },
};

const actionArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ type: fc.constant('call'), key: fc.option(fc.constantFrom(...KEYS), { nil: null }), units: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('settle'), pick: fc.nat(), outcome: fc.constantFrom(...Object.keys(OUTCOMES)) }) },
);

// 让已结算的 callCommand 跑完 commit / release（它们在 await 之后的同步段里）。
const flush = () => new Promise(resolve => setImmediate(resolve));

function nodeIds(units, tag) {
  return Array.from({ length: units }, (_, i) => `${tag}-${i}`);
}

async function runScenario(maxRuns, actions) {
  const session = new WorkflowAgentSession();
  session.budget.grant({ maxRuns, grantedBy: 'model-test' });

  // 假供应商：每次提交都单独扣费（不合并在途的同键请求）；只有已扣费的键再来才直接返回成功、不再扣。
  const inFlight = []; // { id, key, units, promise, resolve, reject }
  const chargedKeys = new Set();
  let chargedUnits = 0;
  let nextId = 0;
  session.dispatchCommand = (_command, args, _source, idempotencyKey) => {
    const key = idempotencyKey || null;
    if (key && chargedKeys.has(key)) return Promise.resolve({ ok: true, result: {}, duplicate: true });
    const sub = { id: nextId++, key, units: args.nodeIds.length };
    sub.promise = new Promise((resolve, reject) => { sub.resolve = resolve; sub.reject = reject; });
    inFlight.push(sub);
    return sub.promise;
  };

  const calls = [];
  const check = step => {
    const exposure = chargedUnits + inFlight.reduce((sum, sub) => sum + sub.units, 0);
    const budget = session.budget.snapshot().budget;
    if (exposure > maxRuns) throw new Error(`超支：步骤 ${step} 后供应商侧已扣 + 在途 = ${exposure} > maxRuns ${maxRuns}`);
    if (budget.used !== chargedUnits) throw new Error(`记账不符：步骤 ${step} 后 used=${budget.used}，供应商实际（可能）扣费 ${chargedUnits}`);
    if (budget.used + (budget.reserved ?? 0) > maxRuns) throw new Error(`预算越界：used+reserved > ${maxRuns}`);
  };

  for (const [step, action] of actions.entries()) {
    if (action.type === 'call') {
      const units = action.key ? UNITS_BY_KEY[action.key] : action.units;
      const args = { nodeIds: nodeIds(units, action.key || `c${step}`) };
      // 不 await：模拟并发，下一个动作可能在这条请求出结果之前到来。
      calls.push(session.callCommand('workflow.node.run', args, 'cli', action.key || undefined).catch(() => undefined));
      await Promise.resolve();
    } else if (inFlight.length) {
      const sub = inFlight.splice(action.pick % inFlight.length, 1)[0];
      const outcome = OUTCOMES[action.outcome];
      if (outcome.charged) {
        chargedUnits += sub.units;
        if (sub.key) chargedKeys.add(sub.key);
      }
      outcome.settle(sub);
      await flush();
    }
    check(step);
  }
  // 收尾：所有在途请求都按成功结束，再核一次账。
  while (inFlight.length) {
    const sub = inFlight.shift();
    chargedUnits += sub.units;
    if (sub.key) chargedKeys.add(sub.key);
    OUTCOMES.ok.settle(sub);
    await flush();
  }
  await Promise.all(calls);
  check('final');
}

describe('session budget model (fast-check)', () => {
  it('never lets the provider charge more than the approved budget and never double-counts a retry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.array(actionArb, { minLength: 1, maxLength: 30 }), runScenario),
      { numRuns: 300 },
    );
  });

  it('pins the minimal concurrency counterexample the old check-then-consume code failed on', async () => {
    // 19ea7fd^：两条并发请求都在 check 时看到「还剩 1 次」，都发给供应商。
    await expect(runScenario(1, [
      { type: 'call', key: null, units: 1 },
      { type: 'call', key: null, units: 1 },
    ])).resolves.toBeUndefined();
  });
});
