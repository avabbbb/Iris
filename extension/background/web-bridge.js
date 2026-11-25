// 网页画布 ↔ 插件通道（externally_connectable + 长连接 Port）。
// 只接受 web-origins.js 白名单里的精确 origin；未经 popup 批准的连接只能发起配对，不能收发业务消息。
import { isAllowedWebOrigin } from './web-origins.js';
import { PAIRINGS_KEY, pairingTransition, readPairings, setPairingStatus } from './web-pairings.js';
import { DIRECT_FETCH_CAPABILITY, DIRECT_FETCH_PORT_NAME, createDirectFetchHandler } from './direct-fetch.js';

export const WEB_PORT_NAME = 'iris-web';
export const WEB_PROTOCOL_VERSION = '1';
// keys.sync.edit（1.7 起）：插件内编辑的 Key 会经 keys.ext.changes 回写到画布 Vault。
const WEB_CAPABILITIES = ['browser.import.image', 'browser.import.video', 'keys.sync', 'keys.sync.edit', DIRECT_FETCH_CAPABILITY];
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// origin → 该 origin 下所有打开的 Port
const portsByOrigin = new Map();
// 已批准的 origin，随 hello 与存储变化更新
const approvedOrigins = new Set();
// requestId → { resolve, reject, timer, port }
const pendingRequests = new Map();
// 业务消息处理器：type → async (message, context) => result
const handlers = new Map();

export function onWebMessage(type, handler) {
  handlers.set(type, handler);
}

function helloResult(status) {
  return {
    type: 'hello.result',
    status,
    protocolVersion: WEB_PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    capabilities: status === 'approved' ? WEB_CAPABILITIES : [],
  };
}

function forgetPort(origin, port) {
  const ports = portsByOrigin.get(origin);
  if (!ports) return;
  ports.delete(port);
  if (!ports.size) portsByOrigin.delete(origin);
  for (const [id, pending] of pendingRequests) {
    if (pending.port !== port) continue;
    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.reject(new Error('网页画布已断开'));
  }
}

function closeOrigin(origin, status) {
  const ports = portsByOrigin.get(origin);
  if (!ports) return;
  for (const port of [...ports]) {
    try {
      port.postMessage(helloResult(status));
    } catch {
      // port already gone
    }
    forgetPort(origin, port);
    port.disconnect();
  }
}

// 直连上游：每个请求一个 Port；配对状态每次从存储读取（service worker 重启后内存为空）。
export async function isApprovedWebOrigin(origin, storage) {
  if (!isAllowedWebOrigin(origin)) return false;
  return (await readPairings(storage))[origin]?.status === 'approved';
}

const handleDirectFetchPort = createDirectFetchHandler({ isApprovedOrigin: origin => isApprovedWebOrigin(origin) });

export function startWebBridge() {
  chrome.runtime.onConnectExternal.addListener(port => {
    const origin = port.sender?.origin;
    if (port.name === DIRECT_FETCH_PORT_NAME) {
      if (!isAllowedWebOrigin(origin)) {
        port.disconnect();
        return;
      }
      handleDirectFetchPort(port);
      return;
    }
    if (port.name !== WEB_PORT_NAME || !isAllowedWebOrigin(origin)) {
      port.disconnect();
      return;
    }
    let ports = portsByOrigin.get(origin);
    if (!ports) {
      ports = new Set();
      portsByOrigin.set(origin, ports);
    }
    ports.add(port);
    port.onDisconnect.addListener(() => forgetPort(origin, port));
    port.onMessage.addListener(message => {
      void handleWebMessage(port, origin, message).catch(error => {
        console.error('[Iris Web Bridge]', error);
      });
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[PAIRINGS_KEY]) return;
    const before = changes[PAIRINGS_KEY].oldValue || {};
    const after = changes[PAIRINGS_KEY].newValue || {};
    for (const origin of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const oldStatus = before[origin]?.status;
      const newStatus = after[origin]?.status;
      if (oldStatus === newStatus) continue;
      const result = pairingTransition(oldStatus, newStatus);
      if (result === 'approved') {
        approvedOrigins.add(origin);
        for (const port of portsByOrigin.get(origin) || []) port.postMessage(helloResult('approved'));
      } else if (result !== 'pending') {
        approvedOrigins.delete(origin);
        closeOrigin(origin, result);
      }
    }
  });
}

async function handleWebMessage(port, origin, message) {
  if (!message || typeof message !== 'object') return;

  if (typeof message.replyTo === 'string') {
    const pending = pendingRequests.get(message.replyTo);
    if (!pending || pending.port !== port) return;
    pendingRequests.delete(message.replyTo);
    clearTimeout(pending.timer);
    if (message.ok === false) pending.reject(new Error(String(message.error || '网页画布返回错误')));
    else pending.resolve(message.result);
    return;
  }

  if (message.type === 'hello') {
    if (message.protocolVersion !== WEB_PROTOCOL_VERSION) {
      port.postMessage(helloResult('unsupported'));
      return;
    }
    const status = (await readPairings())[origin]?.status;
    if (status === 'approved') {
      approvedOrigins.add(origin);
      port.postMessage(helloResult('approved'));
      return;
    }
    if (message.requestPairing === true) {
      if (status !== 'pending') await setPairingStatus(origin, 'pending');
      port.postMessage(helloResult('pending'));
      return;
    }
    port.postMessage(helloResult(status === 'pending' ? 'pending' : 'none'));
    return;
  }

  if (typeof message.id !== 'string' || typeof message.type !== 'string') return;
  const reply = payload => {
    try {
      port.postMessage({ replyTo: message.id, ...payload });
    } catch {
      // port already gone
    }
  };
  if (!approvedOrigins.has(origin)) {
    reply({ ok: false, error: '插件尚未批准此画布连接' });
    return;
  }
  const handler = handlers.get(message.type);
  if (!handler) {
    reply({ ok: false, error: '插件不支持消息：' + message.type });
    return;
  }
  try {
    reply({ ok: true, result: await handler(message, { origin, port }) });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// 返回一个已批准、仍在线的网页画布 Port；没有则为 null。
export function approvedWebPort() {
  for (const origin of approvedOrigins) {
    const ports = portsByOrigin.get(origin);
    if (ports?.size) return [...ports].at(-1);
  }
  return null;
}

// 指定 origin 的已批准在线 Port（插件内编辑的 Key 只回写到它所属的那个画布）。
export function approvedWebPortFor(origin) {
  if (!approvedOrigins.has(origin)) return null;
  const ports = portsByOrigin.get(origin);
  return ports?.size ? [...ports].at(-1) : null;
}

// 向网页画布发请求并等待 { replyTo } 响应。
export function requestWeb(port, message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('网页画布响应超时'));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer, port });
    try {
      port.postMessage({ ...message, id });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    }
  });
}
