/**
 * 对话导航：轮次时间轴与「回到最新消息」的纯逻辑。
 *
 * - 一轮 = 一条用户消息 + 它之后直到下一条用户消息之前的所有回复；
 * - 第一条用户消息之前的系统 / 错误提示不成轮；
 * - 「离开底部」按 1/3 屏判断；跟随底部只在用户没往上翻时生效，流式输出不会把人拉回去。
 */
import { splitQuote } from './agentQuote';
import { stripReferenceLine } from './agentMessageRefs';

export interface TurnMessageLike {
  id: string;
  role: string;
  text: string;
}

export interface ConversationTurn {
  /** 0 起的轮次序号。 */
  index: number;
  /** 这一轮用户消息的 id（时间轴据此定位 DOM）。 */
  userMessageId: string;
  /** 用户提问（去掉引用块与「引用：」「附件：」行）。 */
  question: string;
  /** 回答开头（去掉 Markdown 记号，压成一行，截断）。 */
  answer: string;
}

export const TURN_ANSWER_PREVIEW_MAX = 120;
export const TURN_QUESTION_PREVIEW_MAX = 80;

function clip(text: string, max: number) {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** Markdown → 一行可读文本（预览用，不追求完整解析）。 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionText(text: string) {
  const body = splitQuote(text).body;
  const withoutRefs = stripReferenceLine(body)
    .split(/\n{2,}/)
    .filter(block => !/^附件：/.test(block.trim()))
    .join('\n\n');
  return clip(plainPreview(withoutRefs), TURN_QUESTION_PREVIEW_MAX);
}

/** 把消息列表分成轮次。 */
export function splitConversationTurns(messages: readonly TurnMessageLike[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let answer: string[] = [];
  const flush = () => {
    const last = turns[turns.length - 1];
    if (last) last.answer = clip(plainPreview(answer.join('\n\n')), TURN_ANSWER_PREVIEW_MAX);
    answer = [];
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      turns.push({ index: turns.length, userMessageId: message.id, question: questionText(message.text), answer: '' });
    } else if (message.role === 'assistant' && turns.length && message.text) {
      answer.push(message.text);
    }
  }
  flush();
  return turns;
}

/** 每条消息所属轮次（第一条用户消息之前为 -1）。 */
export function turnIndexByMessage(messages: readonly TurnMessageLike[]): Map<string, number> {
  const out = new Map<string, number>();
  let index = -1;
  for (const message of messages) {
    if (message.role === 'user') index += 1;
    out.set(message.id, index);
  }
  return out;
}

/**
 * 当前可视轮：顶部落在视口上 1/3 线之上的最后一轮。
 * turnTops 是各轮用户消息相对滚动内容顶部的偏移（升序）。
 */
export function activeTurnIndex(turnTops: readonly number[], scrollTop: number, viewportHeight: number): number {
  if (!turnTops.length) return -1;
  const line = scrollTop + Math.max(0, viewportHeight) / 3;
  let active = 0;
  for (let index = 0; index < turnTops.length; index += 1) {
    if (turnTops[index] <= line) active = index;
    else break;
  }
  return active;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/** 是否离开底部到需要显示「回到最新消息」：离底超过 1/3 屏。 */
export function isAwayFromBottom(metrics: ScrollMetrics, ratio = 1 / 3): boolean {
  if (metrics.clientHeight <= 0) return false;
  return distanceFromBottom(metrics) > metrics.clientHeight * ratio;
}

/** 贴底判定的容差（像素）：在这个距离内视为在底部，恢复自动跟随。 */
export const STICK_TOLERANCE = 24;

/**
 * 滚动后是否继续跟随底部：
 * - 回到底部（容差内）→ 跟随；
 * - 用户往上翻（scrollTop 变小）→ 不跟随；
 * - 其余（内容变高、图片加载把底部推远，scrollTop 没变或变大）→ 保持原状态。
 */
export function nextStickToBottom(previous: boolean, metrics: ScrollMetrics, lastScrollTop: number): boolean {
  if (distanceFromBottom(metrics) <= STICK_TOLERANCE) return true;
  if (metrics.scrollTop < lastScrollTop - 1) return false;
  return previous;
}
