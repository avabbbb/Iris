// Agent 工具审批（approval），对齐 oh-my-pi 的 approval-mode：
// https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md
//
// 这不是沙箱：浏览器里没有可隔离的子进程，被批准的工具仍以页面权限运行。
// 这里只回答「这次调用要不要先问用户」：工具按参数声明 tier（read | write | exec），
// 再结合审批模式、用户的按工具策略和会话授权，算出 allow / prompt / deny。
import type { WorkflowDocumentOperation } from '../components/workflow/types';
import { isWorkflowNodeTool, isWorkflowNodeToolCommand, workflowNodeToolIsPaid } from '../components/workflow/nodeToolCatalog';

export type ToolTier = 'read' | 'write' | 'exec';
export type ToolPolicy = 'allow' | 'deny' | 'prompt';
/**
 * Iris 的硬闸：OMP 在 yolo 下忽略「裸 override」，但付费与删除在这里保持为必问。
 * - spend：可能产生费用（付费生成、调用 AI 服务的节点工具），被生效中的付费授权覆盖时放行；
 * - delete：删除内容，永远逐次确认。
 */
export type ToolHardGate = 'spend' | 'delete';

export interface ToolApprovalObject {
  tier: ToolTier;
  reason?: string;
  /** 安全覆盖：非 yolo 模式下强制询问（除非同时声明 policy: allow）。 */
  override?: boolean;
  policy?: ToolPolicy;
  /** 用户策略查找键；缺省用工具名。 */
  policyKey?: string;
  /** 见 ToolHardGate；只有带 override 的决定才有意义。 */
  hardGate?: ToolHardGate;
}
export type ToolApprovalDecision = ToolTier | ToolApprovalObject;

/**
 * 审批模式（OMP 同名）：
 * - always-ask：自动批准 read；write / exec 都询问（旧「手动」）。
 * - write：自动批准 read + write；exec 询问（旧「自动」，默认）。
 * - yolo：全部自动批准；但 Iris 的硬闸（未被授权覆盖的付费、删除）和显式用户拒绝仍然生效。
 * OMP 的 always-ask-cached 依赖文件路径授权，画布工具没有文件目标，不提供。
 */
export type ApprovalMode = 'always-ask' | 'write' | 'yolo';
export const APPROVAL_MODES: readonly ApprovalMode[] = ['always-ask', 'write', 'yolo'];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'write';

export type UserToolPolicyMap = Readonly<Record<string, ToolPolicy>>;

export type ApprovalResolution =
  | { action: 'allow'; tier: ToolTier }
  /** grantable：仅当询问由审批模式按 tier 发起时为 true，可提供「本会话总是允许此工具」。 */
  | { action: 'prompt'; tier: ToolTier; reason?: string; grantable: boolean; hardGate?: ToolHardGate }
  | { action: 'deny'; tier: ToolTier; reason: string };

export interface ApprovalContext {
  mode: ApprovalMode;
  userPolicy?: UserToolPolicyMap;
  /** 会话授权：同一工具、同一 tier 在本会话内已被允许。 */
  isGranted?: (tool: string, tier: ToolTier) => boolean;
  /**
   * 无人值守（委派回合）：任何解析为 prompt 的调用直接拒绝（fail closed），
   * 会话授权不生效，deny 照旧绝对。
   */
  headless?: boolean;
  /**
   * 硬上限：超过这一 tier 的调用一律拒绝，用户 allow、工具 allow、yolo 都不能放宽。
   * 委派回合用它把调用方声明的 read-only / workspace-write 变成真正的边界。
   */
  maxTier?: ToolTier;
}

const TIERS = new Set<ToolTier>(['read', 'write', 'exec']);
const POLICIES = new Set<ToolPolicy>(['allow', 'deny', 'prompt']);

export function normalizeToolPolicy(value: unknown): ToolPolicy | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return POLICIES.has(normalized as ToolPolicy) ? normalized as ToolPolicy : undefined;
}

