import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  buildHarkProactiveCards,
  createCustomHarkPanelFromText,
  getHarkAtmosphere,
} from '../components/agent/harkPanels';
import { HarkAgentWorkspace } from '../components/agent/HarkAgentWorkspace';
import { createWorkflowProject } from '../components/workflow/store';
import { createWorkflowNode } from '../components/workflow/constants';

describe('Hark Agent Workspace pure logic', () => {
  it('derives sky mood and greetings by time of day', () => {
    expect(getHarkAtmosphere(new Date('2026-11-27T07:30:00'), 'zho').mood).toBe('dawn');
    expect(getHarkAtmosphere(new Date('2026-11-27T14:00:00'), 'en').mood).toBe('day');
    expect(getHarkAtmosphere(new Date('2026-11-27T18:30:00'), 'zho').mood).toBe('dusk');
    expect(getHarkAtmosphere(new Date('2026-11-27T23:30:00'), 'en').mood).toBe('night');
  });

  it('generates prioritized proactive action cards from real canvas state', () => {
    const project = createWorkflowProject('电影短片');
    const anchor = {
      ...createWorkflowNode('a1', 'image', { x: 0, y: 0 }),
      title: '主角定妆',
      anchor: { kind: 'character' as const, approved: false },
    };
    const draftVideo = {
      ...createWorkflowNode('v1', 'video', { x: 400, y: 0 }, {
        status: 'success',
        config: { mode: 'video', draftMode: true, resolution: '480p', draftPreviousResolution: '1080p' },
      }),
      title: '镜头 01',
    };
    project.nodes = [anchor, draftVideo];

    const cards = buildHarkProactiveCards({
      project,
      userApiKeys: [],
      pendingApprovals: 1,
      language: 'zho',
    });
    expect(cards.map(c => c.id)).toContain('pending-approvals');
    expect(cards.map(c => c.id)).toContain('setup-byok');
    expect(cards.map(c => c.id)).toContain('approve-anchors');
    expect(cards[0].id).toBe('pending-approvals');
  });

  it('parses natural-language panel descriptions into checklist, prompt-deck, or note panels', () => {
    const checklist = createCustomHarkPanelFromText('交付检查：角色定妆、配音对齐、导出成片', 'zho');
    expect(checklist.kind).toBe('checklist');
    expect(checklist.title).toBe('交付检查');
    expect(checklist.items).toHaveLength(3);

    const promptDeck = createCustomHarkPanelFromText('镜头提示词：广角建立、微距特写', 'zho');
    expect(promptDeck.kind).toBe('prompt-deck');
    expect(promptDeck.items).toHaveLength(2);

    const note = createCustomHarkPanelFromText('保持全片冷青霓虹基调', 'zho');
    expect(note.kind).toBe('note');
    expect(note.body).toBe('保持全片冷青霓虹基调');
  });
});

describe('HarkAgentWorkspace UI', () => {
  it('renders Hark navigation views, masks vault keys, and preserves Connections view', () => {
    const project = { ...createWorkflowProject('测试电影'), id: 'p-hark-test' };
    render(
      <HarkAgentWorkspace
        project={project}
        language="zho"
        userApiKeys={[
          {
            id: 'k1',
            name: 'My OpenAI',
            provider: 'openai_compatible',
            key: 'sk-super-secret-value-never-render',
            capabilities: ['agent', 'image'],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]}
        onOpenSettings={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('hark-agent-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('hark-view-home')).toBeInTheDocument();
    expect(screen.getByTestId('hark-hero-composer')).toBeInTheDocument();
    expect(screen.getByTestId('hark-hero-voice-btn')).toBeInTheDocument();

    // Switch to Vault and verify raw secret is NEVER rendered
    fireEvent.click(screen.getByTestId('hark-tab-vault'));
    expect(screen.getByTestId('hark-view-vault')).toBeInTheDocument();
    expect(screen.getByText('My OpenAI')).toBeInTheDocument();
    expect(screen.queryByText(/sk-super-secret/)).not.toBeInTheDocument();

    // Switch to Live Handoff
    fireEvent.click(screen.getByTestId('hark-tab-handoff'));
    expect(screen.getByTestId('hark-view-handoff')).toBeInTheDocument();

    // Switch to Connections and verify legacy AgentConnectionsPage is preserved inside
    fireEvent.click(screen.getByTestId('hark-tab-connections'));
    expect(screen.getByTestId('agent-connections-page')).toBeInTheDocument();
  });
});
