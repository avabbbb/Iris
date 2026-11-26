// 审批闸（services/agentToolGate.ts）的运行时部分；类型部分由 tsc 保证（裸 AgentTool 进不了内核）。
import { describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { gateReadOnlyTool, gateTool } from '../services/agentToolGate';

const tool = (name: string, execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }], details: {} }))): AgentTool => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  execute,
});

describe('agent tool gate', () => {
  it('runs the approval guard with the tool name and params before executing', async () => {
    const order: string[] = [];
    const execute = vi.fn(async () => { order.push('execute'); return { content: [], details: {} }; });
    const guard = vi.fn(async (command: string) => { order.push('guard:' + command); });
    const gated = gateTool(tool('iris_cut_edit', execute), guard);
    await gated.execute('call-1', { operations: [{ op: 'delete_clips' }] });
    expect(guard).toHaveBeenCalledWith('iris_cut_edit', { operations: [{ op: 'delete_clips' }] });
    expect(order).toEqual(['guard:iris_cut_edit', 'execute']);
  });

  it('does not execute when the guard denies or the user declines', async () => {
    const execute = vi.fn();
    const gated = gateTool(tool('iris_cut_edit', execute), async () => { throw new Error('denied'); });
    await expect(gated.execute('call-1', {})).rejects.toThrow('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('only lets tools the approval layer classifies as read skip the guard', () => {
    expect(() => gateReadOnlyTool(tool('iris_ask'))).not.toThrow();
    expect(() => gateReadOnlyTool(tool('iris_cut_get_timeline'))).not.toThrow();
    expect(() => gateReadOnlyTool(tool('iris_cut_edit'))).toThrow(/不是只读/);
    // 未登记的新工具在审批层是 exec，不能自称只读。
    expect(() => gateReadOnlyTool(tool('iris_new_paid_tool'))).toThrow(/exec/);
  });
});