/** 字符串或对象形态统一成对象；非法 / 缺失的 tier 按 exec（宁可多问）。 */
export function normalizeApprovalDecision(decision: unknown): ToolApprovalObject {
  if (typeof decision === 'string') return { tier: TIERS.has(decision as ToolTier) ? decision as ToolTier : 'exec' };
  if (!decision || typeof decision !== 'object') return { tier: 'exec' };
  const raw = decision as Partial<ToolApprovalObject>;
  const tier = TIERS.has(raw.tier as ToolTier) ? raw.tier as ToolTier : 'exec';
  const policy = normalizeToolPolicy(raw.policy);
  return {
    tier,
    ...(typeof raw.reason === 'string' && raw.reason ? { reason: raw.reason } : {}),
    ...(raw.override === true ? { override: true } : {}),
    ...(policy ? { policy } : {}),
    ...(typeof raw.policyKey === 'string' && raw.policyKey ? { policyKey: raw.policyKey } : {}),
    ...(raw.hardGate === 'spend' || raw.hardGate === 'delete' ? { hardGate: raw.hardGate } : {}),
  };
}

function lookupUserPolicy(map: UserToolPolicyMap | undefined, tool: string, policyKey?: string): ToolPolicy | undefined {
  if (!map) return undefined;
  return (policyKey ? normalizeToolPolicy(map[policyKey]) : undefined) ?? normalizeToolPolicy(map[tool])
    // 拆分前保存的「节点工具」策略继续适用于图片 / 视频 / 音频工具。
    ?? (tool !== 'workflow.node.tool' && isWorkflowNodeToolCommand(tool) ? normalizeToolPolicy(map['workflow.node.tool']) : undefined);
}

const TIER_LABEL: Record<ToolTier, string> = { read: '读取', write: '修改画布', exec: '执行高风险操作' };
const TIER_RANK: Record<ToolTier, number> = { read: 0, write: 1, exec: 2 };

/**
 * 解析一次工具调用，顺序与 OMP 一致：
 * 1. 工具 deny → 拒绝；2. 用户 deny → 拒绝；
 * 3. yolo：[Iris 偏离] 未被付费授权覆盖的 spend / delete 硬闸仍询问；否则工具显式 allow/prompt → 用户策略 → 放行；
 * 4. 非 yolo：override 只在工具同时声明 allow 时放行，否则询问（spend 被授权覆盖时放行）；
 * 5. 工具显式 allow / prompt；6. 用户策略；7. 按模式与 tier；按 tier 询问前先看会话授权。
 * headless 时任何 prompt 转为 deny。
 */
export function resolveToolApproval(input: ApprovalContext & {
  tool: string;
  decision: ToolApprovalDecision | unknown;
  /** 本次付费已被生效中的付费授权覆盖（只在调用方能算出时传入）。 */
  spendCovered?: boolean;
}): ApprovalResolution {
  const resolution = resolveInteractive(input);
  if (input.headless && resolution.action === 'prompt') {
    return {
      action: 'deny',
      tier: resolution.tier,
      reason: `无人值守的委派回合不能确认「${resolution.reason || TIER_LABEL[resolution.tier]}」（${input.tool}），已拒绝。请在 Iris 面板里直接让 Agent 执行，或调整该工具的审批策略。`,
    };
  }
  if (resolution.action !== 'deny' && input.maxTier && TIER_RANK[resolution.tier] > TIER_RANK[input.maxTier]) {
    return {
      action: 'deny',
      tier: resolution.tier,
      reason: `当前回合权限上限是「${TIER_LABEL[input.maxTier]}」，不能「${TIER_LABEL[resolution.tier]}」（${input.tool}），已拒绝。`,
    };
  }
  return resolution;
}

