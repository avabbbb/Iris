import { BookOpen, Check, ChevronDown, Download, ExternalLink, Globe, Minimize2, Plus, RefreshCw, Search, Shuffle, Sparkles, Star, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import localforage from 'localforage';

import {
  createProductionSkillAttachment,
  createSkillAttachment,
  getBundledProductionSkill,
  listBundledProductionSkills,
  type ProductionSkillAttachment,
} from '../../services/productionSkillCatalog';
import { createLocalSkillRegistry, skillRegistryErrorMessage } from '../../services/localSkillRegistry';
import { hubSkillExternalUrl } from '../../services/skillHubClient';
import { buildProductionSkillStarterPrompt, productionSkillHandle } from '../../services/productionSkillLaunch';
import type { SkillInputSlot } from '../../services/skillInputs';
import { useSkillHubStore } from '../../stores/useSkillHubStore';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { translations } from '../../utils/translations';
import { matchSlashCommands, type AgentSlashCommand } from './agentSlashCommands';

const SKILL_ACCENTS = [
  ['#f4b452', '#df6b3f'],
  ['#5fc8bb', '#23767b'],
  ['#7f8de7', '#7355ad'],
  ['#d77f9c', '#8d4469'],
] as const;

const FAVORITES_KEY = 'flovart.skill.favorites.v1';

const COPY = {
  en: {
    installedDescription: 'A Production Skill installed locally.',
    hubDescription: 'A Skill from an external hub.',
    missingBundled: 'Built-in Skill is unavailable',
    desktopRequired: 'Connect a desktop Managed Agent to choose a local Skill.',
    configureHub: 'Enter a Skill Hub address first.',
    welcome: 'Every Skill opens a new direction',
    recommendedSkills: 'Recommended production Skills',
    shuffle: 'Shuffle',
    useSkill: (name: string) => `Use Skill ${name}`,
    remove: (name: string) => `Remove ${name}`,
    chooseSkill: 'Choose a production Skill',
    create: 'Create',
    close: 'Close Skill picker',
    categories: 'Skill categories',
    local: 'Local',
    favoriteCount: (count: number) => ` (${count} favorites)`,
    hubCount: (count: number) => ` (${count})`,
    search: 'Search Skills',
    desktopScan: 'Connect the desktop app to scan local Skill folders.',
    noMatch: 'No matching Skills found.',
    noLocal: 'No Production Skills are available locally.',
    hubAddress: 'Skill Hub address',
    syncing: 'Syncing',
    sync: 'Sync',
    hubFailed: 'Skill Hub sync failed.',
    hubEmpty: 'No Skills in this hub, or no address is configured.',
    viewHub: (name: string) => `View ${name} in Skill Hub`,
    update: 'Update',
    installed: 'Installed',
    install: 'Install',
    add: (name: string) => `Add ${name}`,
    details: 'Details',
    favorite: (name: string) => `Add ${name} to favorites`,
    unfavorite: (name: string) => `Remove ${name} from favorites`,
  },
  zho: {
    installedDescription: '本地已安装的 Production Skill。',
    hubDescription: '来自外部 Skill Hub。',
    missingBundled: '内置 Skill 不存在',
    desktopRequired: '选择本地 Skill 需要桌面端 Managed Agent 连接。',
    configureHub: '请先配置 Skill Hub 地址。',
    welcome: '每个 Skill，都是一个开场',
    recommendedSkills: '推荐制作 Skill',
    shuffle: '换一批',
    useSkill: (name: string) => `使用 Skill ${name}`,
    remove: (name: string) => `移除 ${name}`,
    chooseSkill: '选择制作 Skill',
    create: '创建',
    close: '关闭 Skill',
    categories: 'Skill 分类',
    local: '本地',
    favoriteCount: (count: number) => `（${count} 收藏）`,
    hubCount: (count: number) => `（${count}）`,
    search: '搜索 Skill',
    desktopScan: '连接桌面端后可扫描本机 Skill 目录',
    noMatch: '未找到匹配的 Skill',
    noLocal: '本机还没有可用的 Production Skill',
    hubAddress: 'Skill Hub 地址',
    syncing: '同步中',
    sync: '同步',
    hubFailed: 'Hub 同步失败',
    hubEmpty: 'Hub 暂无 Skill，或尚未配置地址',
    viewHub: (name: string) => `在 Hub 查看 ${name}`,
    update: '更新',
    installed: '已安装',
    install: '安装',
    add: (name: string) => `添加 ${name}`,
    details: '详情',
    favorite: (name: string) => `收藏 ${name}`,
    unfavorite: (name: string) => `取消收藏 ${name}`,
  },
} as const;

interface DeckSkill {
  key: string;
  id: string;
  name: string;
  description: string;
  version: string | null;
  handle: string;
  cover?: string;
  accent: readonly [string, string];
  source: 'bundled' | 'local' | 'hub';
  installed: boolean;
  updateAvailable: boolean;
}

function handleFor(id: string): string {
  return `$${id.split('.').at(-1) || id}`;
}

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
  /** 输入框把方向键/Enter 转交给列表：↓ 进入列表，↑ 越过第一项回到输入框，Enter 选中高亮项。返回 true 表示已消费。 */
  keyboardRef?: { current: ((key: string) => boolean) | null };
  /** 斜杠命令（/compact 等）：只在「/」打开的菜单里显示，排在 Skill 前面。 */
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
  const [shuffleOffset, setShuffleOffset] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(380);
  const [activeTab, setActiveTab] = useState<'local' | 'hub'>('local');
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(new Set());
  const [hubUrlDraft, setHubUrlDraft] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [deckError, setDeckError] = useState<string | null>(null);
  // -1 = 焦点仍在输入框，列表无高亮。
  const [highlight, setHighlight] = useState(-1);
  const reduceMotion = useReducedMotion();
  const language = useWorkspaceStore(state => state.language);
  const copy = COPY[language];

  const {
    hubUrl,
    hubStatus,
    hubError,
    hubSkills,
    localSkills,
    registryStatus,
    setHubUrl,
    syncHub,
    refreshLocal,
    installFromHub,
  } = useSkillHubStore();

  useEffect(() => { setHubUrlDraft(hubUrl); }, [hubUrl]);
  useEffect(() => { if (open) void refreshLocal(); }, [open, refreshLocal]);
  useEffect(() => {
    if (searchQuery === undefined) return;
    setActiveTab('local');
    setQuery(searchQuery);
  }, [searchQuery]);
  useEffect(() => { setHighlight(-1); }, [query, open, activeTab]);

  // 收藏持久化到本地（localforage）
  useEffect(() => {
    let active = true;
    void localforage.getItem<string[]>(FAVORITES_KEY).then(stored => {
      if (active && Array.isArray(stored)) setFavoriteIds(new Set(stored));
    });
    return () => { active = false; };
  }, []);

  const toggleFavorite = (id: string) => {
    setFavoriteIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      void localforage.setItem(FAVORITES_KEY, [...next]);
      return next;
    });
  };

  // 弹性高度：picker 从 composer 向上弹出，高度按可用空间比例收缩，避免顶部被面板/视口裁切。
  // 这是浮层行为几何（不是页面布局）：观察锚点自身尺寸，避免让整个 App
  // 在每个 viewport resize tick 上重渲染。
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = dropTargetRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAvailableHeight(Math.max(260, Math.min(420, Math.floor(rect.top - 64))));
    };
    measure();
    const target = dropTargetRef.current;
    const observer = typeof ResizeObserver === 'undefined' || !target
      ? null
      : new ResizeObserver(measure);
    observer?.observe(target);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [open, dropTargetRef]);

  const bundledSkills = listBundledProductionSkills();
  const bundledId = bundledSkills[0]?.id || '';
  const localProduction = useMemo(
    () => localSkills.filter(skill => skill.kind === 'production' && skill.id !== bundledId),
    [localSkills, bundledId],
  );

  const localDeckSkills = useMemo<DeckSkill[]>(() => {
    const bundled: DeckSkill[] = bundledSkills.map((skill, index) => ({
      key: `bundled:${skill.id}`,
      id: skill.id,
      name: skill.displayName,
      description: skill.description,
      version: skill.version,
      handle: productionSkillHandle(skill),
      cover: undefined,
      accent: SKILL_ACCENTS[index % SKILL_ACCENTS.length],
      source: 'bundled',
      installed: true,
      updateAvailable: false,
    }));
    const local: DeckSkill[] = localProduction.map((skill, index) => ({
      key: `local:${skill.id}`,
      id: skill.id,
      name: skill.name,
      description: skill.description || copy.installedDescription,
      version: skill.version,
      handle: handleFor(skill.id),
      accent: SKILL_ACCENTS[(bundled.length + index) % SKILL_ACCENTS.length],
      source: 'local',
      installed: true,
      updateAvailable: false,
    }));
    return [...bundled, ...local];
  }, [bundledSkills, localProduction, copy.installedDescription]);

  const hubDeckSkills = useMemo<DeckSkill[]>(() => hubSkills.map((skill, index) => ({
    key: `hub:${skill.id}`,
    id: skill.id,
    name: skill.name,
    description: skill.description || copy.hubDescription,
    version: skill.version,
    handle: handleFor(skill.id),
    accent: SKILL_ACCENTS[index % SKILL_ACCENTS.length],
    source: 'hub',
    installed: localProduction.some(item => item.id === skill.id),
    updateAvailable: localProduction.some(item => item.id === skill.id && item.version !== skill.version),
  })), [hubSkills, localProduction, copy.hubDescription]);

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return localDeckSkills
      .filter(skill => activeTab === 'local')
      .filter(skill => !normalized || [skill.name, skill.id, skill.handle, skill.description].some(value => value.toLowerCase().includes(normalized)))
      .filter(skill => !favoriteIds.size || favoriteIds.has(skill.id));
  }, [localDeckSkills, query, activeTab, favoriteIds]);

  // 命令只在「/」菜单（有 searchQuery）的本地页显示；高亮序号命令在前、Skill 在后。
  const visibleCommands = useMemo(
    () => (activeTab === 'local' && onCommand ? matchSlashCommands(commands, searchQuery) : []),
    [activeTab, commands, onCommand, searchQuery],
  );

  const welcomeSkills = useMemo(() => localDeckSkills.length
    ? Array.from({ length: Math.min(4, localDeckSkills.length) }, (_, index) => localDeckSkills[(shuffleOffset + index) % localDeckSkills.length])
    : [], [shuffleOffset, localDeckSkills]);

  const attach = async (skill: DeckSkill, seedPrompt = false) => {
    if (loading) return;
    setLoading(true);
    setDeckError(null);
    try {
      let inputs: readonly SkillInputSlot[] | undefined;
      if (skill.source === 'bundled') {
        const bundled = getBundledProductionSkill(skill.id);
        if (!bundled) throw new Error(copy.missingBundled + ': ' + skill.id);
        inputs = bundled.inputs;
        onChange(await createProductionSkillAttachment(bundled));
      } else {
        const registry = await createLocalSkillRegistry();
        if (!registry) throw new Error(copy.desktopRequired);
        const manifest = await registry.getSkillManifest(skill.id);
        inputs = manifest.inputs;
        onChange(createSkillAttachment({
          id: manifest.id,
          version: manifest.version,
          contentHash: manifest.contentHash,
          displayName: manifest.displayName,
          trustTier: manifest.trustTier,
        }));
      }
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
      if (!open || activeTab !== 'local') return false;
      const commandCount = visibleCommands.length;
      const count = commandCount + filteredSkills.length;
      if (key === 'ArrowDown') { if (count) setHighlight(index => Math.min(index + 1, count - 1)); return true; }
      if (key === 'ArrowUp') { if (highlight < 0) return false; setHighlight(index => index - 1); return true; }
      if (key === 'Enter') {
        if (highlight >= 0 && highlight < commandCount) { onCommand?.(visibleCommands[highlight], { run: false }); return true; }
        const skill = filteredSkills[highlight - commandCount];
        if (skill) { void attach(skill); return true; }
        // 输入的正好是完整命令名（例如 /compact）：直接执行。
        const exact = highlight < 0 ? visibleCommands.find(command => command.name.toLowerCase() === String(searchQuery || '').trim().toLowerCase()) : undefined;
        if (exact) { onCommand?.(exact, { run: true }); return true; }
        // 未进入列表时也吞掉 Enter，避免把半截 /xxx 当消息发出去。
        return true;
      }
      return false;
    };
    return () => { keyboardRef.current = null; };
  });

  const startInstall = async (skill: DeckSkill) => {
    if (!hubUrl) { setDeckError(copy.configureHub); return; }
    setInstallingId(skill.id);
    setDeckError(null);
    try {
      await installFromHub(skill.id);
    } catch (error) {
      setDeckError(skillRegistryErrorMessage(error));
    } finally {
      setInstallingId(null);
    }
  };

  const droppedInComposer = (point: { x: number; y: number }) => {
    const rect = dropTargetRef.current?.getBoundingClientRect();
    return Boolean(rect
      && point.x >= rect.left && point.x <= rect.right
      && point.y >= rect.top && point.y <= rect.bottom);
  };

  const commandOffset = visibleCommands.length;
  const renderCommandRow = (command: AgentSlashCommand, index: number) => (
    <div
      key={'command:' + command.id}
      className={`agent-skill-picker__row agent-slash-command${index === highlight ? ' is-highlighted' : ''}`}
      data-highlighted={index === highlight || undefined}
      data-testid={'agent-slash-command-' + command.id}
      ref={index === highlight ? (element: HTMLDivElement | null) => element?.scrollIntoView?.({ block: 'nearest' }) : undefined}
      role="group"
      aria-label={'/' + command.name}
    >
      <button type="button" className="agent-skill-picker__row-main" onClick={() => onCommand?.(command, { run: false })}>
        <span className="agent-slash-command__mark" aria-hidden="true"><Minimize2 size={15} /></span>
        <span><strong>/{command.name}{command.args && <em>{command.args}</em>}</strong><small>{command.description}</small></span>
      </button>
    </div>
  );

  const renderRow = (skill: DeckSkill, index: number) => (
    <motion.div
      key={skill.key}
      whileHover={reduceMotion ? undefined : { x: 2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      whileDrag={reduceMotion ? undefined : { scale: 1.02 }}
      drag
      dragElastic={0.14}
      dragSnapToOrigin
      onDragEnd={(_, info) => { if (droppedInComposer(info.point)) void attach(skill); }}
      transition={{ type: 'spring', stiffness: 520, damping: 30 }}
      className={`agent-skill-picker__row${index === highlight ? ' is-highlighted' : ''}`}
      data-highlighted={index === highlight || undefined}
      ref={index === highlight ? (element: HTMLDivElement | null) => element?.scrollIntoView?.({ block: 'nearest' }) : undefined}
      role="group"
      aria-label={skill.name}
    >
      <button type="button" className="agent-skill-picker__row-main" aria-label={copy.add(skill.name)} disabled={loading} onClick={() => void attach(skill)}>
        <SkillMark accent={skill.accent} cover={skill.cover} />
        <span><strong>{skill.name}<em>{skill.handle}</em></strong><small>{skill.description}</small></span>
        <i>{attachment?.id === skill.id ? <Check size={13} /> : copy.details}</i>
      </button>
      <button type="button" className="agent-skill-picker__favorite" aria-label={favoriteIds.has(skill.id) ? copy.unfavorite(skill.name) : copy.favorite(skill.name)} aria-pressed={favoriteIds.has(skill.id)} title={favoriteIds.has(skill.id) ? copy.unfavorite(skill.name) : copy.favorite(skill.name)}
        onClick={() => toggleFavorite(skill.id)}>
        <Star size={13} fill={favoriteIds.has(skill.id) ? 'currentColor' : 'none'} />
      </button>
    </motion.div>
  );

  const renderHubRow = (skill: DeckSkill, index: number) => (
    <div key={skill.key} className="agent-skill-picker__hub-row">
      <SkillMark accent={skill.accent} />
      <span><strong>{skill.name}<em>{skill.handle}</em></strong><small>{skill.description}</small></span>
      <a
        href={hubSkillExternalUrl(hubUrl, skill.id)}
        target="_blank"
        rel="noreferrer"
        aria-label={copy.viewHub(skill.name)}
      >
        <ExternalLink size={13} />
      </a>
      <button
        type="button"
        disabled={installingId === skill.id || (skill.installed && !skill.updateAvailable)}
        onClick={() => void startInstall(skill)}
      >
        {installingId === skill.id ? <RefreshCw size={12} className="is-spinning" /> : <Download size={12} />}
        {skill.installed ? (skill.updateAvailable ? copy.update : copy.installed) : copy.install}
      </button>
    </div>
  );

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
              <motion.button
                key={`${skill.key}-${index}`}
                type="button"
                className="agent-skill-card"
                aria-label={copy.useSkill(skill.name)}
                onClick={() => void attach(skill, true)}
                whileHover={{ y: -2 }}
                whileTap={{ scale: .98 }}
                transition={{ type: 'spring', stiffness: 440, damping: 30 }}
              >
                <SkillMark accent={skill.accent} cover={skill.cover} />
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
              initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="agent-skill-picker"
              role="dialog"
              aria-label={language === 'en' ? 'Skill picker' : 'Skill'}
              style={{ maxHeight: availableHeight }}
            >
              <header className="agent-skill-picker__header">
                <strong>Skill</strong>
                <button type="button" className="agent-skill-picker__create" disabled><Plus size={16} />{copy.create}</button>
                <button type="button" aria-label={copy.close} onClick={() => setOpen(false)}><X size={15} /></button>
              </header>
              <div className="agent-skill-picker__toolbar">
                <div role="tablist" aria-label={copy.categories}>
                  <button type="button" aria-selected={activeTab === 'local'} onClick={() => setActiveTab('local')}>
                    {copy.local}{favoriteIds.size > 0 ? copy.favoriteCount(favoriteIds.size) : ''}
                  </button>
                  <button type="button" aria-selected={activeTab === 'hub'} onClick={() => setActiveTab('hub')}>
                    Hub{hubSkills.length > 0 ? copy.hubCount(hubSkills.length) : ''}
                  </button>
                </div>
                {activeTab === 'local' && (
                  <label><Search size={15} /><input autoFocus={searchQuery === undefined} aria-label={copy.search} placeholder={copy.search} value={query} onChange={event => setQuery(event.target.value)} /></label>
                )}
              </div>
              <div className="agent-skill-picker__list">
                {visibleCommands.length > 0 && (
                  <div className="agent-slash-command__group" role="group" aria-label={translations[language].agentPanel.slashCommands}>
                    <div className="agent-slash-command__label">{translations[language].agentPanel.slashCommands}</div>
                    {visibleCommands.map((command, index) => renderCommandRow(command, index))}
                    {filteredSkills.length > 0 && <div className="agent-slash-command__label">Skill</div>}
                  </div>
                )}
                {activeTab === 'local' && filteredSkills.map((skill, index) => renderRow(skill, index + commandOffset))}
                {activeTab === 'local' && !filteredSkills.length && !visibleCommands.length && (
                  <div className="agent-skill-picker__empty">
                    {registryStatus === 'unavailable'
                      ? copy.desktopScan
                      : query ? copy.noMatch : copy.noLocal}
                  </div>
                )}
                {activeTab === 'hub' && (
                  <div className="agent-skill-picker__hub">
                    <div className="agent-skill-picker__hub-config">
                      <input
                        aria-label={copy.hubAddress}
                        placeholder={copy.hubAddress}
                        value={hubUrlDraft}
                        onChange={event => setHubUrlDraft(event.target.value)}
                      />
                      <button
                        type="button"
                        disabled={!hubUrlDraft || hubStatus === 'syncing'}
                        onClick={() => { setHubUrl(hubUrlDraft); void syncHub(); }}
                      >
                        <RefreshCw size={12} className={hubStatus === 'syncing' ? 'is-spinning' : ''} />
                        {hubStatus === 'syncing' ? copy.syncing : copy.sync}
                      </button>
                    </div>
                    {hubStatus === 'error' && hubError && <div className="agent-skill-picker__hub-error">{hubError}</div>}
                    {hubDeckSkills.map((skill, index) => renderHubRow(skill, index))}
                    {!hubDeckSkills.length && hubStatus !== 'syncing' && (
                      <div className="agent-skill-picker__empty">
                        {hubStatus === 'error' ? copy.hubFailed : copy.hubEmpty}
                      </div>
                    )}
                  </div>
                )}
                {deckError && <div className="agent-skill-picker__hub-error">{deckError}</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>}
    </>
  );
}

function SkillMark({ accent, cover }: { accent: readonly [string, string]; cover?: string }) {
  return <span className="agent-skill-mark" style={{ background: `linear-gradient(135deg, ${accent[0]}, ${accent[1]})` }}>{cover ? <img src={cover} alt="" /> : <Sparkles size={15} />}</span>;
}
