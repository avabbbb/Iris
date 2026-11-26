import React from 'react';
import {
    clearDeepSeekExtensionCompat,
    listDeepSeekExtensionCompat,
    loadDeepSeekExtensionSettings,
    saveDeepSeekExtensionSettings,
    subscribeDeepSeekExtensions,
    type DeepSeekExtensionCompatRecord,
    type DeepSeekExtensionSettings,
} from '../../services/deepseekExtensions';

interface DeepSeekExtensionsSectionProps {
    isDark: boolean;
    t: (key: string, ...args: unknown[]) => string;
    /** 外壳样式；嵌在 AI 服务抽屉「更多设置」里时传入抽屉的分区样式。 */
    className?: string;
}

function cx(...parts: Array<string | false | undefined>): string {
    return parts.filter(Boolean).join(' ');
}

function formatUntil(ms: number): string {
    try {
        return new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date(ms).toISOString();
    }
}

function useDeepSeekExtensionState(): { settings: DeepSeekExtensionSettings; compat: DeepSeekExtensionCompatRecord[] } {
    const read = React.useCallback(() => ({ settings: loadDeepSeekExtensionSettings(), compat: listDeepSeekExtensionCompat() }), []);
    const [state, setState] = React.useState(read);
    React.useEffect(() => subscribeDeepSeekExtensions(() => setState(read())), [read]);
    return state;
}

/**
 * DeepSeek 官方线路的三个服务端扩展开关（标题 / 联网 / 安全审核）。
 * 入口：AI 服务抽屉「更多设置」，仅当该服务 Base URL 为 api.deepseek.com 时渲染；开关是全局存储（所有 DeepSeek 官方服务共用）。
 * 只影响 Base URL 为 api.deepseek.com 的请求；兼容探测的结论（扩展与 Agent 工具不能共存等）显示在下方。
 */
export function DeepSeekExtensionsSection({ isDark, t, className }: DeepSeekExtensionsSectionProps) {
    const copy = (name: string, ...args: unknown[]) => t('settingsExtra.deepseekExt.' + name, ...args);
    const { settings, compat } = useDeepSeekExtensionState();
    const inkClass = isDark ? 'text-[#D0D5DD]' : 'text-[#344054]';
    const softClass = isDark ? 'text-[#667085]' : 'text-[#98A2B3]';
    const exclusive = compat.filter(record => record.mode === 'exclusive');

    const rows: Array<{ key: keyof DeepSeekExtensionSettings; label: string; hint: string; testId: string }> = [
        { key: 'title', label: copy('titleLabel'), hint: copy('titleHint'), testId: 'deepseek-ext-title' },
        { key: 'webSearch', label: copy('webSearchLabel'), hint: copy('webSearchHint'), testId: 'deepseek-ext-web-search' },
        { key: 'safetyCheck', label: copy('safetyLabel'), hint: copy('safetyHint'), testId: 'deepseek-ext-safety-check' },
    ];

    return (
        <section className={className ?? cx('rounded-2xl p-4', isDark ? 'bg-[#161A22]' : 'bg-[#F8FAFC]')} data-testid="deepseek-extensions">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className={cx('text-sm font-medium', inkClass)}>{copy('title')}</div>
                    <div className={cx('mt-1 text-xs', softClass)}>{copy('details')}</div>
                    <div className={cx('mt-0.5 text-[11px]', softClass)}>{copy('sharedHint')}</div>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--isl-card)] px-2.5 py-1 font-mono text-[11px] text-[var(--isl-ink-soft)]">{copy('badge')}</span>
            </div>
            <div className="mt-3 space-y-2">
                {rows.map(row => {
                    const checked = settings[row.key];
                    return (
                        <div key={row.key} className={cx('flex items-center justify-between gap-4 rounded-xl border px-3 py-2.5', isDark ? 'border-[#2A3140]' : 'border-[#E4E7EC]')}>
                            <div className="min-w-0">
                                <div className={cx('text-sm font-medium', inkClass)}>{row.label}</div>
                                <div className={cx('mt-0.5 text-[11px] leading-relaxed', softClass)}>{row.hint}</div>
                            </div>
                            <label className="inline-flex shrink-0 cursor-pointer items-center gap-2">
                                <span className={cx('text-[11px] font-semibold', checked ? 'text-emerald-600' : softClass)}>{checked ? copy('on') : copy('off')}</span>
                                <input
                                    type="checkbox"
                                    role="switch"
                                    className="sr-only"
                                    data-testid={row.testId}
                                    checked={checked}
                                    aria-label={row.label}
                                    onChange={event => saveDeepSeekExtensionSettings({ [row.key]: event.target.checked })}
                                />
                                <span className={cx('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', checked ? 'bg-green-500' : isDark ? 'bg-[#3A4458]' : 'bg-[#D0D5DD]')}>
                                    <span className={cx('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
                                </span>
                            </label>
                        </div>
                    );
                })}
            </div>
            {(compat.length > 0) && (
                <div className="mt-3 space-y-1.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300" data-testid="deepseek-ext-compat" aria-live="polite">
                    {settings.safetyCheck && exclusive.map(record => (
                        <div key={'safety-' + record.provider + record.model} className="font-semibold">{copy('safetyBlocked', record.model)}</div>
                    ))}
                    {compat.map(record => (
                        <div key={record.provider + record.model}>
                            {record.mode === 'exclusive' ? copy('compatExclusive', record.model, formatUntil(record.until)) : copy('compatUnsupported', record.model, formatUntil(record.until))}
                        </div>
                    ))}
                    <button type="button" className="mt-1 rounded-lg border border-amber-500/40 px-2 py-0.5 font-semibold hover:bg-amber-400/20" onClick={() => clearDeepSeekExtensionCompat()}>
                        {copy('reprobe')}
                    </button>
                </div>
            )}
        </section>
    );
}
