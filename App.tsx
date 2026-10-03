import React, { useState, useCallback, useEffect, useMemo, Suspense } from 'react';
import { generateId } from './utils/helpers';
import type { AssetLibrary, UserApiKey, PromptEnhanceMode, GenerationHistoryItem, ThemeMode } from './types';
import { addAsset, removeAsset, renameAsset, addFolder, renameFolder, removeFolder, loadAssetLibraryAsync, saveAssetLibraryAsync, updateAssetTags, removeAssetFromFolder, batchRemoveAssets, batchAddAssetsToFolder, batchAddAssetTags } from './utils/assetStorage';
import { loadGenerationHistoryAsync, saveGenerationHistoryAsync, addGenerationHistoryItem } from './utils/generationHistory';
import { reversePromptStreamWithProvider, enhancePromptWithProvider } from './services/aiGateway';
import { useApiKeys, normalizeApiKeyEntry } from './hooks/useApiKeys';
import { useToast } from './hooks/useToast';
import ToastStack from './components/Toast';
import { AppShell } from './components/AppShell';
import { StudioTopMenu, type StudioMenuModel } from './components/studio/StudioTopMenu';
import { StudioNavigationFrame } from './components/studio/StudioNavigationFrame';
import { StudioRightDrawer } from './components/studio/StudioRightDrawer';
import { StudioMediaBrowser } from './components/studio/StudioMediaBrowser';
import { FlovartAgentPanel } from './components/agent/FlovartAgentPanel';
import { AgentConnectionsPage, AgentDrawerEmptyState } from './components/agent/AgentWorkspace';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { flushWorkflowPersistence, useWorkflowStore } from './components/workflow/store';
import { consumeWorkflowAgentDrawerRequest, subscribeWorkflowAgentDrawer } from './components/workflow/agentDrawerRequest';
import type { WorkflowSharedMedia } from './components/workflow/WorkflowConfigPanel';
import { getGenerationCapability, type GenerationMode } from './services/generationCapabilities';
import { cancelWorkflowGeneration, runWorkflowGeneration } from './services/workflowGeneration';
import { ingestWorkflowMedia, loadWorkflowMediaBlob, releaseWorkflowMediaRecord, workflowBlobToDataUrl } from './components/workflow/media';
import { insertSharedMediaIntoProject } from './components/workflow/WorkflowWorkspace';
import { createWorkflowNode } from './components/workflow/constants';
import { setWorkflowExecutor, setWorkflowNodeToolRunner } from './services/workflowDispatcher';
import { createWorkflowExecutor, normalizeWorkflowExecutionError, WorkflowExecutionError, type WorkflowExecutionContext, type WorkflowRunAdapterResult, type WorkflowRunCommand } from './services/workflowExecutor';
import type { CanonicalGenerationInput } from './components/workflow/inputResolver';
import type { PromptIntent } from './components/workflow/promptIntent';
import type { WorkflowNodeToolName, WorkflowNodeToolRuntime } from './services/workflowNodeTools';
import type { WorkflowProject } from './components/workflow/types';
import { translations } from './utils/translations';
import './styles/generation.css';
import type { TableProcessResult } from './services/tableMediaProcessor';
import { resolveRouteMappingForSubmit, type RouteFallbackResolution } from './services/routeMapping';
import { ensureWorkflowImageGenerateOperation } from './components/workflow/operations';
import { getWorkflowOperationCapability } from './components/workflow/operationRegistry';
import { buildGenerationGateSummary, getGenerationGateDetails, requiresExternalGenerationGate } from './services/generationGate';
import { loadCreativeHostResource } from './services/studio/hostResourceRegistry';
import { registerWorkflowArtifact } from './services/studio/artifactRegistry';

const SettingsPanel = React.lazy(() => import('./components/SettingsPanel').then(m => ({ default: m.SettingsPanel })));

const WorkflowWorkspace = React.lazy(() => import('./components/workflow/WorkflowWorkspace').then(m => ({ default: m.WorkflowWorkspace })));
const WorkflowContextPanel = React.lazy(() => import('./components/workflow/WorkflowWorkspace').then(m => ({ default: m.WorkflowContextPanel })));
const TableWorkspace = React.lazy(() => import('./components/table/TableWorkspace').then(m => ({ default: m.TableWorkspace })));
const AssetAddModal = React.lazy(() => import('./components/AssetAddModal').then(m => ({ default: m.AssetAddModal })));
const BrowserImportBridge = React.lazy(() => import('./components/extension/BrowserImportBridge').then(m => ({ default: m.BrowserImportBridge })));

type ThemePalette = {
    appBackground: string;
    uiBgColor: string;
    buttonBgColor: string;
};

const THEME_PALETTES: Record<'light' | 'dark', ThemePalette> = {
    light: {
        appBackground: '#f1ede3',
        uiBgColor: 'rgba(250, 249, 246, 0.92)',
        buttonBgColor: '#19c8b9',
    },
    dark: {
        appBackground: '#131210',
        uiBgColor: 'rgba(32, 31, 29, 0.94)',
        buttonBgColor: '#3ad9c9',
    },
};

