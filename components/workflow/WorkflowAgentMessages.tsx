import { ImageFan } from '../ui/ImageFan';
import { Copy, GitBranch, Quote } from 'lucide-react';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentWorkingOrb } from '../agent/AgentWorkingOrb';
import { AgentToolSteps } from '../agent/AgentToolSteps';
import { AgentCompactionCard, type AgentCompactionInfo } from '../agent/AgentCompactionCard';
import { AgentMediaTiles, AgentMentionPill, findReferenceNode } from '../agent/AgentMediaTiles';
import { splitMentions, stripReferenceLine, type AgentMessageReference } from '../agent/agentMessageRefs';
import type { WorkflowNode } from './types';
import { AgentReasoningBlock } from '../agent/AgentReasoningBlock';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { splitQuote } from '../agent/agentQuote';
import { translations } from '../../utils/translations';
import { agentWorkingMeta, agentWorkingPhase, type AgentOrbState } from '../agent/agentWorkingPhase';

export interface WorkflowAgentDisplayAttachment {
  id: string;
  name: string;
  previewUrl: string;
}

export interface WorkflowAgentDisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  text: string;
  /** 助手的思考过程：折叠展示，不进正文。 */
  thinking?: string;
  title?: string;
  detail?: unknown;
  status?: 'pending' | 'success' | 'error' | 'denied';
  attachments?: WorkflowAgentDisplayAttachment[];
  createdAt?: string;
  /** 工具卡：原始工具名（用于摘要与点阵球状态）与调用参数；detail 是结果。 */
  toolName?: string;
  /** 快照里工具结果对应的调用 id（实时卡片的 id 是 tool-<toolCallId>）。 */
  toolCallId?: string;
  args?: unknown;
  /** 思考开始的本地时间（流式时记录，用于实时计时）。 */
  thinkingStartedAt?: number;
  /** 正文 / 工具调用 / 回合结束后为 true：思考块自动收起并定格用时。 */
  thinkingDone?: boolean;
  thinkingMs?: number;
  /** 用户消息引用的画布节点 / 素材（显示为素材卡；正文里的 @名称 显示为缩略图胶囊）。 */
  references?: AgentMessageReference[];
  /** 工具调用的真实起止时间（毫秒时间戳），用于步骤行的用时；快照恢复的卡片没有。 */
  startedAt?: number;
  endedAt?: number;
  /** 上下文压缩记录（role 为 system）：显示为「已压缩」卡片而不是一行系统提示。 */
  compaction?: AgentCompactionInfo;
}

type MessageSegment =
  | { kind: 'message'; message: WorkflowAgentDisplayMessage }
  | { kind: 'tools'; key: string; tools: WorkflowAgentDisplayMessage[] };

/** 连续的工具调用合成一张步骤卡（参考 Inspora「Sandbox Boot Sequence」的启动清单），其余消息原样。 */
export function segmentAgentMessages(messages: readonly WorkflowAgentDisplayMessage[]): MessageSegment[] {
  const out: MessageSegment[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (message.role === 'tool') {
      if (last?.kind === 'tools') last.tools.push(message);
      else out.push({ kind: 'tools', key: 'tools-' + message.id, tools: [message] });
    } else out.push({ kind: 'message', message });
  }
  return out;
}

/** 运行中胶囊：状态与文案由面板按真实回合事件推出（agentWorkingPhase）。 */
export interface WorkflowAgentWorking {
  state: AgentOrbState;
  label: string;
  /** 本轮已发起的工具调用数。 */
  steps?: number;
}

