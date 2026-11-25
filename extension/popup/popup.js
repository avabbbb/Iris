import { PAIRINGS_KEY, readPairings, removePairing, setPairingStatus } from '../background/web-pairings.js';

// 在线版 Iris 网页画布；按钮直接新开标签页（chrome.tabs.create 不需要 tabs 权限）。
export const IRIS_WEB_URL = 'https://iris.avabbbb.com/';
export const IRIS_GITHUB_URL = 'https://github.com/avabbbb/Iris';
// 「点个 Star」卡片：第一次成功导入 / 反推之后出现，关闭或点过即永久不再出现。
const STAR_DISMISSED_KEY = 'irisStarDismissed';
// 只拿每个画布的同步数量（不解密、不碰明文）；管理入口在插件设置页。
const VAULT_SUMMARY = 'IRIS_VAULT_SUMMARY';
const HISTORY_KEY = 'irisImportHistory';
// 插件内反推结果：只在 chrome.storage.session（浏览器关闭即清空）。
const REVERSE_RESULT_KEY = 'irisReversePrompt';

// 文案走 _locales（跟随浏览器语言）；取不到时用 HTML 里的中文兜底。
const t = (name, fallback = '') => chrome.i18n?.getMessage?.(name) || fallback;
const uiLocale = (chrome.i18n?.getUILanguage?.() || 'zh-CN');
document.documentElement.lang = uiLocale;
for (const node of document.querySelectorAll('[data-i18n]')) {
  node.textContent = t(node.dataset.i18n, node.textContent);
}
for (const node of document.querySelectorAll('[data-i18n-title]')) {
  const label = t(node.dataset.i18nTitle, node.dataset.i18nTitle);
  node.title = label;
  node.setAttribute('aria-label', label);
}

// lucide 线性图标（与主应用同一套，DESIGN §7），内联以免引入依赖。
const ICON_PATHS = {
  idle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  desktop: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  canvas: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  pending: '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
};

function icon(name, size = 14) {
  const span = document.createElement('span');
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
  return span.firstElementChild;
}

function setIcon(host, name, size) {
  host.textContent = '';
  host.appendChild(icon(name, size));
}

for (const node of document.querySelectorAll('[data-icon]')) {
  setIcon(node, node.dataset.icon, node.classList.contains('is-small') ? 12 : 14);
}

const statusIcon = document.getElementById('statusIcon');
const statusTitle = document.getElementById('statusTitle');
const statusMessage = document.getElementById('statusMessage');
const connectButton = document.getElementById('connectDesktop');
const desktopState = document.getElementById('desktopState');
const desktopGlyph = connectButton.parentElement.querySelector('.conn__glyph');
const receipt = document.getElementById('receipt');
const receiptName = document.getElementById('receiptName');
const receiptDestination = document.getElementById('receiptDestination');
const history = document.getElementById('history');
const historyList = document.getElementById('historyList');
const clearHistoryButton = document.getElementById('clearHistory');
const webPairingList = document.getElementById('webPairingList');
const emptyState = document.getElementById('empty');
const reverseSection = document.getElementById('reverse');
const reversePrompt = document.getElementById('reversePrompt');
const reverseMeta = document.getElementById('reverseMeta');
const copyReverseButton = document.getElementById('copyReverse');
const sendReverseButton = document.getElementById('sendReverse');

