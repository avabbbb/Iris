import { exactOptionalOrigin } from './import-protocol.js';
import { transferMedia } from './media-transfer.js';
import { NativeSession, nativeResult } from './native-client.js';
import { ensureRenamedExtensionStorage, purgeLegacyExtensionStorage } from './storage-migration.js';
import { approvedWebPort, approvedWebPortFor, onWebMessage, requestWeb, startWebBridge } from './web-bridge.js';
import { createWebKeyStore, registerWebKeyHandlers } from './web-keys.js';
import { reversePromptFromMedia } from './reverse-prompt.js';

const MENU_IMPORT = 'iris-import-image';
const MENU_IMPORT_VIDEO = 'iris-import-video';
const MENU_OPEN = 'iris-open-desktop';
const MENU_WEB_IMPORT = 'iris-web-import-image';
const MENU_WEB_IMPORT_VIDEO = 'iris-web-import-video';
const MENU_REVERSE_PROMPT = 'iris-reverse-prompt';
// 反推结果只放 session 存储：浏览器关闭即清空，不落盘。
const REVERSE_RESULT_KEY = 'irisReversePrompt';
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const SUPPORTED_VIDEO_MIME = new Set(['video/mp4', 'video/webm']);
const BRIDGE_CAPABILITIES = ['browser.import.image', 'browser.import.video'];

void ensureRenamedExtensionStorage(globalThis.chrome?.storage?.local);
startWebBridge();
// 网页画布 ⇄ 插件双向同步的 BYOK 密钥；反推等插件内能力从这里读取，插件设置页的编辑经同一 Port 回写画布。
const webKeyStore = createWebKeyStore();
void registerWebKeyHandlers(onWebMessage, webKeyStore, globalThis.chrome, {
  portFor: approvedWebPortFor,
  request: (port, message) => requestWeb(port, message),
});

// 右键菜单文案跟随浏览器语言（_locales），取不到时回落中文。
function menuTitle(name, fallback) {
  return chrome.i18n?.getMessage?.(name) || fallback;
}

