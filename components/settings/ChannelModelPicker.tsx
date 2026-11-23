import { useMemo, useState } from 'react';
import type { AICapability, ModelItem } from '../../types';
import type { FetchedModel } from '../../services/modelFetcher';
import { useListboxKeyboard } from '../../hooks/useListboxKeyboard';
import { fetchedModelToItem, refreshModelCapabilityFields } from '../../services/modelThinkingLevels';
import { ThinkingLevelBadge } from '../agent/ThinkingLevelBadge';

// 选择渠道模型：搜索、手动增加、拉取 /models、新获取/已有两栏、全选/取消、按模型指定能力
interface ChannelModelPickerProps {
  existing: ModelItem[];
  fetched: FetchedModel[];
  fetching: boolean;
  fetchError: string | null;
  canFetch: boolean;
  onFetch: () => void;
  onConfirm: (next: ModelItem[]) => void;
  // 拉取 /models 会把编辑中的模型列表整体替换，取消时用打开弹窗时的快照还原
  onClose: (baseline: ModelItem[]) => void;
}

const MODEL_CAPABILITIES: AICapability[] = ['text', 'image', 'video'];
const CAPABILITY_LABEL: Record<string, string> = { text: '文本', image: '图片', video: '视频' };
const smallButton = 'rounded-md border border-[var(--isl-border)] px-2 py-1 text-xs text-[var(--isl-ink-soft)] transition hover:bg-[var(--isl-surface-2)] hover:text-[var(--isl-ink)] disabled:opacity-40';

function matches(item: { id: string; name?: string }, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.id.toLowerCase().includes(q) || (item.name || '').toLowerCase().includes(q);
}