function resolveInteractive(input: ApprovalContext & { tool: string; decision: unknown; spendCovered?: boolean }): ApprovalResolution {
  const decision = normalizeApprovalDecision(input.decision);
  const { tier } = decision;
  const user = lookupUserPolicy(input.userPolicy, input.tool, decision.policyKey);
  const prompt = (grantable: boolean): ApprovalResolution => ({
    action: 'prompt',
    tier,
    grantable,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.hardGate ? { hardGate: decision.hardGate } : {}),
  });

  if (decision.policy === 'deny') return { action: 'deny', tier, reason: decision.reason || `工具策略禁止调用 ${input.tool}。` };
  if (user === 'deny') return { action: 'deny', tier, reason: `你已在审批设置里禁止 ${input.tool}。` };

  const spendCovered = decision.hardGate === 'spend' && input.spendCovered === true && input.mode !== 'always-ask';

  if (input.mode === 'yolo') {
    // 偏离 OMP：OMP 的 yolo 忽略裸 override；Iris 把付费（未被授权覆盖）和删除保留为硬闸，
    // 因为它们会花用户的钱或丢用户的作品，且浏览器里没有撤销 provider 计费的手段。
    if (decision.override && decision.hardGate && !spendCovered) return prompt(false);
    if (decision.policy === 'allow') return { action: 'allow', tier };
    if (decision.policy === 'prompt') return prompt(false);
    if (user === 'prompt') return prompt(false);
    return { action: 'allow', tier };
  }

  if (decision.override) {
    if (decision.policy === 'allow') return { action: 'allow', tier };
    if (spendCovered && user !== 'prompt') return { action: 'allow', tier };
    return prompt(false);
  }
  if (decision.policy === 'allow') return { action: 'allow', tier };
  if (decision.policy === 'prompt') return prompt(false);
  if (user === 'allow') return { action: 'allow', tier };
  if (user === 'prompt') return prompt(false);

  const auto = tier === 'read' || (tier === 'write' && input.mode === 'write');
  if (auto) return { action: 'allow', tier };
  if (!input.headless && input.isGranted?.(input.tool, tier)) return { action: 'allow', tier };
  return prompt(true);
}

// ---------------------------------------------------------------------------
// Iris 工具声明：命令 → approval(args)
// ---------------------------------------------------------------------------

const READ_COMMANDS = new Set([
  'status',
  'workflow.inspect',
  'workflow.selection.get',
  'workflow.project.list',
  'workflow.projection.get',
  'workflow.models.list',
  // 导出只读文档，保存位置由用户在另存为里决定。
  'workflow.export',
  'workflow.shortcut.list',
  'workflow.nodes.search',
  'workflow.cost.estimate',
  'workflow.node.tool.list',
  'iris_workflow_media_view',
  'iris_web_search',
  'iris_grep',
  'flovart_todo', // 已移除任务清单的弃用无操作别名
  'iris_ask',
  // 内核自带：读技能只读包内文本；项目记忆只写本机记忆，不触达画布、不计费。
  'iris_skill_read',
  'iris_memory',
  // 停止 / 选中 / 视口 / 聚焦不改文档；停止只会减少花费，不在手动模式里拦。
  'workflow.node.stop',
  'workflow.select',
  'workflow.viewport.set',
  'workflow.focus.nodes',
]);

const DELETE_OPERATION_TYPES = new Set(['delete_nodes', 'delete_connections']);
export const SPEND_REASON = '可能产生费用';
export const DELETE_REASON = '删除内容';

const spend = (): ToolApprovalObject => ({ tier: 'exec', override: true, hardGate: 'spend', reason: SPEND_REASON });
const destroy = (): ToolApprovalObject => ({ tier: 'exec', override: true, hardGate: 'delete', reason: DELETE_REASON });

