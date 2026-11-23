import { Box, Brain, Check, ChevronRight, KeyRound, Loader2, Plus, Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import type { AICapability, ModelItem, RouteMappingBinding, UserApiKey } from '../../types';
import { isAgentTextKey, isAgentTextMapping, resolveAgentTextRoutes } from '../../services/agentTextRoutes';
import { fetchModelsForProvider } from '../../services/modelFetcher';
import {
  DEFAULT_AGENT_THINKING_LEVEL,
  agentThinkingVersion,
  availableThinkingLevels,
  clearReasoningUnsupported,
  reasoningFormatFor,
  isReasoningUnsupported,
  readAgentThinkingLevel,
  subscribeAgentThinking,
  writeAgentThinkingLevel,
  type AgentThinkingLevel,
} from '../../services/agentThinking';
import {
  clampThinkingLevel,
  fetchedModelToItem,
  subscribeThinkingRegistry,
  thinkingRegistryVersion,
  type ModelThinkingInput,
  type ResolvedModelThinking,
} from '../../services/modelThinkingLevels';
import { thinkingLevelText, thinkingSourceText } from './ThinkingLevelBadge';

type Lang = 'en' | 'zho';
const ui = (language: Lang, zho: string, en: string) => (language === 'en' ? en : zho);

const agentTextMapping = (routeId: string): RouteMappingBinding => ({ target: { kind: 'runtime-capability', capability: 'agent-text' }, routeId, order: 0 });

function keyModels(key: UserApiKey): ModelItem[] {
  const items: ModelItem[] = key.models?.length
    ? key.models
    : (key.customModels || []).map(id => ({ id, name: id, capability: 'text' as AICapability }));
  const text = items.filter(item => item.capability === 'text');
  return text.length ? text : items;
}

export function thinkingLevelLabel(level: AgentThinkingLevel, language: Lang, mode: ResolvedModelThinking['mode'] = 'effort'): string {
  return thinkingLevelText(level, language, mode);
}

/** 存的档位就近夹到该模型可用档位（off 仍是 off）。 */
function displayedThinkingLevel(model: string | ModelThinkingInput): AgentThinkingLevel {
  const id = typeof model === 'string' ? model : model.id;
  const stored = readAgentThinkingLevel(id);
  if (stored === 'off') return 'off';
  const { levels } = availableThinkingLevels(model);
  const on = levels.filter(level => level !== 'off');
  return clampThinkingLevel(stored, on.length ? on : levels);
}

/**
 * 模型胶囊上的思考强度后缀（「· 高」）：只在强度不是默认值、且模型支持时显示。
 * 显示的是就近夹到该模型可用档位后的那一档（与真正发出的请求一致）。
 */
export function thinkingChipSuffix(model: string | ModelThinkingInput, language: Lang): string | null {
  const id = typeof model === 'string' ? model : model.id;
  if (!id || isReasoningUnsupported(id)) return null;
  const level = displayedThinkingLevel(model);
  if (level === DEFAULT_AGENT_THINKING_LEVEL) return null;
  return `· ${thinkingLevelLabel(level, language, availableThinkingLevels(model).mode)}`;
}

/**
 * 该模型可选的思考强度，按模型数据决定（services/modelThinkingLevels：报错学到的 1 小时内 → /models API 字段 → pi-ai 注册表 → id 规则表）：
 * - 已被服务拒绝过思考参数（不支持名单）或模型不思考 → 没有可选强度，点模型直接选中；
 * - 必须思考的模型不列「不思考」；
 * - 档位只来自规则表 / 默认值时，「极简」只对 OpenAI / OpenRouter 列出（其余服务会被降成「低」）。
 */
export function supportedThinkingLevels(model: string | ModelThinkingInput, key: Pick<UserApiKey, 'provider' | 'baseUrl'>): AgentThinkingLevel[] {
  const id = typeof model === 'string' ? model : model.id;
  if (!id || isReasoningUnsupported(id)) return [];
  const thinking = availableThinkingLevels(model);
  if (!thinking.mandatory && thinking.levels.every(level => level === 'off')) return [];
  const heuristic = thinking.source === 'rules' || thinking.source === 'default';
  const acceptsMinimal = !heuristic || key.provider === 'openai' || reasoningFormatFor(String(key.provider || ''), key.baseUrl || '') === 'openrouter';
  return thinking.levels.filter(level => level !== 'minimal' || acceptsMinimal);
}

/**
 * 模型行的级联子菜单：该模型支持的思考强度。选一档 = 同时选中模型与强度。
 * ↑/↓ 移动，Enter / 空格选择，← / Esc 收起回到模型列表。宽面板浮在列表右侧（磨砂），≤340px 在该行下方内联展开。
 */
function ThinkingSubmenu({ model, levels, language, onPick, onClose }: {
  model: ModelItem;
  levels: AgentThinkingLevel[];
  language: Lang;
  onPick: (level: AgentThinkingLevel) => void;
  onClose: () => void;
}) {
  const thinking = availableThinkingLevels(model);
  const current = displayedThinkingLevel(model);
  const label = ui(language, '思考强度', 'Thinking effort');
  const sourceTitle = `${label}（${ui(language, '来源', 'source')}：${thinkingSourceText(thinking.source, language)}）`;
  const ref = useRef<HTMLDivElement | null>(null);
  // 侧边模式（absolute）：顶部对齐所在行，但不超出模型浮层的上下边（浮层贴着输入框，向下会压到底栏）。内联模式不处理。
  useLayoutEffect(() => {
    const menu = ref.current;
    const picker = menu?.closest<HTMLElement>('.agent-model-picker');
    const row = menu?.parentElement;
    if (!menu || !picker || !row) return;
    menu.style.top = '';
    if (getComputedStyle(menu).position !== 'absolute') return;
    const pickerRect = picker.getBoundingClientRect();
    const rowTop = row.getBoundingClientRect().top - pickerRect.top;
    const max = picker.clientHeight - menu.offsetHeight - 4;
    menu.style.top = `${Math.max(4, Math.min(rowTop, max))}px`;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      handled();
      const next = index < 0 ? 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      handled();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      handled();
      onClose();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
  };
  return (
    <div ref={ref} className="agent-model-submenu flv-frost" role="menu" aria-label={`${label} · ${model.id}`} data-testid="agent-thinking-submenu" data-thinking-source={thinking.source} onKeyDown={onKeyDown}>
      <p className="agent-model-submenu__title" aria-hidden="true" title={sourceTitle}><Brain size={12} />{label}</p>
      {levels.map(level => (
        <button key={level} type="button" role="menuitemradio" aria-checked={level === current} tabIndex={-1} onClick={() => onPick(level)}>
          <span>{thinkingLevelLabel(level, language, thinking.mode)}</span>{level === current && <Check size={13} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

function keyLabel(key: UserApiKey): string {
  if (key.name) return key.name;
  try { return key.baseUrl ? new URL(key.baseUrl).host : key.provider; } catch { return key.provider; }
}

export function AgentModelPicker({ userApiKeys, onAddApiKey, onUpdateApiKey, open, onOpenChange, language }: {
  userApiKeys: UserApiKey[];
  onAddApiKey?: (payload: Omit<UserApiKey, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onUpdateApiKey?: (id: string, patch: Partial<Omit<UserApiKey, 'id' | 'createdAt'>>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Lang;
}) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keys = useMemo(() => userApiKeys.filter(isAgentTextKey), [userApiKeys]);
  // 与 Agent 内核同一解析：没有显式映射时，回退选中的模型也会显示为当前模型。
  const current = useMemo(() => resolveAgentTextRoutes(userApiKeys)[0], [userApiKeys]);
  const currentKeyId = current?.key.id;
  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return keys
      .map(key => ({ key, models: keyModels(key).filter(model => !normalized || model.id.toLowerCase().includes(normalized) || (model.name || '').toLowerCase().includes(normalized)) }))
      .filter(group => group.models.length > 0);
  }, [keys, query]);
  const flat = useMemo(() => groups.flatMap(group => group.models.map(model => ({ keyId: group.key.id, model }))), [groups]);
  const showForm = adding || keys.length === 0;
  const label = ui(language, '选择模型', 'Choose model');
  // 思考强度变化时刷新胶囊后缀。
  useSyncExternalStore(subscribeAgentThinking, agentThinkingVersion, agentThinkingVersion);
  // pi-ai 注册表懒加载完成后按模型重算可用档位。
  useSyncExternalStore(subscribeThinkingRegistry, thinkingRegistryVersion, thinkingRegistryVersion);
  const currentInfo = current ? (current.key.models?.find(item => item.id === current.model) || current.model) : null;
  const effortSuffix = currentInfo ? thinkingChipSuffix(currentInfo, language) : null;

  // 只保留一条 agent-text 映射，选哪个就是哪个，避免排序规则让别的 Key 抢先。
  const select = (keyId: string, modelId: string) => {
    for (const key of keys) {
      const others = (key.routeMappings || []).filter(mapping => !isAgentTextMapping(mapping));
      const next = key.id === keyId ? [...others, agentTextMapping(modelId)] : others;
      if (next.length !== (key.routeMappings || []).length || key.id === keyId) onUpdateApiKey?.(key.id, { routeMappings: next });
    }
    onOpenChange(false);
  };

  // 级联子菜单：哪一行（keyId + modelId）展开了思考强度。
  const [submenu, setSubmenu] = useState<{ keyId: string; modelId: string } | null>(null);
  const focusSubmenu = useRef(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!open) setSubmenu(null); }, [open]);
  useEffect(() => {
    if (!submenu || !focusSubmenu.current) return;
    focusSubmenu.current = false;
    const menu = pickerRef.current?.querySelector<HTMLElement>('.agent-model-submenu');
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') || menu?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
  }, [submenu]);
  const keyById = (keyId: string) => keys.find(key => key.id === keyId);
  const levelsFor = (keyId: string, modelId: string) => {
    const key = keyById(keyId);
    return key ? supportedThinkingLevels(keyModels(key).find(item => item.id === modelId) || modelId, key) : [];
  };
  /** 点模型 / Enter / →：有可选强度就展开子菜单（键盘时把焦点送进去），没有就直接选中。 */
  const activate = (keyId: string, modelId: string, viaKeyboard: boolean) => {
    if (!levelsFor(keyId, modelId).length) { select(keyId, modelId); return; }
    focusSubmenu.current = viaKeyboard;
    setSubmenu({ keyId, modelId });
  };
  const closeSubmenu = () => {
    setSubmenu(null);
    pickerRef.current?.querySelector<HTMLInputElement>('.agent-model-picker__search input')?.focus();
  };
  const listbox = useListboxKeyboard({
    items: flat,
    open: open && keys.length > 0,
    query,
    onQueryChange: setQuery,
    onClose: () => onOpenChange(false),
    onSelect: item => activate(item.keyId, item.model.id, true),
    initialIndex: flat.findIndex(item => item.keyId === currentKeyId && item.model.id === current?.model),
    // 「添加 Key」表单展开时让表单先拿焦点。
    autoFocus: !showForm,
  });

  const importModels = async () => {
    const url = baseUrl.trim();
    const secret = apiKey.trim();
    if (!url || !secret || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await fetchModelsForProvider('openai_compatible', secret, url);
      if (!result.ok || result.models.length === 0) {
        setError(result.error || ui(language, '没有拉取到模型，请检查 URL 和 Key', 'No models found. Check the URL and key.'));
        return;
      }
      const models: ModelItem[] = result.models.map(model => fetchedModelToItem(model));
      const capabilities = [...new Set<AICapability>(models.map(model => model.capability))];
      const firstText = models.find(model => model.capability === 'text') || models[0];
      // 新 Key 接管 Agent：先清掉其他 Key 的 agent-text 映射。
      for (const key of keys) {
        const others = (key.routeMappings || []).filter(mapping => !isAgentTextMapping(mapping));
        if (others.length !== (key.routeMappings || []).length) onUpdateApiKey?.(key.id, { routeMappings: others });
      }
      const effectiveBaseUrl = result.effectiveBaseUrl || url;
      let name = effectiveBaseUrl;
      try { name = new URL(effectiveBaseUrl).host; } catch { /* keep raw url */ }
      onAddApiKey?.({
        provider: 'openai_compatible',
        key: secret,
        baseUrl: effectiveBaseUrl,
        name,
        capabilities: capabilities.length ? capabilities : ['text'],
        models,
        defaultModel: firstText.id,
        status: 'ok',
        routeMappings: [agentTextMapping(firstText.id)],
      });
      setApiKey('');
      setBaseUrl('');
      setAdding(false);
    } catch {
      setError(ui(language, '网络错误，拉取模型失败', 'Network error while fetching models.'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="agent-mode-control agent-model-control">
      <button type="button" className={`agent-model-trigger${current ? ' is-active' : ''}`} aria-label={label} title={current ? [current.model, effortSuffix ? `${ui(language, '思考强度', 'Thinking')} ${effortSuffix.slice(2)}` : ''].filter(Boolean).join(' · ') : label} aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <Box size={14} aria-hidden="true" /><span className="agent-model-trigger__name">{current ? current.model : label}</span>
        {effortSuffix && <span className="agent-model-trigger__effort" data-testid="agent-model-effort">{effortSuffix}</span>}
      </button>
      {open && (
        <div ref={pickerRef} {...listbox.getContainerProps({
          className: 'agent-mode-menu agent-model-menu agent-model-picker',
          role: 'dialog',
          'aria-label': label,
          onKeyDown: event => {
            // →：展开高亮模型的思考强度（在搜索框里只在光标位于末尾时接管）。
            if (event.key !== 'ArrowRight' || event.altKey || event.metaKey || event.ctrlKey) return;
            const target = event.target as HTMLElement;
            if (target.closest('.agent-model-submenu')) return;
            if (target instanceof HTMLInputElement && target.selectionStart !== target.value.length) return;
            const item = listbox.activeIndex >= 0 ? flat[listbox.activeIndex] : undefined;
            if (!item || !levelsFor(item.keyId, item.model.id).length) return;
            event.preventDefault();
            activate(item.keyId, item.model.id, true);
          },
        })}>
          <div className="agent-model-picker__head">
            <strong>{label}</strong>
            {keys.length > 0 && <button type="button" aria-label={ui(language, '添加 Key', 'Add key')} aria-pressed={adding} onClick={() => { setAdding(value => !value); setError(null); }}><Plus size={14} /></button>}
          </div>
          {showForm && (
            <form className="agent-model-picker__form" onSubmit={event => { event.preventDefault(); void importModels(); }}>
              <input aria-label="Base URL" placeholder="Base URL，如 https://api.example.com/v1" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} autoComplete="off" spellCheck={false} />
              <input aria-label="API Key" placeholder="API Key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} />
              <button type="submit" disabled={!baseUrl.trim() || !apiKey.trim() || importing}>
                {importing ? <Loader2 size={13} className="is-spinning" /> : <KeyRound size={13} />}
                {importing ? ui(language, '正在拉取模型…', 'Fetching models…') : ui(language, '导入全部模型', 'Import all models')}
              </button>
              {error && <p className="agent-model-picker__error" role="alert">{error}</p>}
            </form>
          )}
          {current && isReasoningUnsupported(current.model) && <p className="agent-model-picker__note">
            {ui(language, '当前模型不支持思考强度（已自动关闭）', 'This model rejected the thinking parameter (turned off)')}
            <button type="button" onClick={() => clearReasoningUnsupported(current.model)}>{ui(language, '重试', 'Retry')}</button>
          </p>}
          {keys.length > 0 && <label className="agent-model-picker__search"><Search size={13} /><input {...listbox.getInputProps({ 'aria-label': ui(language, '搜索模型', 'Search models'), placeholder: ui(language, '搜索模型', 'Search models'), value: query, onChange: event => setQuery(event.target.value) })} /></label>}
          {keys.length > 0 && (
            <div {...listbox.getListboxProps({ className: 'agent-model-menu__list', 'aria-label': label })}>
              {groups.length === 0 && <p className="agent-model-menu__empty">{ui(language, '没有匹配的模型', 'No matching models')}</p>}
              {groups.map(group => (
                <section key={group.key.id} className="agent-model-picker__group">
                  <small>{keyLabel(group.key)}</small>
                  {group.models.map(model => {
                    const selected = group.key.id === currentKeyId && model.id === current?.model;
                    const index = flat.findIndex(item => item.keyId === group.key.id && item.model === model);
                    const levels = supportedThinkingLevels(model, group.key);
                    const expanded = submenu?.keyId === group.key.id && submenu.modelId === model.id;
                    const level = levels.length ? displayedThinkingLevel(model) : null;
                    return (
                      <div key={model.id} className="agent-model-picker__row" data-expanded={expanded || undefined}>
                        <button
                          type="button"
                          tabIndex={-1}
                          {...listbox.getOptionProps(index, {
                            onMouseEnter: () => setSubmenu(levels.length ? { keyId: group.key.id, modelId: model.id } : null),
                          })}
                          aria-selected={selected}
                          aria-haspopup={levels.length ? 'menu' : undefined}
                          aria-expanded={levels.length ? expanded : undefined}
                          onClick={() => activate(group.key.id, model.id, false)}
                        >
                          <span><strong>{model.name || model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}</span>
                          {selected && level && level !== DEFAULT_AGENT_THINKING_LEVEL && <em className="agent-model-picker__effort">{thinkingLevelLabel(level, language, availableThinkingLevels(model).mode)}</em>}
                          {selected && <Check size={14} />}
                          {levels.length > 0 && <ChevronRight size={13} className="agent-model-picker__caret" aria-hidden="true" />}
                        </button>
                        {expanded && <ThinkingSubmenu
                          model={model}
                          levels={levels}
                          language={language}
                          onPick={picked => { writeAgentThinkingLevel(model.id, picked); select(group.key.id, model.id); }}
                          onClose={closeSubmenu}
                        />}
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
