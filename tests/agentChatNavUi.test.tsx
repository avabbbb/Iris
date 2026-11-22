import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowAgentMessages, type WorkflowAgentDisplayMessage } from '../components/workflow/WorkflowAgentMessages';
import { AgentRunPlanCard } from '../components/agent/AgentRunPlanCard';
import { AgentScrollToLatest, AgentTurnTimeline } from '../components/agent/AgentConversationNav';
import { splitConversationTurns } from '../components/agent/agentConversationNavModel';
import type { AgentConfirmRequest } from '../services/agentSpendMandate';
import type { WorkflowNode } from '../components/workflow/types';

const messages: WorkflowAgentDisplayMessage[] = [
  { id: 'u1', role: 'user', text: '第一问' },
  { id: 'a1', role: 'assistant', text: '第一答' },
  { id: 'u2', role: 'user', text: '> 第一答\n\n接着改' },
  { id: 'a2', role: 'assistant', text: '好的' },
];

describe('agent chat navigation UI', () => {
  it('renders a quote button on assistant messages and a quote block in the user bubble', () => {
    const onQuote = vi.fn();
    const { container } = render(<WorkflowAgentMessages messages={messages} language="zho" onQuoteMessage={onQuote} />);
    const buttons = screen.getAllByRole('button', { name: '引用回复' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    const quote = container.querySelector('.workflow-agent__quote');
    expect(quote).toHaveTextContent('第一答');
    expect(screen.getByText('接着改')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-index="1"]')).toHaveAttribute('data-message-id', 'u2');
  });

  it('renders turn footers at the end of each turn', () => {
    render(<WorkflowAgentMessages messages={messages} language="zho" renderTurnFooter={turn => <aside data-testid={'footer-' + turn} />} />);
    const footer0 = screen.getByTestId('footer-0');
    // 第一轮的附加内容在第二条用户消息之前
    expect(footer0.compareDocumentPosition(screen.getByText('接着改')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('footer-1')).toBeInTheDocument();
  });

  it('shows a timeline tick per turn with a hover preview', () => {
    const rootRef = createRef<HTMLDivElement>();
    render(<div ref={rootRef}><WorkflowAgentMessages messages={messages} language="zho" /><AgentTurnTimeline rootRef={rootRef} turns={splitConversationTurns(messages)} language="zho" /></div>);
    const ticks = screen.getAllByRole('button', { name: /^第 \d 轮/ });
    expect(ticks).toHaveLength(2);
    fireEvent.mouseEnter(ticks[1]);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('接着改');
    expect(tip).toHaveTextContent('好的');
    expect(tip).toHaveTextContent('点击回到这轮对话');
    fireEvent.click(ticks[1]);
  });

  it('hides the timeline for a single turn and the latest button when at the bottom', () => {
    const rootRef = createRef<HTMLDivElement>();
    render(<div ref={rootRef}><AgentTurnTimeline rootRef={rootRef} turns={splitConversationTurns(messages.slice(0, 2))} language="en" /><AgentScrollToLatest visible={false} language="en" onClick={vi.fn()} /></div>);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to latest' })).not.toBeInTheDocument();
  });

  it('scroll-to-latest button reports clicks', () => {
    const onClick = vi.fn();
    render(<AgentScrollToLatest visible language="zho" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe('run plan card', () => {
  const nodes = [
    { id: 'g', type: 'subgraph', title: '三机位补充', position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { groupKind: 'group' } },
    { id: 'a', type: 'image', title: '正后方高位', parentId: 'g', position: { x: 0, y: 0 }, width: 1, height: 1, metadata: {} },
    { id: 'b', type: 'image', title: '舞台侧前方', parentId: 'g', position: { x: 0, y: 0 }, width: 1, height: 1, metadata: {} },
  ] as unknown as WorkflowNode[];
  const request: AgentConfirmRequest = {
    kind: 'generation', command: 'workflow.node.run', args: { nodeIds: ['a', 'b'] },
    gates: [
      { serviceLabel: 'RunningHub', modelLabel: 'image-g-2', mediaType: 'image', taskCount: 1 },
      { serviceLabel: 'RunningHub', modelLabel: 'image-g-2', mediaType: 'image', taskCount: 1 },
    ],
  };

  it('shows model, title + status, group, node chips and the three choices', () => {
    const onDecide = vi.fn();
    render(<AgentRunPlanCard request={request} nodes={nodes} language="zho" onDecide={onDecide} />);
    const card = screen.getByRole('alertdialog', { name: '生成计划' });
    expect(card).toHaveTextContent('本批提交模型：image-g-2');
    expect(card).toHaveTextContent('三机位补充');
    expect(card).toHaveTextContent('待生成');
    expect(card).toHaveTextContent('画布工作流（2个节点）');
    expect(screen.getByText('正后方高位')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /资产列表/ }));
    expect(screen.getByRole('button', { name: /资产列表/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '创建后手动生成' }));
    expect(onDecide).toHaveBeenLastCalledWith('manual', { session: false });
    fireEvent.click(screen.getByRole('button', { name: '调整后再创建' }));
    expect(onDecide).toHaveBeenLastCalledWith('adjust', { session: false });
    fireEvent.click(screen.getByRole('button', { name: '创建并自动生成' }));
    expect(onDecide).toHaveBeenLastCalledWith('auto', { session: false });
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onDecide).toHaveBeenLastCalledWith('adjust', { session: false });
  });

  it('marks the primary with ⏎ but never approves from an Enter that is not on the primary', () => {
    const onDecide = vi.fn();
    render(<AgentRunPlanCard request={request} nodes={nodes} language="zho" onDecide={onDecide} />);
    const card = screen.getByRole('alertdialog', { name: '生成计划' });
    const primary = screen.getByRole('button', { name: '创建并自动生成' });
    expect(primary.querySelector('kbd')?.textContent).toBe('⏎');
    // 卡片拿焦点，不是主按钮：回车不批准（付费生成没有自动批准倒计时）
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onDecide).not.toHaveBeenCalled();
    expect(card).not.toHaveTextContent(/自动批准|Auto approve/);
  });

  it('turns on the spend mandate only when the user ticks it, and blocks auto-run for a blocked plan', () => {
    const onDecide = vi.fn();
    const { rerender } = render(<AgentRunPlanCard request={request} nodes={nodes} language="en" offerMandate onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }));
    expect(onDecide).toHaveBeenLastCalledWith('auto', { session: true });
    rerender(<AgentRunPlanCard key="blocked" request={request} nodes={nodes} language="en" blocked onDecide={onDecide} />);
    expect(screen.getByRole('button', { name: 'Create and generate' })).toBeDisabled();
  });

  it('shows progress after approval instead of the buttons', () => {
    const running = nodes.map(node => node.id === 'a' ? { ...node, metadata: { status: 'success' } } : node.id === 'b' ? { ...node, metadata: { status: 'loading' } } : node) as WorkflowNode[];
    const { rerender } = render(<AgentRunPlanCard request={request} nodes={running} language="zho" decision="auto" decidedAt={1} />);
    expect(screen.queryByRole('button', { name: '创建并自动生成' })).not.toBeInTheDocument();
    expect(screen.getAllByText('生成中 1/2').length).toBeGreaterThan(0);
    const done = running.map(node => ({ ...node, metadata: { ...node.metadata, status: node.type === 'image' ? 'success' : undefined } })) as WorkflowNode[];
    rerender(<AgentRunPlanCard request={request} nodes={done} language="zho" decision="auto" decidedAt={1} />);
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
  });
});
