// 插件设置页：查看 / 管理与画布双向同步的 AI 服务 Key。
// 只经 runtime 消息和 service worker（background/web-keys.js）打交道：列表永远是掩码（后 4 位），
// 编辑时 Key 输入框留空表示沿用原 Key；明文只在用户输入新 Key 后随保存消息发出一次，不在这里保存、不打日志。
import { PAIRINGS_KEY, readPairings } from '../background/web-pairings.js';
import { CAPABILITIES, PROVIDER_BASE_URLS, PROVIDER_LABELS, PROVIDER_PRESETS, providerLabel } from './provider-presets.js';

const VAULT = { list: 'IRIS_VAULT_LIST', upsert: 'IRIS_VAULT_UPSERT', remove: 'IRIS_VAULT_REMOVE' };
const KEYS_STORAGE = 'irisWebKeys';

const t = (name, fallback = '', subs) => chrome.i18n?.getMessage?.(name, subs) || fallback;
document.documentElement.lang = chrome.i18n?.getUILanguage?.() || 'zh-CN';
function localize(root) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n, node.textContent);
}
localize(document);
document.getElementById('extensionVersion').textContent = 'v' + chrome.runtime.getManifest().version;

const ICON_PATHS = {
  sync: '<path d="M21 12a9 9 0 0 0-15-6.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><path d="M16 16h5v5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  canvas: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
};
function icon(name, size = 14) {
  const span = document.createElement('span');
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
  return span.firstElementChild;
}
for (const node of document.querySelectorAll('[data-icon]')) {
  node.textContent = '';
  node.appendChild(icon(node.dataset.icon, node.classList.contains('is-small') ? 12 : 15));
}

const originsHost = document.getElementById('origins');
const noPairing = document.getElementById('noPairing');
const editorTemplate = document.getElementById('editorTemplate');
// 正在编辑的位置：{ origin, id | null }；重新渲染时保留，避免存储变化把用户的输入冲掉。
let editing = null;

async function vault(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || t('opt_failed', '操作失败'));
  return response.result;
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(label, onClick, variant = '') {
  const button = el('button', 'isl-chip' + (variant ? ' isl-chip--' + variant : ''), label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function capabilityLabel(cap) {
  return t('opt_cap_' + cap, cap);
}

function providerOptions(select, current) {
  const seen = new Set();
  const add = (value, label) => {
    if (seen.has(value)) return;
    seen.add(value);
    const option = el('option', '', label);
    option.value = value;
    select.appendChild(option);
  };
  for (const preset of PROVIDER_PRESETS) add(preset.provider, preset.label);
  for (const [provider, label] of Object.entries(PROVIDER_LABELS)) add(provider, label);
  select.value = current || PROVIDER_PRESETS[0].provider;
}

function presetFor(provider) {
  return PROVIDER_PRESETS.find(item => item.provider === provider);
}

function buildEditor(origin, entry) {
  const form = editorTemplate.content.firstElementChild.cloneNode(true);
  localize(form);
  const fields = form.elements;
  providerOptions(fields.provider, entry?.provider);
  fields.name.value = entry?.name || '';
  fields.baseUrl.value = entry ? entry.baseUrl : (presetFor(fields.provider.value)?.baseUrl ?? '');
  fields.defaultModel.value = entry ? entry.defaultModel : (presetFor(fields.provider.value)?.defaultModel ?? '');
  fields.key.placeholder = entry ? t('opt_key_keep', '留空则保持不变（当前 $1）', [entry.masked]).replace('$1', entry.masked) : t('opt_key_placeholder', '粘贴 Key');
  fields.baseUrl.placeholder = 'https://…';

  const capsHost = form.querySelector('.caps__list');
  const initialCaps = new Set(entry?.capabilities?.length ? entry.capabilities : presetFor(fields.provider.value)?.capabilities || ['text']);
  for (const cap of CAPABILITIES) {
    const label = el('label', 'cap');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'cap';
    box.value = cap;
    box.checked = initialCaps.has(cap);
    label.append(box, el('span', '', capabilityLabel(cap)));
    capsHost.appendChild(label);
  }

  // 新增时切换服务类型：像画布弹窗一样带出默认地址、能力与默认模型。
  fields.provider.addEventListener('change', () => {
    if (entry) return;
    const preset = presetFor(fields.provider.value);
    fields.baseUrl.value = preset?.baseUrl ?? PROVIDER_BASE_URLS[fields.provider.value] ?? '';
    fields.defaultModel.value = preset?.defaultModel ?? '';
    const caps = new Set(preset?.capabilities || ['text']);
    for (const box of capsHost.querySelectorAll('input')) box.checked = caps.has(box.value);
  });

  const error = form.querySelector('.editor__error');
  const showError = message => {
    error.textContent = message;
    error.hidden = !message;
  };
  form.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    editing = null;
    void refresh();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const key = fields.key.value.trim();
    if (!entry && !key) {
      showError(t('opt_err_key', '请填写 Key'));
      return;
    }
    const baseUrl = fields.baseUrl.value.trim();
    if (baseUrl && !/^https?:\/\/\S+$/i.test(baseUrl)) {
      showError(t('opt_err_url', '请求地址需以 http:// 或 https:// 开头'));
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await vault(VAULT.upsert, {
        origin,
        entry: {
          id: entry?.id,
          provider: fields.provider.value,
          name: fields.name.value,
          key,
          baseUrl,
          defaultModel: fields.defaultModel.value,
          capabilities: [...capsHost.querySelectorAll('input:checked')].map(box => box.value),
        },
      });
      fields.key.value = '';
      editing = null;
      await refresh();
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submit.disabled = false;
    }
  });
  queueMicrotask(() => (entry ? fields.name : fields.key).focus());
  return form;
}

