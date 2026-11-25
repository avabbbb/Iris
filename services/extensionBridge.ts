// 网页画布 ↔ Iris 浏览器插件通道（externally_connectable + 长连接 Port）。
// 插件侧见 extension/background/web-bridge.js。只有用户在插件 popup 里批准后，双方才收发业务消息。

export type ExtensionBridgeStatus =
  | 'unconfigured'
  | 'not-installed'
  | 'idle'
  | 'connecting'
  | 'none'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'disconnected'
  | 'unsupported';

export interface ExtensionBridgeState {
  status: ExtensionBridgeStatus;
  extensionId: string | null;
  extensionVersion: string | null;
  capabilities: string[];
}

export interface ExtensionBridgeMessage {
  type?: unknown;
  id?: unknown;
  replyTo?: unknown;
  ok?: unknown;
  error?: unknown;
  result?: unknown;
  status?: unknown;
  extensionVersion?: unknown;
  capabilities?: unknown;
  [key: string]: unknown;
}

export interface ChromePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: ExtensionBridgeMessage) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export interface ChromeRuntimeLike {
  connect(extensionId: string, connectInfo: { name: string }): ChromePortLike;
}

export type ExtensionRequestHandler = (message: ExtensionBridgeMessage) => unknown;

export interface ExtensionBridge {
  getState(): ExtensionBridgeState;
  subscribe(listener: (state: ExtensionBridgeState) => void): () => void;
  connect(options?: { requestPairing?: boolean }): Promise<ExtensionBridgeState>;
  disconnect(): void;
  request<T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onRequest(type: string, handler: ExtensionRequestHandler): () => void;
  /** 已批准且插件声明了该能力时为 true。 */
  supports(capability: string): boolean;
  /** 向已批准的插件开一条独立的长连接 Port（例如每个直连请求一条）；未批准时返回 null。 */
  openChannel(name: string): ChromePortLike | null;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cancel(): void;
}

export const EXTENSION_PORT_NAME = 'iris-web';
export const EXTENSION_PROTOCOL_VERSION = '1';
const HELLO_STATUSES: Record<string, ExtensionBridgeStatus> = {
  none: 'none',
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  revoked: 'revoked',
  unsupported: 'unsupported',
};
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

// 旁加载（加载解压缩的扩展）固定 ID：由 extension/manifest.json 的 key 字段决定，
// 任何机器、任何目录加载 dist-extension 都是这个 ID。商店 ID 另经 VITE_IRIS_EXTENSION_IDS 追加。
export const IRIS_SIDELOAD_EXTENSION_ID = 'gjfggdmfhdlklpimckjgeolgfoanfaka';

function helloStatus(value: unknown): ExtensionBridgeStatus {
  return typeof value === 'string' && Object.hasOwn(HELLO_STATUSES, value) ? HELLO_STATUSES[value] : 'unsupported';
}

// 解析逗号分隔的扩展 ID；Chrome/Edge 扩展 ID 固定为 32 位 a-p。商店 ID 与本地旁加载 ID 可同时配置。
export function parseExtensionIds(value: string | undefined | null): string[] {
  const ids = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => EXTENSION_ID_PATTERN.test(item));
  return [...new Set(ids)];
}

