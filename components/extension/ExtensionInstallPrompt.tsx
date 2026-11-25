import React from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getExtensionBridge } from '../../services/extensionBridge';
import { canUseExtensionDirect } from '../../services/extensionDirectFetch';
import {
    decideExtensionPrompt,
    extensionInstallUrl,
    getExtensionPromptStore,
} from '../../services/extensionInstallPrompt';
import { IRIS_GITHUB_URL, becameDirectCapable, dismissStarPrompt, isStarPromptDismissed } from '../../services/starPrompt';

interface ExtensionInstallPromptProps {
    isDark: boolean;
    t: (key: string, ...args: unknown[]) => string;
}

// 浮动 chrome：玻璃外壳（DESIGN §9.2，flv-glass 自带实底回退），文字与按钮只用 --isl-* token。
const cardClass = 'flv-glass fixed bottom-5 left-5 z-50 w-[340px] max-w-[calc(100vw-2.5rem)] p-4 text-[var(--isl-ink)]';
const primaryClass = 'rounded-lg bg-[var(--isl-mint)] px-3 py-1.5 text-xs font-semibold text-[var(--isl-on-mint)] transition hover:bg-[var(--isl-mint-deep)]';
const ghostClass = 'rounded-lg px-2.5 py-1.5 text-xs text-[var(--isl-ink-soft)] transition hover:bg-[var(--isl-surface-2)] hover:text-[var(--isl-ink)]';

/**
 * 非阻塞的插件引导：需要经代理访问网关（或代理被限流）且插件未安装/未配对时出现在左下角。
 * 可关闭（静默 3 天；429 例外，见 extensionInstallPrompt.ts）或「不再提醒」；请求始终照常经代理回退，不受影响。
 * 本次会话里刚配对成功时，同一位置换成一次性的 GitHub Star 邀请（关闭即永久不再出现）。
 */
export function ExtensionInstallPrompt({ isDark: _isDark, t }: ExtensionInstallPromptProps) {
    const copy = (name: string) => t('settingsExtra.extension.prompt.' + name);
    const bridge = getExtensionBridge();
    const store = getExtensionPromptStore();
    const bridgeState = React.useSyncExternalStore(bridge.subscribe, bridge.getState);
    const promptState = React.useSyncExternalStore(store.subscribe, store.getState);
    const desktop = React.useMemo(() => {
        try {
            return isTauri();
        } catch {
            return false;
        }
    }, []);
    const capable = canUseExtensionDirect(bridge);

    // 有了需要插件的原因、但还没探测过插件：主动探测一次（不申请配对），才能区分「未安装」与「已安装未配对」。
    React.useEffect(() => {
        if (!desktop && promptState.reason && bridgeState.status === 'idle') void bridge.connect();
    }, [bridge, bridgeState.status, desktop, promptState.reason]);

    // 只在「本次会话里经历了等待批准 → 配对成功」时邀请 Star；已配对用户刷新页面不会看到。
    const sawPending = React.useRef(false);
    if (bridgeState.status === 'pending') sawPending.current = true;
    const previousCapable = React.useRef<boolean | null>(null);
    const [starVisible, setStarVisible] = React.useState(false);
    React.useEffect(() => {
        if (sawPending.current && becameDirectCapable(previousCapable.current, capable) && !isStarPromptDismissed()) setStarVisible(true);
        previousCapable.current = capable;
    }, [capable]);

    const decision = decideExtensionPrompt({
        reason: promptState.reason,
        status: bridgeState.status,
        capable,
        dismissedForever: promptState.dismissedForever,
        dismissedThisSession: promptState.dismissedThisSession,
        quotaDismissed: promptState.quotaDismissed,
        isDesktop: desktop,
    });

    if (!decision.show || !decision.action || !promptState.reason) {
        if (!starVisible) return null;
        const closeStar = () => {
            dismissStarPrompt();
            setStarVisible(false);
        };
        return (
            <div role="status" aria-live="polite" data-testid="iris-star-prompt" className={cardClass}>
                <div className="flex items-start justify-between gap-3">
                    <div className="text-sm font-medium">{t('settingsExtra.extension.star.title')}</div>
                    <button type="button" aria-label={t('settingsExtra.extension.star.close')} className={ghostClass} onClick={closeStar}>×</button>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-[var(--isl-ink-soft)]">{t('settingsExtra.extension.star.body')}</p>
                <div className="mt-3 flex items-center gap-2">
                    <button
                        type="button"
                        className={primaryClass}
                        onClick={() => {
                            window.open(IRIS_GITHUB_URL, '_blank', 'noopener,noreferrer');
                            closeStar();
                        }}
                    >
                        {t('settingsExtra.extension.star.action')}
                    </button>
                </div>
            </div>
        );
    }

    const openInstall = () => window.open(extensionInstallUrl(), '_blank', 'noopener,noreferrer');

    return (
        <div role="status" aria-live="polite" data-testid="extension-install-prompt" className={cardClass}>
            <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-medium">{copy('title')}</div>
                <button type="button" aria-label={copy('later')} className={ghostClass} onClick={() => store.dismiss(false)}>×</button>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-[var(--isl-ink-soft)]">
                {copy(promptState.reason)} {copy('fallback')}
            </p>
            {decision.action === 'approve' && <p className="mt-2 text-xs">{copy('approve')}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
                {decision.action === 'install' && <>
                    <button type="button" className={primaryClass} onClick={openInstall}>{copy('install')}</button>
                    <button type="button" className={ghostClass} onClick={() => void bridge.connect()}>{copy('recheck')}</button>
                </>}
                {decision.action === 'pair' && (
                    <button type="button" className={primaryClass} onClick={() => void bridge.connect({ requestPairing: true })}>{copy('pair')}</button>
                )}
                {decision.action === 'update' && (
                    <button type="button" className={primaryClass} onClick={openInstall}>{copy('update')}</button>
                )}
                <span className="flex-1" />
                <button type="button" className={ghostClass} onClick={() => store.dismiss(true)}>{copy('never')}</button>
            </div>
        </div>
    );
}
