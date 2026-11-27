import {
  Activity,
  ArrowRight,
  ArrowUp,
  Brain,
  Check,
  CheckCircle2,
  FolderKanban,
  Home,
  KeyRound,
  Layers,
  Link2,
  MessageSquare,
  Mic,
  MicOff,
  Plus,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import '../../styles/harkAgent.css';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { readApprovalMode, writeApprovalMode, type ApprovalMode } from '../../services/agentToolPolicy';
import { createBrowserAgentTaskStore } from '../../services/agentTaskStore';
import { useAgentMemoryStore } from '../../stores/useAgentMemoryStore';
import { useAgentReceiptStore } from '../../stores/useAgentReceiptStore';
import { decideCanvasAgentApproval, stopCanvasAgentRun, useCanvasAgentStore } from '../../stores/useCanvasAgentStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import type { AssetLibrary, UserApiKey } from '../../types';
import { buildProductionBible } from '../workflow/productionBible';
import { useWorkflowStore } from '../workflow/store';
import { WORKFLOW_TEMPLATES, buildWorkflowTemplate } from '../workflow/templates';
import type { WorkflowProject } from '../workflow/types';
import { AgentConnectionsPage, AgentDrawerEmptyState } from './AgentWorkspace';
import { IrisAgentPanel } from './IrisAgentPanel';
import {
  buildHarkProactiveCards,
  createCustomHarkPanelFromText,
  getHarkAtmosphere,
  loadCustomHarkPanels,
  saveCustomHarkPanels,
  type HarkCustomPanel,
  type HarkProactiveCard,
} from './harkPanels';

export type HarkWorkspaceTab = 'home' | 'chat' | 'projects' | 'handoff' | 'vault' | 'connections';

export interface HarkAgentWorkspaceProps {
  project: WorkflowProject | null;
  language?: 'en' | 'zho';
  userApiKeys?: UserApiKey[];
  assetLibrary?: AssetLibrary;
  onAddApiKey?: (payload: Omit<UserApiKey, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onUpdateApiKey?: (id: string, patch: Partial<Omit<UserApiKey, 'id' | 'createdAt'>>) => void;
  onOpenSettings: () => void;
  onFocusNode?: (nodeId: string) => void;
  onCreateProject: (title?: string, seed?: Pick<WorkflowProject, 'nodes' | 'connections'>) => void;
}

const APPROVAL_OPTIONS: ReadonlyArray<{ id: ApprovalMode; zho: string; en: string; descZho: string; descEn: string }> = [
  { id: 'always-ask', zho: '逐次确认（最安全）', en: 'Always ask', descZho: '所有写入、付费生成与删除都需明确确认。', descEn: 'Every write, spend, and delete asks before running.' },
  { id: 'write', zho: '自动编辑画布', en: 'Auto canvas writes', descZho: '允许自动修改节点与连线；付费生成与删除仍强制确认。', descEn: 'Auto-apply canvas edits; paid spend and delete still require confirmation.' },
  { id: 'yolo', zho: '高效执行（守住硬闸）', en: 'Autonomous (hard gates intact)', descZho: '放行常规工具；费用扣款与删除硬闸永不跳过。', descEn: 'Auto-run routine tools; spend and delete hard gates are never bypassed.' },
];

export function HarkAgentWorkspace({
  project,
  language = 'zho',
  userApiKeys = [],
  assetLibrary,
  onAddApiKey,
  onUpdateApiKey,
  onOpenSettings,
  onFocusNode,
  onCreateProject,
}: HarkAgentWorkspaceProps) {
  const en = language === 'en';
  const L = (zh: string, enText: string) => (en ? enText : zh);
  const [tab, setTab] = useState<HarkWorkspaceTab>('home');
  const [heroPrompt, setHeroPrompt] = useState('');
  const [pendingChatPrompt, setPendingChatPrompt] = useState<{ id: string; text: string } | null>(null);
  const [customPanels, setCustomPanels] = useState<HarkCustomPanel[]>([]);
  const [panelDraft, setPanelDraft] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [memorySearch, setMemorySearch] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryTagsDraft, setMemoryTagsDraft] = useState('');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() => readApprovalMode());
  const [ledgerTasks, setLedgerTasks] = useState<Array<Record<string, unknown>>>([]);

  const projects = useWorkflowStore(state => state.projects);
  const activeProjectId = useWorkflowStore(state => state.activeProjectId);
  const setActiveProject = useWorkflowStore(state => state.setActiveProject);
  const setCanvasView = useWorkspaceStore(state => state.setCanvasView);

  const liveCanvasRuns = useCanvasAgentStore(state => state.live);
  const memoriesByProject = useAgentMemoryStore(state => state.byProject);
  const loadMemories = useAgentMemoryStore(state => state.load);
  const addMemory = useAgentMemoryStore(state => state.add);
  const removeMemory = useAgentMemoryStore(state => state.remove);
  const receiptsByProject = useAgentReceiptStore(state => state.byProject);

  const projectMemories = project ? (memoriesByProject[project.id] || []) : [];
  const projectReceipts = project ? (receiptsByProject[project.id] || []) : [];

  useEffect(() => {
    void loadCustomHarkPanels().then(setCustomPanels);
  }, []);

  useEffect(() => {
    if (!project) { setLedgerTasks([]); return; }
    void loadMemories(project.id);
    void createBrowserAgentTaskStore(project.id).load().then(records => {
      setLedgerTasks([...records].reverse());
    }).catch(() => setLedgerTasks([]));
  }, [project?.id, loadMemories, tab]);

  const voice = useVoiceInput({
    language,
    onFinalTranscript: transcript => {
      setHeroPrompt(prev => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
    },
  });

  const liveEntries = useMemo(() => Object.entries(liveCanvasRuns), [liveCanvasRuns]);
  const runningCount = liveEntries.filter(([, entry]) => entry.phase === 'running' || entry.phase === 'queued').length;
  const pendingApprovals = liveEntries.filter(([, entry]) => Boolean(entry.approval)).length;

  const atmosphere = useMemo(() => getHarkAtmosphere(new Date(), language), [language]);
  const bible = useMemo(() => buildProductionBible(project), [project]);
  const proactiveCards = useMemo(
    () => buildHarkProactiveCards({ project, userApiKeys, pendingApprovals, language }),
    [project, userApiKeys, pendingApprovals, language],
  );

  const statusPillState = pendingApprovals > 0 ? 'approval' : runningCount > 0 ? 'running' : 'ready';
  const statusPillText = pendingApprovals > 0
    ? L(`等待审批 · ${pendingApprovals}`, `Needs approval · ${pendingApprovals}`)
    : runningCount > 0
      ? L(`实时执行中 · ${runningCount}`, `Working · ${runningCount}`)
      : L('就绪 · 本地安全沙箱', 'Ready · Local Vault');

  const dispatchPromptToChat = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (!project) {
      onCreateProject(clean.slice(0, 24));
    }
    setPendingChatPrompt({ id: `hark_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text: clean });
    setHeroPrompt('');
    setTab('chat');
  };

  const handleHeroKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      dispatchPromptToChat(heroPrompt);
    }
  };

  const handleProactiveAction = (card: HarkProactiveCard) => {
    if (card.actionKind === 'open-settings') { onOpenSettings(); return; }
    if (card.actionKind === 'open-handoff') { setTab('handoff'); return; }
    if (card.actionKind === 'open-vault') { setTab('vault'); return; }
    if (card.actionKind === 'create-project') { onCreateProject(L('未命名工作流', 'Untitled workflow')); return; }
    if (card.actionKind === 'open-canvas') {
      if (card.nodeId && onFocusNode) onFocusNode(card.nodeId);
      else setCanvasView('spatial');
      return;
    }
    if (card.actionKind === 'chat-prompt' && card.prompt) {
      dispatchPromptToChat(card.prompt);
    }
  };

  const handleCreateCustomPanel = async () => {
    const panel = createCustomHarkPanelFromText(panelDraft, language);
    const next = await saveCustomHarkPanels([panel, ...customPanels]);
    setCustomPanels(next);
    setPanelDraft('');
  };

  const handleToggleChecklistItem = async (panelId: string, itemId: string) => {
    const updated = customPanels.map(panel => panel.id !== panelId ? panel : {
      ...panel,
      items: (panel.items || []).map(item => item.id === itemId ? { ...item, done: !item.done } : item),
    });
    const saved = await saveCustomHarkPanels(updated);
    setCustomPanels(saved);
  };

  const handleRemovePanel = async (panelId: string) => {
    const saved = await saveCustomHarkPanels(customPanels.filter(p => p.id !== panelId));
    setCustomPanels(saved);
  };

  const handleAddMemory = async () => {
    if (!project || !memoryDraft.trim()) return;
    const tags = memoryTagsDraft.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    await addMemory(project.id, { text: memoryDraft.trim(), tags });
    setMemoryDraft('');
    setMemoryTagsDraft('');
  };

  const handleChangeApproval = (mode: ApprovalMode) => {
    setApprovalMode(mode);
    writeApprovalMode(mode);
  };

  const filteredProjects = projects.filter(item => {
    const q = projectSearch.trim().toLowerCase();
    return !q || item.title.toLowerCase().includes(q);
  });

  const filteredMemories = projectMemories.filter(entry => {
    const q = memorySearch.trim().toLowerCase();
    if (!q) return true;
    return entry.text.toLowerCase().includes(q) || entry.tags.some(tag => tag.toLowerCase().includes(q));
  });

  const navItems: Array<{ id: HarkWorkspaceTab; label: string; icon: typeof Home; badge?: number }> = [
    { id: 'home', label: L('主页', 'Home'), icon: Home },
    { id: 'chat', label: L('对话', 'Chat'), icon: MessageSquare },
    { id: 'projects', label: L('项目', 'Projects'), icon: FolderKanban },
    { id: 'handoff', label: L('实时执行', 'Handoff'), icon: Activity, badge: pendingApprovals || runningCount || undefined },
    { id: 'vault', label: L('记忆与保险库', 'Memory & Vault'), icon: Shield },
    { id: 'connections', label: L('外部连接', 'Connections'), icon: Link2 },
  ];

  const totalCostEstimate = useMemo(() => {
    if (!project) return 0;
    return project.nodes.reduce((sum, node) => sum + (Number(node.metadata.generationActualCost) || 0), 0);
  }, [project]);

  return (
    <div className="hark-workspace" data-testid="hark-agent-workspace" data-sky={atmosphere.mood}>
      <div className="hark-backdrop" aria-hidden="true">
        <div className="hark-backdrop__orb hark-backdrop__orb--primary" />
        <div className="hark-backdrop__orb hark-backdrop__orb--accent" />
      </div>

      {/* Top Spatial Bar */}
      <header className="hark-topbar">
        <div className="hark-brand">
          <div className="hark-status-pill" data-state={statusPillState} data-testid="hark-status-pill">
            <span className="hark-status-dot" aria-hidden="true" />
            <span>{statusPillText}</span>
          </div>
          {project && (
            <span style={{ fontSize: 12, color: 'var(--isl-ink-soft)' }}>
              {project.title} · {project.nodes.length} {L('节点', 'nodes')}
            </span>
          )}
        </div>

        <nav className="hark-nav" role="tablist" aria-label={L('Agent 工作区视图', 'Agent workspace views')}>
          {navItems.map(item => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                data-testid={`hark-tab-${item.id}`}
                aria-selected={active}
                className={`hark-nav__btn${active ? ' is-active' : ''}`}
                onClick={() => setTab(item.id)}
              >
                <Icon size={14} />
                <span>{item.label}</span>
                {item.badge ? <span className="hark-nav__badge">{item.badge}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="hark-topbar__actions">
          <button type="button" className="hark-ghost-btn" onClick={() => setCanvasView('spatial')}>
            <Layers size={13} />
            {L('回到画布', 'Canvas')}
          </button>
          <button type="button" className="hark-ghost-btn" onClick={onOpenSettings}>
            <KeyRound size={13} />
            {L('AI 服务', 'Services')}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className={`hark-body${tab === 'chat' ? ' hark-body--chat' : ''}`}>
        {tab === 'home' && (
          <div className="hark-container" data-testid="hark-view-home">
            <section className="hark-hero">
              <h1>{atmosphere.greeting}{project ? ` · ${project.title}` : ''}</h1>
              <p>{atmosphere.subtitle}</p>

              {/* Unified Hark Pill Composer with Voice */}
              <div className="hark-pill-composer" data-testid="hark-hero-composer">
                <div className="hark-pill-composer__row">
                  <textarea
                    rows={1}
                    value={heroPrompt}
                    onChange={e => setHeroPrompt(e.target.value)}
                    onKeyDown={handleHeroKeyDown}
                    aria-label={L('向 Iris Agent 下达指令', 'Instruct Iris Agent')}
                    placeholder={voice.listening
                      ? (voice.interimTranscript || L('正在聆听你的语音指令…', 'Listening…'))
                      : L('说或写下你的创作目标，例如「帮我规划 3 镜头电影感产品短片」…', 'Tell Iris what to plan, inspect, or direct on your canvas…')}
                  />
                  <button
                    type="button"
                    className={`hark-circle-btn${voice.listening ? ' hark-circle-btn--listening' : ''}`}
                    data-testid="hark-hero-voice-btn"
                    title={voice.supported
                      ? (voice.listening ? L('停止语音输入', 'Stop listening') : L('语音输入指令', 'Voice dictation'))
                      : L('当前浏览器不支持语音输入', 'Voice input unsupported in this browser')}
                    aria-label={voice.listening ? L('停止语音输入', 'Stop listening') : L('语音输入', 'Voice input')}
                    onClick={voice.toggle}
                  >
                    {voice.listening ? <MicOff size={15} /> : <Mic size={15} />}
                  </button>
                  <button
                    type="button"
                    className="hark-circle-btn hark-circle-btn--primary"
                    data-testid="hark-hero-send-btn"
                    disabled={!heroPrompt.trim()}
                    aria-label={L('发送并进入对话', 'Send to Agent')}
                    onClick={() => dispatchPromptToChat(heroPrompt)}
                  >
                    <ArrowUp size={16} />
                  </button>
                </div>
                {voice.error && <span style={{ fontSize: 11, color: 'var(--isl-coral-deep)', textAlign: 'left' }}>{voice.error}</span>}
                <div className="hark-composer-chips">
                  {[
                    L('检查当前画布锚点与分镜一致性', 'Audit canvas anchors & shot continuity'),
                    L('为当前项目规划 3 镜头电影级分镜', 'Plan a 3-shot cinematic storyboard'),
                    L('梳理所有过期节点并给出重跑预算', 'List stale nodes & rerun budget'),
                    L('记住偏好：默认 16:9 电影感，使用 ARRI ALEXA 35', 'Remember preference: 16:9 cinematic ARRI ALEXA 35'),
                  ].map(suggestion => (
                    <button key={suggestion} type="button" className="hark-composer-chip" onClick={() => dispatchPromptToChat(suggestion)}>
                      <Sparkles size={11} />
                      <span>{suggestion}</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Proactive Action Cards */}
            <section className="hark-glass-shell" aria-label={L('主动建议', 'Proactive Actions')}>
              <div className="hark-section-head" style={{ marginBottom: 12 }}>
                <h2 className="hark-section-title"><Zap size={14} />{L('为你主动准备的下一步', 'Proactive Next Actions')}</h2>
                <span style={{ fontSize: 11, color: 'var(--isl-ink-soft)' }}>{L('基于当前画布实时状态推导', 'Derived live from your canvas')}</span>
              </div>
              <div className="hark-action-grid">
                {proactiveCards.map(card => (
                  <article key={card.id} className="hark-action-card" data-tone={card.tone} data-testid={`hark-proactive-${card.id}`}>
                    <span className="hark-action-card__badge">{card.badge}</span>
                    <strong>{card.title}</strong>
                    <p>{card.description}</p>
                    <button type="button" className="hark-action-card__cta" onClick={() => handleProactiveAction(card)}>
                      <span>{card.actionLabel}</span>
                      <ArrowRight size={12} />
                    </button>
                  </article>
                ))}
              </div>
            </section>

            {/* Live Modular Panels (Hark Panels) */}
            <section className="hark-glass-shell" aria-label={L('动态面板', 'Live Panels')}>
              <div className="hark-section-head" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <h2 className="hark-section-title"><Layers size={14} />{L('我的动态面板（Panels）', 'Modular Live Panels')}</h2>
                <form
                  className="hark-panel-creator"
                  onSubmit={e => { e.preventDefault(); void handleCreateCustomPanel(); }}
                  style={{ minWidth: 280, flex: '0 1 420px' }}
                >
                  <input
                    value={panelDraft}
                    onChange={e => setPanelDraft(e.target.value)}
                    placeholder={L('用自然语言新建面板，如「分镜验收：角色定妆、特写、配音」…', 'Create a panel with natural language, e.g. "Shot list: Hero, Close-up, Audio"…')}
                    aria-label={L('新建自定义面板', 'Create custom panel')}
                  />
                  <button type="submit" className="hark-ghost-btn" data-testid="hark-add-panel-btn">
                    <Plus size={13} />{L('生成面板', 'Add Panel')}
                  </button>
                </form>
              </div>

              <div className="hark-panels-grid">
                {/* System Live Panel 1: Canvas Production Pulse */}
                <div className="hark-widget" data-testid="hark-panel-canvas-pulse">
                  <div className="hark-widget__head">
                    <span className="hark-widget__title"><Layers size={14} />{L('画布制作脉搏', 'Canvas Production Pulse')}</span>
                    <button type="button" className="hark-ghost-btn" style={{ height: 24, padding: '0 9px', fontSize: 11 }} onClick={() => setCanvasView('spatial')}>{L('打开画布', 'Open')}</button>
                  </div>
                  <div className="hark-kpi-row">
                    <div className="hark-kpi"><strong>{project?.nodes.length || 0}</strong><span>{L('总节点', 'Nodes')}</span></div>
                    <div className="hark-kpi"><strong>{bible.totals.approvedAnchors}/{bible.anchors.length}</strong><span>{L('已批准锚点', 'Anchors')}</span></div>
                    <div className="hark-kpi"><strong>{bible.totals.shotCount}</strong><span>{L('分镜镜头', 'Shots')}</span></div>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--isl-ink-soft)' }}>
                    {bible.issues.length > 0
                      ? L(`发现 ${bible.issues.length} 项一致性提醒：${bible.issues[0]}`, `${bible.issues.length} continuity alert: ${bible.issues[0]}`)
                      : L('当前画布锚点与分镜状态健康。', 'Canvas anchors and storyboard continuity look healthy.')}
                  </span>
                </div>

                {/* System Live Panel 2: Live Handoff & Vault Summary */}
                <div className="hark-widget" data-testid="hark-panel-vault-status">
                  <div className="hark-widget__head">
                    <span className="hark-widget__title"><Shield size={14} />{L('安全保险库与费用', 'Vault & Budget')}</span>
                    <button type="button" className="hark-ghost-btn" style={{ height: 24, padding: '0 9px', fontSize: 11 }} onClick={() => setTab('vault')}>{L('管理', 'Manage')}</button>
                  </div>
                  <div className="hark-kpi-row">
                    <div className="hark-kpi"><strong>{userApiKeys.length}</strong><span>{L('本地服务', 'Services')}</span></div>
                    <div className="hark-kpi"><strong>{projectMemories.length}</strong><span>{L('长效记忆', 'Memories')}</span></div>
                    <div className="hark-kpi"><strong>{totalCostEstimate > 0 ? `$${totalCostEstimate.toFixed(2)}` : '$0.00'}</strong><span>{L('本项目记录', 'Logged Spend')}</span></div>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--isl-ink-soft)' }}>
                    {L('费用扣款与删除硬闸始终开启；所有凭据与记忆仅保留在你的本机浏览器。', 'Spend & delete hard gates are always active. Keys and memories stay local.')}
                  </span>
                </div>

                {/* User Custom Modular Panels */}
                {customPanels.map(panel => (
                  <div key={panel.id} className="hark-widget" data-testid={`hark-custom-panel-${panel.id}`}>
                    <div className="hark-widget__head">
                      <span className="hark-widget__title"><Sparkles size={13} />{panel.title}</span>
                      <button type="button" className="hark-circle-btn" style={{ width: 24, height: 24 }} aria-label={L('删除面板', 'Remove panel')} onClick={() => void handleRemovePanel(panel.id)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {panel.kind === 'note' ? (
                      <p style={{ margin: 0, fontSize: 12, color: 'var(--isl-ink-soft)', lineHeight: 1.5 }}>{panel.body}</p>
                    ) : (
                      <div className="hark-checklist">
                        {(panel.items || []).map(item => (
                          <div key={item.id} className={`hark-checklist-item${item.done ? ' is-done' : ''}`}>
                            {panel.kind === 'checklist' ? (
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}>
                                <input type="checkbox" checked={item.done} onChange={() => void handleToggleChecklistItem(panel.id, item.id)} />
                                <span>{item.text}</span>
                              </label>
                            ) : (
                              <button type="button" className="hark-composer-chip" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => dispatchPromptToChat(item.text)}>
                                <span>{item.text}</span>
                                <ArrowRight size={11} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === 'chat' && (
          <div className="hark-glass-shell hark-chat-shell" data-testid="hark-view-chat">
            {project ? (
              <IrisAgentPanel
                project={project}
                onActivityChange={() => undefined}
                onOpenSettings={onOpenSettings}
                assetLibrary={assetLibrary}
                userApiKeys={userApiKeys}
                onAddApiKey={onAddApiKey}
                onUpdateApiKey={onUpdateApiKey}
                onFocusNode={onFocusNode}
                pendingPrompt={pendingChatPrompt}
                onConsumedPendingPrompt={() => setPendingChatPrompt(null)}
                composerPlaceholder={L('继续与 Iris Agent 协作，或点击麦克风语音输入、输入 @ 引用画布节点…', 'Collaborate with Iris Agent, dictate by voice, or @ mention canvas nodes…')}
              />
            ) : (
              <AgentDrawerEmptyState language={language} onCreateProject={() => onCreateProject(L('未命名工作流', 'Untitled workflow'))} />
            )}
          </div>
        )}

        {tab === 'projects' && (
          <div className="hark-container" data-testid="hark-view-projects">
            <section className="hark-glass-shell">
              <div className="hark-section-head" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
                <h2 className="hark-section-title"><FolderKanban size={15} />{L(`项目空间 (${projects.length})`, `Projects (${projects.length})`)}</h2>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div className="iris-search" style={{ flexBasis: 200 }}>
                    <Search size={13} />
                    <input value={projectSearch} onChange={e => setProjectSearch(e.target.value)} placeholder={L('搜索项目…', 'Search projects…')} />
                  </div>
                  <button type="button" className="hark-ghost-btn" onClick={() => onCreateProject(L('未命名工作流', 'Untitled workflow'))}>
                    <Plus size={13} />{L('新建空白项目', 'New Blank Project')}
                  </button>
                </div>
              </div>

              <div className="hark-project-grid">
                {filteredProjects.map(item => {
                  const isCurrent = item.id === activeProjectId;
                  const itemBible = buildProductionBible(item);
                  return (
                    <article key={item.id} className={`hark-project-card${isCurrent ? ' is-active' : ''}`} data-testid={`hark-project-card-${item.id}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                        <strong style={{ fontSize: 13 }}>{item.title}</strong>
                        {isCurrent && <span className="hark-action-card__badge">{L('当前', 'Active')}</span>}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--isl-ink-soft)' }}>
                        {item.nodes.length} {L('节点', 'nodes')} · {item.connections.length} {L('连线', 'wires')} · {itemBible.anchors.length} {L('锚点', 'anchors')} · {itemBible.totals.shotCount} {L('分镜', 'shots')}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--isl-ink-ghost)' }}>
                        {new Date(item.updatedAt).toLocaleString(en ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button type="button" className="hark-ghost-btn" onClick={() => { setActiveProject(item.id); setCanvasView('spatial'); }}>
                          {L('在画布打开', 'Canvas')}
                        </button>
                        <button type="button" className="hark-ghost-btn" onClick={() => { setActiveProject(item.id); setTab('chat'); }}>
                          {L('进入对话', 'Chat')}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            {/* Quick Start from Tapflow Blueprints */}
            <section className="hark-glass-shell">
              <div className="hark-section-head" style={{ marginBottom: 12 }}>
                <h2 className="hark-section-title"><Sparkles size={14} />{L('从 Tapflow 蓝图一键创建项目', 'Start a Project from a Tapflow Blueprint')}</h2>
              </div>
              <div className="hark-action-grid">
                {WORKFLOW_TEMPLATES.slice(0, 6).map(tpl => (
                  <article key={tpl.id} className="hark-action-card">
                    <span className="hark-action-card__badge">{tpl.category || L('模板', 'Blueprint')}</span>
                    <strong>{en ? tpl.title.eng : tpl.title.zho}</strong>
                    <p>{en ? tpl.description.eng : tpl.description.zho}</p>
                    <button
                      type="button"
                      className="hark-action-card__cta"
                      onClick={() => {
                        const seed = buildWorkflowTemplate(tpl.id, '', language);
                        onCreateProject(en ? tpl.title.eng : tpl.title.zho, { nodes: seed.nodes, connections: seed.connections });
                        setCanvasView('spatial');
                      }}
                    >
                      <Plus size={12} />{L('以此蓝图新建', 'Use Blueprint')}
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === 'handoff' && (
          <div className="hark-container" data-testid="hark-view-handoff">
            <section className="hark-glass-shell">
              <div className="hark-section-head" style={{ marginBottom: 12 }}>
                <h2 className="hark-section-title"><Activity size={15} />{L('实时执行与交接监控（Live Handoff）', 'Live Execution & Approval Handoff')}</h2>
                <span style={{ fontSize: 11, color: 'var(--isl-ink-soft)' }}>
                  {L('实时透明查看每一步工具调用，并在敏感操作前人工把关', 'Watch every tool step transparently and approve high-stakes actions')}
                </span>
              </div>

              {liveEntries.length === 0 ? (
                <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--isl-ink-soft)' }}>
                  {L('当前没有正在运行的画布会话。你可以从「主页」或「对话」发起任务，或在画布上双击空白处「问 Agent」。', 'No active canvas sessions right now. Start a run from Home, Chat, or double-click the canvas.')}
                </p>
              ) : (
                <div className="hark-handoff-list">
                  {liveEntries.map(([cardNodeId, entry]) => (
                    <div key={cardNodeId} className="hark-handoff-row" data-testid={`hark-handoff-session-${cardNodeId}`}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 12.5 }}>{entry.prompt || cardNodeId}</strong>
                          <span className="hark-action-card__badge">{entry.phase}</span>
                        </div>
                        {entry.trace?.steps.length ? (
                          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {entry.trace.steps.slice(-5).map(step => (
                              <span key={step.id} className="hark-composer-chip" style={{ cursor: 'default' }}>
                                {step.status === 'success' ? <CheckCircle2 size={11} /> : <Activity size={11} />}
                                {step.label}{step.target ? ` · ${step.target}` : ''}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {entry.approval && (
                          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 10, background: 'color-mix(in srgb, var(--isl-coral) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <ShieldAlert size={14} />
                              <strong>{entry.approval.title}</strong>
                              {entry.approval.cost ? ` · ${entry.approval.cost}` : ''}
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button" className="hark-ghost-btn" onClick={() => decideCanvasAgentApproval({ cardNodeId, approvalId: entry.approval!.id, approved: false })}>{L('拒绝', 'Deny')}</button>
                              <button type="button" className="hark-action-card__cta" onClick={() => decideCanvasAgentApproval({ cardNodeId, approvalId: entry.approval!.id, approved: true })}>{L('批准继续', 'Approve')}</button>
                            </div>
                          </div>
                        )}
                      </div>
                      {(entry.phase === 'running' || entry.phase === 'queued') && (
                        <button type="button" className="hark-ghost-btn" onClick={() => stopCanvasAgentRun(cardNodeId)}>
                          <Square size={11} />{L('停止', 'Stop')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="hark-glass-shell">
              <div className="hark-section-head" style={{ marginBottom: 10 }}>
                <h2 className="hark-section-title"><CheckCircle2 size={14} />{L(`后台任务台账 (${ledgerTasks.length}) 与执行回执 (${projectReceipts.length})`, `Background Tasks (${ledgerTasks.length}) & Receipts (${projectReceipts.length})`)}</h2>
              </div>
              {ledgerTasks.length === 0 && projectReceipts.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: 'var(--isl-ink-soft)' }}>
                  {L('暂无历史任务或回执记录。每次生成、导出与 Agent 决策都会自动留下可追溯台账。', 'No recorded tasks or receipts yet. Generations, exports, and agent decisions log here automatically.')}
                </p>
              ) : (
                <div className="hark-handoff-list">
                  {ledgerTasks.slice(0, 10).map((task, idx) => (
                    <div key={String(task.taskId || idx)} className="hark-handoff-row">
                      <div>
                        <strong style={{ fontSize: 12 }}>{String(task.command || task.taskId || 'Task')}</strong>
                        <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--isl-ink-soft)' }}>
                          {L('状态', 'Status')}: {String(task.status || 'unknown')}
                        </p>
                      </div>
                      <span className="hark-action-card__badge">{String(task.status || 'done')}</span>
                    </div>
                  ))}
                  {projectReceipts.slice(-8).reverse().map(receipt => (
                    <div key={receipt.id} className="hark-handoff-row">
                      <div>
                        <strong style={{ fontSize: 12 }}>{receipt.title}</strong>
                        {receipt.summary && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--isl-ink-soft)' }}>{receipt.summary}</p>}
                      </div>
                      <span style={{ fontSize: 10.5, color: 'var(--isl-ink-ghost)' }}>{receipt.kind}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'vault' && (
          <div className="hark-container" data-testid="hark-view-vault">
            <div className="hark-vault-grid">
              {/* Persistent Long-Term Memory Manager */}
              <section className="hark-glass-shell">
                <div className="hark-section-head" style={{ marginBottom: 10 }}>
                  <h2 className="hark-section-title"><Brain size={15} />{L(`项目长效记忆 (${projectMemories.length})`, `Persistent Memory (${projectMemories.length})`)}</h2>
                </div>
                <p style={{ margin: '0 0 10px', fontSize: 11.5, color: 'var(--isl-ink-soft)' }}>
                  {L('Agent 每轮对话都会自动参考这里的创作偏好与角色规则；仅存于本机 IndexedDB，不用于训练模型。', 'Automatically read by the Agent on every turn. Stored locally in IndexedDB; never used for model training.')}
                </p>
                <form
                  onSubmit={e => { e.preventDefault(); void handleAddMemory(); }}
                  style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}
                >
                  <div className="hark-panel-creator">
                    <input
                      value={memoryDraft}
                      disabled={!project}
                      onChange={e => setMemoryDraft(e.target.value)}
                      placeholder={L('添加一条长期偏好（如：主角固定穿黑色机能风衣，画幅 16:9）…', 'Add a persistent preference (e.g. Hero always wears black techwear, 16:9)…')}
                    />
                    <button type="submit" className="hark-ghost-btn" data-testid="hark-add-memory-btn" disabled={!project || !memoryDraft.trim()}>
                      <Plus size={13} />{L('记住', 'Save')}
                    </button>
                  </div>
                  <div className="hark-panel-creator">
                    <input
                      value={memoryTagsDraft}
                      disabled={!project}
                      onChange={e => setMemoryTagsDraft(e.target.value)}
                      placeholder={L('标签（可选，逗号分隔，如：角色, 光影）', 'Tags (optional, comma-separated)')}
                    />
                    <input
                      value={memorySearch}
                      onChange={e => setMemorySearch(e.target.value)}
                      placeholder={L('筛选记忆…', 'Filter memories…')}
                    />
                  </div>
                </form>

                <div className="hark-memory-list">
                  {filteredMemories.length ? filteredMemories.map(entry => (
                    <div key={entry.id} className="hark-memory-row" data-testid={`hark-memory-${entry.id}`}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45 }}>{entry.text}</p>
                        {entry.tags.length > 0 && (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                            {entry.tags.map(tag => <span key={tag} className="hark-action-card__badge">{tag}</span>)}
                          </div>
                        )}
                      </div>
                      {project && (
                        <button type="button" className="hark-circle-btn" style={{ width: 26, height: 26 }} aria-label={L('删除记忆', 'Remove memory')} onClick={() => void removeMemory(project.id, entry.id)}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  )) : (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--isl-ink-soft)' }}>
                      {L('当前项目还没有保存记忆条目。', 'No memories saved for this project yet.')}
                    </p>
                  )}
                </div>
              </section>

              {/* Secured Credential Vault & Human-in-the-Loop Policy */}
              <section className="hark-glass-shell" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div className="hark-section-head" style={{ marginBottom: 8 }}>
                    <h2 className="hark-section-title"><Shield size={15} />{L('安全凭据保险库（Secured Local Vault）', 'Secured Local Vault')}</h2>
                    <button type="button" className="hark-ghost-btn" onClick={onOpenSettings}>{L('管理 AI 服务', 'Configure')}</button>
                  </div>
                  <p style={{ margin: '0 0 10px', fontSize: 11.5, color: 'var(--isl-ink-soft)' }}>
                    {L('所有 API Key 经本地加密存储，只显示脱敏就绪状态，绝不进入提示词、日志或云端。', 'All API keys are encrypted locally. Only masked readiness is shown; secrets never enter prompts or logs.')}
                  </p>
                  <div className="hark-memory-list">
                    {userApiKeys.length ? userApiKeys.map(item => (
                      <div key={item.id} className="hark-memory-row">
                        <div>
                          <strong style={{ fontSize: 12 }}>{item.name || item.provider}</strong>
                          <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--isl-ink-soft)' }}>
                            {item.provider} · {item.key ? '••••••••' : L('无 Key / 自定义网关', 'No key / custom endpoint')}
                          </p>
                        </div>
                        <span className="hark-action-card__badge">{item.capabilities?.join(' / ') || 'BYOK'}</span>
                      </div>
                    )) : (
                      <p style={{ margin: 0, fontSize: 12, color: 'var(--isl-ink-soft)' }}>
                        {L('尚未添加 BYOK 模型服务。点击右上角「管理 AI 服务」添加。', 'No BYOK services configured yet. Click Configure to add one.')}
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="hark-section-title" style={{ marginBottom: 8 }}><ShieldAlert size={14} />{L('人在环路 · 审批策略', 'Human-in-the-Loop Policy')}</h3>
                  <div className="hark-memory-list">
                    {APPROVAL_OPTIONS.map(opt => {
                      const active = approvalMode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className="hark-memory-row"
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            border: active ? '1.5px solid var(--isl-mint)' : '1px solid transparent',
                            cursor: 'pointer',
                            color: 'var(--isl-ink)',
                          }}
                          onClick={() => handleChangeApproval(opt.id)}
                        >
                          <div>
                            <strong style={{ fontSize: 12 }}>{en ? opt.en : opt.zho}</strong>
                            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--isl-ink-soft)' }}>{en ? opt.descEn : opt.descZho}</p>
                          </div>
                          {active && <Check size={15} style={{ color: 'var(--isl-mint-deep)' }} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        {tab === 'connections' && (
          <div className="hark-container" data-testid="hark-view-connections">
            <AgentConnectionsPage project={project} language={language} />
          </div>
        )}
      </main>
    </div>
  );
}
