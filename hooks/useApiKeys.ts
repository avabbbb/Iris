import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { UserApiKey, AIProvider, AICapability, ModelItem } from '../types';
import { saveKeysEncrypted, loadKeysDecrypted, clearAllKeyData, migrateLegacyKeys } from '../utils/keyVault';
import { getUsageSummary } from '../utils/usageMonitor';
import {
    inferCapabilitiesByProvider,
    inferProviderFromModel,
    isGoogleImageEditModel,
    isGoogleTextToImageModel,
} from '../services/aiGateway';
import { normalizeProviderBaseUrl } from '../services/baseUrl';
import { refreshAllProviderModels } from '../services/modelFetcher';
import { fetchedModelToItem, refreshModelCapabilityFields } from '../services/modelThinkingLevels';
import {
    isLikelyRunningHubModelEndpoint,
    normalizeRunningHubModelEndpoint,
} from '../services/runningHubService';
import { modelRefModelId } from '../utils/modelRefs';
import { getProductModels } from '../services/productModelCatalog';
import { getRunningHubRoutesVersion, subscribeRunningHubRoutes } from '../services/runningHubDynamicRoutes';
import {
    deleteRuntimeCredential,
    reportRuntimeCredentialVault,
    syncRuntimeCredentials,
} from '../services/runtimeCredentials';
import { syncRuntimeAgentTextRoutes } from '../services/runtimeAgentTextRoutes';
import { mergeSuggestedProductRouteMappings } from '../services/aiServiceSetup';
import { loadStoredUserScriptProviders } from '../services/userScriptAuthoring';
import { getExtensionBridge } from '../services/extensionBridge';
import { getExtensionPromptStore, hasProxiedProvider } from '../services/extensionInstallPrompt';
import {
    EXTENSION_KEY_SYNC_DISABLED,
    createExtensionKeySync,
    mergeExtensionKeyChanges,
    type ExtensionKeySync,
} from '../services/extensionKeySync';