// Cut 视频剪辑工具（只在网页内置 Agent 注册，见 services/cut/agentTools.ts）。
// 读工具自动放行；普通编辑是可撤销写入；删片段 / 删轨道 / 删字幕 / 整体替换字幕按删除硬闸逐次确认。
const CUT_READ_TOOLS = new Set([
  'iris_cut_get_timeline', 'iris_cut_get_assets', 'iris_cut_get_inspector', 'iris_cut_get_subtitles', 'iris_cut_snapshot_frame',
]);
const CUT_DELETE_OPS = new Set(['delete_clips', 'delete_side', 'remove_track', 'delete_subtitles', 'replace_subtitles']);
const CUT_DELETE_SUBTITLE_ACTIONS = new Set(['delete', 'replace_all', 'import_srt']);

function cutToolApproval(tool: string, args: Record<string, unknown>): ToolApprovalObject | undefined {
  if (!tool.startsWith('iris_cut_')) return undefined;
  if (CUT_READ_TOOLS.has(tool)) return { tier: 'read' };
  const action = String(args.action || '');
  switch (tool) {
    case 'iris_cut_edit': {
      const ops = Array.isArray(args.operations) ? args.operations : [];
      return ops.some(item => Boolean(item) && typeof item === 'object' && CUT_DELETE_OPS.has(String((item as { op?: unknown }).op)))
        ? destroy() : { tier: 'write' };
    }
    case 'iris_cut_subtitles':
      if (action === 'export_srt') return { tier: 'read' };
      return CUT_DELETE_SUBTITLE_ACTIONS.has(action) ? destroy() : { tier: 'write' };
    case 'iris_cut_playback':
      // undo / redo 改时间线；seek / select / play / pause 只改视图状态。
      return action === 'undo' || action === 'redo' ? { tier: 'write' } : { tier: 'read' };
    case 'iris_cut_import':
    case 'iris_cut_proxy':
    case 'iris_cut_export':
      return { tier: 'write' };
    default:
      return { tier: 'exec' };
  }
}

/**
 * 命令的审批声明。未知命令按 exec（fail safe）。
 * workflow.apply 含删除操作时升级为 exec + 删除覆盖；workflow.node.tool 及图片 / 视频 / 音频工具调用 AI 服务时为 exec + 费用覆盖。
 */
export function toolApprovalFor(command: string, args: Record<string, unknown> = {}): ToolApprovalObject {
  if (READ_COMMANDS.has(command)) return { tier: 'read' };
  const cut = cutToolApproval(command, args);
  if (cut) return cut;
  if (command === 'workflow.node.run') return spend();
  // generate 只写 Prompt Bar 时是普通可撤销写入；run=true 才会花钱。
  if (command === 'workflow.generate' || command === 'workflow.shortcut.apply') return args.run === true || args.run === 'true' ? spend() : { tier: 'write' };
  if (command === 'workflow.group.run') return args.dryRun === true ? { tier: 'read' } : spend();
  if (command === 'workflow.note.write' || command === 'workflow.media.import' || command === 'workflow.script.materialize' || command === 'workflow.group.create') return { tier: 'write' };
  if (command === 'workflow.node.delete' || command === 'workflow.project.delete') return destroy();
  if (command === 'workflow.apply') {
    const raw = args.operations || args.ops;
    const deletes = Array.isArray(raw) && raw.some(item => (
      Boolean(item) && typeof item === 'object' && DELETE_OPERATION_TYPES.has(String((item as WorkflowDocumentOperation).type))
    ));
    return deletes ? destroy() : { tier: 'write' };
  }
  if (isWorkflowNodeToolCommand(command)) {
    const tool = String(args.tool || '');
    return isWorkflowNodeTool(tool) && workflowNodeToolIsPaid(tool) ? spend() : { tier: 'write' };
  }
  if (command.startsWith('workflow.node.') || command.startsWith('workflow.connect')
    || command.startsWith('workflow.disconnect') || command === 'workflow.project.create') return { tier: 'write' };
  return { tier: 'exec' };
}

// ---------------------------------------------------------------------------
// 持久化：审批模式 + 按工具用户策略（localStorage）
// ---------------------------------------------------------------------------

