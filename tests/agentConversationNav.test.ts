import { describe, expect, it } from 'vitest';
import {
  activeTurnIndex,
  distanceFromBottom,
  isAwayFromBottom,
  nextStickToBottom,
  plainPreview,
  splitConversationTurns,
  turnIndexByMessage,
} from '../components/agent/agentConversationNavModel';

describe('conversation turns', () => {
  const messages = [
    { id: 's0', role: 'system', text: '已连接' },
    { id: 'u1', role: 'user', text: '> 引文\n\n你能不能联网搜一下**会议**图片\n\n引用：@图片1' },
    { id: 'a1', role: 'assistant', text: '可以。\n\n1. **会场正后方中央高位** | 16-35mm' },
    { id: 't1', role: 'tool', text: 'ok' },
    { id: 'a2', role: 'assistant', text: '第二段' },
    { id: 'u2', role: 'user', text: '再补三张' },
    { id: 'e2', role: 'error', text: '失败' },
  ];

  it('starts a turn at every user message and ignores what comes before the first one', () => {
    const turns = splitConversationTurns(messages);
    expect(turns.map(turn => turn.userMessageId)).toEqual(['u1', 'u2']);
    expect(turns[0].question).toBe('你能不能联网搜一下会议图片');
    expect(turns[0].answer).toBe('可以。 会场正后方中央高位 | 16-35mm 第二段');
    expect(turns[1]).toMatchObject({ index: 1, question: '再补三张', answer: '' });
  });

  it('maps messages to turn indexes', () => {
    const map = turnIndexByMessage(messages);
    expect(map.get('s0')).toBe(-1);
    expect(map.get('a2')).toBe(0);
    expect(map.get('e2')).toBe(1);
  });

  it('clips long answers', () => {
    const [turn] = splitConversationTurns([{ id: 'u', role: 'user', text: 'q' }, { id: 'a', role: 'assistant', text: '长'.repeat(400) }]);
    expect([...turn.answer].length).toBe(120);
    expect(turn.answer.endsWith('…')).toBe(true);
  });

  it('flattens markdown for previews', () => {
    expect(plainPreview('# 标题\n- **粗**体 `code` [链接](http://x)\n```js\nx\n```')).toBe('标题 粗体 code 链接');
  });

  it('highlights the last turn whose top passed the upper third of the viewport', () => {
    expect(activeTurnIndex([], 0, 600)).toBe(-1);
    expect(activeTurnIndex([0, 500, 1200], 0, 600)).toBe(0);
    expect(activeTurnIndex([0, 500, 1200], 400, 600)).toBe(1);
    expect(activeTurnIndex([0, 500, 1200], 1100, 600)).toBe(2);
  });
});

describe('scroll to latest', () => {
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 600 });

  it('shows the button only after leaving the bottom by a third of a screen', () => {
    expect(distanceFromBottom(at(1400))).toBe(0);
    expect(isAwayFromBottom(at(1400))).toBe(false);
    expect(isAwayFromBottom(at(1250))).toBe(false); // 150 < 200
    expect(isAwayFromBottom(at(1150))).toBe(true); // 250 > 200
    expect(isAwayFromBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(false);
  });

  it('stops following when the user scrolls up and resumes at the bottom', () => {
    expect(nextStickToBottom(true, at(1300), 1400)).toBe(false); // 往上翻
    expect(nextStickToBottom(false, at(1390), 1300)).toBe(true); // 回到底部容差内
  });

  it('keeps following when streamed content pushes the bottom away (scrollTop unchanged)', () => {
    expect(nextStickToBottom(true, { scrollTop: 1400, scrollHeight: 2600, clientHeight: 600 }, 1400)).toBe(true);
    expect(nextStickToBottom(false, { scrollTop: 900, scrollHeight: 2600, clientHeight: 600 }, 900)).toBe(false);
  });
});
