// 斜杠菜单里的 /compact（命令在 Skill 之前、键盘选择、完整命令名直接执行）与「已压缩」卡片渲染。
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

describe('compaction card', () => {
  it('renders before/after tokens and the focus instead of a plain system line', () => {
    render(<WorkflowAgentMessages language="zho" messages={[
      { id: 'u1', role: 'user', text: '你好' },
      { id: 'c1', role: 'system', text: '已压缩上下文', compaction: { tokensBefore: 96_400, tokensAfter: 14_200, focus: '保留接口设计的讨论', reason: 'manual' } },
    ]} />);
    const card = screen.getByTestId('agent-compaction-card');
    expect(card).toHaveTextContent('已压缩上下文');
    expect(card).toHaveTextContent('约 96K → 14K tokens');
    expect(card).toHaveTextContent('保留接口设计的讨论');
  });

  it('shows a pending state and auto-compaction labels', () => {
    render(<WorkflowAgentMessages language="en" messages={[
      { id: 'c2', role: 'system', text: '', compaction: { tokensBefore: 0, pending: true, reason: 'midturn' } },
    ]} />);
    const card = screen.getByTestId('agent-compaction-card');
    expect(card).toHaveTextContent('Compacting context…');
    expect(card).toHaveTextContent('Auto (mid-turn)');
  });
});
