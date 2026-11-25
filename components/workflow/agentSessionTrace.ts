// 画布 Agent 会话卡的「运行轨迹」（P1b）：全部从面板已有的显示消息 / 回合状态 / 确认请求归约而来，不另建存储。
// - 头部身份行：Agent · 模型 · 思考档位 · 运行环境（浏览器内核 / 本机 Tauri runtime / 外部 harness，带 workspace-lease 范围）。
// - 运行中：思考行（计时 + reasoning 最后一句）与工具时间线（图标 + 工具名 + 目标 + 状态 + 耗时）。
// - 上下文：本轮加载的 Skill、命中的项目记忆（条目标题只在悬停时出现）。
// - 状态优先级参照 Huabu（MIT，只借鉴语义）：等待授权 > 出错 > 冲突 > 运行中 > 完成未读 > 已查看。
// P1b+：Context（本轮实际发给模型的素材，来自 iris.turn_context）、Budget（token 用量 + 付费生成次数，次数用 agent/session-budget 的 paidUnits 计，
// 会话授权 = 面板共享的付费授权 / 预算门快照）、Artifact（本轮写入工具结果里、仍在画布上的节点）。三处（卡片 / Drawer / Workbench）共用这一份归约。
import { paidUnits } from '../../agent/session-budget.js';
import { getAgentToolSpecs } from '../../tools/iris/agent-tools.js';
import type { WorkflowAgentDisplayMessage } from './WorkflowAgentMessages';
import type { WorkflowNode } from './types';

type Lang = 'en' | 'zho';

export const SKILL_TOOL = 'iris_skill_read';
export const MEMORY_TOOL = 'iris_memory';
/** 工具时间线在卡片上最多显示几行，其余折成「+N」。 */
export const TRACE_VISIBLE_TOOLS = 3;

export type AgentTraceStepStatus = 'running' | 'success' | 'error' | 'denied' | 'waiting';
export type AgentTraceStepKind = 'tool' | 'skill' | 'memory';

export interface AgentTraceStep {
  /** 显示消息 id（实时 tool-<callId>，快照里是 entry id）。 */
  id: string;
  /** 工具调用 id：点击行时 Drawer 据此定位工具卡。 */
  toolCallId?: string;
  /** 快照里的持久 entry id（实时卡没有）。 */
  entryId?: string;
  kind: AgentTraceStepKind;
  toolName: string;
  label: string;
  /** 目标：素材名、文件名、Skill id 或记忆查询。 */
  target?: string;
  status: AgentTraceStepStatus;
  startedAt?: number;
  endedAt?: number;
  /** 已结束的耗时（毫秒）；运行中的由卡片按 startedAt 走表。 */
  ms?: number;
  /** 结果里的冲突（REVISION_CONFLICT / LEASE_TARGET_CHANGED）。 */
  conflict?: boolean;
  error?: string;
}

export interface AgentTraceThinking {
  /** 本轮出现过思考（provider 给了 reasoning）。 */
  present: boolean;
  /** 正在思考（最后一段思考还没结束）。 */
  active: boolean;
  /** 正在思考那一段的开始时间（卡片走表）。 */
  startedAt?: number;
  /** 已结束各段思考的用时合计。 */
  ms: number;
  /** reasoning 的最后一句；provider 没给 reasoning 时为空，只显示计时。 */
  summary: string;
  /** 含最新思考的那条助手消息：点击思考行时定位。 */
  messageId?: string;
}

export interface AgentTraceSkill { id: string; label: string; toolCallId?: string }
export interface AgentTraceMemory { count: number; titles: string[]; toolCallId?: string }

export interface AgentTraceContextItem { kind: 'node' | 'asset'; id?: string; label: string }
export interface AgentTraceArtifact { nodeId: string; label: string; type?: string; toolCallId?: string }
export interface AgentTraceBudget {
  /** provider 报的 token（没报为 undefined，不估算）。 */
  tokens?: { input: number; output: number; reasoning?: number };
  /** 本轮成功发起的付费生成次数（session-budget 的 paidUnits）。 */
  paidRuns: number;
}

