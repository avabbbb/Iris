import type { ManagedAgentConnection } from './managedAgentConnection';
import type { ProductionSkillAttachment } from './productionSkillCatalog';

export interface IrisAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** 模型的思考过程（reasoning_content），与正文分开展示。 */
  thinking?: string;
  toolName?: string;
  /** 工具结果对应的调用 id（与流式 tool-start 的 id 相同），用于把实时卡片的参数 / 用时接到快照上。 */
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  error?: string;
  /** 浏览器内核的上下文压缩分隔条（role 为 system）。 */
  compaction?: { tokensBefore: number };
}

export interface IrisAgentSnapshot {
  sessionId: string;
  projectId: string;
  messages: IrisAgentMessage[];
  running: boolean;
  boundProductionSkill?: ProductionSkillAttachment;
  productionSkillBindingError?: string;
}

export type IrisAgentTurnEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'snapshot'; snapshot: IrisAgentSnapshot }
  | { type: 'status'; running: boolean }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | { type: 'tool-update'; id: string; name: string; partial: unknown }
  | { type: 'tool-end'; id: string; name: string; result: unknown; isError: boolean }
  | { type: 'error'; message: string };

function headers(connection: ManagedAgentConnection, body = false) {
  return {
    'X-Iris-Agent-Token': connection.token,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return new Error(body?.error?.message || body?.error || `Iris Agent 请求失败（HTTP ${response.status}）`);
}

function parseSseBlock(block: string) {
  let type = '';
  const data: string[] = [];
  block.split(/\r?\n/).forEach(line => {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  });
  if (!type || !data.length) return undefined;
  try {
    return { type, data: JSON.parse(data.join('\n')) };
  } catch (error) {
    console.warn('[IrisAgent] 忽略无法解析的 SSE 数据块。', error);
    return undefined;
  }
}

// 线上协议：本机 Agent 的会话接口仍走 /agent/flovart/*（更名前的已安装 Agent 只认这个路径；新 Agent 两个路径都接受）。
export class ManagedIrisAgentClient {
  constructor(private connection: ManagedAgentConnection) {}

  async session(projectId: string): Promise<IrisAgentSnapshot> {
    const response = await fetch(`${this.connection.url}/agent/flovart/session?projectId=${encodeURIComponent(projectId)}`, {
      headers: headers(this.connection),
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }

  async turn(
    projectId: string,
    prompt: string,
    emit: (event: IrisAgentTurnEvent) => void,
    signal?: AbortSignal,
    skillAttachment?: ProductionSkillAttachment | null,
    /** 本轮 id：Agent 只把这一轮的事件推给本连接，取消也能精确到这一轮（含仍在排队时）。 */
    turnId?: string,
  ): Promise<void> {
    const response = await fetch(`${this.connection.url}/agent/flovart/turn`, {
      method: 'POST',
      signal,
      headers: headers(this.connection, true),
      body: JSON.stringify({ projectId, prompt, skillAttachment: skillAttachment || null, ...(turnId ? { turnId } : {}) }),
    });
    if (!response.ok) throw await responseError(response);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Iris Agent 没有返回事件流。');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const event = parseSseBlock(block);
        if (!event) continue;
        if (event.type === 'text-delta') emit({ type: 'text-delta', delta: String(event.data?.delta || '') });
        else if (event.type === 'thinking-delta') emit({ type: 'thinking-delta', delta: String(event.data?.delta || '') });
        else if (event.type === 'snapshot') emit({ type: 'snapshot', snapshot: event.data });
        else if (event.type === 'status') emit({ type: 'status', running: Boolean(event.data?.running) });
        else if (event.type === 'tool-start') emit({
          type: 'tool-start',
          id: String(event.data?.id || ''),
          name: String(event.data?.name || 'Workflow 工具'),
          args: event.data?.args,
        });
        else if (event.type === 'tool-update') emit({
          type: 'tool-update',
          id: String(event.data?.id || ''),
          name: String(event.data?.name || 'Workflow 工具'),
          partial: event.data?.partial,
        });
        else if (event.type === 'tool-end') emit({
          type: 'tool-end',
          id: String(event.data?.id || ''),
          name: String(event.data?.name || 'Workflow 工具'),
          result: event.data?.result,
          isError: Boolean(event.data?.isError),
        });
        else if (event.type === 'error') emit({ type: 'error', message: String(event.data?.message || 'Iris Agent 运行失败') });
      }
      if (done) break;
    }
  }

  /** 给了 turnId 只取消这一轮（排队中的直接出队）；不给则取消该项目正在执行的回合。 */
  async cancel(projectId: string, turnId?: string): Promise<void> {
    const response = await fetch(`${this.connection.url}/agent/flovart/cancel`, {
      method: 'POST',
      headers: headers(this.connection, true),
      body: JSON.stringify({ projectId, ...(turnId ? { turnId } : {}) }),
    });
    if (!response.ok) throw await responseError(response);
  }
}