export function ChannelModelPicker({ existing: currentModels, fetched, fetching, fetchError, canFetch, onFetch, onConfirm, onClose }: ChannelModelPickerProps) {
  const [existing] = useState<ModelItem[]>(() => currentModels);
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [manual, setManual] = useState<ModelItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(existing.map(item => item.id)));
  const [capabilityOverrides, setCapabilityOverrides] = useState<Record<string, AICapability>>({});

  const existingIds = useMemo(() => new Set(existing.map(item => item.id)), [existing]);
  const fresh = useMemo<ModelItem[]>(() => {
    const seen = new Set(existingIds);
    const list: ModelItem[] = [];
    for (const item of [...manual, ...fetched.map(fetchedModelToItem)]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      list.push(item);
    }
    return list;
  }, [existingIds, fetched, manual]);

  const fetchedById = useMemo(() => new Map(fetched.map(model => [model.id, model])), [fetched]);
  // 已有模型如果这次也拉到了，思考档位 / 上下文窗口跟着刷新。
  const refreshedExisting = useMemo(() => existing.map(item => {
    const hit = fetchedById.get(item.id);
    return hit ? refreshModelCapabilityFields(item, hit) : item;
  }), [existing, fetchedById]);
  const visibleFresh = useMemo(() => fresh.filter(item => matches(item, query)), [fresh, query]);
  const visibleExisting = useMemo(() => refreshedExisting.filter(item => matches(item, query)), [refreshedExisting, query]);

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // 打开即可输入筛选；↑/↓ 在两栏之间连续移动高亮，Enter 勾选 / 取消，Esc 先清空搜索再关闭。
  const navItems = useMemo(() => [...visibleFresh, ...visibleExisting], [visibleFresh, visibleExisting]);
  const listbox = useListboxKeyboard({
    items: navItems,
    query,
    onQueryChange: setQuery,
    onClose: () => onClose(existing),
    onSelect: item => toggle(item.id),
  });
  const setMany = (items: ModelItem[], on: boolean) => setSelected(prev => {
    const next = new Set(prev);
    for (const item of items) {
      if (on) next.add(item.id); else next.delete(item.id);
    }
    return next;
  });

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    if (!existingIds.has(id) && !fresh.some(item => item.id === id)) setManual(prev => [{ id, name: id }, ...prev]);
    setSelected(prev => new Set(prev).add(id));
    setManualId('');
  };

  const capabilityOf = (item: ModelItem): AICapability | '' => capabilityOverrides[item.id] || item.capability || '';

  const confirm = () => {
    const next = [...refreshedExisting, ...fresh]
      .filter(item => selected.has(item.id))
      .map(item => {
        const capability = capabilityOverrides[item.id] || item.capability;
        return capability ? { ...item, capability } : { ...item };
      });
    onConfirm(next);
  };

  const renderColumn = (title: string, items: ModelItem[], testId: string, offset: number) => {
    const allOn = items.length > 0 && items.every(item => selected.has(item.id));
    return (
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--isl-border)] settings-elevated" data-testid={testId}>
        <div className="flex items-center justify-between gap-2 border-b border-[var(--isl-border)] px-3 py-2">
          <span className="text-xs font-semibold text-[var(--isl-ink)]">{title} · {items.length}</span>
          <button type="button" className={smallButton} disabled={items.length === 0} onClick={() => setMany(items, !allOn)}>
            {allOn ? '取消全选' : '全选'}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 && <div className="px-3 py-6 text-center text-xs text-[var(--isl-ink-soft)]">暂无</div>}
          {items.map((item, index) => (
            <div key={item.id} {...listbox.getOptionProps(offset + index)} aria-selected={selected.has(item.id)} className={`flex items-center gap-2 border-b border-[var(--isl-border)] px-3 py-1.5 last:border-b-0${listbox.activeIndex === offset + index ? ' bg-[var(--isl-surface-2)]' : ''}`}>
              <input type="checkbox" aria-label={item.id} checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--isl-ink)]" title={item.id}>{item.name || item.id}</span>
              {(!item.capability || item.capability === 'text') && <ThinkingLevelBadge model={item} />}
              <select
                aria-label={'能力 ' + item.id}
                value={capabilityOf(item)}
                onChange={event => {
                  const value = event.target.value as AICapability;
                  setCapabilityOverrides(prev => ({ ...prev, [item.id]: value }));
                }}
                className="rounded-md border border-[var(--isl-border)] bg-[var(--isl-card)] px-1 py-0.5 text-[11px] text-[var(--isl-ink-soft)]"
              >
                <option value="">自动</option>
                {MODEL_CAPABILITIES.map(capability => (
                  <option key={capability} value={capability}>{CAPABILITY_LABEL[capability] || capability}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4" onClick={() => onClose(existing)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="选择渠道模型"
        data-testid="channel-model-picker"
        className="isl-shell flex h-[min(640px,calc(100dvh-32px))] w-[min(760px,100%)] flex-col gap-3 p-4"
        onClick={event => event.stopPropagation()}
        {...listbox.getContainerProps()}
      >
        <div className="flex items-center justify-between">
          <h5 className="text-sm font-extrabold text-[var(--isl-ink)]">选择渠道模型</h5>
          <button type="button" aria-label="关闭" className={smallButton} onClick={() => onClose(existing)}>×</button>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            {...listbox.getInputProps({
              value: query,
              onChange: event => setQuery(event.target.value),
              placeholder: '搜索模型',
              'aria-label': '搜索模型',
              className: 'min-w-0 flex-1 rounded-md border border-[var(--isl-border)] bg-[var(--isl-card)] px-2 py-1.5 text-xs text-[var(--isl-ink)]',
            })}
          />
          <input
            value={manualId}
            onChange={event => setManualId(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManual(); } }}
            placeholder="手动输入模型 ID"
            className="min-w-0 flex-1 rounded-md border border-[var(--isl-border)] bg-[var(--isl-card)] px-2 py-1.5 text-xs text-[var(--isl-ink)]"
          />
          <button type="button" className={smallButton} disabled={!manualId.trim()} onClick={addManual}>手动增加</button>
          <button type="button" className={smallButton} disabled={!canFetch || fetching} onClick={onFetch}>
            {fetching ? '拉取中…' : '拉取 /models'}
          </button>
        </div>
        {fetchError && <div className="rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-500">{fetchError}</div>}
        <div {...listbox.getListboxProps({ className: 'flex min-h-0 flex-1 gap-3', 'aria-label': '选择渠道模型', 'aria-multiselectable': true })}>
          {renderColumn('新获取', visibleFresh, 'channel-model-picker-fresh', 0)}
          {renderColumn('已有', visibleExisting, 'channel-model-picker-existing', visibleFresh.length)}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--isl-ink-soft)]">已选 {selected.size} 个</span>
          <div className="flex gap-2">
            <button type="button" className="isl-chip px-3 py-1.5 text-xs" onClick={() => onClose(existing)}>取消</button>
            <button type="button" className="isl-chip isl-chip--active px-3 py-1.5 text-xs" onClick={confirm}>确定</button>
          </div>
        </div>
      </div>
    </div>
  );
}
