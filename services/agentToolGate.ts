// 内置 Agent 工具的注册闸（审计 PR-7，C4）。
// 内核（BrowserAgentKernel）只接受 GatedAgentTool：一个工具要进 Agent，必须经过下面三个入口之一，
// 每个入口都把「这次调用要不要先问用户」交给 services/agentToolPolicy.ts 的审批层。
// 直接把裸 AgentTool 塞进工具列表会在 tsc 报错——6c63d21 之前 iris_cut_* 就是这样绕过了审批（删除不确认、委派回合不受 maxTier 限制）。
//
// 修法（tsc 报「not assignable to GatedAgentTool」时）：
// - 新工具：gateTool(tool, guard)，执行前先过 guard（读放行、写按模式、付费 / 删除硬闸、委派回合 maxTier / 无人值守 fail closed）；
//   同时在 agentToolPolicy.toolApprovalFor 里给出正确 tier（未登记的工具名按 exec 处理，会逐次询问）。
// - 只读工具：gateReadOnlyTool(tool)，名字必须已在 agentToolPolicy 的只读清单里，否则注册时直接抛错。
// - 命令面工具：gateCommandSurfaceTool(tool)，只给 browserAgentKernel 里执行函数经 runCommand / startTask 的工具用
//   （那两条路径自己调用 guard，并处理命令面的付费 / 删除确认卡）。不要用它给别的工具开后门。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { toolApprovalFor } from './agentToolPolicy';

declare const GATED: unique symbol;

/** 经过审批闸的工具。品牌字段只存在于类型里，只能由本文件的三个入口产生。 */
export type GatedAgentTool = AgentTool & { readonly [GATED]: true };

/** 审批层：deny 抛错；prompt 时问用户，被拒绝抛错；放行时正常返回。 */
export type AgentToolApprovalGuard = (command: string, params: Record<string, unknown>) => Promise<void>;

const brand = (tool: AgentTool): GatedAgentTool => tool as GatedAgentTool;

/** 执行前先以工具名过审批层。 */
export function gateTool(tool: AgentTool, guard: AgentToolApprovalGuard): GatedAgentTool {
  return brand({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      await guard(tool.name, (params ?? {}) as Record<string, unknown>);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  });
}

/** 只读工具不弹确认；名字必须被审批层判为 read，否则在注册时失败（不允许把写入伪装成只读）。 */
export function gateReadOnlyTool(tool: AgentTool): GatedAgentTool {
  const decision = toolApprovalFor(tool.name, {});
  if (decision.tier !== 'read') {
    throw new Error(`gateReadOnlyTool：${tool.name} 在审批层是 ${decision.tier}，不是只读。用 gateTool(tool, guard)，或先在 agentToolPolicy 的只读清单里登记。`);
  }
  return brand(tool);
}

/** 命令面工具：执行函数经 browserAgentKernel 的 runCommand / startTask，由它们调用 guard 并处理确认卡。 */
export function gateCommandSurfaceTool(tool: AgentTool): GatedAgentTool {
  return brand(tool);
}
