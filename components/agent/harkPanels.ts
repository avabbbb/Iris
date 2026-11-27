// Hark Agent Workspace pure data model & IndexedDB persistence (localforage).
// Provides:
// - Proactive Action Cards derived from real live Iris project/canvas state
// - Custom modular Hark Panels (checklists, trackers, quick prompt boards) created from natural language
// - Time-of-day atmospheric sky mood & greetings

import localforage from 'localforage';
import { nanoid } from 'nanoid';
import { buildProductionBible } from '../workflow/productionBible';
import { planWorkflowStaleRerun } from '../workflow/runState';
import type { WorkflowProject } from '../workflow/types';
import type { UserApiKey } from '../../types';

export type HarkSkyMood = 'dawn' | 'day' | 'dusk' | 'night';

export interface HarkAtmosphere {
  mood: HarkSkyMood;
  greeting: string;
  subtitle: string;
}

export function getHarkAtmosphere(date: Date = new Date(), language: 'en' | 'zho' = 'zho'): HarkAtmosphere {
  const hour = date.getHours();
  const en = language === 'en';
  if (hour >= 5 && hour < 10) {
    return {
      mood: 'dawn',
      greeting: en ? 'Good morning' : '早上好',
      subtitle: en ? 'Your creative workspace is calm and ready.' : '清晨光线刚好，画布与智能体已就绪。',
    };
  }
  if (hour >= 10 && hour < 17) {
    return {
      mood: 'day',
      greeting: en ? 'Good afternoon' : '下午好',
      subtitle: en ? 'Direct your canvas, review takes, or hand off multi-step work.' : '指挥画布创作、审片对比，或将多步骤任务交接给智能体。',
    };
  }
  if (hour >= 17 && hour < 21) {
    return {
      mood: 'dusk',
      greeting: en ? 'Good evening' : '傍晚好',
      subtitle: en ? 'Golden hour for polishing shots and locking consistency.' : '黄金时刻，适合打磨镜头与锁定角色一致性。',
    };
  }
  return {
    mood: 'night',
    greeting: en ? 'Working late' : '夜深了',
    subtitle: en ? 'Quiet atmospheric workspace — every change stays local and reversible.' : '安静的深蓝工作台，每次改动都可追溯、可撤销。',
  };
}

export type HarkProactiveActionKind =
  | 'chat-prompt'
  | 'open-canvas'
  | 'open-settings'
  | 'open-handoff'
  | 'open-vault'
  | 'create-project';

export interface HarkProactiveCard {
  id: string;
  priority: number;
  badge: string;
  title: string;
  description: string;
  actionLabel: string;
  actionKind: HarkProactiveActionKind;
  /** Prompt prefilled & executed when actionKind === 'chat-prompt'. */
  prompt?: string;
  /** Focus node id when jumping to Canvas. */
  nodeId?: string;
  tone: 'mint' | 'amber' | 'violet' | 'coral';
}

