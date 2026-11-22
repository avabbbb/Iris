// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pipeline } from '../tools/iris/pipeline/index.js';
import { canonicalJson, sha256Text } from '../tools/iris/pipeline/store.js';

const brief = { keyLine: '截图进去，宣传片出来', aspect: '9:16' };
const budget = { maxTasks: 4, maxRounds: 2 };

let home;
let pipeline;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'iris-approvals-'));
  pipeline = new Pipeline({ home });
});
afterEach(() => {
  pipeline.close();
  rmSync(home, { recursive: true, force: true });
});

const startArgs = (extra = {}) => ({ projectId: 'p', brief, budget, budgetConfirmed: true, ...extra });

describe('pipeline user approvals', () => {
  it('ignores a model-filled budgetConfirmed and asks for a UI approval instead', async () => {
    const first = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'built-in', mutationId: 's1' });
    expect(first.ok).toBe(false);
    expect(first.error.code).toBe('CONFIRMATION_REQUIRED');
    const { approvalId } = first.error.details.approval;
    expect(approvalId).toMatch(/^apr_/);
    expect(pipeline.listApprovals()).toHaveLength(1);

    // 模型再试一次仍被拦，而且复用同一条待审批请求，不刷出新卡片。
    const again = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'built-in', mutationId: 's1' });
    expect(again.error.details.approval.approvalId).toBe(approvalId);
    expect(pipeline.listApprovals()).toHaveLength(1);

    pipeline.grantApproval(approvalId);
    const approved = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'built-in', mutationId: 's1' });
    expect(approved.ok).toBe(true);
    expect(pipeline.listApprovals()).toHaveLength(0);

    const replay = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'built-in', mutationId: 's1' });
    expect(replay.ok).toBe(true);
    expect(replay.step.replayed).toBe(true);
  });

  it('binds an approval to the exact arguments and consumes it once', async () => {
    const first = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'mcp', mutationId: 'a' });
    pipeline.grantApproval(first.error.details.approval.approvalId);

    const different = await pipeline.execute('pipeline.run.start', startArgs({ budget: { maxTasks: 99, maxRounds: 2 } }), { caller: 'mcp', mutationId: 'b' });
    expect(different.error.code).toBe('CONFIRMATION_REQUIRED');

    const used = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'mcp', mutationId: 'c' });
    expect(used.ok).toBe(true);
    const reused = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'mcp', mutationId: 'd' });
    expect(reused.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('a caller cannot claim to be the user to skip approval', async () => {
    const spoofed = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'user', mutationId: 'u' });
    expect(spoofed.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('keeps the explicit flag for the trusted CLI entry', async () => {
    const cli = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'cli', mutationId: 'cli', trustedConfirmation: true });
    expect(cli.ok).toBe(true);
  });

  it('denied or unknown approvals cannot be granted', () => {
    expect(() => pipeline.grantApproval('apr_00000000-0000-0000-0000-000000000000')).toThrow(/找不到/);
    expect(() => pipeline.grantApproval('../../etc/passwd')).toThrow(/找不到/);
  });
});

describe('paid step with unknown submit', () => {
  it('stays locked on every retry until confirmResubmit', async () => {
    const run = await pipeline.execute('pipeline.run.start', startArgs(), { caller: 'cli', mutationId: 'run', trustedConfirmation: true });
    const runId = run.result.runId;
    const args = { runId, lines: [{ id: 'l1', speechText: '你好', displayText: '你好' }], voice: { route: 'minimax' } };
    const argsDigest = sha256Text(canonicalJson({ command: 'audio.tts', args }));
    // 模拟进程在付费提交途中崩溃：Step 停在 running。
    pipeline.store.startStep({ runId, tool: 'audio.tts', caller: 'built-in', mutationId: 'tts-1', argsDigest, args, paid: true });

    const first = await pipeline.execute('audio.tts', args, { caller: 'built-in', mutationId: 'tts-1' });
    expect(first.error.code).toBe('UNKNOWN_SUBMIT');
    const second = await pipeline.execute('audio.tts', args, { caller: 'built-in', mutationId: 'tts-1' });
    expect(second.error.code).toBe('UNKNOWN_SUBMIT');

    const step = pipeline.trace(runId).steps.find(item => item.mutationId === 'tts-1');
    expect(step.status).toBe('unknown_submit');
    expect(step.attempts).toBe(1);
  });
});
