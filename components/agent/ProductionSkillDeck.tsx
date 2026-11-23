import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileUp, Heart, LayoutTemplate, Minimize2, Plus, RefreshCw, Search, Shuffle, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import '../../styles/skillHub.css';

import {
  getBundledProductionSkill,
  type ProductionSkillAttachment,
} from '../../services/productionSkillCatalog';
import { skillRegistryErrorMessage } from '../../services/localSkillRegistry';
import { hubSkillExternalUrl } from '../../services/skillHubClient';
import { buildProductionSkillStarterPrompt } from '../../services/productionSkillLaunch';
import { isUserSkillAttachment, userSkillAttachment } from '../../services/userSkillContext';
import { useSkillHubStore } from '../../stores/useSkillHubStore';
import { useStudioHubStore } from '../../stores/useStudioHubStore';
import { isSkillEnabled, useUserSkillsStore, type RemovedUserSkill } from '../../stores/useUserSkillsStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { translations } from '../../utils/translations';
import { matchSlashCommands, type AgentSlashCommand } from './agentSlashCommands';
import {
  parseSkillImport,
  pickTextFile,
  resolveSkillAttachment,
  SKILL_COPY,
  SkillDetail,
  SkillEditor,
  SkillMark,
  skillMatches,
  skillTemplates,
  useSkillCatalog,
  type DeckSkill,
  type EditorDraft,
} from './skillHubParts';
import { nextHighlight, previewPlacement } from './pickerNavigation';
import { isComposingEvent, isEditableElement, isPrintableKey, useMenuKeyboard } from '../../hooks/useListboxKeyboard';

// Composer 的 Skill 浮层。结构按用户 2026-11-16 截图：标题 + 搜索 / 创建 ▾ / 更多 >，
// 综合 / 喜欢 / 我的 三个页签，行 = 标题 + 一行说明，悬停抬起并出「详情」，
// 悬停时在浮层左侧浮出预览卡；底部「查看更多 →」打开放大的 Skills 窗口。
// 行内状态借 Inspora「AI agent dashboard」（@BenceRedmond）的凸起图标方块与 ✓ 已添加 / 「+」。
// 参考登记见 docs/design/references.md。

const UNDO_MS = 6000;
const PREVIEW_WIDTH = 248;

type SkillTab = 'all' | 'favorites' | 'mine';
type DeckView =
  | { type: 'list' }
  | { type: 'detail'; key: string }
  | { type: 'edit'; id: string | null; initial?: EditorDraft };

const EMPTY_DRAFT: EditorDraft = { name: '', slug: '', description: '', prompt: '', enabled: true };