export function buildHarkProactiveCards(input: {
  project: WorkflowProject | null;
  userApiKeys: readonly UserApiKey[];
  pendingApprovals?: number;
  language?: 'en' | 'zho';
}): HarkProactiveCard[] {
  const en = input.language === 'en';
  const L = (zh: string, enText: string) => (en ? enText : zh);
  const cards: HarkProactiveCard[] = [];

  if ((input.pendingApprovals || 0) > 0) {
    cards.push({
      id: 'pending-approvals',
      priority: 100,
      badge: L('等待确认', 'Approval'),
      title: L(`有 ${input.pendingApprovals} 项操作等待你的授权`, `${input.pendingApprovals} action(s) awaiting approval`),
      description: L('智能体已在敏感操作或付费生成前暂停，打开实时执行台确认后继续。', 'The agent paused before a paid or write action. Review and decide in Live Handoff.'),
      actionLabel: L('去审批', 'Review'),
      actionKind: 'open-handoff',
      tone: 'coral',
    });
  }

  if (input.userApiKeys.length === 0) {
    cards.push({
      id: 'setup-byok',
      priority: 95,
      badge: L('凭据保险库', 'Vault'),
      title: L('接入你的第一个 BYOK 模型服务', 'Connect your first BYOK AI service'),
      description: L('API Key 仅加密保存在本机浏览器，不经云端训练；配置后即可启用对话与多模态生成。', 'Keys stay encrypted in this browser only. Configure a service to unlock chat and generation.'),
      actionLabel: L('配置服务', 'Open Settings'),
      actionKind: 'open-settings',
      tone: 'amber',
    });
  }

  const project = input.project;
  if (!project) {
    cards.push({
      id: 'start-first-project',
      priority: 90,
      badge: L('起步', 'Start'),
      title: L('创建你的第一个创作画布', 'Create your first creative canvas'),
      description: L('从空白画布或 Tapflow 电影级工作流蓝图开始，画布、Cut 与 Agent 共享同一份状态。', 'Start blank or from a Tapflow blueprint. Canvas, Cut, and Agent share one state.'),
      actionLabel: L('新建项目', 'New Project'),
      actionKind: 'create-project',
      tone: 'mint',
    });
    return cards;
  }

  const bible = buildProductionBible(project);
  const staleIds = planWorkflowStaleRerun({ nodes: project.nodes, connections: project.connections });
  const draftVideos = project.nodes.filter(
    node => node.type === 'video' && node.metadata.config?.draftMode && node.metadata.status === 'success',
  );
  const unapprovedAnchors = bible.anchors.filter(anchor => !anchor.approved);

  if (unapprovedAnchors.length > 0) {
    const first = unapprovedAnchors[0];
    cards.push({
      id: 'approve-anchors',
      priority: 85,
      badge: L('一致性锚点', 'Anchors'),
      title: L(`${unapprovedAnchors.length} 个角色/场景锚点尚未批准`, `${unapprovedAnchors.length} anchor(s) pending approval`),
      description: L(`批准「${first.title}」后，下游分镜将自动锁定它的外貌与风格引用。`, `Approve "${first.title}" so downstream shots lock its identity automatically.`),
      actionLabel: L('定位审批', 'Inspect'),
      actionKind: 'open-canvas',
      nodeId: first.nodeId,
      tone: 'mint',
    });
  }

  if (staleIds.length > 0) {
    cards.push({
      id: 'stale-nodes',
      priority: 80,
      badge: L('变更追踪', 'Stale'),
      title: L(`${staleIds.length} 个画布节点因上游变更需要更新`, `${staleIds.length} node(s) out of date`),
      description: L('让 Agent 按依赖顺序检查并生成重跑计划，未过期的结果直接复用不重复扣费。', 'Ask the Agent to plan an incremental rerun while reusing up-to-date outputs.'),
      actionLabel: L('生成重跑计划', 'Plan Rerun'),
      actionKind: 'chat-prompt',
      prompt: L('请检查当前画布中过期的节点，列出最小重跑计划与费用预估，等我确认后再执行。', 'Inspect stale nodes on the current canvas, present a minimal rerun plan with cost estimate, and wait for my approval.'),
      tone: 'amber',
    });
  }

  if (draftVideos.length > 0) {
    cards.push({
      id: 'upgrade-drafts',
      priority: 75,
      badge: L('草稿升级', 'Draft HD'),
      title: L(`${draftVideos.length} 条 480p 草稿视频已可升级高清`, `${draftVideos.length} draft video(s) ready for HD upgrade`),
      description: L(`「${draftVideos[0].title}」已验证运镜构图，可前往画布一键切换为 1080p 成片。`, `"${draftVideos[0].title}" preview is ready to upgrade to HD on the canvas.`),
      actionLabel: L('前往升级', 'Upgrade'),
      actionKind: 'open-canvas',
      nodeId: draftVideos[0].id,
      tone: 'violet',
    });
  }

  if (bible.totals.shotsWithoutMedia > 0) {
    cards.push({
      id: 'fill-shots',
      priority: 70,
      badge: L('分镜进度', 'Storyboard'),
      title: L(`还有 ${bible.totals.shotsWithoutMedia} 个分镜镜头缺少画面`, `${bible.totals.shotsWithoutMedia} storyboard shot(s) missing media`),
      description: L('结合已批准的锚点与机位参数，让 Agent 为缺失镜头补全关键帧提示词与生成计划。', 'Let the Agent prepare keyframe prompts and a generation plan aligned to your approved anchors.'),
      actionLabel: L('交接给 Agent', 'Handoff'),
      actionKind: 'chat-prompt',
      prompt: L('请检查当前项目的制作圣经，帮我梳理尚未出图的分镜镜头，结合已批准锚点优化它们的镜头提示词。', 'Review the production bible, identify shots missing media, and refine their prompts using our approved anchors.'),
      tone: 'mint',
    });
  }

  if (cards.length < 3) {
    cards.push({
      id: 'director-blueprint',
      priority: 40,
      badge: L('导演助手', 'Director'),
      title: L('一键搭建三镜头商业短片分镜', 'Build a 3-shot cinematic commercial graph'),
      description: L('让 Agent 先在画布上搭好角色锚点、3D 多角度关键帧与视频镜头结构，不自动计费。', 'Have the Agent lay out anchors, multi-angle keyframes, and video nodes before spending.'),
      actionLabel: L('立即规划', 'Plan Shots'),
      actionKind: 'chat-prompt',
      prompt: L('请在当前画布帮我规划一套 3 镜头电影感产品短片工作流（含建立全景、微距特写、落幅镜头与摄影机参数），先只搭建节点不运行付费生成。', 'Plan a 3-shot cinematic commercial workflow on this canvas (establishing, macro detail, hero end card with camera specs). Lay out the nodes only without running paid generation.'),
      tone: 'violet',
    });
  }

  if (cards.length < 3 && project.nodes.length > 0) {
    cards.push({
      id: 'audit-consistency',
      priority: 30,
      badge: L('质检', 'Audit'),
      title: L('检查画布角色与构图一致性', 'Audit canvas consistency & pacing'),
      description: L('扫描当前画布上的全部节点、连线、机位与锚点，输出可执行的优化建议清单。', 'Scan all nodes, wires, camera rigs, and anchors for continuity issues.'),
      actionLabel: L('开始体检', 'Run Audit'),
      actionKind: 'chat-prompt',
      prompt: L('请全面检查当前画布的节点拓扑、角色/场景锚点与镜头衔接，给我一份简洁可执行的改进建议。', 'Inspect the current canvas topology, anchors, and shot continuity, and summarize actionable improvements.'),
      tone: 'mint',
    });
  }

  return cards.sort((a, b) => b.priority - a.priority).slice(0, 4);
}