function keyRow(origin, entry, disabled) {
  const row = el('li', 'krow');
  const glyph = el('span', 'conn__glyph is-on');
  glyph.appendChild(icon('key'));
  const text = el('div', 'krow__text');
  const title = el('strong', '', entry.name || providerLabel(entry.provider));
  const meta = el('small', 'krow__meta');
  const parts = [entry.name ? providerLabel(entry.provider) : '', entry.masked, entry.defaultModel].filter(Boolean);
  meta.textContent = parts.join(' · ');
  meta.title = [entry.baseUrl, ...parts].filter(Boolean).join(' · ');
  text.append(title, meta);
  const tags = el('div', 'krow__tags');
  for (const cap of entry.capabilities || []) tags.appendChild(el('span', 'tag', capabilityLabel(cap)));
  if (entry.pending) tags.appendChild(el('span', 'tag tag--sun', t('opt_pending_one', '待回写')));
  text.appendChild(tags);
  row.append(glyph, text);
  if (!disabled) {
    const actions = el('div', 'conn__actions');
    actions.append(
      chip(t('opt_edit', '编辑'), () => {
        editing = { origin, id: entry.id };
        void refresh();
      }),
      chip(t('opt_delete', '删除'), async () => {
        if (!confirm(t('opt_delete_confirm', '删除这个 Key？画布里的同一个 Key 也会被删除。'))) return;
        try {
          await vault(VAULT.remove, { origin, id: entry.id });
        } catch (failure) {
          alert(failure instanceof Error ? failure.message : String(failure));
        }
        await refresh();
      }, 'danger'),
    );
    row.appendChild(actions);
  }
  return row;
}

function originCard(origin, state) {
  const card = el('section', 'card opt__card');
  const head = el('div', 'card__head');
  const title = el('div', 'opt__origin');
  const glyph = el('span', 'conn__glyph is-on');
  glyph.appendChild(icon('canvas'));
  const name = el('strong', '', hostOf(origin));
  name.title = origin;
  title.append(glyph, name);
  head.appendChild(title);
  const disabled = state.syncDisabled;
  if (!disabled && editing?.origin !== origin) {
    head.appendChild(chip(t('opt_add', '添加 Key'), () => {
      editing = { origin, id: null };
      void refresh();
    }, 'mint'));
  }
  card.appendChild(head);

  const keys = state.keys || [];
  const providers = [...new Set(keys.map(entry => providerLabel(entry.provider)))];
  const providerList = providers.join(t('opt_list_sep', '、'));
  const summary = el('p', 'opt__summary');
  if (disabled) {
    summary.textContent = t('opt_disabled', '这个画布开启了「关闭应用时清除 API Key」，两边都不同步 Key。');
    summary.classList.add('is-warn');
  } else {
    const synced = keys.length
      ? t('opt_synced', '已同步 $1 个 Key：$2。', [String(keys.length), providerList]).replace('$1', String(keys.length)).replace('$2', providerList)
      : t('opt_synced_none', '这个画布还没有同步过 Key。');
    const pending = state.pending ? ' ' + t('opt_pending', '$1 处改动等画布打开后回写。', [String(state.pending)]).replace('$1', String(state.pending)) : '';
    summary.textContent = synced + pending;
  }
  card.appendChild(summary);

  if (editing?.origin === origin && editing.id === null) card.appendChild(buildEditor(origin, null));
  if (keys.length) {
    const list = el('ul', 'klist');
    for (const entry of keys) {
      if (editing?.origin === origin && editing.id === entry.id) {
        const holder = el('li', 'krow krow--editing');
        holder.appendChild(buildEditor(origin, entry));
        list.appendChild(holder);
      } else {
        list.appendChild(keyRow(origin, entry, disabled));
      }
    }
    card.appendChild(list);
  }
  return card;
}

async function refresh() {
  const [pairings, vaultState] = await Promise.all([readPairings(), vault(VAULT.list).catch(() => ({}))]);
  const approved = Object.keys(pairings).filter(origin => pairings[origin]?.status === 'approved');
  originsHost.textContent = '';
  noPairing.hidden = approved.length > 0;
  for (const origin of approved) {
    originsHost.appendChild(originCard(origin, vaultState[origin] || { keys: [], pending: 0, syncDisabled: false }));
  }
}

void refresh();
chrome.storage.onChanged.addListener((changes, area) => {
  // 正在编辑时不重绘，避免冲掉输入；保存或取消后会刷新。
  if (area === 'local' && (changes[PAIRINGS_KEY] || changes[KEYS_STORAGE]) && !editing) void refresh();
});
