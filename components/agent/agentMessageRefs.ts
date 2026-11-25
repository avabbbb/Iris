import type { TurnSourceMedia } from '../../services/turnContext';

// 用户消息里的画布引用：从发给模型的「引用上下文」块里还原带 nodeId 的引用，
// 把显示文本里的「引用：@…」行换成可视化的素材卡，并把正文里的 @名称 拆成小缩略图胶囊。纯函数，面板与测试共用。

export interface AgentMessageReference {
  /** nodeId / assetId；旧消息只剩名字时为空。 */
  id?: string;
  kind: 'node' | 'asset';
  label: string;
  /** 发送时的内容指纹（结构化来源记录才有）；与当前节点比较得出「来源已更新」。 */
  fingerprint?: string;
  /** 这个来源实际送进模型的画面（结构化来源记录才有）。 */
  media?: TurnSourceMedia;
}

const CONTEXT_LINE = /^- @(.+?)（(?:工作流节点 nodeId=([^）\s]+)|我的素材 assetId=([^）\s]+))）\s*$/;

/** 内核里存的用户消息 → 引用列表（按出现顺序去重）。 */
export function userTurnReferences(storedText: string): AgentMessageReference[] {
  const out: AgentMessageReference[] = [];
  for (const block of String(storedText || '').split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed.startsWith('引用上下文：')) continue;
    for (const line of trimmed.split('\n').slice(1)) {
      const match = CONTEXT_LINE.exec(line.trim());
      if (!match) continue;
      const ref: AgentMessageReference = match[2] ? { id: match[2], kind: 'node', label: match[1] } : { id: match[3], kind: 'asset', label: match[1] };
      if (!out.some(item => item.kind === ref.kind && item.id === ref.id)) out.push(ref);
    }
  }
  return out;
}

/** 显示文本里去掉「引用：@A、@B」那一段（改由素材卡展示）；没有就原样返回。 */
export function stripReferenceLine(text: string): string {
  return String(text || '').split(/\n{2,}/).filter(block => !block.trim().startsWith('引用：')).join('\n\n').trim();
}

/** 旧消息只有「引用：@A、@B」时，按名字还原引用。 */
export function referenceLineLabels(text: string): string[] {
  const block = String(text || '').split(/\n{2,}/).find(item => item.trim().startsWith('引用：'));
  if (!block) return [];
  return block.trim().slice('引用：'.length).split('、').map(item => item.trim().replace(/^@/, '')).filter(Boolean);
}

export type MentionSegment = { type: 'text'; text: string } | { type: 'mention'; label: string };

/** 正文里的 @名称 → 胶囊；只认 labels 里的名字（最长优先），其余 @ 原样保留。 */
export function splitMentions(text: string, labels: readonly string[]): MentionSegment[] {
  const source = String(text || '');
  const names = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!names.length || !source.includes('@')) return source ? [{ type: 'text', text: source }] : [];
  const out: MentionSegment[] = [];
  let buffer = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] === '@') {
      const name = names.find(candidate => source.startsWith(candidate, index + 1));
      if (name) {
        if (buffer) out.push({ type: 'text', text: buffer });
        buffer = '';
        out.push({ type: 'mention', label: name });
        index += name.length + 1;
        continue;
      }
    }
    buffer += source[index];
    index += 1;
  }
  if (buffer) out.push({ type: 'text', text: buffer });
  return out;
}

/** 素材卡最多显示 max 张，其余收成「+N」。 */
export function visibleTiles<T>(items: readonly T[], max: number): { shown: T[]; overflow: number } {
  if (items.length <= max) return { shown: [...items], overflow: 0 };
  const shown = items.slice(0, Math.max(0, max - 1));
  return { shown, overflow: items.length - shown.length };
}

/** 视频时长角标：0:07 / 1:05 / 1:02:03。 */
export function formatMediaDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