document.getElementById('extensionVersion').textContent = 'v' + chrome.runtime.getManifest().version;
document.getElementById('openIris').addEventListener('click', () => {
  void chrome.tabs.create({ url: IRIS_WEB_URL });
  window.close();
});
document.getElementById('openSettings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

const starCard = document.getElementById('star');
let starDismissed = true;
let hadSuccess = false;
function updateStar() {
  starCard.hidden = starDismissed || !hadSuccess;
}
async function dismissStar() {
  starDismissed = true;
  updateStar();
  await chrome.storage.local.set({ [STAR_DISMISSED_KEY]: true });
}
document.getElementById('starOpen').addEventListener('click', () => {
  void chrome.tabs.create({ url: IRIS_GITHUB_URL });
  void dismissStar();
});
document.getElementById('starClose').addEventListener('click', () => void dismissStar());

const STATE_ICON = { connected: 'check', imported: 'check', connecting: 'loader', importing: 'loader', error: 'error' };

function render(status) {
  const state = status?.state || 'idle';
  statusIcon.dataset.state = state;
  setIcon(statusIcon, STATE_ICON[state] || 'idle', 15);
  statusTitle.textContent = t('state_' + state, t('state_idle', '等待连接'));
  statusMessage.textContent = status?.message || t('idle_message');

  const desktopOn = state === 'connected';
  desktopState.textContent = desktopOn ? t('desktop_connected', '已连接') : t('desktop_idle', '未连接');
  desktopGlyph.classList.toggle('is-on', Boolean(desktopOn));
  connectButton.textContent = state === 'error' ? t('desktop_retry', '重试') : t('desktop_connect', '连接');

  const lastReceipt = status?.receipt;
  receipt.hidden = !lastReceipt;
  if (state === 'imported') {
    hadSuccess = true;
    updateStar();
  }
  if (lastReceipt) {
    receiptName.textContent = lastReceipt.name || t('untitled', '未命名媒体');
    receiptDestination.textContent = lastReceipt.destinationProjectId ? t('dest_workflow') : t('dest_inbox');
  }
  updateEmpty();
}

function formatTime(at) {
  try {
    return new Date(at).toLocaleTimeString(uiLocale, { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

function renderHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  history.hidden = list.length === 0;
  if (list.length) {
    hadSuccess = true;
    updateStar();
  }
  historyList.textContent = '';
  for (const entry of list) {
    const item = document.createElement('li');
    const name = String(entry.name || t('untitled', '未命名媒体'));
    const glyph = document.createElement('span');
    glyph.className = 'conn__glyph is-small';
    glyph.appendChild(icon(/\.(mp4|webm)$/i.test(name) ? 'video' : 'image', 12));
    const label = document.createElement('span');
    label.textContent = name;
    label.title = entry.destination ? `${name} · ${entry.destination}` : name;
    const when = document.createElement('small');
    when.textContent = formatTime(entry.at);
    item.append(glyph, label, when);
    historyList.appendChild(item);
  }
  updateEmpty();
}

function updateEmpty() {
  emptyState.hidden = !(history.hidden && receipt.hidden && reverseSection.hidden);
}

function chip(label, action, variant = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'isl-chip' + (variant ? ' isl-chip--' + variant : '');
  button.textContent = label;
  button.addEventListener('click', () => {
    button.disabled = true;
    action()
      .catch(error => render({ state: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(() => { button.disabled = false; });
  });
  return button;
}

function originLabel(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

let lastPairings = {};
let syncSummary = {};

// 已配对画布的同步摘要：数量 / 待回写 / 「退出时清除」。
function syncDetail(origin) {
  const info = syncSummary[origin];
  if (!info) return t('canvas_connected');
  if (info.syncDisabled) return t('canvas_sync_disabled', '已连接 · 退出时清除，不同步');
  const parts = [info.count ? t('canvas_synced', '已同步 $1 项', [String(info.count)]).replace('$1', String(info.count)) : t('canvas_connected')];
  if (info.pending) parts.push(t('canvas_pending_push', '$1 处待回写', [String(info.pending)]).replace('$1', String(info.pending)));
  return parts.join(' · ');
}

async function refreshSyncSummary() {
  try {
    const response = await chrome.runtime.sendMessage({ type: VAULT_SUMMARY });
    syncSummary = response?.ok && response.result && typeof response.result === 'object' ? response.result : {};
  } catch {
    syncSummary = {};
  }
  renderPairings(lastPairings);
}

// 网页画布配对：pending 显示允许/拒绝，approved 显示断开。拒绝与断开都会删除条目，网页可再次发起。
function renderPairings(pairings) {
  lastPairings = pairings && typeof pairings === 'object' ? pairings : {};
  const entries = Object.entries(pairings && typeof pairings === 'object' ? pairings : {});
  webPairingList.textContent = '';
  if (entries.length === 0) {
    webPairingList.appendChild(connRow('canvas', t('canvas_label', '网页画布'), t('canvas_none'), false));
    return;
  }
  // 待确认的请求排在前面，并用阳光色底提醒（DESIGN §4：警示 · 待确认）。
  entries.sort(([, a], [, b]) => Number(a?.status === 'approved') - Number(b?.status === 'approved'));
  for (const [origin, entry] of entries) {
    const approved = entry?.status === 'approved';
    const row = connRow(approved ? 'canvas' : 'pending', originLabel(origin), approved ? syncDetail(origin) : t('canvas_pending'), approved);
    row.title = origin;
    if (approved) row.classList.add('is-wrap');
    const actions = document.createElement('div');
    actions.className = 'conn__actions';
    if (approved) {
      actions.append(chip(t('disconnect', '断开'), () => removePairing(origin), 'danger'));
    } else {
      row.classList.add('is-pending');
      actions.append(
        chip(t('reject', '拒绝'), () => removePairing(origin), 'danger'),
        chip(t('allow', '允许'), () => setPairingStatus(origin, 'approved'), 'mint'),
      );
    }
    row.appendChild(actions);
    webPairingList.appendChild(row);
  }
}

function connRow(iconName, title, detail, on) {
  const row = document.createElement('li');
  row.className = 'conn__row';
  const glyph = document.createElement('span');
  glyph.className = 'conn__glyph' + (on ? ' is-on' : '');
  glyph.appendChild(icon(iconName));
  const text = document.createElement('div');
  text.className = 'conn__text';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  text.append(strong, small);
  row.append(glyph, text);
  return row;
}

function renderReverse(result) {
  reverseSection.hidden = !result?.prompt;
  if (result?.prompt) {
    hadSuccess = true;
    updateStar();
    reversePrompt.textContent = result.prompt;
    reverseMeta.textContent = [result.provider, result.model].filter(Boolean).join(' · ');
    copyReverseButton.textContent = t('copy', '复制');
    sendReverseButton.textContent = t('send_to_canvas', '送进画布');
  }
  updateEmpty();
}

chrome.storage.local.get(['irisBridgeStatus', HISTORY_KEY, STAR_DISMISSED_KEY]).then(result => {
  starDismissed = result[STAR_DISMISSED_KEY] === true;
  render(result.irisBridgeStatus);
  renderHistory(result[HISTORY_KEY]);
  updateStar();
});
readPairings().then(renderPairings).then(refreshSyncSummary);
chrome.storage.session.get(REVERSE_RESULT_KEY).then(stored => renderReverse(stored[REVERSE_RESULT_KEY]));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.irisBridgeStatus) render(changes.irisBridgeStatus.newValue);
    if (changes[HISTORY_KEY]) renderHistory(changes[HISTORY_KEY].newValue);
    if (changes[PAIRINGS_KEY]) renderPairings(changes[PAIRINGS_KEY].newValue);
    if (changes.irisWebKeys || changes[PAIRINGS_KEY]) void refreshSyncSummary();
  }
  if (area === 'session' && changes[REVERSE_RESULT_KEY]) renderReverse(changes[REVERSE_RESULT_KEY].newValue);
});

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'IRIS_DESKTOP_CONNECT' });
    if (!response?.ok) throw new Error(response?.error || t('connect_failed', '连接失败'));
  } catch (error) {
    render({ state: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    connectButton.disabled = false;
  }
});

clearHistoryButton.addEventListener('click', async () => {
  await chrome.storage.local.remove(HISTORY_KEY);
  renderHistory([]);
});

copyReverseButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(reversePrompt.textContent || '');
  copyReverseButton.textContent = t('copied', '已复制');
});

sendReverseButton.addEventListener('click', async () => {
  sendReverseButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'IRIS_REVERSE_TO_CANVAS' });
    sendReverseButton.textContent = response?.ok ? t('sent', '已送进画布') : t('send_failed', '发送失败');
    if (!response?.ok) reverseMeta.textContent = response?.error || t('send_failed', '发送失败');
  } finally {
    sendReverseButton.disabled = false;
  }
});