chrome.runtime.onInstalled.addListener(() => {
  void purgeLegacyExtensionStorage().catch(error => {
    console.error('[Iris Browser Import] 清理旧扩展数据失败', error);
  });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IMPORT,
      title: menuTitle('menu_import_image', '添加图片到 Iris Desktop'),
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_IMPORT_VIDEO,
      title: menuTitle('menu_import_video', '添加视频到 Iris Desktop'),
      contexts: ['video'],
    });
    chrome.contextMenus.create({
      id: MENU_WEB_IMPORT,
      title: menuTitle('menu_web_image', '发送图片到 Iris 画布'),
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_WEB_IMPORT_VIDEO,
      title: menuTitle('menu_web_video', '发送视频到 Iris 画布'),
      contexts: ['video'],
    });
    chrome.contextMenus.create({
      id: MENU_REVERSE_PROMPT,
      title: menuTitle('menu_reverse', '反推图片提示词'),
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_OPEN,
      title: menuTitle('menu_open_desktop', '连接 / 打开 Iris Desktop'),
      contexts: ['page', 'image', 'video', 'selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_IMPORT) void importSelectedMedia(info, tab, 'image');
  if (info.menuItemId === MENU_IMPORT_VIDEO) void importSelectedMedia(info, tab, 'video');
  if (info.menuItemId === MENU_WEB_IMPORT) void importSelectedMedia(info, tab, 'image', 'web');
  if (info.menuItemId === MENU_WEB_IMPORT_VIDEO) void importSelectedMedia(info, tab, 'video', 'web');
  if (info.menuItemId === MENU_REVERSE_PROMPT) void reverseSelectedImage(info, tab);
  if (info.menuItemId === MENU_OPEN) {
    connectDesktop().catch(error => console.error('[Iris Browser Import] 连接 Desktop 失败', error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'IRIS_REVERSE_TO_CANVAS') {
    sendReverseResultToCanvas()
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }
  if (message?.type !== 'IRIS_DESKTOP_CONNECT') return undefined;
  connectDesktop()
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

async function connectDesktop() {
  await setBridgeStatus('connecting', '正在连接 Iris Desktop…');
  let session;
  try {
    session = new NativeSession();
    const pairing = nativeResult(await requestPairing(session, ['browser.import.image']));
    if (pairing.status === 'rejected') throw new Error('Desktop 已拒绝此扩展连接');
    await setBridgeStatus('connected', 'Iris Desktop 已连接');
    return pairing;
  } catch (error) {
    await setBridgeStatus('error', userFacingError(error));
    throw error;
  } finally {
    session?.disconnect();
  }
}

/**
 * bridge.hello may wait up to 35s for the user to approve pairing in Desktop,
 * which outlives the MV3 service-worker idle window. Pinging the native port
 * every 20s keeps port traffic flowing so the service worker is not retired
 * mid-wait.
 */
function requestPairing(session, capabilities) {
  const keepalive = setInterval(() => session.keepalive(), 20_000);
  return session.request({
    type: 'bridge.hello',
    protocolVersion: '1',
    capabilities,
  }, 35_000).finally(() => clearInterval(keepalive));
}

async function importSelectedMedia(info, tab, kind, target = 'desktop') {
  if (!info.srcUrl) return;
  // Start the exact-origin permission request synchronously from the context-menu
  // gesture; the gesture may no longer be valid after Desktop pairing completes.
  const mediaPromise = readSelectedMedia(info.srcUrl, info.pageUrl, tab?.id, kind);
  await setBridgeStatus('importing', '正在读取所选媒体…');
  let session;
  try {
    const media = await mediaPromise;
    let send;
    if (target === 'web') {
      const port = approvedWebPort();
      if (!port) throw new Error('没有已配对且打开的网页画布：请在画布设置里申请配对，并在插件弹窗中批准');
      send = (message, timeoutMs) => requestWeb(port, message, timeoutMs);
    } else {
      session = new NativeSession();
      const pairing = nativeResult(await requestPairing(session, BRIDGE_CAPABILITIES));
      if (pairing.status === 'rejected') throw new Error('Desktop 已拒绝此扩展连接');
      const desktop = session;
      send = async (message, timeoutMs) => nativeResult(await desktop.request(message, timeoutMs));
    }

    const receipt = await transferMedia(
      send,
      media,
      { kind, sourceUrl: info.srcUrl, pageUrl: info.pageUrl || tab?.url || '', title: tab?.title },
      (percent, sent, total) => setBridgeStatus('importing', '正在传输 ' + percent + '%（' + formatBytes(sent) + ' / ' + formatBytes(total) + '）'),
    );
    const destination = target === 'web'
      ? '网页画布'
      : receipt?.destinationProjectId ? '活动 Workflow' : '浏览器导入箱';
    await appendImportHistory(media.name, destination);
    await setBridgeStatus('imported', '已发送到' + destination, receipt);
  } catch (error) {
    console.error('[Iris Browser Import]', error);
    await setBridgeStatus('error', userFacingError(error));
  } finally {
    session?.disconnect();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function userFacingError(error) {
  const text = errorMessage(error);
  if (/拒绝|rejected/i.test(text)) {
    return `${text}。请在 Iris Desktop 的首次连接弹窗中点击“允许”。`;
  }
  if (/Native Host|Host 已断开|响应超时|No such native messenger|未找到|无法连接/i.test(text)) {
    return `${text}。请先启动 Iris Desktop（首次会自动注册 Native Host），或手动执行 extension/register-native-host.ps1。`;
  }
  return text;
}

const HISTORY_KEY = 'irisImportHistory';
const HISTORY_LIMIT = 5;
// 导入历史写入串行化：读-改-写之间不再被并发导入穿插覆盖。
let importHistoryWrite = Promise.resolve();

async function appendImportHistory(name, destination) {
  const write = importHistoryWrite.then(async () => {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const existing = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    const next = [{ name, destination, at: Date.now() }, ...existing].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
  });
  importHistoryWrite = write.catch(() => {});
  await write;
}

export { HISTORY_KEY, HISTORY_LIMIT };

async function readSelectedMedia(sourceUrl, pageUrl, tabId, kind) {
  if (sourceUrl.startsWith('blob:')) {
    if (!tabId) throw new Error('无法从当前页面读取 Blob 媒体');
    return readBlobMediaFromTab(tabId, sourceUrl, kind);
  }

  const optionalOrigin = exactOptionalOrigin(sourceUrl, pageUrl || '');
  let temporaryPermission = false;
  try {
    if (optionalOrigin) {
      temporaryPermission = await chrome.permissions.request({ origins: [optionalOrigin] });
      if (!temporaryPermission) throw new Error('未授予所选媒体来源的临时读取权限');
    }
    const response = await fetch(sourceUrl, { cache: 'no-store', credentials: 'include' });
    if (!response.ok) throw new Error(`读取媒体失败（HTTP ${response.status}）`);
    return inspectMedia(await response.blob(), sourceUrl, kind);
  } finally {
    if (temporaryPermission && optionalOrigin) {
      await chrome.permissions.remove({ origins: [optionalOrigin] }).catch(() => false);
    }
  }
}

async function readBlobMediaFromTab(tabId, sourceUrl, kind) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [sourceUrl, MAX_IMPORT_BYTES],
    func: async (url, maximum) => {
      const response = await fetch(url);
      const blob = await response.blob();
      if (blob.size > maximum) throw new Error('媒体超过 64 MB 限制');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
      }
      return { dataBase64: btoa(binary), mimeType: blob.type };
    },
  });
  if (!result?.result?.dataBase64) throw new Error('页面没有返回 Blob 媒体字节');
  const binary = atob(result.result.dataBase64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return inspectMedia(new Blob([bytes], { type: result.result.mimeType }), sourceUrl, kind);
}

async function inspectMedia(blob, sourceUrl, kind) {
  if (!blob.size || blob.size > MAX_IMPORT_BYTES) throw new Error('媒体大小必须在 1 B 到 64 MB 之间');
  const supported = kind === 'video' ? SUPPORTED_VIDEO_MIME : SUPPORTED_IMAGE_MIME;
  const mimeType = normalizedMediaMime(blob.type, sourceUrl, kind);
  if (!supported.has(mimeType)) throw new Error(`暂不支持此媒体格式：${blob.type || 'unknown'}`);
  let width = null;
  let height = null;
  if (kind === 'image') {
    try {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      // Desktop still validates bytes/hash; dimensions are optional metadata.
    }
  }
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    name: mediaName(sourceUrl, mimeType, kind),
    width,
    height,
  };
}

function normalizedMediaMime(value, sourceUrl, kind) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  const supported = kind === 'video' ? SUPPORTED_VIDEO_MIME : SUPPORTED_IMAGE_MIME;
  if (supported.has(mime)) return mime;
  const path = (() => { try { return new URL(sourceUrl).pathname.toLowerCase(); } catch { return ''; } })();
  if (kind === 'video') {
    if (/\.mp4$/.test(path)) return 'video/mp4';
    if (/\.webm$/.test(path)) return 'video/webm';
    return mime;
  }
  if (/\.jpe?g$/.test(path)) return 'image/jpeg';
  if (/\.webp$/.test(path)) return 'image/webp';
  if (/\.gif$/.test(path)) return 'image/gif';
  if (/\.avif$/.test(path)) return 'image/avif';
  if (/\.png$/.test(path) || sourceUrl.startsWith('data:image/png')) return 'image/png';
  return mime;
}

function mediaName(sourceUrl, mimeType, kind) {
  const extension = kind === 'video'
    ? { 'video/mp4': 'mp4', 'video/webm': 'webm' }[mimeType] || 'mp4'
    : {
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/avif': 'avif',
      }[mimeType] || 'png';
  const fallback = kind === 'video' ? 'browser-video' : 'browser-image';
  if (!sourceUrl.startsWith('http:') && !sourceUrl.startsWith('https:')) {
    return `${fallback}.${extension}`;
  }
  try {
    const segment = decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() || '');
    const safe = segment.replace(/[\\/:*?"<>|]/g, '-').slice(0, 160);
    if (safe && safe.includes('.')) return safe;
  } catch {
    // data/blob URL
  }
  return `${fallback}.${extension}`;
}

async function setBridgeStatus(state, message, receipt = null) {
  const status = { state, message, receipt, updatedAt: Date.now() };
  await chrome.storage.local.set({ irisBridgeStatus: status });
  const badge = state === 'importing' || state === 'connecting' ? '…' : state === 'error' ? '!' : state === 'imported' ? '✓' : '';
  await chrome.action.setBadgeText({ text: badge });
  if (badge) await chrome.action.setBadgeBackgroundColor({ color: state === 'error' ? '#e8615a' : '#12a89b' });
  return status;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

// 插件内反推：读取所选图片（复用导入的临时权限与格式校验），用网页画布同步的 Key 请求模型。
async function reverseSelectedImage(info, tab) {
  if (!info.srcUrl) return;
  // 与导入相同：权限请求必须在右键手势内同步发起。
  const mediaPromise = readSelectedMedia(info.srcUrl, info.pageUrl, tab?.id, 'image');
  await setBridgeStatus('importing', '正在读取图片并反推提示词…');
  try {
    const media = await mediaPromise;
    const keys = await webKeyStore.allKeys();
    const lang = chrome.i18n.getUILanguage().startsWith('zh') ? 'zho' : 'en';
    const result = await reversePromptFromMedia(media, keys, { lang });
    await chrome.storage.session.set({
      [REVERSE_RESULT_KEY]: { ...result, sourceUrl: info.srcUrl, pageUrl: info.pageUrl || tab?.url || '', at: Date.now() },
    });
    await setBridgeStatus('imported', '反推完成：在插件弹窗中查看、复制或发送到网页画布');
  } catch (error) {
    console.error('[Iris Reverse Prompt]', error);
    await setBridgeStatus('error', userFacingError(error));
  }
}

async function sendReverseResultToCanvas() {
  const stored = await chrome.storage.session.get(REVERSE_RESULT_KEY);
  const result = stored[REVERSE_RESULT_KEY];
  if (!result?.prompt) throw new Error('没有可发送的反推结果');
  const port = approvedWebPort();
  if (!port) throw new Error('没有已配对且打开的网页画布：请在画布设置里申请配对，并在插件弹窗中批准');
  return requestWeb(port, { type: 'prompt.insert', text: result.prompt, sourceUrl: result.sourceUrl, model: result.model }, 15000);
}
