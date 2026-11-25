// 多会话隔离（真实内核）：面板主运行时与画布后台运行时同时在同一项目的两个会话里跑，会话列表整表读改写不能互相覆盖；
// 后台要的新会话不复用「最近的空会话」；会话认领期间另一个运行时打不开它。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import localforage from 'localforage';
import { BrowserAgentKernel } from '../services/browserAgentKernel';
import { BrowserAgentRuntime, browserAgentSessionClaimed } from '../services/browserAgentRuntime';
import { createInMemoryMemoryBackend } from '../services/agentProjectMemory';

const PROJECT = 'project-isolation';
const route = { provider: 'openai_compatible', model: 'm', baseUrl: 'https://gw.example/v1', apiKey: 'k' };

function sse(text: string): Response {
  const body = [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const make = () => new BrowserAgentKernel({
  projectId: PROJECT, route, tools: [], confirm: async () => true, systemPrompt: 'SYS', getThinkingLevel: () => 'off',
  skillCatalog: { list: () => [], read: async () => null }, memory: createInMemoryMemoryBackend(),
});

describe('browser agent session isolation', () => {
  beforeEach(async () => { await localforage.removeItem(`iris.agent.sessions.${PROJECT}`); });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await localforage.removeItem(`iris.agent.sessions.${PROJECT}`); });

  it('two kernels sending at the same time in different sessions both keep their turns', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> };
      const last = JSON.stringify(body.messages[body.messages.length - 1]?.content ?? '');
      await new Promise(resolve => setTimeout(resolve, last.includes('A') ? 5 : 1));
      return sse(last.includes('A') ? '回复 A' : '回复 B');
    }));
    // 拉宽「读 → 写」之间的窗口（IndexedDB 真实环境里是异步的）：没有串行锁时两个内核会互相覆盖。
    const getItem = localforage.getItem.bind(localforage);
    vi.spyOn(localforage, 'getItem').mockImplementation(async (key: string) => { const value = await getItem(key); await new Promise(resolve => setTimeout(resolve, 3)); return value as never; });
    const main = make();
    await main.openSession();
    const background = make();
    await background.openSession();
    // 主运行时的会话是空的：后台要新会话时不能复用它。
    await background.newSession({ fresh: true });
    const mainId = String((await main.snapshot() as { sessionId: string }).sessionId);
    const backgroundId = String((await background.snapshot() as { sessionId: string }).sessionId);
    expect(backgroundId).not.toBe(mainId);
    await Promise.all([main.send('问题 A'), background.send('问题 B')]);
    const fresh = make();
    const sessions = await fresh.listSessions();
    expect(sessions.map(item => item.id).sort()).toEqual([mainId, backgroundId].sort());
    await fresh.openSessionById(backgroundId);
    const texts = ((await fresh.snapshot()) as { messages: Array<{ role: string; text: string }> }).messages.map(item => item.text);
    expect(texts).toContain('问题 B');
    expect(texts).toContain('回复 B');
    expect(texts.join('|')).not.toContain('问题 A');
    await Promise.all([main.close(), background.close(), fresh.close()]);
  });

  it('a claimed session cannot be opened by another runtime until the claimant closes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse('ok')));
    const deps = { projectId: PROJECT, route, confirm: async () => true, systemPrompt: 'SYS' };
    const panel = await BrowserAgentRuntime.connect(deps as never, { kernel: make() });
    const runner = await BrowserAgentRuntime.connect(deps as never, { kernel: make(), register: false, session: 'new' });
    const claimed = String((await runner.snapshot() as { sessionId: string }).sessionId);
    expect(browserAgentSessionClaimed(PROJECT, claimed)).toBe(true);
    await expect(panel.openSessionById(claimed)).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    await runner.close();
    expect(browserAgentSessionClaimed(PROJECT, claimed)).toBe(false);
    await expect(panel.openSessionById(claimed)).resolves.toBeTruthy();
    await panel.close();
  });
});