export function createExtensionBridge(options: {
  runtime: ChromeRuntimeLike | null;
  extensionIds: string[];
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
}): ExtensionBridge {
  const listeners = new Set<(state: ExtensionBridgeState) => void>();
  const handlers = new Map<string, ExtensionRequestHandler>();
  const pending = new Map<string, PendingRequest>();
  let port: ChromePortLike | null = null;
  let state: ExtensionBridgeState = {
    status: !options.extensionIds.length ? 'unconfigured' : options.runtime ? 'idle' : 'not-installed',
    extensionId: null,
    extensionVersion: null,
    capabilities: [],
  };

  const setState = (patch: Partial<ExtensionBridgeState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const rejectPending = (reason: string) => {
    for (const entry of pending.values()) {
      entry.cancel();
      entry.reject(new Error(reason));
    }
    pending.clear();
  };

  const applyHello = (message: ExtensionBridgeMessage) => {
    setState({
      status: helloStatus(message.status),
      extensionVersion: typeof message.extensionVersion === 'string' ? message.extensionVersion : null,
      capabilities: Array.isArray(message.capabilities)
        ? message.capabilities.filter((item): item is string => typeof item === 'string')
        : [],
    });
  };

  const respond = async (current: ChromePortLike, message: ExtensionBridgeMessage, id: string, type: string) => {
    let reply: { ok: boolean; result?: unknown; error?: string };
    const handler = handlers.get(type);
    if (state.status !== 'approved') {
      reply = { ok: false, error: '画布尚未与插件配对' };
    } else if (!handler) {
      reply = { ok: false, error: '画布不支持消息：' + type };
    } else {
      try {
        reply = { ok: true, result: await handler(message) };
      } catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      current.postMessage({ replyTo: id, ...reply });
    } catch {
      // 插件已断开，回复无处可去。
    }
  };

  const handleMessage = (current: ChromePortLike, message: ExtensionBridgeMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello.result') {
      applyHello(message);
      return;
    }
    if (typeof message.replyTo === 'string') {
      const entry = pending.get(message.replyTo);
      if (!entry) return;
      pending.delete(message.replyTo);
      entry.cancel();
      if (message.ok === false) entry.reject(new Error(String(message.error || '插件返回错误')));
      else entry.resolve(message.result);
      return;
    }
    const { id, type } = message;
    if (typeof id === 'string' && typeof type === 'string') void respond(current, message, id, type);
  };

  const tryConnect = (runtime: ChromeRuntimeLike, extensionId: string, requestPairing: boolean): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    let candidate: ChromePortLike | null = null;
    const timer = setTimeout(() => {
      candidate?.disconnect();
      finish(false);
    }, options.helloTimeoutMs ?? 3000);
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(connected);
    };
    try {
      candidate = runtime.connect(extensionId, { name: EXTENSION_PORT_NAME });
    } catch {
      finish(false);
      return promise;
    }
    const current = candidate;
    current.onDisconnect.addListener(() => {
      if (port === current) {
        port = null;
        rejectPending('插件连接已断开');
        // 拒绝/撤销由插件主动断开，保留该状态给 UI；其余情况视为连接丢失。
        if (state.status !== 'rejected' && state.status !== 'revoked') setState({ status: 'disconnected' });
      }
      finish(false);
    });
    current.onMessage.addListener(message => {
      if (!settled && message?.type === 'hello.result') {
        port = current;
        setState({ extensionId });
        finish(true);
      }
      if (port === current) handleMessage(current, message);
    });
    current.postMessage({ type: 'hello', protocolVersion: EXTENSION_PROTOCOL_VERSION, requestPairing });
    return promise;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async connect({ requestPairing = false } = {}) {
      if (!options.extensionIds.length) {
        setState({ status: 'unconfigured' });
        return state;
      }
      const runtime = options.runtime;
      if (!runtime) {
        setState({ status: 'not-installed' });
        return state;
      }
      if (port) {
        if (requestPairing && state.status !== 'approved' && state.status !== 'pending') {
          port.postMessage({ type: 'hello', protocolVersion: EXTENSION_PROTOCOL_VERSION, requestPairing: true });
        }
        return state;
      }
      setState({ status: 'connecting' });
      for (const extensionId of options.extensionIds) {
        if (await tryConnect(runtime, extensionId, requestPairing)) return state;
      }
      setState({ status: 'not-installed', extensionId: null, extensionVersion: null, capabilities: [] });
      return state;
    },
    disconnect() {
      const current = port;
      port = null;
      rejectPending('画布已断开插件连接');
      current?.disconnect();
      setState({ status: 'idle', extensionId: null, extensionVersion: null, capabilities: [] });
    },
    request<T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs = options.requestTimeoutMs ?? 15_000): Promise<T> {
      const current = port;
      if (!current || state.status !== 'approved') return Promise.reject(new Error('插件未连接或尚未批准此画布'));
      const id = crypto.randomUUID();
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('插件响应超时'));
      }, timeoutMs);
      // 插件回包是未经校验的 JSON，调用方用 T 声明期望形状并自行校验。
      pending.set(id, { resolve: value => resolve(value as T), reject, cancel: () => clearTimeout(timer) });
      try {
        current.postMessage({ ...payload, type, id });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return promise;
    },
    supports(capability) {
      return state.status === 'approved' && Boolean(state.extensionId) && state.capabilities.includes(capability);
    },
    openChannel(name) {
      const runtime = options.runtime;
      if (!runtime || state.status !== 'approved' || !state.extensionId) return null;
      try {
        return runtime.connect(state.extensionId, { name });
      } catch {
        return null;
      }
    },
    onRequest(type, handler) {
      handlers.set(type, handler);
      return () => {
        if (handlers.get(type) === handler) handlers.delete(type);
      };
    },
  };
}

function browserRuntime(): ChromeRuntimeLike | null {
  const chromeApi: unknown = Reflect.get(globalThis, 'chrome');
  if (!chromeApi || typeof chromeApi !== 'object' || !('runtime' in chromeApi)) return null;
  const runtime = chromeApi.runtime;
  if (!runtime || typeof runtime !== 'object' || !('connect' in runtime) || typeof runtime.connect !== 'function') return null;
  // connect 的签名由浏览器保证，运行时只能做存在性检查。
  const chromeRuntime = runtime as ChromeRuntimeLike;
  return chromeRuntime;
}

let sharedBridge: ExtensionBridge | null = null;

// 页面级单例。chrome.runtime.connect 只在某个扩展的 externally_connectable 匹配本页时才存在。
export function getExtensionBridge(): ExtensionBridge {
  if (!sharedBridge) {
    sharedBridge = createExtensionBridge({
      runtime: browserRuntime(),
      extensionIds: parseExtensionIds([
        import.meta.env.VITE_IRIS_EXTENSION_IDS || import.meta.env.VITE_FLOVART_EXTENSION_IDS,
        IRIS_SIDELOAD_EXTENSION_ID,
      ].filter(Boolean).join(',')),
    });
  }
  return sharedBridge;
}
