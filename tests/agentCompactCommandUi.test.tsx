// 斜杠菜单里的 /compact（命令在 Skill 之前、键盘选择、完整命令名直接执行）；压缩过程沿用 main 的奶蛙胶囊。
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProductionSkillDeck } from '../components/agent/ProductionSkillDeck';
import { WorkflowAgentMessages } from '../components/workflow/WorkflowAgentMessages';
import { agentSlashCommands } from '../components/agent/agentSlashCommands';

const commands = agentSlashCommands('zho', { builtin: true });

function renderDeck(searchQuery: string, onCommand = vi.fn(), onChange = vi.fn()) {
  const keyboardRef: { current: ((key: string) => boolean) | null } = { current: null };
  const dropTargetRef = createRef<HTMLDivElement>();
  render(<div ref={dropTargetRef}><ProductionSkillDeck onChange={onChange} dropTargetRef={dropTargetRef} open onOpenChange={vi.fn()} searchQuery={searchQuery} keyboardRef={keyboardRef} commands={commands} onCommand={onCommand} /></div>);
  return { keyboardRef, onCommand, onChange };
}

describe('/compact in the slash menu', () => {
  it('lists /compact above the Skills and picks it with ↓ + Enter (inserting it for a focus)', async () => {
    const { keyboardRef, onCommand, onChange } = renderDeck('');
    const command = await screen.findByTestId('agent-slash-command-compact');
    expect(command).toHaveTextContent('/compact');
    expect(command).toHaveTextContent('[聚焦说明]');
    const groups = screen.getAllByRole('group');
    expect(groups.indexOf(command)).toBeLessThan(groups.length - 1);
    await waitFor(() => expect(keyboardRef.current).toBeTypeOf('function'));
    act(() => { keyboardRef.current!('ArrowDown'); });
    expect(command).toHaveAttribute('data-highlighted', 'true');
    act(() => { keyboardRef.current!('Enter'); });
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'compact' }), { run: false });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('runs straight away when the typed text is the full command name', async () => {
    const { keyboardRef, onCommand } = renderDeck('compact');
    await screen.findByTestId('agent-slash-command-compact');
    await waitFor(() => expect(keyboardRef.current).toBeTypeOf('function'));
    act(() => { keyboardRef.current!('Enter'); });
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'compact' }), { run: true });
  });

  it('clicking the row picks the command; other queries hide it', async () => {
    const { onCommand } = renderDeck('comp');
    fireEvent.click(await screen.findByRole('button', { name: /\/compact/ }));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'compact' }), { run: false });
  });

  it('does not show commands for an unrelated query', async () => {
    renderDeck('zzz-no-match');
    await waitFor(() => expect(screen.queryByTestId('agent-slash-command-compact')).toBeNull());
  });
});

describe('compaction capsule (main UI)', () => {
  it('keeps no card in history for a compaction record; the live capsule covers mid-turn compaction', () => {
    const { container } = render(<WorkflowAgentMessages language="zho" messages={[
      { id: 'u1', role: 'user', text: '你好' },
      { id: 'c1', role: 'system', text: '已压缩上下文', compaction: { tokensBefore: 96_400 } },
    ]} compaction={{ phase: 'running', reason: 'midturn', startedAt: Date.now() }} />);
    expect(container.querySelector('[data-message-id="c1"]')).toBeNull();
    expect(screen.getByTestId('agent-compaction-live')).toHaveTextContent('正在压缩上下文');
  });
});
