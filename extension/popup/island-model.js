// 「状态岛」的纯逻辑：把 service worker 写进 chrome.storage.local 的 irisBridgeStatus
// （{ state, message, receipt, updatedAt }）映射成岛的形态、步骤行与两段进度。
// 不新增后端状态：worker 只有 idle / connecting / connected / importing / imported / error 六种 state，
// 进度只能从它已经写出的 message 读（「正在读取所选媒体…」「正在传输 N%（a / b）」「正在读取图片并反推提示词…」
// 「已发送到…」「反推完成…」）。读不出百分比时进度条是不定态，反推只有开始 / 结束两档。
// 这里不碰 chrome.*，方便在 node 里测试（tests/extensionPopupIsland.test.js）。

const IN_FLIGHT = new Set(['importing']);
const PERCENT_RE = /(\d{1,3})\s*%/;
const BYTES_RE = /[（(]\s*([^/（）()]+?)\s*\/\s*([^/（）()]+?)\s*[）)]/;

/** 这条状态属于哪条流程：反推、导入，或只是连接。 */
export function statusFlow(status) {
  const state = status?.state;
  const message = String(status?.message || '');
  if (state === 'importing' || state === 'imported') return /反推|reverse/i.test(message) ? 'reverse' : 'import';
  if (state === 'connecting' || state === 'connected') return 'connect';
  return null;
}

/** 从「正在传输 42%（1.2 MB / 3 MB）」里读出百分比与字节；读不出返回 null。 */
export function transferProgress(message) {
  const text = String(message || '');
  const match = text.match(PERCENT_RE);
  if (!match) return null;
  const percent = Math.max(0, Math.min(100, Number(match[1])));
  const bytes = text.match(BYTES_RE);
  return { percent, sent: bytes ? bytes[1] : '', total: bytes ? bytes[2] : '' };
}

/** 完成消息里的目的地：web（网页画布）/ workflow（活动 Workflow）/ inbox（导入箱）。 */
export function importDestination(status) {
  const message = String(status?.message || '');
  if (/网页画布|web canvas/i.test(message)) return 'web';
  if (status?.receipt?.destinationProjectId || /Workflow/.test(message)) return 'workflow';
  if (/导入箱|inbox/i.test(message)) return 'inbox';
  return null;
}

const step = (id, labelKey, state, detail = '') => ({ id, labelKey, state, detail });
const segment = (id, labelKey, state, percent = null) => ({ id, labelKey, state, percent });

function importSteps(status) {
  const progress = transferProgress(status.message);
  if (status.state === 'imported') {
    return {
      steps: [
        step('read', 'island_step_read', 'done'),
        step('send', 'island_step_send', 'done'),
        step('deliver', 'island_step_delivered', 'done'),
      ],
      segments: [segment('import', 'island_stage_import', 'done', 100), segment('process', 'island_stage_process', 'done', 100)],
    };
  }
  if (!progress) {
    // 只有「正在读取所选媒体…」：读取（含首次配对 Desktop）进行中，百分比未知。
    return {
      steps: [
        step('read', 'island_step_read', 'active'),
        step('send', 'island_step_send', 'pending'),
        step('deliver', 'island_step_deliver', 'pending'),
      ],
      segments: [segment('import', 'island_stage_import', 'active', null), segment('process', 'island_stage_process', 'pending')],
    };
  }
  if (progress.percent < 100) {
    return {
      steps: [
        step('read', 'island_step_read', 'done'),
        step('send', 'island_step_send', 'active', progress),
        step('deliver', 'island_step_deliver', 'pending'),
      ],
      segments: [segment('import', 'island_stage_import', 'active', progress.percent), segment('process', 'island_stage_process', 'pending')],
    };
  }
  // 100%：字节都发完了，等对端落盘 / 回执——没有更细的状态，处理段用不定态。
  return {
    steps: [
      step('read', 'island_step_read', 'done'),
      step('send', 'island_step_send', 'done', progress),
      step('deliver', 'island_step_deliver', 'active'),
    ],
    segments: [segment('import', 'island_stage_import', 'done', 100), segment('process', 'island_stage_process', 'active', null)],
  };
}

function reverseSteps(status) {
  // worker 对反推只写开始与结束两条状态：诚实地只给两档。
  const done = status.state === 'imported';
  return {
    steps: [
      step('reverse', 'island_step_reverse', done ? 'done' : 'active'),
      step('result', 'island_step_reverse_done', done ? 'done' : 'pending'),
    ],
    segments: [
      segment('reverse', 'island_stage_reverse', done ? 'done' : 'active', done ? 100 : null),
      segment('result', 'island_stage_done', done ? 'done' : 'pending', done ? 100 : null),
    ],
  };
}

/**
 * 岛的形态：
 * - pill：空闲 / 已连接 / 连接中 / 已完成（收起），单行胶囊；
 * - expanded：导入或反推进行中，展开显示步骤与两段进度；
 * - success：刚完成（展开态 + 薄荷扫光 + 对勾），约 2.5s 后由调用方收回 pill；
 * - error：展开、珊瑚色，直到用户关闭。
 * previous 是上一次的模型（同一个 popup 会话里），用来在出错时标出失败的那一步。
 */
export function islandModel(status, previous = null, { live = false } = {}) {
  const state = status?.state || 'idle';
  const flow = statusFlow(status);
  const base = { state, flow, tone: 'idle', mode: 'pill', steps: [], segments: [], destination: null };

  if (state === 'connected') return { ...base, tone: 'mint' };
  if (state === 'connecting') return { ...base, tone: 'sun' };
  if (state === 'importing') {
    const { steps, segments } = flow === 'reverse' ? reverseSteps(status) : importSteps(status);
    return { ...base, tone: 'sun', mode: 'expanded', steps, segments };
  }
  if (state === 'imported') {
    const { steps, segments } = flow === 'reverse' ? reverseSteps(status) : importSteps(status);
    const destination = flow === 'import' ? importDestination(status) : null;
    // 只有这次 popup 亲眼看到它变成完成（onChanged，或打开时刚完成不久）才播成功动画，否则直接是收起的胶囊。
    const celebrate = Boolean(live);
    return { ...base, tone: 'mint', mode: celebrate ? 'success' : 'pill', steps, segments, destination };
  }
  if (state === 'error') {
    const carried = previous && IN_FLIGHT.has(previous.state) ? previous : null;
    const steps = carried
      ? carried.steps.map(item => (item.state === 'active' ? { ...item, state: 'failed' } : item))
      : [];
    const segments = carried
      ? carried.segments.map(item => (item.state === 'active' ? { ...item, state: 'failed' } : item))
      : [];
    return { ...base, flow: carried?.flow || null, tone: 'coral', mode: 'error', steps, segments };
  }
  return base;
}

/** 成功态停留多久再收回胶囊（ms）。 */
export const ISLAND_SUCCESS_HOLD_MS = 2500;
/** 打开 popup 时，多新的「完成」仍算刚发生（会播一次成功动画）。 */
export const ISLAND_FRESH_MS = 4000;

/** 打开 popup 时读到的状态是否「刚刚」写入。 */
export function isFresh(status, now = Date.now()) {
  const at = Number(status?.updatedAt);
  return Number.isFinite(at) && now - at >= 0 && now - at < ISLAND_FRESH_MS;
}