export function ProductionSkillDeck({
  attachment,
  onChange,
  dropTargetRef,
  onPromptChange,
  showWelcome = false,
  open: openProp,
  onOpenChange,
  searchQuery,
  keyboardRef,
  commands = [],
  onCommand,
}: {
  attachment?: ProductionSkillAttachment;
  onChange: (attachment?: ProductionSkillAttachment) => void;
  dropTargetRef: RefObject<HTMLElement | null>;
  onPromptChange?: (prompt: string) => void;
  showWelcome?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Text typed after "/" in the composer; drives the search and keeps focus in the composer. */
  searchQuery?: string;
  /** 输入框把方向键 / Enter / Tab / Esc 转交给列表。返回 true 表示已消费。 */
  keyboardRef?: { current: ((key: string) => boolean) | null };
  /** 斜杠命令（/compact 等）：只在「/」打开的菜单（searchQuery 有值）的「全部」页显示，排在 Skill 前面。 */
  commands?: readonly AgentSlashCommand[];
  /** 选中命令。run=true 表示输入已是完整命令名、直接执行；否则把命令写进输入框等用户补参数。 */
  onCommand?: (command: AgentSlashCommand, options: { run: boolean }) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    if (openProp === undefined) setOpenState(value);
    onOpenChange?.(value);
  };
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [tab, setTab] = useState<SkillTab>('all');
  const [shuffleOffset, setShuffleOffset] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(380);
  const [view, setView] = useState<DeckView>({ type: 'list' });
  const [menu, setMenu] = useState<null | 'create' | 'templates'>(null);
  const [hubUrlDraft, setHubUrlDraft] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [failedInstallId, setFailedInstallId] = useState<string | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [undo, setUndo] = useState<RemovedUserSkill | null>(null);
  const [preview, setPreview] = useState<{ key: string; top: number; side: 'left' | 'above' } | null>(null);
  // -1 = 焦点仍在输入框，列表无高亮。
  const [highlight, setHighlight] = useState(-1);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const reduceMotion = useReducedMotion();
  const language = useWorkspaceStore(state => state.language);
  const copy = SKILL_COPY[language];

  const { hubUrl, hubStatus, hubError, hubSkills, registryStatus, setHubUrl, syncHub, refreshLocal, installFromHub, uninstallSkill } = useSkillHubStore();
  const userSkills = useUserSkillsStore(state => state.skills);
  const disabledIds = useUserSkillsStore(state => state.disabledIds);
  const userSkillsLoaded = useUserSkillsStore(state => state.loaded);
  const toggleFavorite = useUserSkillsStore(state => state.toggleFavorite);
  const catalog = useSkillCatalog(copy);
  const { favoriteIds } = catalog;

  useEffect(() => { setHubUrlDraft(hubUrl); }, [hubUrl]);
  useEffect(() => { if (open) void refreshLocal(); }, [open, refreshLocal]);
  useEffect(() => { if (!useUserSkillsStore.getState().loaded) void useUserSkillsStore.getState().load(); }, []);
  useEffect(() => {
    if (searchQuery === undefined) return;
    setView({ type: 'list' });
    setQuery(searchQuery);
  }, [searchQuery]);
  useEffect(() => { if (!open) { setView({ type: 'list' }); setMenu(null); setPreview(null); setSearchOpen(false); } }, [open]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  // 放大的 Skills 窗口里「使用」也走这里，附到同一个 Composer。
  useEffect(() => {
    if (showWelcome) return;
    return useStudioHubStore.getState().register('attachSkill', value => onChange(value));
  }, [onChange, showWelcome]);

  // 当前附着的 Skill 跟随它的权威：我的 Skill 被编辑 → 换新指纹；被删除或停用 → 撤掉附件。
  useEffect(() => {
    if (!attachment || !userSkillsLoaded) return;
    if (isUserSkillAttachment(attachment)) {
      const record = userSkills.find(skill => skill.id === attachment.id);
      if (!record || record.enabled === false) { onChange(undefined); return; }
      const fresh = userSkillAttachment(record);
      if (fresh.contentHash !== attachment.contentHash || fresh.displayName !== attachment.displayName) onChange(fresh);
      return;
    }
    if (!isSkillEnabled({ skills: userSkills, disabledIds }, attachment.id)) onChange(undefined);
  }, [attachment, userSkills, disabledIds, userSkillsLoaded, onChange]);

  // 弹性高度：浮层从 composer 向上弹出，高度按可用空间收缩；观察锚点自身尺寸。
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = dropTargetRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAvailableHeight(Math.max(260, Math.min(460, Math.floor(rect.top - 64))));
    };
    measure();
    const target = dropTargetRef.current;
    const observer = typeof ResizeObserver === 'undefined' || !target ? null : new ResizeObserver(measure);
    observer?.observe(target);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [open, dropTargetRef]);

  const favoritesFirst = (skills: DeckSkill[]) => [...skills.filter(skill => favoriteIds.has(skill.id)), ...skills.filter(skill => !favoriteIds.has(skill.id))];
  const hubOnly = useMemo(() => catalog.hub.filter(skill => !skill.installed || skill.updateAvailable), [catalog.hub]);
  const tabSkills = useMemo(() => {
    if (tab === 'mine') return [...catalog.mine, ...catalog.installed.filter(skill => skill.source === 'local')];
    if (tab === 'favorites') {
      const seen = new Set<string>();
      return [...catalog.mine, ...catalog.installed, ...catalog.hub].filter(skill => favoriteIds.has(skill.id) && !seen.has(skill.id) && Boolean(seen.add(skill.id)));
    }
    return favoritesFirst([...catalog.mine, ...catalog.installed]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, catalog, favoriteIds]);
  const visible = useMemo(() => tabSkills.filter(skill => skillMatches(skill, query)), [tabSkills, query]);
  const visibleHub = useMemo(() => (tab === 'all' ? hubOnly.filter(skill => skillMatches(skill, query)) : []), [tab, hubOnly, query]);
  // 键盘在能直接选用的行之间走（跳过停用与未安装的 Hub 行）。
  const navSkills = useMemo(() => visible.filter(skill => skill.enabled && skill.installed), [visible]);
  // 斜杠命令：键盘序号命令在前、Skill 在后（highlight < commandCount 指向命令）。
  const visibleCommands = useMemo(
    () => (tab === 'all' && onCommand && searchQuery !== undefined ? matchSlashCommands(commands, searchQuery) : []),
    [tab, commands, onCommand, searchQuery],
  );
  const commandCount = visibleCommands.length;
  const navCount = commandCount + navSkills.length;
  const navSkillAt = (index: number) => (index >= commandCount ? navSkills[index - commandCount] : undefined);
  /** 命令 Enter：输入正好是完整命令名时直接执行，否则写进输入框等补参数；Tab 只补全。 */
  const pickCommand = (command: AgentSlashCommand, key: string) => {
    const exact = command.name.toLowerCase() === String(searchQuery || '').trim().toLowerCase();
    onCommand?.(command, { run: key === 'Enter' && exact });
  };
  // 每次筛选后高亮第一项（Enter 直接选中）；composer 里刚敲 `/` 还没筛选时保持在输入框（-1）。
  const createMenuKeys = useMenuKeyboard({ open: menu !== null, onClose: () => setMenu(null) });
  // 从按钮打开（非 composer 里的 `/`）时把焦点放进浮层，键盘立刻可用：打字即搜索。
  useEffect(() => {
    if (!open || searchQuery !== undefined) return;
    const frame = requestAnimationFrame(() => { if (!pickerRef.current?.contains(document.activeElement)) pickerRef.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [open, searchQuery]);
  const firstNav = navCount && (query || searchQuery === undefined) ? 0 : -1;
  useEffect(() => { setHighlight(firstNav); }, [query, open, view.type, tab, firstNav]);
  const highlightedKey = highlight < 0 ? undefined
    : highlight < commandCount ? 'command:' + visibleCommands[highlight].id
      : navSkillAt(highlight)?.key;
  const rowId = (key: string) => `${listId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const welcomeSource = useMemo(() => [...catalog.installed, ...catalog.mine].filter(skill => skill.enabled), [catalog.installed, catalog.mine]);
  const welcomeSkills = useMemo(() => welcomeSource.length
    ? Array.from({ length: Math.min(4, welcomeSource.length) }, (_, index) => welcomeSource[(shuffleOffset + index) % welcomeSource.length])
    : [], [shuffleOffset, welcomeSource]);
  const allSkills = useMemo(() => [...catalog.mine, ...catalog.installed, ...catalog.hub], [catalog]);

  const attach = async (skill: DeckSkill, seedPrompt = false) => {
    if (loading || !skill.enabled) return;
    setLoading(true);
    setDeckError(null);
    try {
      const { attachment: next, inputs } = await resolveSkillAttachment(skill, copy);
      onChange(next);
      if (seedPrompt) onPromptChange?.(buildProductionSkillStarterPrompt({ id: skill.id, version: skill.version || '', displayName: skill.name, inputs }));
      setOpen(false);
      setQuery('');
    } catch (error) {
      setDeckError(skillRegistryErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!keyboardRef) return;
    keyboardRef.current = (key: string) => {
      if (!open) return false;
      if (key === 'Escape') { setOpen(false); return true; }
      if (view.type !== 'list') return false;
      const count = navCount;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        // ↑ 越过第一项回到输入框（不消费），让光标照常移动。
        if (key === 'ArrowUp' && highlight < 0) return false;
        setHighlight(index => nextHighlight(index, count, key === 'ArrowDown' ? 1 : -1, { exitAbove: true }));
        return true;
      }
      // 未进入列表时也吞掉 Enter，避免把半截 /xxx 当消息发出去；Tab 只在有高亮时消费。
      if (key === 'Enter' || key === 'Tab') {
        if (highlight >= 0 && highlight < commandCount) { pickCommand(visibleCommands[highlight], key); return true; }
        const skill = navSkillAt(highlight);
        if (skill) { void attach(skill); return true; }
        // 没进列表、输入的正好是完整命令名（例如 /compact）：Enter 直接执行。
        const exact = key === 'Enter' ? visibleCommands.find(command => command.name.toLowerCase() === String(searchQuery || '').trim().toLowerCase()) : undefined;
        if (exact) { onCommand?.(exact, { run: true }); return true; }
        return key === 'Enter';
      }
      return false;
    };
    return () => { keyboardRef.current = null; };
  });

  const startInstall = async (skill: DeckSkill) => {
    if (!hubUrl) { setDeckError(copy.configureHub); return; }
    setInstallingId(skill.id);
    setFailedInstallId(null);
    setDeckError(null);
    try {
      await installFromHub(skill.id);
    } catch (error) {
      setFailedInstallId(skill.id);
      setDeckError(skillRegistryErrorMessage(error));
    } finally {
      setInstallingId(null);
    }
  };

  const droppedInComposer = (point: { x: number; y: number }) => {
    const rect = dropTargetRef.current?.getBoundingClientRect();
    return Boolean(rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  };

  const removeMine = async (skill: DeckSkill) => {
    const removed = await useUserSkillsStore.getState().remove(skill.id);
    setView({ type: 'list' });
    if (removed) setUndo(removed);
  };

  const undoRemove = async () => {
    if (!undo) return;
    const removed = undo;
    setUndo(null);
    await useUserSkillsStore.getState().restore(removed);
  };

  const importSkill = async () => {
    setMenu(null);
    const file = await pickTextFile('.md,.markdown,.json,text/markdown,application/json');
    if (!file) return;
    const parsed = parseSkillImport(file.text, file.name);
    if (!parsed) { setDeckError(copy.importFailed); return; }
    setView({ type: 'edit', id: null, initial: { ...parsed, enabled: true } });
  };

  // 悬停预览：浮层左侧有空间就放左边，否则放上方，都没有就不显示（窄面板 / 触屏）。
  const showPreview = (skill: DeckSkill, row: HTMLElement) => {
    const picker = pickerRef.current;
    if (!picker || (typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches)) return;
    const rect = picker.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const side = previewPlacement(picker, PREVIEW_WIDTH, 204);
    if (side === 'left') {
      setPreview({ key: skill.key, side: 'left', top: Math.max(0, Math.min(rowRect.top - rect.top - 8, rect.height - 200)) });
    } else if (side === 'above') {
      setPreview({ key: skill.key, side: 'above', top: 0 });
    } else {
      setPreview(null);
    }
  };

  const openFullHub = () => {
    useStudioHubStore.getState().openHub('skills', tab === 'favorites' ? 'favorites' : tab === 'mine' ? 'mine' : 'all');
    setOpen(false);
  };

  const stateFor = (skill: DeckSkill) => {
    if (!skill.enabled) return <span className="skill-hub__state is-off">{copy.disabled}</span>;
    if (attachment?.id === skill.id) return <span className="skill-hub__state is-active"><Check size={12} aria-hidden="true" /><span>{copy.inUse}</span></span>;
    return <span className="skill-hub__state is-added" title={copy.added}><Check size={12} aria-hidden="true" /><span>{copy.added}</span></span>;
  };

  const hubAction = (skill: DeckSkill) => {
    if (installingId === skill.id) return <span className="skill-hub__add is-busy" role="status" aria-label={copy.syncing}><RefreshCw size={13} className="is-spinning" aria-hidden="true" /></span>;
    if (skill.installed && !skill.updateAvailable) return <span className="skill-hub__state is-added"><Check size={12} aria-hidden="true" /><span>{copy.added}</span></span>;
    if (skill.updateAvailable) return <button type="button" className="skill-hub__add is-wide" onClick={() => void startInstall(skill)}><RefreshCw size={12} aria-hidden="true" /><span>{copy.update}</span></button>;
    if (failedInstallId === skill.id) return <button type="button" className="skill-hub__add is-wide is-failed" aria-label={copy.install(skill.name)} onClick={() => void startInstall(skill)}><RefreshCw size={12} aria-hidden="true" /><span>{copy.retry}</span></button>;
    return <button type="button" className="skill-hub__add" aria-label={copy.install(skill.name)} title={copy.install(skill.name)} onClick={() => void startInstall(skill)}><Plus size={15} aria-hidden="true" /></button>;
  };

  const detailsButton = (skill: DeckSkill) => (
    <button type="button" className="skill-hub__details" aria-label={copy.details(skill.name)} title={copy.details(skill.name)} onClick={() => { setPreview(null); setView({ type: 'detail', key: skill.key }); }}>
      <span>{language === 'zho' ? '详情' : 'Details'}</span><ChevronRight size={12} aria-hidden="true" />
    </button>
  );

  const renderRow = (skill: DeckSkill) => {
    const highlighted = skill.key === highlightedKey;
    const hub = skill.source === 'hub';
    const skillIndex = navSkills.findIndex(item => item.key === skill.key);
    const navIndex = skillIndex >= 0 ? skillIndex + commandCount : -1;
    return (
      <motion.div
        key={skill.key}
        id={rowId(skill.key)}
        whileTap={reduceMotion || hub ? undefined : { scale: 0.99 }}
        drag={!hub && skill.enabled}
        dragElastic={0.14}
        dragSnapToOrigin
        onDragEnd={(_, info) => { if (droppedInComposer(info.point)) void attach(skill); }}
        transition={{ type: 'spring', visualDuration: 0.22, bounce: 0 }}
        className={`skill-hub__row${highlighted ? ' is-highlighted' : ''}${preview?.key === skill.key ? ' is-previewed' : ''}${hub ? ' skill-hub__row--hub' : ''}`}
        data-highlighted={highlighted || undefined}
        data-disabled={!skill.enabled || undefined}
        ref={highlighted ? (element: HTMLDivElement | null) => element?.scrollIntoView?.({ block: 'nearest' }) : undefined}
        role={hub ? undefined : 'group'}
        aria-label={skill.name}
        onMouseEnter={event => { if (navIndex >= 0) setHighlight(navIndex); showPreview(skill, event.currentTarget); }}
        onMouseLeave={() => setPreview(current => (current?.key === skill.key ? null : current))}
      >
        {hub ? (
          <div className="skill-hub__row-main is-static">
            <SkillMark seed={skill.seed} />
            <span className="skill-hub__text"><strong><span>{skill.name}</span><em>{skill.handle}</em></strong><small>{skill.description}</small></span>
          </div>
        ) : (
          <button type="button" className="skill-hub__row-main" aria-label={copy.add(skill.name)} disabled={loading || !skill.enabled} onClick={() => void attach(skill)}>
            <SkillMark seed={skill.seed} cover={skill.cover} />
            <span className="skill-hub__text"><strong><span>{skill.name}</span><em>{skill.handle}</em></strong><small>{skill.description}</small></span>
          </button>
        )}
        {detailsButton(skill)}
        {hub ? hubAction(skill) : stateFor(skill)}
      </motion.div>
    );
  };

  const renderCommandRow = (command: AgentSlashCommand, index: number) => {
    const key = 'command:' + command.id;
    const highlighted = key === highlightedKey;
    return (
      <div
        key={key}
        id={rowId(key)}
        className={`skill-hub__row agent-slash-command${highlighted ? ' is-highlighted' : ''}`}
        data-highlighted={highlighted || undefined}
        data-testid={'agent-slash-command-' + command.id}
        ref={highlighted ? (element: HTMLDivElement | null) => element?.scrollIntoView?.({ block: 'nearest' }) : undefined}
        role="group"
        aria-label={'/' + command.name}
        onMouseEnter={() => { setHighlight(index); setPreview(null); }}
      >
        <button type="button" className="skill-hub__row-main" onClick={() => pickCommand(command, 'Tab')}>
          <span className="agent-slash-command__mark" aria-hidden="true"><Minimize2 size={15} /></span>
          <span className="skill-hub__text"><strong><span>/{command.name}</span>{command.args && <em>{command.args}</em>}</strong><small>{command.description}</small></span>
        </button>
      </div>
    );
  };

  const previewSkill = preview ? allSkills.find(skill => skill.key === preview.key) : undefined;
  const previewRecord = previewSkill?.source === 'mine' ? userSkills.find(item => item.id === previewSkill.id) : undefined;
  const previewBody = previewRecord?.prompt || (previewSkill?.source === 'bundled' ? getBundledProductionSkill(previewSkill.id)?.description : undefined) || previewSkill?.description || '';
  const sourceLabel = (skill: DeckSkill) => (skill.source === 'bundled' ? copy.sourceBundled : skill.source === 'local' ? copy.sourceLocal : skill.source === 'mine' ? copy.sourceMine : copy.sourceHub);

  const emptyText = tab === 'favorites' && !query ? copy.favoritesEmpty
    : query ? copy.noMatch
      : tab === 'mine' ? copy.mineEmpty
        : registryStatus === 'unavailable' ? copy.desktopScan : copy.noLocal;

  // 搜索框与浮层其他位置共用：↑/↓ 移动，Enter / Tab 选中，Esc 先清空搜索再关闭。
  const listKey = (event: ReactKeyboardEvent): boolean => {
    const key = event.key;
    const done = () => { event.preventDefault(); event.stopPropagation(); return true; };
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const count = navCount;
      setHighlight(index => nextHighlight(index, count, key === 'ArrowDown' ? 1 : -1, { exitAbove: true }));
      return done();
    }
    if ((key === 'Enter' || key === 'Tab') && highlight >= 0 && highlight < commandCount) { pickCommand(visibleCommands[highlight], key); return done(); }
    if ((key === 'Enter' || key === 'Tab') && navSkillAt(highlight)) { void attach(navSkillAt(highlight)!); return done(); }
    if (key === 'Escape') {
      if (query && searchQuery === undefined) { setQuery(''); return done(); }
      setOpen(false);
      return done();
    }
    return false;
  };

  // 焦点在浮层其他位置（标签页、行按钮）时：可打印字符打开搜索并写进去，方向键 / Enter / Esc 照常。
  const pickerKey = (event: ReactKeyboardEvent) => {
    if (view.type !== 'list' || menu || event.defaultPrevented || isComposingEvent(event) || isEditableElement(event.target)) return;
    if (searchQuery === undefined && isPrintableKey(event) && event.key !== ' ') {
      setSearchOpen(true);
      setQuery(value => value + event.key);
      event.preventDefault();
      return;
    }
    if (searchQuery === undefined && event.key === 'Backspace' && query) { setQuery(value => value.slice(0, -1)); event.preventDefault(); return; }
    const onButton = (event.target as HTMLElement).tagName === 'BUTTON';
    if (onButton && (event.key === 'Enter' || event.key === 'Tab')) return;
    listKey(event);
  };

  const listBody = (
    <>
      <div className="skill-hub__tabs" role="tablist" aria-label={copy.title}>
        {([['all', copy.tabAll], ['favorites', copy.tabFavorites], ['mine', copy.tabMine]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
            {tab === id && <motion.span layoutId={`${listId}-tab-pill`} className="skill-hub__tab-pill" transition={reduceMotion ? { duration: 0 } : { type: 'spring', visualDuration: 0.22, bounce: 0 }} />}
            <span>{label}</span>
          </button>
        ))}
      </div>
      {(searchOpen || query || searchQuery !== undefined) && (
        <label className="skill-hub__search">
          <Search size={14} aria-hidden="true" />
          <input
            autoFocus={searchQuery === undefined}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={highlightedKey ? rowId(highlightedKey) : undefined}
            aria-label={copy.search}
            placeholder={copy.search}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (isComposingEvent(event)) return; if (keyboardRef?.current?.(event.key)) event.preventDefault(); else listKey(event); }}
          />
          {query && <button type="button" className="skill-hub__search-clear" aria-label={copy.cancel} onClick={() => setQuery('')}><X size={12} aria-hidden="true" /></button>}
        </label>
      )}
      <div className="skill-hub__list" id={listId} role="listbox" aria-label={copy.title} onMouseLeave={() => setPreview(null)} onScroll={() => setPreview(null)}>
        <section className="skill-hub__section" aria-label={tab === 'mine' ? copy.sectionMine : tab === 'favorites' ? copy.tabFavorites : copy.sectionInstalled}>
          {commandCount > 0 && (
            <div className="agent-slash-command__group" role="group" aria-label={translations[language].agentPanel.slashCommands}>
              <div className="agent-slash-command__label">{translations[language].agentPanel.slashCommands}</div>
              {visibleCommands.map(renderCommandRow)}
              {visible.length > 0 && <div className="agent-slash-command__label">Skill</div>}
            </div>
          )}
          {visible.map(renderRow)}
          {!visible.length && !commandCount && !(tab === 'all' && visibleHub.length) && (
            tab === 'mine' && !query
              ? <button type="button" className="skill-hub__inline-empty" onClick={() => setView({ type: 'edit', id: null })}><Plus size={13} aria-hidden="true" /><span>{copy.mineEmpty} · {copy.newSkill}</span></button>
              : <div className="skill-hub__empty" role="status">{emptyText}</div>
          )}
        </section>
        {tab === 'all' && (
          <section className="skill-hub__section" aria-label={copy.sectionHub}>
            <div className="skill-hub__label-row">
              <h3 className="skill-hub__label">{copy.sectionHub}</h3>
              {hubSkills.length > 0 && <span className="skill-hub__count">{hubSkills.length}</span>}
            </div>
            <div className="skill-hub__hub-config">
              <input aria-label={copy.hubAddress} placeholder={copy.hubAddress} value={hubUrlDraft} onChange={event => setHubUrlDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && hubUrlDraft) { setHubUrl(hubUrlDraft); void syncHub(); } }} />
              <button type="button" disabled={!hubUrlDraft || hubStatus === 'syncing'} onClick={() => { setHubUrl(hubUrlDraft); void syncHub(); }}>
                <RefreshCw size={12} className={hubStatus === 'syncing' ? 'is-spinning' : ''} aria-hidden="true" />
                <span>{hubStatus === 'syncing' ? copy.syncing : copy.sync}</span>
              </button>
            </div>
            {hubStatus === 'error' && hubError && <div className="skill-hub__error" role="alert">{hubError}</div>}
            {hubStatus === 'syncing' && !hubSkills.length && <div className="skill-hub__skeletons" aria-hidden="true"><span /><span /><span /></div>}
            {visibleHub.map(renderRow)}
            {/* 已安装的 Hub Skill 出现在上方，并在这里保留「已添加」状态。 */}
            {catalog.hub.filter(skill => skill.installed && !skill.updateAvailable && skillMatches(skill, query)).map(renderRow)}
            {!hubSkills.length && hubStatus !== 'syncing' && <div className="skill-hub__empty">{hubStatus === 'error' ? copy.hubFailed : copy.hubEmpty}</div>}
          </section>
        )}
        {deckError && <div className="skill-hub__error" role="alert">{deckError}</div>}
      </div>
      <footer className="skill-hub__footer">
        <button type="button" onClick={openFullHub}><span>{copy.viewMore}</span><ChevronRight size={13} aria-hidden="true" /></button>
      </footer>
    </>
  );

  const detailSkill = view.type === 'detail' ? allSkills.find(skill => skill.key === view.key) : undefined;
  const editingRecord = view.type === 'edit' && view.id ? userSkills.find(skill => skill.id === view.id) : undefined;
  const headerTitle = view.type === 'edit' ? (view.id ? copy.editSkill : copy.newSkill) : view.type === 'detail' ? (detailSkill?.name || copy.title) : 'Skill';

  return (
    <>
      {showWelcome && !attachment && welcomeSkills.length > 0 && (
        <section className="agent-skill-welcome" aria-label={copy.recommendedSkills}>
          <div className="agent-skill-welcome__heading">
            <BookOpen size={18} />
            <h2>{copy.welcome}</h2>
            {welcomeSkills.length > 1 && <button type="button" onClick={() => setShuffleOffset(value => (value + 1) % welcomeSkills.length)}><Shuffle size={12} />{copy.shuffle}</button>}
          </div>
          <div className="agent-skill-welcome__grid">
            {welcomeSkills.map((skill, index) => (
              <motion.button key={`${skill.key}-${index}`} type="button" className="agent-skill-card" aria-label={copy.useSkill(skill.name)} onClick={() => void attach(skill, true)}
                whileHover={reduceMotion ? undefined : { y: -2 }} whileTap={reduceMotion ? undefined : { scale: .98 }} transition={{ type: 'spring', visualDuration: 0.22, bounce: 0 }}>
                <SkillMark seed={skill.seed} cover={skill.cover} />
                <span><strong>{skill.name}</strong><small>{skill.handle}</small></span>
              </motion.button>
            ))}
          </div>
        </section>
      )}
      {!showWelcome && <div className="agent-skill-control">
        {attachment ? (
          <span className="agent-skill-chip">
            <BookOpen size={13} />
            <span>{attachment.displayName}</span>
            <button type="button" aria-label={copy.remove(attachment.displayName)} onClick={() => onChange(undefined)}><X size={11} /></button>
          </span>
        ) : (
          <button type="button" aria-label={copy.chooseSkill} className="agent-composer-tool" onClick={() => setOpen(value => !value)}>
            <BookOpen size={16} /><span>Skill</span><ChevronDown size={12} />
          </button>
        )}
        <AnimatePresence>
          {open && (
            <motion.div
              ref={pickerRef}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
              transition={reduceMotion ? { duration: 0.12 } : { type: 'spring', visualDuration: 0.22, bounce: 0 }}
              className="agent-skill-picker skill-hub"
              role="dialog"
              aria-label={language === 'en' ? 'Skill picker' : 'Skill'}
              style={{ maxHeight: availableHeight }}
              tabIndex={-1}
              onKeyDown={pickerKey}
            >
              <header className="skill-hub__header">
                {view.type !== 'list' && (
                  <button type="button" className="skill-hub__icon-btn" aria-label={copy.back} title={copy.back} onClick={() => setView({ type: 'list' })}><ChevronLeft size={15} aria-hidden="true" /></button>
                )}
                <strong className="skill-hub__title">{headerTitle}</strong>
                {view.type === 'list' && (
                  <>
                    <button type="button" className={`skill-hub__head-btn${searchOpen ? ' is-on' : ''}`} aria-label={copy.searchToggle} aria-pressed={searchOpen} onClick={() => setSearchOpen(value => !value)}>
                      <Search size={13} aria-hidden="true" /><span>{copy.searchToggle}</span>
                    </button>
                    <div className="skill-hub__menu-anchor">
                      <button type="button" className="skill-hub__create" aria-haspopup="menu" aria-expanded={menu !== null} onClick={() => setMenu(value => (value ? null : 'create'))}>
                        <Plus size={14} aria-hidden="true" /><span>{copy.createMenu}</span><ChevronDown size={12} aria-hidden="true" />
                      </button>
                      {menu && (
                        <div className="skill-hub__menu" role="menu" aria-label={copy.createMenu} {...createMenuKeys} key={menu}>
                          {menu === 'create' ? (
                            <>
                              <button type="button" role="menuitem" onClick={() => { setMenu(null); setView({ type: 'edit', id: null }); }}><Plus size={13} aria-hidden="true" /><span>{copy.createBlank}</span></button>
                              <button type="button" role="menuitem" onClick={() => setMenu('templates')}><LayoutTemplate size={13} aria-hidden="true" /><span>{copy.createFromTemplate}</span><ChevronRight size={12} aria-hidden="true" /></button>
                              <button type="button" role="menuitem" onClick={() => void importSkill()}><FileUp size={13} aria-hidden="true" /><span>{copy.createImport}</span></button>
                            </>
                          ) : skillTemplates(language).map(template => (
                            <button key={template.id} type="button" role="menuitem" title={template.description} onClick={() => { setMenu(null); setView({ type: 'edit', id: null, initial: { name: template.name, slug: template.slug, description: template.description, prompt: template.prompt, enabled: true } }); }}>
                              <Sparkles size={13} aria-hidden="true" /><span>{template.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button type="button" className="skill-hub__head-btn" onClick={openFullHub}><span>{copy.more}</span><ChevronRight size={13} aria-hidden="true" /></button>
                  </>
                )}
                <button type="button" className="skill-hub__close" aria-label={copy.close} onClick={() => setOpen(false)}><X size={15} aria-hidden="true" /></button>
              </header>
              {view.type === 'list' && listBody}
              {view.type === 'detail' && detailSkill && (
                <SkillDetail
                  key={detailSkill.key}
                  skill={detailSkill}
                  copy={copy}
                  language={language}
                  attached={attachment?.id === detailSkill.id}
                  hubUrl={hubUrl}
                  installing={installingId === detailSkill.id}
                  favorite={favoriteIds.has(detailSkill.id)}
                  onToggleFavorite={() => void toggleFavorite(detailSkill.id)}
                  onUse={() => void attach(detailSkill)}
                  onToggleEnabled={enabled => void useUserSkillsStore.getState().setEnabled(detailSkill.id, enabled)}
                  onEdit={() => setView({ type: 'edit', id: detailSkill.id })}
                  onDelete={() => void removeMine(detailSkill)}
                  onUninstall={async () => { await uninstallSkill(detailSkill.id); setView({ type: 'list' }); }}
                  onInstall={() => void startInstall(detailSkill)}
                  onRefresh={() => void refreshLocal()}
                />
              )}
              {view.type === 'detail' && !detailSkill && <div className="skill-hub__empty">{copy.noMatch}</div>}
              {view.type === 'edit' && (
                <SkillEditor
                  key={view.id || 'new'}
                  copy={copy}
                  initial={editingRecord ? { name: editingRecord.name, slug: editingRecord.slug, description: editingRecord.description, prompt: editingRecord.prompt, enabled: editingRecord.enabled !== false } : view.initial || EMPTY_DRAFT}
                  onCancel={() => setView(view.id ? { type: 'detail', key: `mine:${view.id}` } : { type: 'list' })}
                  onSave={async draft => {
                    const saved = view.id ? await useUserSkillsStore.getState().update(view.id, draft) : await useUserSkillsStore.getState().create(draft);
                    setView({ type: 'detail', key: `mine:${saved.id}` });
                  }}
                />
              )}
              {undo && (
                <div className="skill-hub__undo" role="status">
                  <span>{copy.deleted(undo.skill.name)}</span>
                  <button type="button" onClick={() => void undoRemove()}>{copy.undo}</button>
                </div>
              )}
              <AnimatePresence>
                {view.type === 'list' && previewSkill && preview && (
                  <motion.aside
                    key={previewSkill.key}
                    className="skill-hub__preview"
                    data-side={preview.side}
                    style={preview.side === 'left' ? { top: preview.top } : undefined}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: preview.side === 'left' ? 6 : 0, y: preview.side === 'above' ? 6 : 0 }}
                    animate={{ opacity: 1, x: 0, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={reduceMotion ? { duration: 0.1 } : { type: 'spring', visualDuration: 0.22, bounce: 0 }}
                    aria-hidden="true"
                  >
                    <div className="skill-hub__preview-cover" data-tone-seed={previewSkill.seed % 4}>
                      {previewSkill.cover ? <img src={previewSkill.cover} alt="" /> : <SkillMark seed={previewSkill.seed} large />}
                      <span className="skill-hub__badge">{sourceLabel(previewSkill)}</span>
                      {favoriteIds.has(previewSkill.id) && <Heart size={13} className="skill-hub__preview-like" fill="currentColor" aria-hidden="true" />}
                    </div>
                    <div className="skill-hub__preview-body">
                      <strong>{previewSkill.name}</strong>
                      <em>{previewSkill.handle}</em>
                      <p>{previewBody}</p>
                    </div>
                    {previewSkill.source === 'hub' && hubUrl && <span className="skill-hub__preview-link"><ExternalLink size={11} aria-hidden="true" />{copy.viewInHub}</span>}
                  </motion.aside>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>}
    </>
  );
}

export { hubSkillExternalUrl };