const generateId = () => `id_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const buildApiKeyFingerprint = (item: Pick<Partial<UserApiKey>, 'provider' | 'key' | 'baseUrl'>) => {
    const provider = item.provider || '';
    const key = item.key || '';
    const baseUrl = item.baseUrl?.trim().replace(/\/+$/, '') || '';
    return `${provider}::${key}::${baseUrl}`;
};

const sanitizeRunningHubModelId = (model?: string) => {
    const normalized = normalizeRunningHubModelEndpoint(model);
    if (!normalized) return '';
    return isLikelyRunningHubModelEndpoint(normalized) ? normalized : '';
};

const sanitizeRunningHubModelItems = (models?: ModelItem[]) => (models || [])
    .map(model => {
        const id = sanitizeRunningHubModelId(model.id);
        return id ? { ...model, id, name: model.name || id } : null;
    })
    .filter((model): model is ModelItem => Boolean(model));

const mergeFetchedModelsIntoKey = (key: UserApiKey, fetchedItems: ModelItem[]) => {
    if (fetchedItems.length === 0) return key;
    // 同 id 的已有条目：名字 / 能力以本次拉取为准，思考档位 / 上下文窗口整体刷新（拉取里没有的旧值清掉）。
    const previousById = new Map((key.models || []).map(model => [model.id, model]));
    const modelItems = fetchedItems.map(item => {
        const previous = previousById.get(item.id);
        return previous ? refreshModelCapabilityFields({ ...previous, ...item }, item) : item;
    });
    if (key.provider !== 'runningHub') {
        return { ...key, models: modelItems, updatedAt: Date.now() };
    }
    const fetchedIds = new Set(modelItems.map(model => model.id));
    const preservedCustomModels = (key.customModels || [])
        .map(sanitizeRunningHubModelId)
        .filter((model): model is string => Boolean(model) && !fetchedIds.has(model));
    const mergedModels = [
        ...modelItems,
        ...preservedCustomModels.map(id => ({ id, name: id })),
    ];
    const validIds = new Set(mergedModels.map(model => model.id));
    const defaultModel = key.defaultModel && validIds.has(key.defaultModel)
        ? key.defaultModel
        : mergedModels[0]?.id;
    return {
        ...key,
        models: mergedModels,
        customModels: mergedModels.map(model => model.id),
        defaultModel,
        updatedAt: Date.now(),
    };
};

export const normalizeApiKeyEntry = (item: Partial<UserApiKey>): UserApiKey | null => {
    if (!item || !item.id || !item.provider || !item.key) return null;
    const runningHubModels = item.provider === 'runningHub' ? sanitizeRunningHubModelItems(item.models) : item.models;
    const runningHubCustomModels = item.provider === 'runningHub'
        ? (item.customModels || []).map(sanitizeRunningHubModelId).filter((model): model is string => Boolean(model))
        : item.customModels;
    const runningHubDefaultModel = item.provider === 'runningHub'
        ? sanitizeRunningHubModelId(item.defaultModel) || runningHubModels?.[0]?.id || runningHubCustomModels?.[0]
        : item.defaultModel;
    return {
        id: item.id,
        provider: item.provider,
        capabilities:
            Array.isArray(item.capabilities) && item.capabilities.length > 0
                ? item.capabilities
                : inferCapabilitiesByProvider(item.provider),
        key: item.key,
        baseUrl: item.provider === 'runningHub' ? normalizeProviderBaseUrl('runningHub', item.baseUrl) : item.baseUrl,
        name: item.name,
        isDefault: item.isDefault,
        status: item.status,
        customModels: runningHubCustomModels,
        defaultModel: runningHubDefaultModel,
        models: runningHubModels,
        extraConfig: item.extraConfig,
        routeMappings: item.routeMappings,
        pricingRules: item.pricingRules,
        budgetPolicy: item.budgetPolicy,
        ...(item.streamUsage === 'request' ? { streamUsage: 'request' as const } : {}),
        createdAt: item.createdAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
    };
};

export function mergeExtensionApiKeys(current: UserApiKey[], incoming: Array<Partial<UserApiKey>>): UserApiKey[] {
    const next = [...current];
    for (const item of incoming) {
        if (!item.provider || !item.key) continue;
        const fingerprint = buildApiKeyFingerprint(item);
        const idIndex = item.id ? next.findIndex(existing => existing.id === item.id) : -1;
        const index = idIndex >= 0
            ? idIndex
            : next.findIndex(existing => buildApiKeyFingerprint(existing) === fingerprint);
        const existing = index >= 0 ? next[index] : undefined;
        const definedItem = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined));
        const merged: Partial<UserApiKey> = { ...existing, ...definedItem };
        merged.id = existing?.id || item.id || crypto.randomUUID();
        merged.createdAt = existing?.createdAt || item.createdAt || Date.now();
        merged.updatedAt = item.updatedAt || Date.now();
        const normalized = normalizeApiKeyEntry(merged);
        if (!normalized) continue;
        if (index >= 0) next[index] = normalized;
        else next.push(normalized);
    }
    return next;
}

const hasCapabilityOverlap = (left: AICapability[], right: AICapability[]) =>
    left.some(capability => right.includes(capability));

/**
 * Distinguishes generic multi-agent discussion support from provider-bound image tool endpoint availability.
 */
export function buildAgentRuntimeSummary(input: {
    textModel: string;
    keys: Array<Pick<UserApiKey, 'provider' | 'key' | 'capabilities'>>;
}) {
    const discussionProvider = inferProviderFromModel(modelRefModelId(input.textModel));
    const discussionSupported = input.keys.some(
        k => !!k.key && (
            k.provider === discussionProvider ||
            (k.capabilities ?? inferCapabilitiesByProvider(k.provider as AIProvider)).includes('text')
        ),
    );
    const imageToolSupported = input.keys.some(k => !!k.key && (k.capabilities ?? inferCapabilitiesByProvider(k.provider as AIProvider)).includes('agent'));
    return { discussionSupported, imageToolSupported };
}

export function useApiKeys(isSettingsPanelOpen: boolean) {
    const [userApiKeys, setUserApiKeys] = useState<UserApiKey[]>([]);
    const [apiKeysLoaded, setApiKeysLoaded] = useState(false);

    const [clearKeysOnExit, setClearKeysOnExit] = useState<boolean>(() => {
        try { return localStorage.getItem('security.clearKeysOnExit') === 'true'; } catch { return false; }
    });
    // RunningHub 动态线路（官方文档解析）更新时刷新产品卡列表与自动映射。
    const [runningHubRoutesVersion, setRunningHubRoutesVersion] = useState(getRunningHubRoutesVersion);
    useEffect(() => subscribeRunningHubRoutes(() => setRunningHubRoutesVersion(getRunningHubRoutesVersion())), []);

    // PromptBar 展示 Product Model（静态产品卡 + RunningHub 动态家族卡）；文本执行模型由 Runtime Capability 映射决定。
    const dynamicModelOptions = useMemo(() => {
        return {
            text: [],
            image: getProductModels('image').map(model => model.id),
            video: getProductModels('video').map(model => model.id),
        };
    }, [runningHubRoutesVersion]);

    const [usageSummaryMap, setUsageSummaryMap] = useState<Awaited<ReturnType<typeof getUsageSummary>> | undefined>();
    useEffect(() => {
        if (!isSettingsPanelOpen || userApiKeys.length === 0) {
            setUsageSummaryMap(undefined);
            return;
        }
        let cancelled = false;
        void getUsageSummary(userApiKeys).then(summary => { if (!cancelled) setUsageSummaryMap(summary); });
        return () => { cancelled = true; };
    }, [isSettingsPanelOpen, userApiKeys]);

    // 从加密存储异步加载 API Key（首次挂载 + 兼容迁移旧明文）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            loadStoredUserScriptProviders();
            await migrateLegacyKeys();
            const keys = await loadKeysDecrypted<Partial<UserApiKey>[]>();
            if (cancelled) return;
            const normalized = (keys || [])
                .map(normalizeApiKeyEntry)
                .filter((item): item is UserApiKey => !!item);
            setUserApiKeys(normalized);
            setApiKeysLoaded(true);
        })();
        return () => { cancelled = true; };
    }, []);

    // 持久化 API Key（加密写入 localforage）；“退出时清除”开启后只保留内存态。
    useEffect(() => {
        if (!apiKeysLoaded) return;
        void reportRuntimeCredentialVault(userApiKeys.length, !clearKeysOnExit)
            .catch(() => { /* Runtime may be unavailable in web builds. */ });
        if (clearKeysOnExit) {
            void clearAllKeyData();
            void syncRuntimeAgentTextRoutes([]).catch(() => { /* Runtime may be unavailable in web builds. */ });
            return;
        }
        void saveKeysEncrypted(userApiKeys);
        void syncRuntimeCredentials(userApiKeys)
            .then(() => syncRuntimeAgentTextRoutes(userApiKeys))
            .catch(() => { /* Runtime may be unavailable in web builds. */ });
    }, [userApiKeys, apiKeysLoaded, clearKeysOnExit]);

    // 首次进入画布或连接外部助手不需要 Provider Key。AI 服务由用户在设置中配置。

    // 持久化 clearKeysOnExit 设置
    useEffect(() => {
        try { localStorage.setItem('security.clearKeysOnExit', clearKeysOnExit.toString()); } catch { /* non-critical */ }
    }, [clearKeysOnExit]);

    // 已配对的浏览器插件：经 Port 双向同步 Key（全量 snapshot + 增量 delta；插件内编辑经 keys.ext.changes 回写），
    // 插件本地加密保存，撤销配对即清空。“退出时清除”开启时发 syncDisabled：插件清空，且拒绝插件回写。
    const extensionKeySyncRef = useRef<ExtensionKeySync | null>(null);
    const latestKeysRef = useRef({ keys: userApiKeys, loaded: apiKeysLoaded, clearOnExit: clearKeysOnExit });
    latestKeysRef.current = { keys: userApiKeys, loaded: apiKeysLoaded, clearOnExit: clearKeysOnExit };
    useEffect(() => {
        const bridge = getExtensionBridge();
        const sync = createExtensionKeySync(bridge);
        extensionKeySyncRef.current = sync;
        // 插件 → 画布：校验字段白名单与 Provider，按 updatedAt 后写者胜合并；之后改发全量让插件对齐。
        const offChanges = bridge.onRequest('keys.ext.changes', message => {
            const latest = latestKeysRef.current;
            if (!latest.loaded) throw new Error('keys.not-ready');
            if (latest.clearOnExit) throw new Error(EXTENSION_KEY_SYNC_DISABLED);
            const result = mergeExtensionKeyChanges(latest.keys, message, normalizeApiKeyEntry as (item: Record<string, unknown>) => UserApiKey | null);
            sync.noteRemoteRevision(message.revision);
            if (result.changed) {
                latestKeysRef.current = { ...latest, keys: result.next };
                setUserApiKeys(result.next);
            }
            void sync.update(result.next);
            return { applied: result.applied, ignored: result.ignored };
        });
        return () => {
            offChanges();
            sync.dispose();
            extensionKeySyncRef.current = null;
        };
    }, []);
    useEffect(() => {
        if (!apiKeysLoaded) return;
        void extensionKeySyncRef.current?.update(clearKeysOnExit ? [] : userApiKeys, { syncDisabled: clearKeysOnExit });
    }, [userApiKeys, apiKeysLoaded, clearKeysOnExit]);

    // 配置了只能经代理访问的网关（OpenCode 等）：记下原因，未装/未配对插件时提示安装（不阻塞）。
    useEffect(() => {
        if (!apiKeysLoaded || typeof window === 'undefined') return;
        if (hasProxiedProvider(userApiKeys, window.location.origin)) getExtensionPromptStore().note('configured');
    }, [userApiKeys, apiKeysLoaded]);

    // 启动时、以及 RunningHub 官方文档解析出新线路后，补齐自动映射（每个家族 + 模式 → 对应 endpoint），不覆盖用户已选的映射。
    useEffect(() => {
        if (!apiKeysLoaded || userApiKeys.length === 0) return;
        setUserApiKeys(prev => {
            let changed = false;
            const next = prev.map(k => {
                const merged = mergeSuggestedProductRouteMappings(k);
                if (merged !== k) changed = true;
                return merged;
            });
            return changed ? next : prev;
        });
    }, [apiKeysLoaded, userApiKeys.length, runningHubRoutesVersion]);

    // 启动时后台自动刷新所有 Provider 的模型列表（带缓存 TTL）
    const autoRefreshRan = useRef(false);
    useEffect(() => {
        if (!apiKeysLoaded || userApiKeys.length === 0 || autoRefreshRan.current) return;
        autoRefreshRan.current = true;
        const keysToFetch = userApiKeys
            .filter(k => k.key && k.status !== 'error')
            .map(k => ({ id: k.id, provider: k.provider, key: k.key, baseUrl: k.baseUrl }));
        if (keysToFetch.length === 0) return;
        refreshAllProviderModels(keysToFetch).then(results => {
            if (results.size === 0) return;
            setUserApiKeys(prev => prev.map(k => {
                const fetched = results.get(k.id);
                if (!fetched || fetched.length === 0) return k;
                const modelItems = fetched.map(fetchedModelToItem);
                return mergeSuggestedProductRouteMappings(mergeFetchedModelsIntoKey(k, modelItems));
            }));
        }).catch(() => { /* silent background refresh failure */ });
    }, [apiKeysLoaded, userApiKeys.length]);

    const handleAddApiKey = useCallback((payload: Omit<UserApiKey, 'id' | 'createdAt' | 'updatedAt'>) => {
        const now = Date.now();
        const capabilities = payload.capabilities?.length ? payload.capabilities : inferCapabilitiesByProvider(payload.provider);
        const initialKey: UserApiKey = {
            ...payload,
            capabilities,
            id: generateId(),
            createdAt: now,
            updatedAt: now,
        };
        const nextKey = mergeSuggestedProductRouteMappings(initialKey);
        setUserApiKeys(prev => {
            const isFirstOfCapabilities = !prev.some(k =>
                hasCapabilityOverlap(
                    k.capabilities?.length ? k.capabilities : inferCapabilitiesByProvider(k.provider),
                    capabilities
                )
            );
            const shouldSetDefault = payload.isDefault || isFirstOfCapabilities;
            const withDefault = shouldSetDefault
                ? prev.map(k => {
                    const existingCaps = k.capabilities?.length ? k.capabilities : inferCapabilitiesByProvider(k.provider);
                    return hasCapabilityOverlap(existingCaps, capabilities)
                        ? { ...k, isDefault: false }
                        : k;
                })
                : prev;
            return [{ ...nextKey, isDefault: shouldSetDefault }, ...withDefault];
        });
        // 新增 Key 后自动拉取模型列表（后台静默）
        refreshAllProviderModels([{ id: nextKey.id, provider: payload.provider, key: payload.key, baseUrl: payload.baseUrl }], true)
            .then(results => {
                const fetched = results.get(nextKey.id);
                if (fetched && fetched.length > 0) {
                    const modelItems = fetched.map(fetchedModelToItem);
                    setUserApiKeys(prev => prev.map(k =>
                        k.id === nextKey.id ? mergeSuggestedProductRouteMappings(mergeFetchedModelsIntoKey(k, modelItems)) : k
                    ));
                }
            })
            .catch(() => {});
    }, []);

    const handleDeleteApiKey = useCallback((id: string) => {
        setUserApiKeys(prev => {
            const removed = prev.find(k => k.id === id);
            if (removed) void deleteRuntimeCredential(removed).catch(() => { /* Local vault remains authoritative. */ });
            return prev.filter(k => k.id !== id);
        });
    }, []);

    const handleUpdateApiKey = useCallback((id: string, patch: Partial<Omit<UserApiKey, 'id' | 'createdAt'>>) => {
        setUserApiKeys(prev => prev.map(k =>
            k.id === id ? { ...k, ...patch, updatedAt: Date.now() } : k
        ));
    }, []);

    const handleSetDefaultApiKey = useCallback((id: string) => {
        setUserApiKeys(prev => {
            const target = prev.find(k => k.id === id);
            if (!target) return prev;
            const targetCaps = target.capabilities?.length ? target.capabilities : inferCapabilitiesByProvider(target.provider);
            return prev.map(k => {
                const existingCaps = k.capabilities?.length ? k.capabilities : inferCapabilitiesByProvider(k.provider);
                return hasCapabilityOverlap(existingCaps, targetCaps)
                    ? { ...k, isDefault: k.id === id }
                    : k;
            });
        });
    }, []);

    return {
        userApiKeys,
        setUserApiKeys,
        apiKeysLoaded,

        clearKeysOnExit,
        setClearKeysOnExit,
        dynamicModelOptions,
        usageSummaryMap,
        handleAddApiKey,
        handleDeleteApiKey,
        handleUpdateApiKey,
        handleSetDefaultApiKey,
    };
}
