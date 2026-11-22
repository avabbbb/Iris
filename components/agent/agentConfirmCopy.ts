import { isWorkflowNodeToolCommand, workflowNodeToolSpec } from '../workflow/nodeToolCatalog';
import type { WorkflowNode } from '../workflow/types';
import type { AgentConfirmRequest } from '../../services/agentSpendMandate';
import { getWorkflowOperationCapabilityByNodeTool, localizeOperationLabel, parseWorkflowOperationNodeToolArguments } from '../workflow/operationRegistry';
import { planSummaryLine } from '../GenerationPlanCard';
import { sessionGrantKey } from '../../services/agentToolPolicy';
import { describeRunApproval } from '../../services/runApproval';

type Language = 'en' | 'zho';
export type AgentConfirmScope = 'once' | 'session';

export interface AgentConfirmCopy {
  /** 一句人话：动作 + 对象，例如「删除「海报 1」」。 */
  title: string;
  /** 一行补充：参数、费用或影响；没有就不显示。 */
  detail?: string;
}

const TOOL_COPY: Record<string, { zho: string; en: string }> = {
  iris_web_search: { zho: '联网搜索', en: 'Search the web' },
  iris_grep: { zho: '读取本地文件夹', en: 'Read your local folder' },
};

const TIER_COPY: Record<string, { zho: string; en: string }> = {
  read: { zho: '读取画布', en: 'Read the canvas' },
  write: { zho: '修改画布', en: 'Edit the canvas' },
  exec: { zho: '执行高风险操作', en: 'Run a high-risk action' },
};