const MODE_KEY = 'iris.agent.approvalMode';
/** 旧版面板的模式按钮（手动 / 自动）。 */
const LEGACY_MODE_KEY = 'iris.agent.mode';
const USER_POLICY_KEY = 'iris.agent.toolApproval';
/** 旧版「始终允许此类操作」的授权键列表（command[:tool]:risk）。 */
const LEGACY_ALWAYS_KEY = 'iris.agent.alwaysAllow';

type RWStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStorage = (): RWStorage | undefined => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

/** 旧值迁移：manual → always-ask，auto → write；未知值回到默认。 */
export function migrateApprovalMode(value: unknown): ApprovalMode {
  if (value === 'manual') return 'always-ask';
  if (value === 'auto') return 'write';
  return APPROVAL_MODES.includes(value as ApprovalMode) ? value as ApprovalMode : DEFAULT_APPROVAL_MODE;
}

export function readApprovalMode(storage: RWStorage | undefined = defaultStorage()): ApprovalMode {
  try {
    const stored = storage?.getItem(MODE_KEY);
    if (stored) return migrateApprovalMode(stored);
    const legacy = storage?.getItem(LEGACY_MODE_KEY);
    if (legacy) {
      const migrated = migrateApprovalMode(legacy);
      storage?.setItem(MODE_KEY, migrated);
      storage?.removeItem(LEGACY_MODE_KEY);
      return migrated;
    }
  } catch {
    // 存储不可用（隐私模式）时用默认值。
  }
  return DEFAULT_APPROVAL_MODE;
}

export function writeApprovalMode(mode: ApprovalMode, storage: RWStorage | undefined = defaultStorage()): void {
  try { storage?.setItem(MODE_KEY, migrateApprovalMode(mode)); } catch { /* 仅本次生效 */ }
}

export function readUserToolPolicy(storage: RWStorage | undefined = defaultStorage()): Record<string, ToolPolicy> {
  const out: Record<string, ToolPolicy> = {};
  try {
    const parsed = JSON.parse(storage?.getItem(USER_POLICY_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [tool, value] of Object.entries(parsed)) {
        const policy = normalizeToolPolicy(value);
        if (tool && policy) out[tool] = policy;
      }
    }
    // 旧「始终允许」：只迁移不带子工具的整命令授权（如 workflow.apply:write）为 allow；
    // 带子工具的（workflow.node.tool:xxx:write）迁移后会放宽到所有子工具，不迁移。
    const legacy = storage?.getItem(LEGACY_ALWAYS_KEY);
    if (legacy) {
      const keys = JSON.parse(legacy);
      if (Array.isArray(keys)) {
        for (const key of keys) {
          if (typeof key !== 'string') continue;
          const parts = key.split(':');
          if (parts.length === 2 && parts[1] === 'write' && parts[0] !== 'workflow.node.tool' && !out[parts[0]]) out[parts[0]] = 'allow';
        }
      }
      storage?.removeItem(LEGACY_ALWAYS_KEY);
      if (Object.keys(out).length) storage?.setItem(USER_POLICY_KEY, JSON.stringify(out));
    }
  } catch {
    return out;
  }
  return out;
}

export function writeUserToolPolicy(policy: UserToolPolicyMap, storage: RWStorage | undefined = defaultStorage()): void {
  try {
    const clean: Record<string, ToolPolicy> = {};
    for (const [tool, value] of Object.entries(policy)) {
      const normalized = normalizeToolPolicy(value);
      if (tool && normalized) clean[tool] = normalized;
    }
    if (Object.keys(clean).length) storage?.setItem(USER_POLICY_KEY, JSON.stringify(clean));
    else storage?.removeItem(USER_POLICY_KEY);
  } catch {
    // 存储不可用时只在内存里生效。
  }
}

/** 会话授权键：同一工具、同一 tier。 */
export const sessionGrantKey = (tool: string, tier: ToolTier) => `${tool}\u0000${tier}`;
