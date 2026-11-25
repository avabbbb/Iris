// Iris Link 的页面部分（只在网页端挂载）：
// 1. /link?code=… 配对确认：显示 CLI 的名字、来源、申请的权限；用户核对配对码并逐项勾选后才允许。
// 2. 审批托盘：CLI 发起的非画布回合 / 工具调用需要确认时出现在这里（画布回合在会话卡上批）。付费 / 删除只能在这里点。
// 3. 「CLI 连接」列表：在线状态与断开（服务端撤销）。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { LINK_SCOPE_LABELS, LINK_SCOPES, normalizeLinkCode } from '../../tools/iris/link/protocol.js';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { allLinkManagers, linkTrayVersion, subscribeLinkTray } from '../../services/link/agentLinkRuns';
import { decideLinkApprovalFromPage } from '../../services/link/agentLinkCommands';
import {
  decideLinkPairing,
  fetchLinkPairingInfo,
  revokeLinkPairing,
  startWebLinkHost,
  useWebLinkHostState,
  type LinkPairingInfo,
} from '../../services/link/webLinkHost';

type Lang = 'en' | 'zho';

function isLinkPath(): boolean {
  try { return /\/link\/?$/.test(window.location.pathname); } catch { return false; }
}

function initialCode(): string {
  try { return new URLSearchParams(window.location.search).get('code') || ''; } catch { return ''; }
}

function leaveLinkPath() {
  try {
    const base = window.location.pathname.replace(/\/link\/?$/, '/');
    window.history.replaceState(null, '', base + (window.location.hash || '#/app'));
  } catch { /* ignore */ }
}

const T = {
  title: { zho: '允许命令行连接这个 Iris？', en: 'Allow a command line to connect to this Iris?' },
  codeLabel: { zho: '配对码', en: 'Pairing code' },
  enterCode: { zho: '输入终端里显示的配对码', en: 'Enter the code shown in your terminal' },
  lookup: { zho: '查看请求', en: 'Look up' },
  client: { zho: '客户端', en: 'Client' },
  from: { zho: '来源', en: 'From' },
  requested: { zho: '申请时间', en: 'Requested' },
  scopes: { zho: '它可以做什么', en: 'What it can do' },
  matches: { zho: '终端里显示的配对码就是', en: 'The code in my terminal is' },
  keyNote: { zho: '模型 Key 不会离开这个浏览器：命令在这个标签页里执行。付费和删除操作仍然只能由你在页面上批准，CLI 不能代批。', en: 'Model keys never leave this browser: commands run in this tab. Paid and destructive steps still need your approval here; the CLI cannot approve them.' },
  allow: { zho: '允许', en: 'Allow' },
  deny: { zho: '拒绝', en: 'Deny' },
  linked: { zho: '已连接', en: 'Connected' },
  linkedBody: { zho: '命令行现在可以驱动这个标签页里的 Iris。保持这个标签页打开；关掉后 CLI 会收到 TAB_OFFLINE。', en: 'The command line can now drive Iris in this tab. Keep the tab open; closing it sends TAB_OFFLINE to the CLI.' },
  done: { zho: '回到画布', en: 'Back to canvas' },
  denied: { zho: '已拒绝这次连接。', en: 'Connection denied.' },
  connections: { zho: 'CLI 连接', en: 'CLI links' },
  disconnect: { zho: '断开', en: 'Disconnect' },
  approvalTitle: { zho: 'CLI 回合等你批准', en: 'A CLI run needs your approval' },
  paid: { zho: '会产生费用', en: 'Costs money' },
  destructive: { zho: '会删除内容', en: 'Deletes content' },
  blocked: { zho: '被预算 / 检查挡住', en: 'Blocked by budget / checks' },
  approve: { zho: '批准', en: 'Approve' },
  reject: { zho: '拒绝', en: 'Deny' },
  status: { online: { zho: '在线', en: 'online' }, connecting: { zho: '连接中', en: 'connecting' }, standby: { zho: '其它标签页在执行', en: 'another tab hosts it' }, offline: { zho: '离线，重连中', en: 'offline, retrying' }, idle: { zho: '待连接', en: 'idle' }, revoked: { zho: '已撤销', en: 'revoked' } },
} as const;

function useLang(): Lang {
  const language = useWorkspaceStore(state => state.language);
  return language === 'en' ? 'en' : 'zho';
}