// ── Custom Modular Hark Panels (persisted in IndexedDB via localforage) ──

export type HarkCustomPanelKind = 'checklist' | 'note' | 'prompt-deck';

export interface HarkChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface HarkCustomPanel {
  id: string;
  title: string;
  kind: HarkCustomPanelKind;
  accent: 'mint' | 'violet' | 'amber' | 'sky';
  pinned?: boolean;
  body?: string;
  items?: HarkChecklistItem[];
  createdAt: string;
}

const HARK_PANELS_KEY = 'hark_custom_panels_v1';
let harkPanelDb: LocalForage | null = null;

function getHarkPanelDb(): LocalForage {
  if (!harkPanelDb) {
    harkPanelDb = localforage.createInstance({ name: 'iris_hark_panels_v1', storeName: 'panels' });
  }
  return harkPanelDb;
}

/**
 * Parse a natural-language panel request (Hark "Create Panel with natural language")
 * into a structured modular widget card (checklist, prompt deck, or note).
 */
export function createCustomHarkPanelFromText(rawInput: string, language: 'en' | 'zho' = 'zho'): HarkCustomPanel {
  const clean = rawInput.trim();
  const en = language === 'en';
  const now = new Date().toISOString();
  if (!clean) {
    return {
      id: `panel_${nanoid(8)}`,
      title: en ? 'Shot Checklist' : '分镜验收清单',
      kind: 'checklist',
      accent: 'mint',
      items: [
        { id: nanoid(6), text: en ? 'Lock character anchor A01' : '锁定角色锚点 A01', done: false },
        { id: nanoid(6), text: en ? 'Render 480p draft video preview' : '渲染 480p 草稿视频预演', done: false },
        { id: nanoid(6), text: en ? 'Upgrade final cut to HD & export' : '升级高清成片并送入 Cut 导出', done: false },
      ],
      createdAt: now,
    };
  }

  const colonIdx = clean.search(/[:：]/);
  const title = colonIdx > 0 && colonIdx <= 28
    ? clean.slice(0, colonIdx).trim()
    : clean.length > 20 ? clean.slice(0, 20) + '…' : clean;
  const rest = colonIdx > 0 ? clean.slice(colonIdx + 1).trim() : clean;
  const splitParts = rest
    .split(/[、,，;；\n]+/)
    .map(part => part.trim())
    .filter(Boolean);

  if (splitParts.length >= 2) {
    const isPromptDeck = /提示词|prompt|镜头|shot|指令/i.test(clean);
    return {
      id: `panel_${nanoid(8)}`,
      title,
      kind: isPromptDeck ? 'prompt-deck' : 'checklist',
      accent: isPromptDeck ? 'violet' : 'mint',
      items: splitParts.slice(0, 8).map(text => ({ id: nanoid(6), text, done: false })),
      createdAt: now,
    };
  }

  return {
    id: `panel_${nanoid(8)}`,
    title,
    kind: 'note',
    accent: 'sky',
    body: rest,
    createdAt: now,
  };
}

export async function loadCustomHarkPanels(db: LocalForage = getHarkPanelDb()): Promise<HarkCustomPanel[]> {
  const stored = await db.getItem<HarkCustomPanel[]>(HARK_PANELS_KEY).catch(() => null);
  return Array.isArray(stored) ? stored : [];
}

export async function saveCustomHarkPanels(
  panels: HarkCustomPanel[],
  db: LocalForage = getHarkPanelDb(),
): Promise<HarkCustomPanel[]> {
  const trimmed = panels.slice(0, 24);
  await db.setItem(HARK_PANELS_KEY, trimmed);
  return trimmed;
}
