import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { copyToClipboard } from './agentTranscript';
import { AgentSetupGuide } from './AgentSetupGuide';
import '../../styles/agent.css';
import type { WorkflowProject } from '../workflow/types';

/**
 * Dedicated top-level Agent surface.
 *
 * This page is for discovering, preparing, and switching local/external coding
 * agents (Codex, WorkBuddy, etc.). It intentionally does not contain the
 * built-in Iris assistant; that assistant stays beside Canvas/Table in the
 * right drawer so users can keep the work visible while chatting.
 */
function isHostedDemo(): boolean {
  if (typeof window === 'undefined') return false;
  const { protocol, hostname } = window.location;
  return protocol === 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname);
}

export function AgentConnectionsPage({ project, language = 'zho' }: { project: WorkflowProject | null; language?: 'en' | 'zho' }) {
  void project;
  const hosted = isHostedDemo();
  const zh = language === 'zho';
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const copy = zh
    ? {
        tag: 'Agent · DSH',
        title: '用 DeepSeek Harness（DSH）指挥画布',
        body: 'DSH 主会话是指挥入口，Iris 插件在 Iris 页签中读取并修改你当前可见的 Workflow。生成仍走同一条确认与提交链路。',
        envHosted: '你正在使用线上页面（HTTPS）。浏览器会阻止 HTTPS 页面直接访问本机 http 服务（DSH 需在本地工作区运行）；外部 CLI / 编码 Agent 可通过 Iris Link（iris login web）经同源中继安全连接当前线上画布，模型 Key 始终留在浏览器内。',
        envLocal: '当前为本地工作区，可按以下步骤连接 DSH。',
        stepsTitle: '本地连接步骤',
        steps: [
          { text: '克隆 Iris 仓库并安装依赖（Node 22.19+ 或 24+）', command: 'npm install' },
          { text: '安装 DSH Profile（兼容 DeepSeek Harness 0.2.2-rc.1 起的 0.2.x）', command: 'npm run dsh:profile:install' },
          { text: '启动 DSH；启动器会准备本地工作区并打开可见 Workflow', command: 'npm run dsh:start' },
          { text: '在 DeepSeek 主会话切换到 Iris 页签，用自然语言指挥，例如“创建三个镜头的工作流”，再“只修改第二个镜头”' },
          { text: '回到本地画布查看变更；没有可见 Workflow 时 DSH 会明确提示，不会创建隐藏副本' },
          { text: '连不上时运行诊断，并在画布右侧 Agent 面板的「连接状态」查看原因与下一步', command: 'npm --prefix dsh-plugin run profile:doctor' },
        ],
        status: '状态：插件已在本地完成打包与干净 Profile 安装验证；npm 发布与插件市场尚未完成；真实 DeepSeek 登录态下的对话验收待验证。',
        drawer: '不连接 DSH 也可以在画布右侧的助手面板继续工作。',
      }
    : {
        tag: 'Agent · DSH',
        title: 'Drive the canvas from DeepSeek Harness (DSH)',
        body: 'The DSH main conversation is the command entry; the Iris plugin reads and edits your currently visible Workflow from the Iris tab. Generation still goes through the same confirm-and-submit path.',
        envHosted: 'You are on the hosted HTTPS page. Browsers block HTTPS pages from calling a local http agent directly (DSH runs in a local workspace); external CLI or coding agents can connect to this tab through Iris Link (iris login web) over the same-origin relay while keeping model keys in your browser.',
        envLocal: 'This is a local workspace; follow the steps below to connect DSH.',
        stepsTitle: 'Local setup',
        steps: [
          { text: 'Clone the Iris repo and install dependencies (Node 22.19+ or 24+)', command: 'npm install' },
          { text: 'Install the DSH profile (DeepSeek Harness 0.2.x, from 0.2.2-rc.1)', command: 'npm run dsh:profile:install' },
          { text: 'Start DSH; the launcher prepares the local workspace and opens a visible Workflow', command: 'npm run dsh:start' },
          { text: 'In the DeepSeek main conversation open the Iris tab and give instructions, e.g. "create a three-shot workflow", then "only change the second shot"' },
          { text: 'Check the change on the local canvas; with no visible Workflow DSH says so and never creates a hidden copy' },
          { text: 'If it cannot connect, run the doctor and check the reason under Status in the Agent panel beside the canvas', command: 'npm --prefix dsh-plugin run profile:doctor' },
        ],
        status: 'Status: packaged and installed into a clean profile locally; npm publish and marketplace listing not done yet; conversation acceptance under a real DeepSeek login still unverified.',
        drawer: 'Without DSH you can keep working in the assistant panel beside the canvas.',
      };
  const hostedOrigin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://iris.avabbbb.com';
  const handoffPrompt = hosted
    ? (zh
        ? `你是 Iris 的编码 Agent。请通过可见的线上 Iris Workflow（${hostedOrigin}/#/app）操作画布，不要直接改前端状态。

仓库：https://github.com/avabbbb/Iris

准备（通过 Iris Link 连接当前线上标签页，不经本机 http）：
git clone https://github.com/avabbbb/Iris.git
cd Iris
npm install
npm run iris:cli -- login web --open --url ${hostedOrigin} --scopes agent.read,agent.run,tools.invoke
npm run iris:cli -- link status --json

连接后先读：
npm run iris:cli -- workflow.inspect --summary --json

约束：
- 只通过 iris CLI / Iris Skill 的 Workflow 契约读写；参考 .claude/skills/iris/SKILL.md。
- 写入只用 workflow.apply，带 projectId、expectedRevision、mutationId 和 --idempotency-key；多个修改合并为一次 apply。
- 不直接写 React/Zustand、浏览器存储、Runtime 数据库或 Provider 私有 API。
- 修改前后都要 inspect；付费生成或删除前先让用户在页面上确认。

如果你在本地工作区（http://127.0.0.1:37522）或 DSH 中运行，改用 npm run iris:cli -- ensure --json 或 npm run dsh:profile:install。`
        : `You are a coding agent working on Iris. Operate only through the visible hosted Iris Workflow (${hostedOrigin}/#/app); never write frontend state directly.

Repository: https://github.com/avabbbb/Iris

Prepare (connect to this hosted tab through Iris Link, without local http loopback):
git clone https://github.com/avabbbb/Iris.git
cd Iris
npm install
npm run iris:cli -- login web --open --url ${hostedOrigin} --scopes agent.read,agent.run,tools.invoke
npm run iris:cli -- link status --json

Read the graph first:
npm run iris:cli -- workflow.inspect --summary --json

Constraints:
- Read/write only through the iris CLI / Iris Skill Workflow contract; see .claude/skills/iris/SKILL.md.
- Writes go through workflow.apply with projectId, expectedRevision, mutationId and --idempotency-key; batch related edits into one apply.
- Never write React/Zustand, browser storage, Runtime databases or Provider private APIs directly.
- Inspect before and after changes; paid generation or deletion always requires confirmation on the page.

For a local workspace (http://127.0.0.1:37522) or DSH, use npm run iris:cli -- ensure --json or npm run dsh:profile:install instead.`)
    : (zh
        ? `你是 Iris 的本地编码 Agent。请通过可见的 Iris Workflow 操作画布，不要直接改前端状态。

仓库：https://github.com/avabbbb/Iris

准备：
git clone https://github.com/avabbbb/Iris.git
cd Iris
npm install
npm run iris:cli -- ensure --json
npm run iris:cli -- status --json

连接后先读：
npm run iris:cli -- workflow.inspect --summary --json

约束：
- 只通过 iris CLI / Iris Skill 的 Workflow 契约读写；参考 .claude/skills/iris/SKILL.md。
- 写入只用 workflow.apply，带 projectId、expectedRevision、mutationId；多个修改合并为一次 apply。
- 不直接写 React/Zustand、浏览器存储、Runtime 数据库或 Provider 私有 API。
- 修改前后都要 inspect；付费生成前先让用户确认。

如果在 DSH 中运行：先执行 npm run dsh:profile:install，然后在 DSH 主会话切到 Iris 页签，用同一套自然语言指令操作画布；其他 Agent 使用上面的 CLI 方式。`
        : `You are a local coding agent working on Iris. Operate only through the visible Iris Workflow; never write frontend state directly.

Repository: https://github.com/avabbbb/Iris

Prepare:
git clone https://github.com/avabbbb/Iris.git
cd Iris
npm install
npm run iris:cli -- ensure --json
npm run iris:cli -- status --json

Read the graph first:
npm run iris:cli -- workflow.inspect --summary --json

Constraints:
- Read/write only through the iris CLI / Iris Skill Workflow contract; see .claude/skills/iris/SKILL.md.
- Writes go through workflow.apply with projectId, expectedRevision and mutationId; batch related edits into one apply.
- Never write React/Zustand, browser storage, Runtime databases or Provider private APIs directly.
- Inspect before and after changes; ask the user before any paid generation.

For DSH: run npm run dsh:profile:install, then switch to the Iris tab in the DSH main conversation and use the same natural-language instructions. Other agents should use the CLI setup above.`);
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="agent-connections-page" style={{ color: 'var(--isl-ink)' }}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
        <section className={'agent-connections-page_' + '_surface'} data-testid="agent-connections-surface" aria-labelledby="agent-connections-title">
          <header className={'agent-connections-page_' + '_header'}>
            <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--isl-ink-ghost)' }}>{copy.tag}</span>
            <h1 id="agent-connections-title">{copy.title}</h1>
            <p>{copy.body}</p>
          </header>
          <div className="m-3 rounded-xl border p-4 text-sm" role="note" data-testid="agent-env-note" data-env={hosted ? 'hosted' : 'local'} style={{ borderColor: 'var(--isl-border)', background: 'var(--isl-surface)' }}>
            {hosted ? copy.envHosted : copy.envLocal}
          </div>
          <div className="m-3" data-testid="agent-dsh-steps">
            <AgentSetupGuide hostId="deepseek-harness" hostLabel="DeepSeek Harness" language={language} steps={copy.steps} title={copy.stepsTitle} />
          </div>
          <div className="m-3 rounded-xl border p-4" data-testid="agent-handoff-prompt" style={{ borderColor: 'var(--isl-border)', background: 'var(--isl-surface)' }}>
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <strong className="text-sm">{zh ? '给其他本地 Agent 的提示词' : 'Prompt for another local agent'}</strong>
                <p className="mt-1 text-xs" style={{ color: 'var(--isl-ink-soft)' }}>
                  {zh ? '复制后直接发给 Codex / Claude Code / 你自己的 Agent。没有 DSH 也能通过 GitHub 源码和 Iris CLI 接入本地可见画布。' : 'Copy this into Codex, Claude Code or your own agent. It can use the GitHub source and Iris CLI without DSH.'}
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                style={{ borderColor: 'var(--isl-border)', color: 'var(--isl-ink)' }}
                aria-live="polite"
                onClick={async () => {
                  if (!await copyToClipboard(handoffPrompt)) return;
                  setCopiedPrompt(true);
                  window.setTimeout(() => setCopiedPrompt(false), 1600);
                }}
              >
                {copiedPrompt ? (zh ? '已复制' : 'Copied') : (zh ? '一键复制提示词' : 'Copy prompt')}
              </button>
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs leading-relaxed" style={{ background: 'var(--isl-surface-sunk)', color: 'var(--isl-ink-soft)', userSelect: 'text' }}>{handoffPrompt}</pre>
          </div>
          <p className="mx-3 text-xs" data-testid="agent-dsh-status" style={{ color: 'var(--isl-ink-soft)' }}>{copy.status}</p>
          <p className="mx-3 mb-3 mt-1 text-xs" style={{ color: 'var(--isl-ink-soft)' }}>{copy.drawer}</p>
        </section>
      </div>
    </div>
  );
}

