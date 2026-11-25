// `iris login web` / `iris logout` / `iris link status` / `iris agent <…>` 的入口（cli.js 在最前面分流到这里）。
// 输出沿用 CLI 约定：stdout 每条结果一行 JSON（--pretty 缩进），进度走 stderr。
import { cliProgress, formatCliResponse } from '../cli-output.js';
import { parseCliArgs } from '../core.js';
import { LINK_DEFAULT_SCOPES, LINK_SCOPE_LABELS, normalizeLinkScopes } from './protocol.js';
import { deleteLink, linkFilePath, readLink, redactLink } from './link-store.js';
import { LinkClientError, pollPairing, saveLinkTokens, startPairing, WebLinkClient } from './web-link-client.js';
import { linkCommandFromArgv, LINK_CLI_COMMANDS, runAgentLinkCommand } from './agent-commands.js';
import { resolveLinkTransport } from './transports.js';

export { linkCommandFromArgv };

function errorJson(error) {
  if (error instanceof LinkClientError) return error.toJSON();
  return { code: error?.code || 'CLI_FATAL', message: error instanceof Error ? error.message : String(error), retryable: Boolean(error?.retryable) };
}

export async function runLinkCli(command, rest, io = {}) {
  const args = parseCliArgs(rest);
  const pretty = Boolean(args.pretty);
  const out = io.stdout || (line => console.log(line));
  const progress = io.progress || cliProgress;
  const print = payload => out(formatCliResponse(payload, { pretty }));
  const env = io.env || process.env;
  const storeOptions = io.storeOptions || {};
  let exitCode = 0;
  const respond = (ok, data, error, extra = {}) => {
    print({ ok, command, data: ok ? data : null, error: ok ? null : error, ...extra });
    if (!ok) exitCode = 1;
  };

  if (args.help || args.h) {
    respond(true, { command, ...LINK_CLI_COMMANDS[command] });
    return exitCode;
  }

  if (command === 'login.web') {
    try {
      const scopes = normalizeLinkScopes(args.scopes);
      const mode = args.device ? 'device' : 'open';
      const pairing = await startPairing({ baseUrl: args.url, clientName: typeof args.name === 'string' ? args.name : undefined, scopes: scopes.length ? scopes : [...LINK_DEFAULT_SCOPES], mode, fetchImpl: io.fetchImpl });
      const requested = scopes.length ? scopes : [...LINK_DEFAULT_SCOPES];
      progress(`配对码 ${pairing.code}（10 分钟内有效）`);
      progress(`申请的权限：${requested.map(scope => LINK_SCOPE_LABELS[scope]?.zho || scope).join('；')}`);
      if (mode === 'device') {
        progress(`在任意已打开 Iris 的浏览器里访问 ${pairing.verificationUrl}，输入配对码 ${pairing.code} 并确认。`);
      } else {
        progress(`正在打开 ${pairing.verificationUrlComplete} —— 在 Iris 页面上核对配对码后点「允许」。`);
        if (args.open !== false && args['no-open'] !== true) (io.openUrl || (await import('../skill-commands.js')).openUrlNative)(pairing.verificationUrlComplete);
      }
      // 机器可读的一行：沙箱 / 外部 Agent 可以把它转给用户。
      print({ ok: true, command, event: 'pairing', data: { code: pairing.code, verificationUrl: pairing.verificationUrl, verificationUrlComplete: pairing.verificationUrlComplete, expiresIn: pairing.expiresIn, mode } });
      let dots = 0;
      const tokens = await pollPairing(pairing, { fetchImpl: io.fetchImpl, intervalMs: io.pollIntervalMs, onPending: () => { if (++dots % 15 === 0) progress('仍在等待页面确认…'); } });
      const { record, file } = saveLinkTokens(pairing.baseUrl, tokens, storeOptions);
      progress(`已连接 ${pairing.baseUrl}；凭证保存在 ${file}（0600）。`);
      respond(true, { linked: true, file, ...redactLink(record) });
    } catch (error) {
      respond(false, null, errorJson(error));
    }
    return exitCode;
  }

  if (command === 'logout') {
    let record = null;
    try { record = readLink(storeOptions); } catch (error) { record = null; progress(String(error?.message || error)); }
    if (!record) {
      const removed = deleteLink(storeOptions);
      respond(true, { linked: false, serverRevoked: false, removedLocal: removed, file: storeOptions.file || linkFilePath(env) });
      return exitCode;
    }
    let serverRevoked = false;
    let serverError = null;
    try {
      await new WebLinkClient({ record, storeOptions, fetchImpl: io.fetchImpl }).revoke();
      serverRevoked = true;
    } catch (error) {
      serverError = errorJson(error);
    }
    const removed = deleteLink(storeOptions);
    // 服务端已经撤销（或令牌早已失效）才算干净；连不上中继时本地照删，但如实报告。
    const alreadyGone = serverError && ['UNAUTHORIZED', 'REVOKED'].includes(serverError.code);
    respond(serverRevoked || alreadyGone, { linked: false, serverRevoked: serverRevoked || Boolean(alreadyGone), removedLocal: removed, baseUrl: record.baseUrl }, serverError, serverError && !alreadyGone ? { warning: '本地凭证已删除，但中继没有确认撤销；连上网络后可在 Iris 页面的「CLI 连接」里断开。' } : {});
    return exitCode;
  }

  let transport = null;
  try {
    transport = io.transport || await resolveLinkTransport(args.target || 'auto', {
      env,
      web: { baseUrl: typeof args.url === 'string' ? args.url : undefined, storeOptions, fetchImpl: io.fetchImpl },
    });
    const data = await runAgentLinkCommand(command, args, { transport, print, progress });
    const ok = !(command === 'agent.e2e' && data && data.ok === false);
    respond(ok, data, ok ? null : { code: 'E2E_FAILED', message: `agent.e2e：${data.summary.passed}/${data.summary.total} 个场景通过，详见 ${data.files.markdown}` }, { target: transport.kind });
  } catch (error) {
    respond(false, null, errorJson(error), transport ? { target: transport.kind } : {});
  } finally {
    if (!io.transport) transport?.close();
  }
  return exitCode;
}
