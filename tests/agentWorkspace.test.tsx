import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentConnectionsPage, AgentDrawerEmptyState } from '../components/agent/AgentWorkspace';
import { createWorkflowProject } from '../components/workflow/store';

describe('Agent surfaces', () => {
  it('uses the top-level Agent page for local-agent connections only', () => {
    const project = { ...createWorkflowProject('Agent 项目'), id: 'project' };
    render(<AgentConnectionsPage project={project} />);

    expect(screen.getByTestId('agent-connections-page')).toBeInTheDocument();
    expect(screen.getByTestId('agent-connections-surface')).toHaveClass('agent-connections-page__surface');
    expect(screen.getByTestId('agent-connections-surface')).toHaveAttribute('aria-labelledby', 'agent-connections-title');
    expect(screen.getByRole('heading', { name: '用 DeepSeek Harness（DSH）指挥画布' })).toBeInTheDocument();
    expect(screen.queryByTestId('agent-host-picker')).not.toBeInTheDocument();
    expect(screen.getByText('npm run dsh:profile:install')).toBeInTheDocument();
    expect(screen.getByTestId('agent-dsh-steps')).toHaveTextContent('npm run dsh:start');
    const handoff = screen.getByTestId('agent-handoff-prompt');
    expect(handoff).toHaveTextContent('https://github.com/avabbbb/Iris');
    expect(handoff).toHaveTextContent('workflow.inspect --summary');
    expect(screen.getByRole('button', { name: '一键复制提示词' })).toBeInTheDocument();
    expect(screen.getByTestId('agent-env-note')).toHaveAttribute('data-env', 'local');
    expect(screen.getByTestId('agent-dsh-status')).toHaveTextContent('npm 发布与插件市场尚未完成');
    expect(screen.queryByText('正在优化，后续上线')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /开始你的创作/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Brief/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /时间线/ })).not.toBeInTheDocument();
  });

  it('keeps project-less assistant onboarding separate from connection management', () => {
    const onCreateProject = vi.fn();
    render(<AgentDrawerEmptyState onCreateProject={onCreateProject} />);

    expect(screen.getByTestId('agent-drawer-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-host-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(onCreateProject).toHaveBeenCalledOnce();
  });

  it('shows the Iris Link handoff prompt on hosted HTTPS origins instead of local ensure', () => {
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, protocol: 'https:', hostname: 'iris.avabbbb.com', origin: 'https://iris.avabbbb.com' },
    });
    try {
      const project = { ...createWorkflowProject('线上项目'), id: 'project-hosted' };
      render(<AgentConnectionsPage project={project} />);

      expect(screen.getByTestId('agent-env-note')).toHaveAttribute('data-env', 'hosted');
      expect(screen.getByTestId('agent-env-note')).toHaveTextContent('Iris Link');
      const handoff = screen.getByTestId('agent-handoff-prompt');
      expect(handoff).toHaveTextContent('login web --open --url https://iris.avabbbb.com --scopes agent.read,agent.run,tools.invoke');
      expect(handoff).toHaveTextContent('link status --json');
      expect(handoff).toHaveTextContent('workflow.inspect --summary --json');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });
});