/**
 * Project-less onboarding for the in-context assistant drawer. A Workflow is
 * required before the built-in assistant can edit the shared canvas.
 */
export function AgentDrawerEmptyState({ onCreateProject, language = 'zho' }: { onCreateProject: () => void; language?: 'en' | 'zho' }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="agent-drawer-empty" style={{ color: 'var(--isl-ink)' }}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CreateProjectCard onCreateProject={onCreateProject} language={language} />
      </div>
    </div>
  );
}

function CreateProjectCard({ onCreateProject, language }: { onCreateProject: () => void; language: 'en' | 'zho' }) {
  const copy = language === 'zho'
    ? { title: '从一个新项目开始', body: '创建画布后，你和助手可以一起编辑，结果会保存在这里。', create: '创建项目' }
    : { title: 'Start with a new project', body: 'Create a canvas to edit together with your assistant. Your work will be saved here.', create: 'Create project' };
  return (
    <div className="m-3 rounded-xl border p-5 text-center" style={{ borderColor: 'var(--isl-border)', background: 'var(--isl-surface)' }}>
      <Sparkles className="mx-auto mb-2" size={22} style={{ color: 'var(--isl-mint)' }} />
      <strong className="text-sm">{copy.title}</strong>
      <p className="mt-1 text-xs" style={{ color: 'var(--isl-ink-soft)' }}>{copy.body}</p>
      <button type="button" className="mx-auto mt-3 rounded-lg border px-3 py-2 text-xs font-semibold" style={{ borderColor: 'var(--isl-border)' }} onClick={onCreateProject}>{copy.create}</button>
    </div>
  );
}
