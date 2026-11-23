// Agent 输入框的斜杠命令（omp 风格）：输入「/」时与 Skill 列表一起出现在同一个菜单里，
// 命令在上、Skill 在下。目前只有 /compact [聚焦说明]，只对浏览器内置内核可用。
import { translations } from '../../utils/translations';

export type AgentSlashCommandId = 'compact';

export interface AgentSlashCommand {
  id: AgentSlashCommandId;
  /** 不含斜杠的命令名。 */
  name: string;
  /** 参数提示，例如「[聚焦说明]」。 */
  args?: string;
  description: string;
}

/** 当前可用的斜杠命令；builtin=false（托管 Agent）时没有 /compact。 */
export function agentSlashCommands(language: 'en' | 'zho', options: { builtin: boolean }): AgentSlashCommand[] {
  if (!options.builtin) return [];
  const copy = translations[language].agentPanel;
  return [{ id: 'compact', name: 'compact', args: copy.compactCommandArgs, description: copy.compactCommandHint }];
}

/** 按「/」后输入的文字筛命令：前缀匹配命令名（不区分大小写），空查询列出全部。 */
export function matchSlashCommands(commands: readonly AgentSlashCommand[], query: string | undefined): AgentSlashCommand[] {
  if (query === undefined) return [];
  const normalized = query.trim().toLowerCase();
  return commands.filter(command => !normalized || command.name.toLowerCase().startsWith(normalized));
}

/** 选中命令后写回输入框的文字：把末尾的「/xxx」换成「/compact 」，光标停在后面接着写聚焦说明。 */
export function insertSlashCommand(prompt: string, command: Pick<AgentSlashCommand, 'name'>): string {
  const replaced = prompt.replace(/(^|\s)\/[^\s/]*$/, `$1/${command.name} `);
  return replaced === prompt ? `/${command.name} ` : replaced;
}