function isStorageQuotaError(err: unknown): boolean {
    if (err instanceof DOMException) {
        return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED';
    }
    return false;
}

const App: React.FC = () => {
    const [dataReady, setDataReady] = useState(false);
    const [assetLibrary, setAssetLibrary] = useState<AssetLibrary>({ folders: [], items: [] });
    const [generationHistory, setGenerationHistory] = useState<GenerationHistoryItem[]>([]);
    const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(false);
    const [addAssetModal, setAddAssetModal] = useState<{ open: boolean; dataUrl: string; mimeType: string; width: number; height: number } | null>(null);
    const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light');
    const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
    const [isAssetPanelOpen, setIsAssetPanelOpen] = useState(false);
    const [tableSourceNodeId, setTableSourceNodeId] = useState<string | null>(null);
    // Global right drawer: single Agent surface over BOTH Canvas and Table —
    // docked (reflow) on desktop, overlay on medium viewports.
    const mediumViewport = useMediaQuery('(max-width: 1023px)');
    const [desktopRightOpen, setDesktopRightOpen] = useState(() => {
        try { return localStorage.getItem('workflowRightPanelOpenV2') !== 'false'; } catch { return true; }
    });
    const [mobileRightOpen, setMobileRightOpen] = useState(false);
    const rightOpen = mediumViewport ? mobileRightOpen : desktopRightOpen;
    const setRightOpen = useCallback((open: boolean) => {
        if (mediumViewport) setMobileRightOpen(open); else setDesktopRightOpen(open);
    }, [mediumViewport]);
    const [rightTab, setRightTab] = useState<'agent' | 'hosts' | 'context' | 'history'>('agent');
    const [rightWidth, setRightWidth] = useState(() => {
        try {
            const stored = Number(localStorage.getItem('workflowRightPanelWidth'));
            return Number.isFinite(stored) && stored >= 280 && stored <= 640 ? stored : 360;
        } catch { return 360; }
    });
    const [focusNodeRequest, setFocusNodeRequest] = useState<{ nodeId: string; nonce: number } | undefined>(undefined);


    const toast = useToast();

    const language = useWorkspaceStore(s => s.language);
    const setLanguage = useWorkspaceStore(s => s.setLanguage);
    const activeView = useWorkspaceStore(s => s.activeView);
    const setActiveView = useWorkspaceStore(s => s.setActiveView);
    const canvasView = useWorkspaceStore(s => s.canvasView);
    const setCanvasView = useWorkspaceStore(s => s.setCanvasView);
    const themeMode = useWorkspaceStore(s => s.themeMode);
    const setThemeMode = useWorkspaceStore(s => s.setThemeMode);

    const workflowProjects = useWorkflowStore(s => s.projects);
    const activeWorkflowProjectId = useWorkflowStore(s => s.activeProjectId);
    const workflowCreateProject = useWorkflowStore(s => s.createProject);
    const workflowDeleteProjects = useWorkflowStore(s => s.deleteProjects);
    const workflowRenameProject = useWorkflowStore(s => s.renameProject);
    const workflowSetActiveProject = useWorkflowStore(s => s.setActiveProject);

    const activeWorkflowIndex = useMemo(() => Math.max(0, workflowProjects.findIndex(p => p.id === activeWorkflowProjectId)), [workflowProjects, activeWorkflowProjectId]);
    const recoveryTasks = React.useRef(new Set<string>());

    const resolvedTheme: 'light' | 'dark' = themeMode === 'system' ? systemTheme : themeMode;
    const themePalette = THEME_PALETTES[resolvedTheme];

    const {
        userApiKeys, setUserApiKeys, apiKeysLoaded,
        clearKeysOnExit, setClearKeysOnExit,
        handleAddApiKey, handleDeleteApiKey, handleUpdateApiKey, handleSetDefaultApiKey,
        dynamicModelOptions, usageSummaryMap,
    } = useApiKeys(isSettingsPanelOpen);

    useEffect(() => {
        Promise.all([
            loadAssetLibraryAsync(),
            loadGenerationHistoryAsync(),
        ]).then(([loadedAssets, loadedHistory]) => {
            setAssetLibrary(loadedAssets);
            setGenerationHistory(loadedHistory);
            setDataReady(true);
        }).catch(() => {
            setDataReady(true);
        });
    }, []);

    // Legacy persisted sessions may still carry activeView='agent'. Agent is no
    // longer a top-level mode (it lives in the right drawer) — normalize once.
    useEffect(() => {
        if (activeView === 'agent') setActiveView('workflow');
    }, [activeView, setActiveView]);

    // Cross-surface "open the Agent drawer" requests (top-menu status chip,
    // canvas toolbar, host hub CTA). Consume any request made before mount and
    // keep listening while mounted.
    useEffect(() => {
        const openAgentDrawer = () => {
            consumeWorkflowAgentDrawerRequest();
            setRightTab('agent');
            setRightOpen(true);
        };
        if (consumeWorkflowAgentDrawerRequest()) openAgentDrawer();
        return subscribeWorkflowAgentDrawer(openAgentDrawer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        try { localStorage.setItem('workflowRightPanelWidth', String(rightWidth)); } catch { /* storage may be unavailable */ }
    }, [rightWidth]);

    useEffect(() => {
        try { localStorage.setItem('workflowRightPanelOpenV2', String(desktopRightOpen)); } catch { /* storage may be unavailable */ }
    }, [desktopRightOpen]);

    useEffect(() => {
        if (mediumViewport) setMobileRightOpen(false);
    }, [mediumViewport]);

    const openAgentDrawerTab = useCallback(() => {
        if (rightOpen && rightTab === 'agent') setRightOpen(false);
        else { setRightTab('agent'); setRightOpen(true); }
    }, [rightOpen, rightTab, setRightOpen]);

    const handleFocusNodeFromDrawer = useCallback((nodeId: string) => {
        setCanvasView('spatial');
        setFocusNodeRequest({ nodeId, nonce: Date.now() });
    }, [setCanvasView]);

    useEffect(() => {
        if (!dataReady) return;
        saveAssetLibraryAsync(assetLibrary).catch(console.error);
    }, [assetLibrary, dataReady]);

    useEffect(() => {
        if (!dataReady) return;
        saveGenerationHistoryAsync(generationHistory).catch(console.error);
    }, [generationHistory, dataReady]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const updateTheme = (event?: MediaQueryListEvent) => {
            setSystemTheme((event ? event.matches : media.matches) ? 'dark' : 'light');
        };
        updateTheme();
        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', updateTheme);
            return () => media.removeEventListener('change', updateTheme);
        }
        media.addListener(updateTheme);
        return () => media.removeListener(updateTheme);
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = resolvedTheme;
        root.style.setProperty('--ui-bg-color', themePalette.uiBgColor);
        root.style.setProperty('--button-bg-color', themePalette.buttonBgColor);
        document.body.style.backgroundColor = themePalette.appBackground;
    }, [resolvedTheme, themePalette]);

    const t = useCallback((key: string, ...args: any[]): any => {
        const dict = translations[language] || translations.en;
        const value = key.split('.').reduce<unknown>((current, part) => {
            if (!current || typeof current !== 'object' || !(part in current)) return undefined;
            return (current as Record<string, unknown>)[part];
        }, dict as unknown);
        if (typeof value === 'function') return value(...args);
        return value ?? key;
    }, [language]);


    const confirmRouteFallback = useCallback((resolution: RouteFallbackResolution) => window.confirm(
        `主线路 ${resolution.unavailablePrimary.key.name || resolution.unavailablePrimary.key.provider} · ${resolution.unavailablePrimary.routeId || '未配置'} 当前不可用。\n\n是否改用 ${resolution.key.name || resolution.key.provider} · ${resolution.routeId}？`,
    ), []);

    const handleEnhancePrompt = useCallback(async (payload: { prompt: string; mode: PromptEnhanceMode; stylePreset?: string }) => {
        setIsEnhancingPrompt(true);
        try {
            const route = await resolveRouteMappingForSubmit(
                { kind: 'runtime-capability', capability: 'prompt-enhancement' },
                userApiKeys,
                confirmRouteFallback,
            );
            return await enhancePromptWithProvider(payload, route.routeId, route.key);
        } finally {
            setIsEnhancingPrompt(false);
        }
    }, [confirmRouteFallback, userApiKeys]);

    const saveGenerationToHistory = useCallback(async (payload: {
        name?: string;
        dataUrl: string;
        mimeType: string;
        width: number;
        height: number;
        prompt: string;
        mediaType?: 'image' | 'video';
    }) => {
        const item: GenerationHistoryItem = {
            id: generateId(),
            name: payload.name,
            dataUrl: payload.dataUrl,
            mimeType: payload.mimeType,
            width: payload.width,
            height: payload.height,
            prompt: payload.prompt,
            createdAt: Date.now(),
            mediaType: payload.mediaType,
        };
        setGenerationHistory(prev => addGenerationHistoryItem(prev, item));
    }, []);

    const resolveWorkflowGenerationCapability = useCallback((mode: GenerationMode, modelId?: string) => {
        return getGenerationCapability(userApiKeys, mode, modelId);
    }, [userApiKeys]);

    const workflowSharedMedia = useMemo(() => generationHistory.map(item => ({
        id: `history:${item.id}`,
        source: 'history' as const,
        sourceId: item.id,
        name: item.name || (item.mediaType === 'video' ? '生成视频' : '生成图片'),
        href: item.dataUrl,
        mimeType: item.mimeType,
        type: item.mediaType === 'video' || item.mimeType.startsWith('video/') ? 'video' as const : 'image' as const,
        width: item.width,
        height: item.height,
        createdAt: item.createdAt,
        prompt: item.prompt,
    })), [generationHistory]);

    const handleRunWorkflowNode = useCallback(async (command: WorkflowRunCommand, context: WorkflowExecutionContext): Promise<WorkflowRunAdapterResult | void> => {
        const { projectId, nodeId } = command;
        let project = useWorkflowStore.getState().projects.find(item => item.id === projectId);
        if (!project) return;
        const currentRevision = project.draftVersion || 1;
        if (command.expectedRevision !== undefined && command.expectedRevision !== currentRevision) {
            throw new WorkflowExecutionError('REVISION_CONFLICT', `Workflow 草稿版本已变化：期望 ${command.expectedRevision}，当前 ${currentRevision}。`, context.runId);
        }
        const requestedNode = project.nodes.find(item => item.id === nodeId);
        const capabilityId = requestedNode?.metadata.operation?.capabilityId;
        const operationCapability = capabilityId ? getWorkflowOperationCapability(capabilityId) : undefined;
        if (requestedNode?.type === 'operation' && operationCapability?.executor === 'local-transform' && operationCapability.mediaType === 'video') {
            const { rerunWorkflowVideoOperation } = await import('./services/workflowVideoOperations');
            await rerunWorkflowVideoOperation(projectId, nodeId, {
                getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
                onProjectChange: next => { useWorkflowStore.getState().updateProject(projectId, next); },
                loadCreativeHostResource,
            });
            return { status: 'completed' };
        }
        if (requestedNode?.type === 'operation' && operationCapability?.executor === 'local-transform' && operationCapability.mediaType === 'audio') {
            const { rerunWorkflowAudioOperation } = await import('./services/workflowAudioOperations');
            await rerunWorkflowAudioOperation(projectId, nodeId, {
                getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
                onProjectChange: next => { useWorkflowStore.getState().updateProject(projectId, next); },
                loadCreativeHostResource,
            });
            return { status: 'completed' };
        }
        if (requestedNode?.type === 'operation' && operationCapability?.mediaType === 'image' && capabilityId !== 'image.generate@1') {
            const { rerunWorkflowImageOperation } = await import('./services/workflowImageOperations');
            await rerunWorkflowImageOperation(projectId, nodeId, {
                userApiKeys, confirmRouteFallback,
                getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
                onProjectChange: next => { useWorkflowStore.getState().updateProject(projectId, next); },
                loadCreativeHostResource,
            });
            return { status: 'completed' };
        }
        const prepared = await ensureWorkflowImageGenerateOperation({ project, nodeId, createId: generateId });
        const executableNodeId = prepared.operationNodeId;
        if (prepared.created) {
            project = prepared.project;
            useWorkflowStore.getState().updateProject(projectId, {
                nodes: project.nodes,
                connections: project.connections,
                selectedNodeIds: project.selectedNodeIds,
                draftVersion: project.draftVersion,
            });
        }
        let canonicalInput: CanonicalGenerationInput | undefined;
        const generated = await runWorkflowGeneration(project, executableNodeId, {
            userApiKeys,
            confirmRouteFallback,
            runId: context.runId,
            resumeProviderTaskId: context.resumeProviderTaskId,
            promptIntent: command.promptIntent?.targetNodeId === executableNodeId ? command.promptIntent : undefined,
            onCanonicalInput: input => { canonicalInput = input; },
            assets: assetLibrary.items.map(({ id, name, mimeType }) => ({ id, name, mimeType })),
            getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
            loadCreativeHostResource,
            onProjectChange: (next) => {
                const previous = useWorkflowStore.getState().projects.find(item => item.id === projectId);
                useWorkflowStore.getState().updateProject(projectId, next);
                const gainedDurableTask = next.nodes.some(node => {
                    const taskId = node.metadata.generationProviderTaskId;
                    if (!taskId || node.metadata.status !== 'loading') return false;
                    return previous?.nodes.find(item => item.id === node.id)?.metadata.generationProviderTaskId !== taskId;
                });
                if (gainedDurableTask) return flushWorkflowPersistence();
            },
            saveHistory: saveGenerationToHistory,
        });
        const generatedNode = generated.nodes.find(item => item.id === executableNodeId);
        const failureMessage = generatedNode?.metadata.status === 'error' ? generatedNode.metadata.error : undefined;
        if (failureMessage) {
            const normalized = normalizeWorkflowExecutionError(new Error(failureMessage), context.runId);
            return { status: 'failed', error: { code: normalized.code, message: normalized.message }, canonicalInput };
        }
        const committedArtifact = generatedNode?.metadata.storageKey && context.runId
            ? registerWorkflowArtifact({
                artifactId: context.runId,
                storageKey: generatedNode.metadata.storageKey,
                kind: generatedNode.type === 'video' ? 'video' : generatedNode.type === 'audio' ? 'audio' : 'image',
                mimeType: generatedNode.metadata.mimeType,
                name: generatedNode.metadata.name || generatedNode.title,
                prompt: generatedNode.metadata.prompt,
                modelId: generatedNode.metadata.config?.modelId,
                taskId: generatedNode.metadata.generationProviderTaskId,
                byteSize: generatedNode.metadata.bytes,
                width: generatedNode.metadata.naturalWidth,
                height: generatedNode.metadata.naturalHeight,
                durationMs: generatedNode.metadata.durationMs,
            })
            : undefined;
        return { status: 'completed', canonicalInput, ...(committedArtifact ? { artifact: committedArtifact } : {}) };
    }, [assetLibrary.items, confirmRouteFallback, saveGenerationToHistory, userApiKeys]);

    const workflowExecutor = useMemo(() => createWorkflowExecutor({
        runNode: (command, context) => handleRunWorkflowNode(command, context),
        stopNode: ({ projectId, nodeId }) => { cancelWorkflowGeneration(projectId, nodeId); },
    }), [handleRunWorkflowNode]);
    useEffect(() => {
        if (!apiKeysLoaded || !activeWorkflowProjectId || userApiKeys.length === 0) return;
        const project = workflowProjects.find(item => item.id === activeWorkflowProjectId);
        if (!project) return;
        project.nodes
            .filter(node => node.metadata.status === 'loading' && node.metadata.generationProviderTaskId && node.metadata.config?.mode === 'video')
            .forEach(node => {
                const providerTaskId = node.metadata.generationProviderTaskId;
                if (!providerTaskId) return;
                const recoveryKey = [project.id, node.id, providerTaskId].join(':');
                if (recoveryTasks.current.has(recoveryKey)) return;
                recoveryTasks.current.add(recoveryKey);
                void (async () => {
                    try {
                        const modelId = node.metadata.config?.modelId || '';
                        const submode = node.metadata.config?.submode || 'text-to-video';
                        const route = await resolveRouteMappingForSubmit({ kind: 'product-mode', productModelId: modelId, mode: submode as any }, userApiKeys);
                        // Resume is supported for any provider whose runner honors
                        // resumeProviderTaskId: the desktop Runtime ('custom') and
                        // RunningHub both persist providerTaskId and resume the same
                        // upstream task. Gating on 'custom' alone made RunningHub
                        // restart-recovery unreachable despite the mechanism existing.
                        if (route.key.provider !== 'custom' && route.key.provider !== 'runningHub') throw new Error('当前 AI 服务暂不支持刷新后恢复视频任务。');
                        await workflowExecutor.runNode(
                            { projectId: project.id, nodeId: node.id },
                            { surface: 'recovery', runId: 'recovery_' + providerTaskId, resumeProviderTaskId: providerTaskId },
                        );
                    } catch (error) {
                        const message = error instanceof Error ? error.message : '视频任务恢复失败，请稍后重试。';
                        const latest = useWorkflowStore.getState().projects.find(item => item.id === project.id);
                        if (latest) {
                            useWorkflowStore.getState().updateProject(project.id, {
                                nodes: latest.nodes.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, status: 'error', error: message, generationMessage: undefined, progress: undefined } } : item),
                            });
                        }
                    }
                })();
            });
    }, [activeWorkflowProjectId, apiKeysLoaded, userApiKeys, workflowExecutor, workflowProjects]);
    const runWorkflowNodeFromUi = useCallback((projectId: string, nodeId: string, promptIntent?: PromptIntent) => {
        const node = useWorkflowStore.getState().projects.find(item => item.id === projectId)?.nodes.find(item => item.id === nodeId);
        if (!node) return;
        const capabilityId = node.metadata.operation?.capabilityId;
        const capability = capabilityId ? getWorkflowOperationCapability(capabilityId) : undefined;
        if (requiresExternalGenerationGate(node, capability)) {
            const details = getGenerationGateDetails(node, capability, userApiKeys);
            if (!window.confirm(buildGenerationGateSummary(details))) {
                toast.show('已取消生成。', 'info');
                return;
            }
        }
        void workflowExecutor.runNode({ projectId, nodeId, ...(promptIntent ? { promptIntent } : {}) }, { surface: 'ui' });
    }, [toast, userApiKeys, workflowExecutor]);

    const handleSaveWorkflowMedia = useCallback(async (projectId: string, nodeId: string) => {
        const node = useWorkflowStore.getState().projects.find(item => item.id === projectId)?.nodes.find(item => item.id === nodeId);
        if (!node || (!node.metadata.storageKey && !node.metadata.href)) return;
        const blob = await loadWorkflowMediaBlob(node.metadata.storageKey, node.metadata.href);
        if (!blob) return;
        setAddAssetModal({ open: true, dataUrl: await blobToDataUrl(blob), mimeType: blob.type, width: node.width || 0, height: node.height || 0 });
    }, []);

    useEffect(() => {
        setWorkflowExecutor(workflowExecutor);
        return () => setWorkflowExecutor(undefined);
    }, [workflowExecutor]);

    const handleWorkflowNodeTool = useCallback(async (projectId: string, nodeId: string, tool: string, args: Record<string, unknown>) => {
        // 画布二次处理工具服务含 ffmpeg 等重型依赖，懒加载避免拖进主 chunk。
        const { runWorkflowNodeTool } = await import('./services/workflowNodeTools');
        const runtime: WorkflowNodeToolRuntime = {
            userApiKeys,
            confirmRouteFallback,
            getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
            loadCreativeHostResource,
            onProjectChange: (next) => { useWorkflowStore.getState().updateProject(projectId, next); },
        };
        return runWorkflowNodeTool(projectId, nodeId, tool as WorkflowNodeToolName, args, runtime);
    }, [confirmRouteFallback, userApiKeys]);

    useEffect(() => {
        setWorkflowNodeToolRunner(handleWorkflowNodeTool);
    }, [handleWorkflowNodeTool]);

    const activeWorkflowProject = workflowProjects.find(project => project.id === activeWorkflowProjectId) || null;
    const activeWorkflowTitle = activeWorkflowProject?.title || 'Workflow';
    const handleWorkflowReversePrompt = useCallback(async (imageHref: string, mimeType: string, imgWidth?: number, imgHeight?: number): Promise<string> => {
        const route = await resolveRouteMappingForSubmit(
            { kind: 'runtime-capability', capability: 'image-understanding' },
            userApiKeys,
            confirmRouteFallback,
        );
        return reversePromptStreamWithProvider(imageHref, mimeType, route.routeId, route.key, () => undefined, undefined, language, { width: imgWidth, height: imgHeight });
    }, [confirmRouteFallback, language, userApiKeys]);

    const handleOpenTable = useCallback((nodeId?: string) => {
        setTableSourceNodeId(nodeId ?? null);
        setActiveView('workflow');
        setCanvasView('table');
    }, [setActiveView, setCanvasView]);

    const handleCommitTableResult = useCallback(async (result: TableProcessResult, sourceNodeId: string | null, name: string) => {
        const project = useWorkflowStore.getState().projects.find(item => item.id === useWorkflowStore.getState().activeProjectId);
        if (!project) throw new Error('请先创建 Workflow 项目。');
        const extension = result.mimeType.includes('webm') ? 'webm' : result.mimeType.includes('png') ? 'png' : 'webp';
        const file = new File([result.blob], `${name}.${extension}`, { type: result.mimeType, lastModified: Date.now() });
        const record = await ingestWorkflowMedia(file);
        const source = project.nodes.find(node => node.id === sourceNodeId);
        const node = createWorkflowNode(generateId(), record.type, source
            ? { x: source.position.x + source.width + 80, y: source.position.y }
            : { x: -project.viewport.x / project.viewport.k + 180, y: -project.viewport.y / project.viewport.k + 140 }, { ...record, status: 'success' });
        node.title = name;
        if (record.naturalWidth && record.naturalHeight) {
            node.width = Math.min(record.type === 'video' ? 480 : 420, record.naturalWidth);
            node.height = Math.round(node.width * record.naturalHeight / record.naturalWidth);
        }
        const connection = source ? [{ id: generateId(), fromNodeId: source.id, toNodeId: node.id }] : [];
        useWorkflowStore.getState().updateProject(project.id, {
            nodes: [...project.nodes, node],
            connections: [...project.connections, ...connection],
            selectedNodeIds: [node.id],
        });
        releaseWorkflowMediaRecord(record.storageKey);
        toast.show('预处理结果已发送到 Workflow。', 'success');
    }, [toast]);

    const handleSaveTableAsset = useCallback(async (result: TableProcessResult, name: string) => {
        const dataUrl = await blobToDataUrl(result.blob);
        setAssetLibrary(previous => addAsset(previous, {
            id: generateId(),
            name,
            folderIds: [],
            tags: ['Table 预处理'],
            dataUrl,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            createdAt: Date.now(),
            source: 'generation',
        }));
        toast.show('已保存到我的素材。', 'success');
    }, [toast]);

    const studioRuntimeStatus = useMemo(() => ({
        tone: 'ready' as const,
        label: language === 'zho' ? '制作台就绪' : 'Production ready',
        detail: language === 'zho' ? '可选择 Codex、WorkBuddy 或 DeepSeek Harness 作为 Agent 指挥入口' : 'Pick Codex, WorkBuddy, or DeepSeek Harness as your agent director',
    }), [language]);
    const studioMenuModel: StudioMenuModel = useMemo(() => ({
        mode: activeView,
        title: canvasView === 'table' ? 'Table' : canvasView === 'agent' ? 'Agent' : activeWorkflowTitle,
        themeMode,
        resolvedTheme,
        language,
        status: studioRuntimeStatus,
        actions: {
            changeMode: setActiveView,
            setThemeMode,
            toggleLanguage: () => setLanguage(language === 'zho' ? 'en' : 'zho'),
            openSettings: () => setIsSettingsPanelOpen(true),
        },
        projectList: workflowProjects.map(project => ({ id: project.id, title: project.title })),
        activeProjectIndex: activeWorkflowIndex,
        projectActions: {
            create: () => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow'),
            remove: () => { if (activeWorkflowProjectId) workflowDeleteProjects([activeWorkflowProjectId]); },
            rename: (newTitle: string) => { if (activeWorkflowProjectId) workflowRenameProject(activeWorkflowProjectId, newTitle); },
            setActiveByIndex: (index: number) => { const target = workflowProjects[index]; if (target) workflowSetActiveProject(target.id); },
        },
    }), [activeView, canvasView, activeWorkflowTitle, resolvedTheme, themeMode, language, setActiveView, setThemeMode, setLanguage, studioRuntimeStatus, workflowProjects, activeWorkflowIndex, activeWorkflowProjectId, workflowCreateProject, workflowDeleteProjects, workflowRenameProject, workflowSetActiveProject]);

    const historyDrawerMedia = workflowSharedMedia.filter(media => (media.source || (media.id.startsWith('history:') ? 'history' : 'asset')) === 'history');

    const insertDrawerMedia = useCallback((media: WorkflowSharedMedia) => {
        void insertSharedMediaIntoProject(media)
            .then(result => { if (!result.ok && result.error) toast.show(result.error, 'warning'); });
    }, [toast]);

    const main = (
        // One global right drawer spans both noun surfaces — Canvas and Table
        // are two views of the same Workflow; Agent is the verb beside them.
        <div
            className="studio-layout relative flex h-full min-h-0 min-w-0"
            data-drawer-open={canvasView !== 'agent' && rightOpen ? 'true' : 'false'}
            data-drawer-docked={!mediumViewport ? 'true' : 'false'}
        >
            <div className="studio-layout__surface relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
                {/* Three top-level surfaces. Agent is connection management only;
                    the built-in assistant remains in the right drawer beside the
                    two Workflow views. */}
                {canvasView === 'agent' ? (
                    <AgentConnectionsPage project={activeWorkflowProject} language={language} />
                ) : canvasView === 'table' ? (
                    <Suspense fallback={<div className="grid h-full place-content-center text-sm opacity-40">{language === 'zho' ? '正在加载 Table...' : 'Loading Table...'}</div>}>
                        <TableWorkspace
                            project={activeWorkflowProject}
                            userApiKeys={userApiKeys}
                            confirmRouteFallback={confirmRouteFallback}
                            initialNodeId={tableSourceNodeId}
                            onCommit={handleCommitTableResult}
                            onSaveAsset={handleSaveTableAsset}
                            onOpenWorkflow={() => setCanvasView('spatial')}
                            onOpenSettings={() => setIsSettingsPanelOpen(true)}
                            language={language}
                        />
                    </Suspense>
                ) : (
                    <Suspense fallback={<div className="grid h-full place-content-center text-sm opacity-40">{language === 'zho' ? '正在加载 Workflow...' : 'Loading Workflow...'}</div>}>
                        <WorkflowWorkspace
                            theme={resolvedTheme}
                            language={language}
                            resolveGenerationCapability={resolveWorkflowGenerationCapability}
                            sharedMedia={workflowSharedMedia}
                            onReversePrompt={handleWorkflowReversePrompt}
                            onRunNode={runWorkflowNodeFromUi}
                            onStopNode={(projectId, nodeId) => workflowExecutor.stopNode?.({ projectId, nodeId }, { surface: 'ui' })}
                            onSaveWorkflowMedia={handleSaveWorkflowMedia}
                            assetLibrary={assetLibrary}
                            onRenameAsset={(id, name) => setAssetLibrary(prev => renameAsset(prev, id, name))}
                            onRemoveAsset={id => setAssetLibrary(prev => removeAsset(prev, id))}
                            onUpdateAssetTags={(id, tags) => setAssetLibrary(prev => updateAssetTags(prev, id, tags))}
                            onRemoveAssetFromFolder={(itemId, folderId) => setAssetLibrary(prev => removeAssetFromFolder(prev, itemId, folderId))}
                            onBatchRemoveAssets={ids => setAssetLibrary(prev => batchRemoveAssets(prev, ids))}
                            onBatchAddAssetsToFolder={(ids, folderId) => setAssetLibrary(prev => batchAddAssetsToFolder(prev, ids, folderId))}
                            onBatchAddAssetTags={(ids, tags) => setAssetLibrary(prev => batchAddAssetTags(prev, ids, tags))}
                            onCreateFolder={(parentId, name) => setAssetLibrary(prev => addFolder(prev, { id: generateId(), name, parentId, createdAt: Date.now() }))}
                            onRenameFolder={(id, name) => setAssetLibrary(prev => renameFolder(prev, id, name))}
                            onRemoveFolder={(id, deleteItems) => setAssetLibrary(prev => removeFolder(prev, id, deleteItems))}
                            t={t}
                            userApiKeys={userApiKeys}
                            confirmRouteFallback={confirmRouteFallback}
                            dynamicModelOptions={dynamicModelOptions}
                            onOpenSettings={() => setIsSettingsPanelOpen(true)}
                            onEnhancePrompt={handleEnhancePrompt}
                            isEnhancingPrompt={isEnhancingPrompt}
                            onOpenAgent={openAgentDrawerTab}
                            agentOpen={rightOpen && rightTab === 'agent'}
                            focusNodeRequest={focusNodeRequest}
                            onNotify={(message, level) => toast.show(message, level)}
                        />
                    </Suspense>
                )}
            </div>

            <StudioRightDrawer
                open={canvasView !== 'agent' && rightOpen}
                onOpenChange={setRightOpen}
                outerGap={0}
                width={rightWidth}
                minWidth={280}
                maxWidth={640}
                onWidthChange={setRightWidth}
                flush
                docked={!mediumViewport}
                activeTab={rightTab}
                onTabChange={tab => setRightTab(tab as 'agent' | 'context' | 'history')}
                tabs={[
                    { id: 'agent', label: language === 'zho' ? '助手' : 'Assistant', icon: undefined },
                    { id: 'context', label: language === 'zho' ? '上下文' : 'Context', icon: undefined },
                    { id: 'history', label: language === 'zho' ? '生成历史' : 'History', icon: undefined },
                ]}
            >
                {rightTab === 'agent' && (activeWorkflowProject ? (
                    <FlovartAgentPanel
                        project={activeWorkflowProject}
                        onActivityChange={() => undefined}
                        onOpenSettings={() => setIsSettingsPanelOpen(true)}
                        assetLibrary={assetLibrary}
                        userApiKeys={userApiKeys}
                        onFocusNode={handleFocusNodeFromDrawer}
                    />
                ) : (
                    // Project-less onboarding folded into the drawer's empty state:
                    // pick an external host or create the first project in place.
                    <AgentDrawerEmptyState
                        language={language}
                        onCreateProject={() => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow')}
                    />
                ))}
                {rightTab === 'context' && (activeWorkflowProject ? (
                    <Suspense fallback={null}>
                        <WorkflowContextPanel project={activeWorkflowProject} />
                    </Suspense>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '100%', padding: '0 32px', textAlign: 'center', color: 'var(--isl-ink-soft)', fontSize: 13 }}>
                        <strong style={{ color: 'var(--isl-ink)' }}>{language === 'zho' ? '制作状态需要一个 Workflow 项目' : 'Context needs a workflow project'}</strong>
                        <button type="button" aria-label="新建工作流" onClick={() => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow')}
                            style={{ marginTop: 6, padding: '7px 16px', border: 0, borderRadius: 9, color: '#fff', background: 'var(--isl-accent, #1677ff)', cursor: 'pointer', fontSize: 12 }}>
                            {language === 'zho' ? '创建项目' : 'Create project'}
                        </button>
                    </div>
                ))}
                {rightTab === 'history' && (
                    <StudioMediaBrowser
                        mode="history"
                        items={historyDrawerMedia}
                        language={language}
                        onInsert={media => insertDrawerMedia(media)}
                        onReversePrompt={async media => {
                            const blob = await loadWorkflowMediaBlob(undefined, media.href);
                            return handleWorkflowReversePrompt(await workflowBlobToDataUrl(blob), media.mimeType || blob.type, media.width, media.height);
                        }}
                    />
                )}
            </StudioRightDrawer>
        </div>
    );

    return <AppShell
        themeBackground={themePalette.appBackground}
        topBar={<StudioTopMenu model={studioMenuModel} />}
        main={(
            <StudioNavigationFrame
                language={language}
                canvasView={canvasView}
                projects={workflowProjects.map(project => ({ id: project.id, title: project.title }))}
                activeProjectId={activeWorkflowProjectId}
                onCanvasViewChange={setCanvasView}
                onSelectProject={workflowSetActiveProject}
                onCreateProject={() => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow')}
                onOpenSettings={() => setIsSettingsPanelOpen(true)}
            >
                {main}
            </StudioNavigationFrame>
        )}
        overlays={<>
            <Suspense fallback={null}>
                <SettingsPanel
                    isOpen={isSettingsPanelOpen}
                    onClose={() => setIsSettingsPanelOpen(false)}
                    resolvedTheme={resolvedTheme}
                    userApiKeys={userApiKeys}
                    onAddApiKey={handleAddApiKey}
                    onDeleteApiKey={handleDeleteApiKey}
                    onUpdateApiKey={handleUpdateApiKey}
                    onSetDefaultApiKey={handleSetDefaultApiKey}
                    t={t}
                    clearKeysOnExit={clearKeysOnExit}
                    setClearKeysOnExit={setClearKeysOnExit}
                    usageSummary={usageSummaryMap}
                />

                {addAssetModal?.open && <AssetAddModal
                    isOpen
                    previewDataUrl={addAssetModal.dataUrl}
                    library={assetLibrary}
                    onClose={() => setAddAssetModal(null)}
                    onConfirm={(folderIds, name, tags) => {
                        setAssetLibrary(previous => addAsset(previous, {
                            id: generateId(), name, folderIds, tags: tags || [], dataUrl: addAssetModal.dataUrl,
                            mimeType: addAssetModal.mimeType, width: addAssetModal.width, height: addAssetModal.height,
                            createdAt: Date.now(), source: 'generation',
                        }));
                        setAddAssetModal(null);
                        toast.show('已保存到我的素材。', 'success');
                    }}
                />}
                <BrowserImportBridge />
            </Suspense>
            <ToastStack toasts={toast.toasts} onDismiss={toast.dismiss} />
        </>}
    />;
};

async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export default App;