export interface AgentSessionTrace {
  /** 本轮实际发给模型的素材（turn_context 的来源）。 */
  context: AgentTraceContextItem[];
  budget: AgentTraceBudget;
  /** 本轮写入 / 生成的画布节点（还在画布上的）。 */
  artifacts: AgentTraceArtifact[];
  thinking: AgentTraceThinking;
  steps: AgentTraceStep[];
  skills: AgentTraceSkill[];
  memory: AgentTraceMemory;
  conflicts: number;
  /** 本轮最后一条有正文的助手消息（持久 entry id 优先）：点击摘录时定位。 */
  replyId?: string;
  /** 本轮开始的时间（第一条有时间戳的消息），用于「运行中」总计时。 */
  startedAt?: number;
}

export const EMPTY_TRACE: AgentSessionTrace = {
  context: [],
  budget: { paidRuns: 0 },
  artifacts: [],
  thinking: { present: false, active: false, ms: 0, summary: '' },
  steps: [],
  skills: [],
  memory: { count: 0, titles: [] },
  conflicts: 0,
};

const CONFLICT_RE = /REVISION_CONFLICT|LEASE_TARGET_CHANGED|expectedRevision.*(?:冲突|conflict)|版本冲突|已被修改/i;

/** reasoning 的最后一句：按句末标点 / 换行切开取最后一段非空内容，截到 max 字。 */
export function lastThinkingSentence(text: string, max = 60): string {
  const plain = String(text || '').replace(/[*_`#>]+/g, '').trim();
  if (!plain) return '';
  const parts = plain.split(/(?<=[。！？!?；;])|\n+|(?<=\.)\s+/).map(item => item.trim()).filter(item => item.replace(/[。！？!?；;.\s]/g, '').length > 0);
  const last = parts[parts.length - 1] || '';
  return last.length > max ? '…' + last.slice(last.length - max + 1) : last;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => (typeof item === 'string' ? item : String(asRecord(item).id || ''))).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 工具结果的文字（实时卡的 detail 是 {content, details}；快照恢复的卡只有 text）。 */
function resultText(message: WorkflowAgentDisplayMessage): string {
  const detail = message.detail === message.args ? undefined : message.detail;
  const content = asRecord(detail).content;
  if (Array.isArray(content)) {
    const text = content.map(item => asRecord(item)).filter(item => item.type === 'text').map(item => String(item.text || '')).join('\n');
    if (text) return text;
  }
  return message.status === 'pending' ? '' : String(message.text || '');
}

function resultDetails(message: WorkflowAgentDisplayMessage): Record<string, unknown> {
  const detail = message.detail === message.args ? undefined : message.detail;
  return asRecord(asRecord(detail).details);
}

/** 工具的目标：素材名（节点 id 换成标题）、文件名、Skill id、记忆查询。 */
export function agentTraceTarget(toolName: string, args: unknown, nodes: readonly Pick<WorkflowNode, 'id' | 'title'>[] = [], language: Lang = 'zho'): string | undefined {
  const input = asRecord(args);
  if (toolName === SKILL_TOOL) {
    const id = String(input.id || '');
    const file = input.file ? String(input.file) : '';
    return id ? (file && file !== 'SKILL.md' ? id + '/' + basename(file) : id) : undefined;
  }
  if (toolName === MEMORY_TOOL) {
    const action = String(input.action || '');
    if (action === 'search' && input.query) return '「' + String(input.query) + '」';
    if (action === 'list') return language === 'en' ? 'all' : '全部';
    if (action === 'add' && input.text) return String(input.text).slice(0, 16);
    return action || undefined;
  }
  const ids = [
    ...stringList(input.nodeIds),
    ...(input.nodeId ? [String(input.nodeId)] : []),
    ...(input.targetNodeId ? [String(input.targetNodeId)] : []),
  ];
  const ops = Array.isArray(input.operations) ? input.operations.map(asRecord) : [];
  for (const op of ops) {
    ids.push(...stringList(op.ids));
    if (op.id) ids.push(String(op.id));
    if (op.nodeId) ids.push(String(op.nodeId));
  }
  if (ids.length) {
    const names = [...new Set(ids)].map(id => nodes.find(node => node.id === id)?.title || id);
    return names.length > 1 ? names[0] + (language === 'en' ? ` +${names.length - 1}` : ` 等 ${names.length} 个`) : names[0];
  }
  for (const keyName of ['path', 'file', 'filePath', 'filename', 'name', 'title']) {
    const value = input[keyName];
    if (typeof value === 'string' && value.trim()) return keyName.toLowerCase().includes('path') || keyName === 'file' ? basename(value) : value.trim().slice(0, 24);
  }
  if (typeof input.query === 'string' && input.query.trim()) return '「' + input.query.trim().slice(0, 16) + '」';
  return undefined;
}

/** 记忆读取命中的条目标题：结果里每行「- [id] 文本（标签）」。 */
export function memoryTitles(text: string, max = 32): string[] {
  return String(text || '').split('\n')
    .map(line => /^\s*-\s*\[[^\]]*\]\s*(.+)$/.exec(line)?.[1]?.replace(/（[^）]*）$/, '').trim() || '')
    .filter(Boolean)
    .map(title => (title.length > max ? title.slice(0, max - 1) + '…' : title));
}

function stepStatus(message: WorkflowAgentDisplayMessage, running: boolean): AgentTraceStepStatus {
  const status = message.status || 'pending';
  if (status === 'pending') return running ? 'running' : 'waiting';
  return status;
}

/** 本轮 = 最后一条用户消息之后的显示消息。 */
export function currentTurnMessages(messages: readonly WorkflowAgentDisplayMessage[]): { prompt?: WorkflowAgentDisplayMessage; after: WorkflowAgentDisplayMessage[] } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return { prompt: messages[index], after: messages.slice(index + 1) };
  }
  return { after: [...messages] };
}

/**
 * 把本轮的显示消息（面板从内核事件 / 快照得来的那一份）归约成卡片的运行轨迹。
 * running：这一轮还在进行（决定 pending 工具是「运行中」还是「等待」、思考是否仍在计时）。
 */
export function reduceAgentSessionTrace(
  turn: readonly WorkflowAgentDisplayMessage[],
  options: { running: boolean; nodes?: readonly Pick<WorkflowNode, 'id' | 'title' | 'type'>[]; language?: Lang; now?: number; prompt?: Pick<WorkflowAgentDisplayMessage, 'references'> },
): AgentSessionTrace {
  const language = options.language || 'zho';
  const now = options.now ?? Date.now();
  const steps: AgentTraceStep[] = [];
  const skills: AgentTraceSkill[] = [];
  const memory: AgentTraceMemory = { count: 0, titles: [] };
  const thinking: AgentTraceThinking = { present: false, active: false, ms: 0, summary: '' };
  let conflicts = 0;
  let replyId: string | undefined;
  let startedAt: number | undefined;
  const context: AgentTraceContextItem[] = (options.prompt?.references || []).map(ref => ({ kind: ref.kind === 'asset' ? 'asset' as const : 'node' as const, ...(ref.id ? { id: ref.id } : {}), label: ref.label }));
  let tokens: AgentTraceBudget['tokens'];
  let paidRuns = 0;
  const artifacts: AgentTraceArtifact[] = [];

  for (const message of turn) {
    const at = message.startedAt ?? message.thinkingStartedAt ?? (message.createdAt ? Date.parse(message.createdAt) : undefined);
    if (at !== undefined && Number.isFinite(at)) startedAt = startedAt === undefined ? at : Math.min(startedAt, at);
    if (message.role === 'assistant') {
      if (message.thinking) {
        thinking.present = true;
        thinking.messageId = message.id;
        const summary = lastThinkingSentence(message.thinking);
        if (summary) thinking.summary = summary;
        if (message.thinkingDone || !options.running) {
          // 回合已结束但这段思考没被定格（中断 / 快照）：用时未知，不按当前时间硬算。
          thinking.ms += message.thinkingMs ?? 0;
          thinking.active = false;
        } else {
          thinking.active = true;
          thinking.startedAt = message.thinkingStartedAt ?? now;
        }
      }
      if (message.text && message.text.trim()) replyId = message.id;
      if (message.usage) tokens = { input: (tokens?.input || 0) + message.usage.input, output: (tokens?.output || 0) + message.usage.output, ...(message.usage.reasoning !== undefined || tokens?.reasoning !== undefined ? { reasoning: (tokens?.reasoning || 0) + (message.usage.reasoning || 0) } : {}) };
      continue;
    }
    if (message.role !== 'tool') continue;
    const toolName = message.toolName || '';
    const kind: AgentTraceStepKind = toolName === SKILL_TOOL ? 'skill' : toolName === MEMORY_TOOL ? 'memory' : 'tool';
    const status = stepStatus(message, options.running);
    const text = resultText(message);
    const conflict = status === 'error' || status === 'success' ? CONFLICT_RE.test(text) : false;
    if (conflict) conflicts += 1;
    const callId = message.toolCallId || (message.id.startsWith('tool-') ? message.id.slice(5) : undefined);
    const ended = message.endedAt;
    steps.push({
      id: message.id,
      ...(callId ? { toolCallId: callId } : {}),
      ...(!message.id.startsWith('tool-') ? { entryId: message.id } : {}),
      kind,
      toolName,
      label: message.title || toolName || (language === 'en' ? 'Tool' : '工具'),
      target: agentTraceTarget(toolName, message.args, options.nodes, language),
      status,
      ...(message.startedAt !== undefined ? { startedAt: message.startedAt } : {}),
      ...(ended !== undefined ? { endedAt: ended } : {}),
      ...(message.startedAt !== undefined && ended !== undefined ? { ms: Math.max(0, ended - message.startedAt) } : {}),
      ...(conflict ? { conflict: true } : {}),
      ...(status === 'error' && text ? { error: text.split('\n')[0].slice(0, 120) } : {}),
    });
    if (status === 'success' && kind === 'tool' && !READ_ONLY_TOOLS.has(toolName)) {
      const command = toolCommandFor(toolName);
      if (command) paidRuns += paidUnits(command, asRecord(message.args));
      const detail = message.detail === message.args ? undefined : message.detail;
      const ids = [...resultNodeIds(asRecord(detail).details), ...resultNodeIds(parseJson(text))];
      for (const id of ids) {
        if (artifacts.some(item => item.nodeId === id)) continue;
        const node = options.nodes?.find(item => item.id === id);
        // 只认还在画布上的节点：删掉的产物不再可定位。
        if (!node) continue;
        artifacts.push({ nodeId: id, label: node.title || id, ...(node.type ? { type: node.type } : {}), ...(callId ? { toolCallId: callId } : {}) });
      }
    }
    const details = resultDetails(message);
    if (kind === 'skill' && status === 'success' && !details.isError) {
      const args = asRecord(message.args);
      const id = String(details.id || args.id || '').trim();
      if (id && !skills.some(skill => skill.id === id)) skills.push({ id, label: id, ...(callId ? { toolCallId: callId } : {}) });
    }
    if (kind === 'memory' && status === 'success') {
      const action = String(details.action || asRecord(message.args).action || '');
      if (action === 'search' || action === 'list') {
        const titles = memoryTitles(text);
        const count = typeof details.count === 'number' ? details.count : titles.length;
        if (count > 0) {
          memory.count += count;
          for (const title of titles) if (!memory.titles.includes(title)) memory.titles.push(title);
          if (callId) memory.toolCallId = memory.toolCallId || callId;
        }
      }
    }
  }
  return { context, budget: { ...(tokens ? { tokens } : {}), paidRuns }, artifacts, thinking, steps, skills, memory, conflicts, ...(replyId ? { replyId } : {}), ...(startedAt !== undefined ? { startedAt } : {}) };
}


/* ── Budget / Artifact 辅助 ── */

let toolCommands: Map<string, string> | null = null;
/** iris_* 工具名 → 命令面命令（workflow.generate 等），用来按 session-budget 的口径数付费次数。 */
export function toolCommandFor(toolName: string): string | undefined {
  if (!toolCommands) {
    toolCommands = new Map();
    for (const spec of getAgentToolSpecs('builtin') as unknown as Array<{ name: string; command: string; aliases?: readonly string[] }>) {
      toolCommands.set(spec.name, spec.command);
      for (const alias of spec.aliases || []) toolCommands.set(alias, spec.command);
    }
  }
  return toolCommands.get(toolName);
}

const READ_ONLY_TOOLS = new Set([SKILL_TOOL, MEMORY_TOOL, 'iris_workflow_media_view', 'iris_workflow_inspect', 'iris_workflow_selection_get', 'iris_workflow_search_nodes', 'iris_models_list', 'iris_node_tool_list', 'iris_status', 'iris_cost_estimate', 'iris_shortcut_list', 'iris_web_search', 'iris_ask', 'iris_task_get', 'iris_workflow_focus_nodes', 'iris_export']);

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/** 写入类工具结果里的节点 id：nodeId / noteId / createdNodeIds / nodeIds / node.id / nodes[].id / changes[].id（只走 4 层）。 */
export function resultNodeIds(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) resultNodeIds(item, depth + 1, out); return out; }
  const record = value as Record<string, unknown>;
  for (const key of ['nodeId', 'noteId', 'createdNodeId', 'targetNodeId']) if (typeof record[key] === 'string') out.push(record[key] as string);
  for (const key of ['createdNodeIds', 'nodeIds', 'updatedNodeIds', 'addedNodeIds']) if (Array.isArray(record[key])) out.push(...(record[key] as unknown[]).filter((id): id is string => typeof id === 'string'));
  for (const key of ['node', 'note', 'result', 'details', 'created']) if (record[key] && typeof record[key] === 'object') resultNodeIds(record[key], depth + 1, out);
  for (const key of ['nodes', 'changes', 'nodeChanges']) {
    const list = record[key];
    if (Array.isArray(list)) for (const item of list) {
      const id = item && typeof item === 'object' ? (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).nodeId : undefined;
      if (typeof id === 'string') out.push(id);
    }
  }
  return out;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return (count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
}

/* ── 完成后的一行统计 ── */

export function formatTraceSeconds(ms: number): string {
  // 工具多半在 1 秒内结束：给一位小数，不显示误导的「0s」。
  if (ms < 100) return '<0.1s';
  if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + 's';
  return Math.floor(seconds / 60) + 'm' + String(seconds % 60).padStart(2, '0') + 's';
}

/** 「思考 12s · 5 次工具 · 2 个 Skill · 记忆 3 条」；为 0 的项不写。没有任何内容时返回空串。 */
export function traceSummaryLine(trace: AgentSessionTrace, language: Lang = 'zho'): string {
  const en = language === 'en';
  const parts: string[] = [];
  // 快照恢复的思考没有用时：只写「思考」，不写假的 0s。
  if (trace.thinking.present) parts.push(trace.thinking.ms > 0 ? (en ? 'Thought ' : '思考 ') + formatTraceSeconds(trace.thinking.ms) : (en ? 'Thought' : '思考'));
  if (trace.steps.length) parts.push(en ? `${trace.steps.length} tool call${trace.steps.length > 1 ? 's' : ''}` : `${trace.steps.length} 次工具`);
  const failed = trace.steps.filter(step => step.status === 'error').length;
  if (failed) parts.push(en ? `${failed} failed` : `${failed} 次失败`);
  if (trace.skills.length) parts.push(en ? `${trace.skills.length} skill${trace.skills.length > 1 ? 's' : ''}` : `${trace.skills.length} 个 Skill`);
  if (trace.memory.count) parts.push(en ? `${trace.memory.count} memor${trace.memory.count > 1 ? 'ies' : 'y'}` : `记忆 ${trace.memory.count} 条`);
  if (trace.artifacts.length) parts.push(en ? `${trace.artifacts.length} artifact${trace.artifacts.length > 1 ? 's' : ''}` : `产物 ${trace.artifacts.length}`);
  const budget = traceBudgetLine(trace, language);
  if (budget) parts.push(budget);
  return parts.join(' · ');
}

/** Budget 摘要：「1.2k tokens · 生成 2 次」；provider 没报 token 且没有付费生成时为空。 */
export function traceBudgetLine(trace: Pick<AgentSessionTrace, 'budget'>, language: Lang = 'zho'): string {
  const en = language === 'en';
  const parts: string[] = [];
  const tokens = trace.budget.tokens;
  if (tokens) parts.push(formatTokens(tokens.input + tokens.output) + ' tokens');
  if (trace.budget.paidRuns) parts.push(en ? `${trace.budget.paidRuns} paid run${trace.budget.paidRuns > 1 ? 's' : ''}` : `生成 ${trace.budget.paidRuns} 次`);
  return parts.join(' · ');
}

/** 没有推理内容时的「当前步骤」：运行中的工具，或等模型回复。不编造思考。 */
export function traceCurrentStep(trace: AgentSessionTrace, language: Lang = 'zho'): string {
  const en = language === 'en';
  const running = [...trace.steps].reverse().find(step => step.status === 'running');
  if (running) return (en ? 'Running ' : '正在') + running.label + (running.target ? ' · ' + running.target : '');
  const done = trace.steps.filter(step => step.status !== 'running' && step.status !== 'waiting').length;
  // provider 正在流式给出思考：如实写「在想下一步」，不编造想的内容（内容在思考行里，只取真实 reasoning）。
  if (trace.thinking.active) return done ? (en ? `${done} step${done > 1 ? 's' : ''} done · thinking about the next` : `已完成 ${done} 步 · 在想下一步`) : (en ? 'Thinking' : '在想怎么做');
  return done ? (en ? `${done} step${done > 1 ? 's' : ''} done · waiting for the model` : `已完成 ${done} 步 · 等模型回复`) : (en ? 'Waiting for the model' : '等模型回复');
}

/** 卡片上的工具时间线：运行中优先显示最新的 3 行，其余折成 +N。 */
export function visibleTraceSteps(steps: readonly AgentTraceStep[], max = TRACE_VISIBLE_TOOLS): { shown: AgentTraceStep[]; hidden: number } {
  if (steps.length <= max) return { shown: [...steps], hidden: 0 };
  return { shown: steps.slice(steps.length - max), hidden: steps.length - max };
}

/* ── 状态优先级（Huabu 语义） ── */

export type AgentSessionCardStatus = 'approval' | 'error' | 'conflict' | 'running' | 'unread' | 'seen' | 'idle';

export const AGENT_SESSION_STATUS_RANK: readonly AgentSessionCardStatus[] = ['approval', 'error', 'conflict', 'running', 'unread', 'seen', 'idle'];

/**
 * 卡片状态：等待授权 > 出错 > 冲突 > 运行中 > 完成未读 > 已查看。
 * - approval：这一轮正等用户批准（卡片上直接给批准 / 拒绝）。
 * - error：这一轮失败（连不上模型、内核报错），或持久摘要记的是失败。
 * - conflict：本轮有写入因版本冲突被拒（需要用户看一眼）。
 * - running：排队或进行中。
 * - unread：本页里完成的一轮，还没在 Drawer 里打开过这个会话。
 * - seen：完成且看过（或刷新前就完成的旧一轮）。
 */
export function deriveAgentSessionStatus(input: {
  phase?: 'queued' | 'running' | 'done' | 'error';
  approvalPending?: boolean;
  lastTurnStatus?: 'done' | 'error';
  conflicts?: number;
  /** 本页里完成的这一轮的标识（entryId 或完成时间）；没有表示不是本页完成的。 */
  completedKey?: string;
  /** Drawer 里看过的那一轮的标识。 */
  seenKey?: string;
}): AgentSessionCardStatus {
  if (input.approvalPending) return 'approval';
  if (input.phase === 'error' || (!input.phase && input.lastTurnStatus === 'error')) return 'error';
  if ((input.conflicts || 0) > 0) return 'conflict';
  if (input.phase === 'queued' || input.phase === 'running') return 'running';
  if (input.phase === 'done' && input.completedKey && input.completedKey !== input.seenKey) return 'unread';
  if (input.phase === 'done' || input.lastTurnStatus === 'done') return 'seen';
  return 'idle';
}

export function agentSessionStatusLabel(status: AgentSessionCardStatus, language: Lang = 'zho'): string {
  const en = language === 'en';
  switch (status) {
    case 'approval': return en ? 'Needs approval' : '等待授权';
    case 'error': return en ? 'Failed' : '出错';
    case 'conflict': return en ? 'Conflict' : '有冲突';
    case 'running': return en ? 'Running' : '运行中';
    case 'unread': return en ? 'New' : '未读';
    default: return '';
  }
}

/* ── 头部身份行 ── */

export type AgentHarnessRuntime = 'browser' | 'tauri' | 'external';

export interface AgentHarnessIdentity {
  /** 内置 / Codex / Claude Code … */
  name: string;
  model?: string;
  /** 思考档位的显示文字；不思考时为空。 */
  thinking?: string;
  runtime: AgentHarnessRuntime;
  /** 运行环境徽标文字。 */
  env: string;
  /** 沙箱 / 租约范围（workspace-lease 等），可选。 */
  scope?: string;
  /** 悬停时显示的完整信息。 */
  title: string;
}

const HOST_NAMES: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', claude: 'Claude Code', opencode: 'OpenCode', gemini: 'Gemini CLI', cursor: 'Cursor' };

export function agentHarnessIdentity(input: {
  runtime: AgentHarnessRuntime;
  hostId?: string;
  model?: string;
  thinkingLabel?: string;
  scope?: string;
  language?: Lang;
}): AgentHarnessIdentity {
  const en = input.language === 'en';
  const name = input.runtime === 'external' && input.hostId
    ? HOST_NAMES[input.hostId.toLowerCase()] || input.hostId
    : input.runtime === 'external' ? (en ? 'External agent' : '外部 Agent') : (en ? 'Built-in agent' : '内置 Agent');
  const env = input.runtime === 'browser' ? (en ? 'Browser kernel' : '浏览器内核') : input.runtime === 'tauri' ? (en ? 'Local Tauri runtime' : '本机 Tauri runtime') : (en ? 'External harness' : '外部 harness');
  const sandbox = input.runtime === 'browser'
    ? (en ? 'runs in this page; canvas tools only, no local files or shell' : '在本页运行：只有画布工具，不碰本机文件和命令')
    : input.runtime === 'tauri'
      ? (en ? 'desktop runtime; file / command tools follow approval mode' : '桌面 Runtime：文件 / 命令工具按审批模式询问')
      : (en ? 'outside Iris; writes go through the workspace lease' : 'Iris 之外运行：写入只经 workspace-lease');
  const lines = [
    (en ? 'Agent: ' : 'Agent：') + name,
    input.model ? (en ? 'Model: ' : '模型：') + input.model : '',
    input.thinkingLabel ? (en ? 'Thinking: ' : '思考档位：') + input.thinkingLabel : '',
    (en ? 'Runtime: ' : '运行环境：') + env + (en ? ' — ' : ' — ') + sandbox,
    input.scope ? (en ? 'Scope: ' : '范围：') + input.scope : '',
  ].filter(Boolean);
  return {
    name,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLabel ? { thinking: input.thinkingLabel } : {}),
    runtime: input.runtime,
    env,
    ...(input.scope ? { scope: input.scope } : {}),
    title: lines.join('\n'),
  };
}

/* ── 卡片审批行 ── */

export interface AgentSessionApproval {
  /** 面板确认队列里这一项的 id：卡片批准 / 拒绝时据此对上，过期的点击无效。 */
  id: string;
  /** 一句人话（同 Drawer 确认卡的标题）。 */
  title: string;
  /** 工具名（人话）。 */
  tool?: string;
  /** 为什么要问：可能产生费用 / 删除内容 / 修改画布。 */
  reason?: string;
  /** 费用（只有付费生成才有）。 */
  cost?: string;
  /** 预算门挡住（有节点不可生成 / 超出授权）：卡片不给「批准」，只能在 Drawer 里看明细。 */
  blocked?: boolean;
  /** 生成计划卡（三选一）：卡片上「批准」= 创建并自动生成。 */
  plan?: boolean;
  /** 排队中的其它确认数。 */
  queued?: number;
  /** Agent 在用表单提问（iris_ask）：卡片不代答，只给「去回答」。 */
  ask?: boolean;
}

/** 卡片按钮 → 面板确认队列的决定（与 Drawer 确认卡同一入口：decideConfirmation / decideRunPlan）。 */
export type AgentSessionApprovalDecision =
  | { kind: 'confirm'; approved: boolean; scope: 'once' }
  | { kind: 'plan'; decision: 'auto' }
  | { kind: 'ignored'; reason: 'stale' | 'blocked' };

export function resolveCardApprovalDecision(input: { pendingId?: string; approvalId: string; approved: boolean; plan?: boolean; blocked?: boolean }): AgentSessionApprovalDecision {
  if (!input.pendingId || input.pendingId !== input.approvalId) return { kind: 'ignored', reason: 'stale' };
  // 预算门：被挡住的批次不能从卡片上批准（拒绝仍然可以）。
  if (input.approved && input.blocked) return { kind: 'ignored', reason: 'blocked' };
  if (input.approved && input.plan) return { kind: 'plan', decision: 'auto' };
  return { kind: 'confirm', approved: input.approved, scope: 'once' };
}