function nodeNames(nodes: readonly WorkflowNode[], ids: readonly string[], language: Language) {
  const titles = ids.map(id => nodes.find(node => node.id === id)?.title?.trim()).map(title => title || (language === 'en' ? 'Untitled node' : '未命名节点'));
  if (!titles.length) return language === 'en' ? 'a node' : '一个节点';
  const shown = titles.slice(0, 2).map(title => (language === 'en' ? `"${title}"` : `「${title}」`)).join(language === 'en' ? ', ' : '');
  const rest = titles.length - 2;
  if (rest <= 0) return shown;
  return language === 'en' ? `${shown} and ${rest} more` : `${shown} 等 ${titles.length} 个节点`;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

function targetIds(args: Record<string, unknown>) {
  const many = stringList(args.nodeIds);
  if (many.length) return many;
  const one = args.nodeId ?? args.id;
  return one ? [String(one)] : [];
}

/** 内部命令名或 `命令：ID` 这类机器文本不直接给用户看。 */
function looksLikeMachineText(text: string) {
  return /^[a-z_]+(\.[a-z0-9_-]+)+/i.test(text.trim());
}

/**
 * 把 Agent 的确认请求翻译成用户看得懂的一句话。
 * 只依据命令与参数本身，节点 ID 一律换成节点标题；原始摘要只在它本来就是人话时兜底。
 */
export function describeAgentConfirmation(
  request: AgentConfirmRequest | undefined,
  nodes: readonly WorkflowNode[],
  language: Language,
  fallback = '',
): AgentConfirmCopy {
  const en = language === 'en';
  const args = request?.args || {};
  // 图片 / 视频 / 音频工具命令与 workflow.node.tool 同一张卡。
  switch (request?.command && isWorkflowNodeToolCommand(request.command) ? 'workflow.node.tool' : request?.command) {
    case 'workflow.node.run': {
      const ids = targetIds(args);
      const gates = request.gates || [];
      const tasks = gates.reduce((sum, gate) => sum + gate.taskCount, 0);
      // 按批审批（建与跑分离后的 approve_run）：清单上每个节点各运行一次，费用合计确认一次。
      if (ids.length > 1) return describeRunApproval(ids.length, gates, language);
      return {
        title: en ? `Run ${nodeNames(nodes, ids, language)}` : `运行${nodeNames(nodes, ids, language)}`,
        detail: gates.length ? (en ? `${gates.length} node(s) · ${tasks} task(s) · billed by your AI service` : planSummaryLine(gates)) : undefined,
      };
    }
    case 'workflow.group.run': {
      // 整组执行：与按批审批同一张卡——成员各运行一次，合计费用确认一次。
      const gates = request.gates || [];
      if (gates.length) return describeRunApproval(gates.length, gates, language);
      break;
    }
    case 'workflow.node.tool': {
      const tool = String(args.tool || '');
      const capability = getWorkflowOperationCapabilityByNodeTool(tool);
      const spec = workflowNodeToolSpec(tool);
      const label = capability ? localizeOperationLabel(capability, language) : spec ? (en ? `Canvas tool: ${tool}` : spec.label) : (en ? 'Run a canvas tool' : '运行画布工具');
      let parameters = '';
      if (capability) {
        try {
          parameters = capability.summarizeParameters(parseWorkflowOperationNodeToolArguments(capability.id, args));
        } catch {
          parameters = '';
        }
      }
      // 计费以工具说明书为准（outpaint / mask 等未迁入 registry 的工具也会正确标出费用）。
      const paid = spec ? spec.billing === 'paid' : true;
      const cost = paid ? (en ? 'Uses your AI service and may cost credits' : '会调用 AI 服务，可能产生费用') : '';
      return {
        title: `${label}${en ? ' · ' : ''}${nodeNames(nodes, targetIds(args), language)}`,
        detail: [parameters, cost].filter(Boolean).join(' · ') || undefined,
      };
    }
    case 'workflow.node.delete':
      return { title: en ? `Delete ${nodeNames(nodes, targetIds(args), language)}` : `删除${nodeNames(nodes, targetIds(args), language)}` };
    case 'workflow.project.delete':
      return { title: en ? 'Delete this project' : '删除这个项目' };
    case 'workflow.apply': {
      const rawOperations = args.operations || args.ops;
      const operations = Array.isArray(rawOperations) ? rawOperations as Array<{ type?: string; ids?: unknown; all?: boolean }> : [];
      const deletedNodes = operations.filter(op => op?.type === 'delete_nodes').flatMap(op => stringList(op.ids));
      const deletedLinks = operations.filter(op => op?.type === 'delete_connections');
      if (deletedNodes.length) {
        return { title: en ? `Delete ${nodeNames(nodes, deletedNodes, language)}` : `删除${nodeNames(nodes, deletedNodes, language)}`, detail: en ? `${operations.length} change(s) in this step` : `本次共 ${operations.length} 项改动` };
      }
      if (deletedLinks.length) return { title: en ? 'Remove connections' : '删除连线', detail: en ? `${operations.length} change(s) in this step` : `本次共 ${operations.length} 项改动` };
      return { title: en ? 'Edit the canvas' : '修改画布', detail: operations.length ? (en ? `${operations.length} change(s)` : `${operations.length} 项改动`) : undefined };
    }
    case 'iris_cut_edit': {
      const operations = Array.isArray(args.operations) ? args.operations as Array<{ op?: string; clipIds?: unknown }> : [];
      const clips = operations.filter(op => op?.op === 'delete_clips').reduce((sum, op) => sum + stringList(op.clipIds).length, 0);
      const sides = operations.filter(op => op?.op === 'delete_side').length;
      const tracks = operations.filter(op => op?.op === 'remove_track').length;
      const parts = en
        ? [clips && `${clips} clip(s)`, sides && 'everything on one side of the playhead', tracks && `${tracks} track(s)`]
        : [clips && `${clips} 个片段`, sides && '播放头一侧的片段', tracks && `${tracks} 条轨道`];
      const what = parts.filter(Boolean).join(en ? ', ' : '、');
      const detail = en ? `${operations.length} change(s) in this step, one undo` : `本次共 ${operations.length} 项改动，可一步撤销`;
      if (what) return { title: en ? `Delete ${what} in Cut` : `在 Cut 里删除 ${what}`, detail };
      return { title: en ? 'Edit the Cut timeline' : '修改 Cut 时间线', detail };
    }
    case 'iris_cut_subtitles': {
      const action = String(args.action || '');
      if (action === 'delete') {
        const count = stringList(args.clipIds).length || (args.clipId ? 1 : 0);
        return { title: en ? `Delete ${count} subtitle(s) in Cut` : `在 Cut 里删除 ${count} 条字幕` };
      }
      if (action === 'replace_all' || action === 'import_srt') {
        const count = Array.isArray(args.cues) ? args.cues.length : undefined;
        return {
          title: en ? 'Replace all subtitles in Cut' : '替换 Cut 里的全部字幕',
          detail: action === 'import_srt' ? (en ? 'From an SRT / VTT file' : '来自 SRT / VTT 文本') : (count !== undefined ? (en ? `${count} new cue(s)` : `新字幕 ${count} 条`) : undefined),
        };
      }
      return { title: en ? 'Edit Cut subtitles' : '修改 Cut 字幕' };
    }
    default:
      break;
  }
  const known = request && (TOOL_COPY[request.tool || request.command] || (request.tier && TIER_COPY[request.tier]));
  if (known) return { title: known[language], ...(request?.reason && !en ? { detail: request.reason } : {}) };
  if (fallback && !looksLikeMachineText(fallback)) return { title: fallback };
  return { title: en ? 'Run a canvas action' : '执行一个画布操作' };
}

/**
 * 授权范围（对齐 OMP）：「本会话总是允许此工具」只给审批模式按 tier 发起的询问；
 * 安全覆盖（删除、可能产生费用）、显式 prompt 策略永远逐次确认。
 * 例外：付费生成可在 write / yolo 模式开启有上限的付费授权（Spend Mandate），它不是工具授权。
 */
export function confirmScopesFor(request: AgentConfirmRequest | undefined, options: { offerMandate?: boolean } = {}): AgentConfirmScope[] {
  if (!request) return ['once'];
  if (request.kind === 'generation') return options.offerMandate ? ['once', 'session'] : ['once'];
  if (request.kind === 'destructive') return ['once'];
  return request.grantable && request.tier ? ['once', 'session'] : ['once'];
}

/** 会话授权键：同一工具、同一 tier（与 agentToolPolicy.sessionGrantKey 一致）。不可授权时为 null。 */
export function confirmGrantKey(request: AgentConfirmRequest | undefined): string | null {
  if (!request || request.kind !== 'other' || !request.grantable || !request.tier) return null;
  return sessionGrantKey(request.tool || request.command, request.tier);
}