function PairingDialog({ lang }: { lang: Lang }) {
  const [code, setCode] = useState(() => normalizeLinkCode(initialCode()) || '');
  const [draft, setDraft] = useState(() => initialCode());
  const [info, setInfo] = useState<LinkPairingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [result, setResult] = useState<'linked' | 'denied' | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!code) return;
    let active = true;
    setBusy(true);
    setError(null);
    fetchLinkPairingInfo(code)
      .then(next => {
        if (!active) return;
        setInfo(next);
        // 读写会话默认勾上；批准非付费确认、直接调用工具要用户主动勾选。
        setScopes(next.requestedScopes.filter(scope => scope === 'agent.read' || scope === 'agent.run'));
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [code]);

  if (!open) return null;
  const close = () => { setOpen(false); leaveLinkPath(); };
  const decide = async (approve: boolean) => {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await decideLinkPairing(info.code, approve, approve ? scopes : []);
      setResult(outcome.approved ? 'linked' : 'denied');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="iris-link-title" data-testid="iris-link-dialog">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[var(--panel-bg,#1d1f24)] p-5 text-sm text-[var(--text-primary,#f3f4f6)] shadow-2xl">
        <h2 id="iris-link-title" className="mb-3 text-base font-semibold">{T.title[lang]}</h2>
        {result === 'linked' ? (
          <div data-testid="iris-link-linked">
            <p className="mb-1 font-medium">{T.linked[lang]} · {info?.clientName}</p>
            <p className="mb-4 opacity-75">{T.linkedBody[lang]}</p>
            <button type="button" className="rounded-lg bg-[var(--accent,#6d5efc)] px-4 py-2 font-medium text-white" onClick={close}>{T.done[lang]}</button>
          </div>
        ) : result === 'denied' ? (
          <div>
            <p className="mb-4 opacity-75">{T.denied[lang]}</p>
            <button type="button" className="rounded-lg border border-white/15 px-4 py-2" onClick={close}>{T.done[lang]}</button>
          </div>
        ) : !code ? (
          <form className="space-y-3" onSubmit={event => { event.preventDefault(); const next = normalizeLinkCode(draft); if (next) setCode(next); else setError(lang === 'en' ? 'The code has 8 characters, e.g. ABCD-2345.' : '配对码是 8 位，例如 ABCD-2345。'); }}>
            <label className="block">
              <span className="mb-1 block opacity-75">{T.enterCode[lang]}</span>
              <input data-testid="iris-link-code-input" autoFocus value={draft} onChange={event => setDraft(event.target.value)} placeholder="ABCD-2345" className="w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 font-mono text-lg tracking-widest" />
            </label>
            {error && <p className="text-red-400" role="alert">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-white/15 px-4 py-2" onClick={close}>{T.deny[lang]}</button>
              <button type="submit" className="rounded-lg bg-[var(--accent,#6d5efc)] px-4 py-2 font-medium text-white">{T.lookup[lang]}</button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            {busy && !info && <p className="opacity-60">…</p>}
            {info && (
              <>
                <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
                  <dt className="opacity-60">{T.client[lang]}</dt><dd data-testid="iris-link-client" className="font-medium">{info.clientName}<span className="block text-xs opacity-60">{info.clientAgent}</span></dd>
                  <dt className="opacity-60">{T.from[lang]}</dt><dd>{info.source.ip}{info.source.country ? ` · ${info.source.country}` : ''}{info.source.city ? ` · ${info.source.city}` : ''}</dd>
                  <dt className="opacity-60">{T.requested[lang]}</dt><dd>{new Date(info.requestedAt).toLocaleString()}</dd>
                  <dt className="opacity-60">{T.codeLabel[lang]}</dt><dd className="font-mono text-base tracking-widest" data-testid="iris-link-code">{info.code}</dd>
                </dl>
                <fieldset className="space-y-1.5 rounded-xl border border-white/10 p-3">
                  <legend className="px-1 opacity-60">{T.scopes[lang]}</legend>
                  {LINK_SCOPES.filter(scope => info.requestedScopes.includes(scope)).map(scope => (
                    <label key={scope} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        data-testid={'iris-link-scope-' + scope}
                        checked={scope === 'agent.read' || scopes.includes(scope)}
                        disabled={scope === 'agent.read'}
                        onChange={event => setScopes(current => event.target.checked ? [...new Set([...current, scope])] : current.filter(item => item !== scope))}
                      />
                      <span><code className="text-xs opacity-70">{scope}</code> {LINK_SCOPE_LABELS[scope as keyof typeof LINK_SCOPE_LABELS][lang]}</span>
                    </label>
                  ))}
                </fieldset>
                <p className="text-xs opacity-70">{T.keyNote[lang]}</p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" data-testid="iris-link-code-confirm" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
                  <span>{T.matches[lang]} <b className="font-mono">{info.code}</b></span>
                </label>
              </>
            )}
            {error && <p className="text-red-400" role="alert">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" data-testid="iris-link-deny" disabled={busy || !info} className="rounded-lg border border-white/15 px-4 py-2 disabled:opacity-40" onClick={() => void decide(false)}>{T.deny[lang]}</button>
              <button type="button" data-testid="iris-link-allow" disabled={busy || !info || !confirmed} className="rounded-lg bg-[var(--accent,#6d5efc)] px-4 py-2 font-medium text-white disabled:opacity-40" onClick={() => void decide(true)}>{T.allow[lang]}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalTray({ lang }: { lang: Lang }) {
  useSyncExternalStore(subscribeLinkTray, linkTrayVersion, linkTrayVersion);
  const pending = allLinkManagers().flatMap(manager => manager.pendingTrayApprovals());
  if (!pending.length) return null;
  return (
    <div className="pointer-events-auto w-80 space-y-2" data-testid="iris-link-approvals">
      {pending.map(({ run, approval }) => (
        <div key={approval.approvalId} className="rounded-xl border border-amber-400/40 bg-[var(--panel-bg,#1d1f24)] p-3 text-sm shadow-xl" data-testid="iris-link-approval" data-approval-id={approval.approvalId}>
          <p className="mb-1 text-xs font-semibold opacity-70">{T.approvalTitle[lang]}{run.clientName ? ` · ${run.clientName}` : ''}</p>
          <p className="mb-2 whitespace-pre-wrap break-words">{approval.summary || run.prompt}</p>
          <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
            {approval.paid && <span className="rounded bg-amber-500/20 px-1.5 py-0.5">{T.paid[lang]}</span>}
            {approval.destructive && <span className="rounded bg-red-500/20 px-1.5 py-0.5">{T.destructive[lang]}</span>}
            {approval.blocked && <span className="rounded bg-red-500/20 px-1.5 py-0.5">{T.blocked[lang]}</span>}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" data-testid="iris-link-approval-deny" className="rounded-lg border border-white/15 px-3 py-1" onClick={() => decideLinkApprovalFromPage(run.runId, approval.approvalId, false)}>{T.reject[lang]}</button>
            <button type="button" data-testid="iris-link-approval-approve" disabled={approval.blocked} className="rounded-lg bg-[var(--accent,#6d5efc)] px-3 py-1 text-white disabled:opacity-40" onClick={() => decideLinkApprovalFromPage(run.runId, approval.approvalId, true)}>{T.approve[lang]}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConnectionsPill({ lang }: { lang: Lang }) {
  const state = useWebLinkHostState();
  const [expanded, setExpanded] = useState(false);
  const online = useMemo(() => state.pairings.filter(item => item.status === 'online').length, [state.pairings]);
  if (!state.pairings.length) return null;
  return (
    <div className="pointer-events-auto text-xs" data-testid="iris-link-connections">
      <button type="button" className="rounded-full border border-white/15 bg-[var(--panel-bg,#1d1f24)] px-3 py-1 shadow" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
        <span className={online ? 'text-emerald-400' : 'opacity-60'}>●</span> {T.connections[lang]} · {state.pairings.length}
      </button>
      {expanded && (
        <ul className="mt-2 w-72 space-y-1 rounded-xl border border-white/10 bg-[var(--panel-bg,#1d1f24)] p-2 shadow-xl">
          {state.pairings.map(item => (
            <li key={item.roomId} className="flex items-center justify-between gap-2" data-testid="iris-link-connection">
              <span className="min-w-0 truncate">
                <b>{item.clientName}</b> <span className="opacity-60">{T.status[item.status][lang]}</span>
                <span className="block truncate opacity-50">{item.scopes.join(', ')}</span>
              </span>
              <button type="button" data-testid="iris-link-disconnect" className="shrink-0 rounded border border-white/15 px-2 py-0.5" onClick={() => void revokeLinkPairing(item.roomId)}>{T.disconnect[lang]}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IrisLinkOverlay() {
  const lang = useLang();
  // 网页端才需要中继；首次渲染前同步启动，让连接状态订阅从一开始就拿到宿主。
  useState(() => startWebLinkHost());
  const [pairing] = useState(isLinkPath);
  return (
    <>
      {pairing && <PairingDialog lang={lang} />}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[900] flex flex-col items-end gap-2">
        <ApprovalTray lang={lang} />
        <ConnectionsPill lang={lang} />
      </div>
    </>
  );
}