/** 胶囊尾部「3 步 · 12s」：自己每秒走表，不让整个面板跟着重渲染。 */
function WorkingMeta({ steps, startedAt, language }: { steps: number; startedAt?: number; language: 'en' | 'zho' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const meta = agentWorkingMeta(steps, startedAt === undefined ? 0 : now - startedAt, language);
  if (!meta.steps && startedAt === undefined) return null;
  return <>{meta.steps && <span className="agent-orb-meta-extra">{meta.steps}{startedAt !== undefined ? ' · ' : ''}</span>}{startedAt !== undefined ? meta.time : null}</>;
}

/** 每个片段所属的对话轮次（片段第一条消息之前出现过几条用户消息 - 1；首条用户消息前为 -1）。 */
export function segmentTurnIndexes(segments: readonly MessageSegment[]): number[] {
  let turn = -1;
  return segments.map(segment => {
    if (segment.kind === 'message' && segment.message.role === 'user') turn += 1;
    return turn;
  });
}

export function WorkflowAgentMessages({ messages, running, working, turnStartedAt, nodes, onOpenReference, language = 'zho', onCopyMessage, onBranchMessage, branchDisabled, onQuoteMessage, renderTurnFooter }: {
  messages: WorkflowAgentDisplayMessage[];
  running?: boolean;
  /** 运行中胶囊的状态；不给就按消息推一个（只看本轮工具 / 正文）。 */
  working?: WorkflowAgentWorking;
  /** 本轮开始时间（毫秒），胶囊尾部显示用时。 */
  turnStartedAt?: number;
  /** 当前画布节点：用于引用素材卡的缩略图与「已删除」占位。 */
  nodes?: readonly WorkflowNode[];
  /** 点素材卡 / @胶囊：在画布上定位节点。 */
  onOpenReference?: (reference: AgentMessageReference) => void;
  language?: 'en' | 'zho';
  /** 复制单条消息（Markdown 文本） */
  onCopyMessage?: (message: WorkflowAgentDisplayMessage) => void;
  /** 从这条助手消息处分出新会话 */
  onBranchMessage?: (message: WorkflowAgentDisplayMessage) => void;
  branchDisabled?: boolean;
  /** 引用这条助手消息回复（输入框上方出现引用条）。 */
  onQuoteMessage?: (message: WorkflowAgentDisplayMessage) => void;
  /** 每轮对话末尾附加的内容（例如这一轮的生成计划卡）；参数是 0 起的轮次序号。 */
  renderTurnFooter?: (turnIndex: number) => ReactNode;
}) {
  const en = language === 'en';
  const pill = running ? working ?? agentWorkingPhase({ turnPhase: 'sending', messages, language }) : undefined;
  if (messages.length === 0 && !running) return <div className="workflow-agent__empty">{en ? 'Describe what you want the Agent to do with this Workflow.' : '描述你希望 Agent 对当前 Workflow 做什么。'}</div>;
  const copy = translations[language].agentPanel;
  const segments = segmentAgentMessages(messages);
  const turns = segmentTurnIndexes(segments);
  return (
    <div className="workflow-agent__messages">
      {segments.flatMap((segment, index) => {
        const turn = turns[index];
        const footer = renderTurnFooter && turn >= 0 && turns[index + 1] !== turn ? renderTurnFooter(turn) : null;
        const body = segment.kind === 'tools'
        ? <AgentToolSteps key={segment.key} tools={segment.tools} language={language} running={running} />
        : segment.message.compaction
        ? <div key={segment.message.id} className="workflow-agent__message workflow-agent__message--compaction" data-message-id={segment.message.id}><AgentCompactionCard info={segment.message.compaction} language={language} /></div>
        : ((message: WorkflowAgentDisplayMessage) => (
          <div
            key={message.id}
            className={`workflow-agent__message workflow-agent__message--${message.role}`}
            data-message-id={message.id}
            {...(message.role === 'user' ? { 'data-turn-index': turn } : {})}
          >
            <span>{message.role === 'user' ? (en ? 'You' : '你') : message.role === 'assistant' ? 'Agent' : message.role === 'error' ? (en ? 'Error' : '错误') : (en ? 'System' : '系统')}</span>
            {message.role === 'assistant' && message.thinking ? (
              <AgentReasoningBlock
                text={message.thinking}
                live={Boolean(running && !message.thinkingDone && message.thinkingStartedAt !== undefined)}
                startedAt={message.thinkingStartedAt}
                ms={message.thinkingMs}
                language={language}
              />
            ) : null}
            {message.role === 'assistant'
              ? (message.text ? <AgentMarkdown text={message.text} language={language} /> : null)
              : message.role === 'user'
                ? <UserText message={message} nodes={nodes} onOpenReference={onOpenReference} quotedLabel={copy.quotedLabel} />
                : <p>{message.text}</p>}
            {message.role === 'user' && message.references?.length ? <AgentMediaTiles refs={message.references} nodes={nodes} language={language} onOpen={onOpenReference} testId="agent-message-refs" /> : null}
            {message.attachments?.length === 1 ? <div className="workflow-agent__message-attachments">{message.attachments.map(item => <img key={item.id} src={item.previewUrl} alt={item.name} title={item.name} />)}</div> : null}
            {message.attachments && message.attachments.length > 1 ? <ImageFan className="workflow-agent__message-fan" items={message.attachments.map(item => ({ id: item.id, src: item.previewUrl, alt: item.name }))} /> : null}
            {(onCopyMessage || ((onBranchMessage || onQuoteMessage) && message.role === 'assistant')) && (message.role !== 'assistant' || message.text) && (
              <div className="workflow-agent__message-actions">
                {onCopyMessage && <button type="button" onClick={() => onCopyMessage(message)} aria-label={`${en ? 'Copy message' : '复制这条消息'}`} title={en ? 'Copy message' : '复制这条消息'}><Copy size={11} />{en ? 'Copy' : '复制'}</button>}
                {onQuoteMessage && message.role === 'assistant' && <button type="button" onClick={() => onQuoteMessage(message)} aria-label={copy.quoteReply} title={copy.quoteReply}><Quote size={11} />{copy.quoteMessage}</button>}
                {onBranchMessage && message.role === 'assistant' && <button type="button" disabled={branchDisabled} onClick={() => onBranchMessage(message)} aria-label={en ? 'Branch from here' : '从这里分支'} title={en ? 'Branch from here' : '从这里新建一个分支会话'}><GitBranch size={11} />{en ? 'Branch' : '分支'}</button>}
              </div>
            )}
          </div>
        ))(segment.message);
        // 附加内容用按轮次的稳定 key 平铺在消息之后：本轮新增片段时它只是挪位，不会让消息或卡片重新挂载。
        return footer ? [body, <Fragment key={'turn-footer-' + turn}>{footer}</Fragment>] : [body];
      })}
      {pill && <div className="workflow-agent__working"><AgentWorkingOrb state={pill.state} label={pill.label} meta={<WorkingMeta steps={pill.steps ?? 0} startedAt={turnStartedAt} language={language} />} /></div>}
    </div>
  );
}

/** 用户正文：开头的引用块单独显示；去掉「引用：…」行（改由素材卡展示），@名称 换成缩略图胶囊。 */
function UserText({ message, nodes, onOpenReference, quotedLabel }: { message: WorkflowAgentDisplayMessage; nodes?: readonly WorkflowNode[]; onOpenReference?: (reference: AgentMessageReference) => void; quotedLabel: string }) {
  const refs = message.references || [];
  const { quote, body } = splitQuote(message.text);
  const text = refs.length ? stripReferenceLine(body) : body;
  const quoteBlock = quote ? <blockquote className="workflow-agent__quote" aria-label={quotedLabel}>{quote}</blockquote> : null;
  if (!text) return quoteBlock;
  if (!refs.length) return <>{quoteBlock}<p>{text}</p></>;
  const segments = splitMentions(text, refs.map(ref => ref.label));
  return (
    <>{quoteBlock}<p>
      {segments.map((segment, index) => {
        if (segment.type === 'text') return <span key={index}>{segment.text}</span>;
        const ref = refs.find(item => item.label === segment.label)!;
        const node = findReferenceNode(ref, nodes);
        return <AgentMentionPill key={index} label={segment.label} node={node} onOpen={onOpenReference ? () => onOpenReference(ref) : undefined} />;
      })}
    </p></>
  );
}
