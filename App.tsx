import { isDshEmbed } from './services/dshEmbedBridge';
import React, { useState, useCallback, useEffect, useMemo, Suspense } from 'react';
import { generateId } from './utils/helpers';
import type { AssetLibrary, UserApiKey, PromptEnhanceMode, GenerationHistoryItem, ThemeMode } from './types';
import { addAsset, removeAsset, renameAsset, addFolder, renameFolder, removeFolder, loadAssetLibraryAsync, saveAssetLibraryAsync, updateAssetTags, removeAssetFromFolder, batchRemoveAssets, batchAddAssetsToFolder, batchAddAssetTags } from './utils/assetStorage';
import { historyOriginFromSurface, recordWorkflowRunInTimeline } from './components/workflow/timelineEvents';
import { loadGenerationHistoryAsync, saveGenerationHistoryAsync, addGenerationHistoryItem } from './utils/generationHistory';
import { reversePromptStreamWithProvider, enhancePromptWithProvider } from './services/aiGateway';
import { useApiKeys, normalizeApiKeyEntry } from './hooks/useApiKeys';
import { useToast } from './hooks/useToast';
import ToastStack from './components/Toast';
import { ConfirmHost } from './components/ConfirmHost';
import { StudioHub } from './components/studio/StudioHub';
import { requestUiConfirm } from './services/uiConfirm';
import { AppShell } from './components/AppShell';
import { StudioTopMenu, type StudioMenuModel } from './components/studio/StudioTopMenu';
import { StudioNavigationFrame } from './components/studio/StudioNavigationFrame';
import { runCanvasSwitch, type CanvasSwitchOrigin } from './components/studio/canvasSwitchTransition';
import { StudioRightDrawer } from './components/studio/StudioRightDrawer';
import { StudioMediaBrowser } from './components/studio/StudioMediaBrowser';
import { IrisAgentPanel } from './components/agent/IrisAgentPanel';
import { AgentDrawerEmptyState } from './components/agent/AgentWorkspace';
import { HarkAgentWorkspace } from './components/agent/HarkAgentWorkspace';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { flushWorkflowPersistence, useWorkflowStore } from './components/workflow/store';
import { consumeWorkflowAgentDrawerRequest, subscribeWorkflowAgentDrawer } from './components/workflow/agentDrawerRequest';
import { useCanvasAgentStore } from './stores/useCanvasAgentStore';
import type {  } from './components/workflow/WorkflowConfigPanel';
import { getGenerationCapability, type GenerationMode } from './services/generationCapabilities';
import { cancelWorkflowGeneration, findInterruptedWorkflowNodes, runWorkflowGeneration, stopOrphanedWorkflowNode, terminalGenerationPatch } from './services/workflowGeneration';
import { loadWorkflowMediaBlob, workflowBlobToDataUrl } from './components/workflow/media';
import { extractVideoFrame } from './services/videoFrameExtractor';
import { setWorkflowAssetLookup, setWorkflowExecutor, setWorkflowNodeToolRunner, setWorkflowUserApiKeysProvider } from './services/workflowDispatcher';
import { createWorkflowExecutor, normalizeWorkflowExecutionError, WorkflowExecutionError, type WorkflowExecutionContext, type WorkflowRunAdapterResult, type WorkflowRunCommand } from './services/workflowExecutor';
import type { CanonicalGenerationInput } from './components/workflow/inputResolver';
import type { PromptIntent } from './components/workflow/promptIntent';
import type { WorkflowNodeToolName, WorkflowNodeToolRuntime } from './services/workflowNodeTools';
import type { WorkflowNode, WorkflowProject } from './components/workflow/types';
import { translations } from './utils/translations';
import './styles/generation.css';
import { resolveRouteMappingForSubmit, type RouteFallbackResolution } from './services/routeMapping';
import { prepareWorkflowImageGenerateRun } from './components/workflow/operations';
import { getWorkflowOperationCapability } from './components/workflow/operationRegistry';
import { buildGenerationGateSummary, getGenerationGateDetails, requiresExternalGenerationGate } from './services/generationGate';
import { applyPlanChecks, buildGenerationPlanChecks } from './services/generationPlan';
import { loadCreativeHostResource } from './services/studio/hostResourceRegistry';
import { registerWorkflowArtifact } from './services/studio/artifactRegistry';
import { collectWorkflowRunOutputNodes } from './services/workflowRunOutputs';

const SettingsPanel = React.lazy(() => import('./components/SettingsPanel').then(m => ({ default: m.SettingsPanel })));

import { AgentDrawerSections } from './components/agent/AgentDrawerSections';
const WorkflowWorkspace = React.lazy(() => import('./components/workflow/WorkflowWorkspace').then(m => ({ default: m.WorkflowWorkspace })));
// Cut 页（视图 id 'reverse'）：视频编辑器 + 故事版 · 逆向子页，整页懒加载。
const CutPage = React.lazy(() => import('./components/cut/CutPage').then(m => ({ default: m.CutPage })));
const AssetAddModal = React.lazy(() => import('./components/AssetAddModal').then(m => ({ default: m.AssetAddModal })));
const BrowserImportBridge = React.lazy(() => import('./components/extension/BrowserImportBridge').then(m => ({ default: m.BrowserImportBridge })));
const ExtensionInstallPrompt = React.lazy(() => import('./components/extension/ExtensionInstallPrompt').then(m => ({ default: m.ExtensionInstallPrompt })));
import { WorkflowSessionGuard } from './components/workflow/WorkflowSessionGuard';
import { useWorkflowWriterState } from './components/workflow/writerLock';

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
    // Global right drawer: single Assistant surface beside Canvas and Reverse —
    // docked (reflow) on desktop, overlay on medium viewports.
    const mediumViewport = useMediaQuery('(max-width: 1023px)');
    const [desktopRightOpen, setDesktopRightOpen] = useState(() => {
        // Closed by default so a first visit sees one clear canvas; the drawer
        // opens from the Agent button and remembers the user's choice after that.
        try { return localStorage.getItem('workflowRightPanelOpenV3') === 'true'; } catch { return false; }
    });
    const [mobileRightOpen, setMobileRightOpen] = useState(false);
    const rightOpen = mediumViewport ? mobileRightOpen : desktopRightOpen;
    const setRightOpen = useCallback((open: boolean) => {
        if (mediumViewport) setMobileRightOpen(open); else setDesktopRightOpen(open);
    }, [mediumViewport]);
    const [rightTab, setRightTab] = useState<'agent' | 'hosts'>('agent');
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
    const interruptCheckedProjects = React.useRef(new Set<string>());

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

    // 画布会话卡的「已读」：对话页可见（抽屉打开在对话页，或 Cut 里常驻的对话栏）时，正显示的会话算已看过。
    useEffect(() => {
        useCanvasAgentStore.getState().setDrawerOpen((canvasView === 'spatial' && rightOpen && rightTab === 'agent') || canvasView === 'reverse');
    }, [canvasView, rightOpen, rightTab]);

    useEffect(() => {
        try { localStorage.setItem('workflowRightPanelWidth', String(rightWidth)); } catch { /* storage may be unavailable */ }
    }, [rightWidth]);

    useEffect(() => {
        try { localStorage.setItem('workflowRightPanelOpenV3', String(desktopRightOpen)); } catch { /* storage may be unavailable */ }
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
        // Embedded in DSH, the host shell paints the backdrop; keep the page body transparent.
        document.body.style.backgroundColor = isDshEmbed() ? 'transparent' : themePalette.appBackground;
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


    const confirmRouteFallback = useCallback((resolution: RouteFallbackResolution) => requestUiConfirm({
        title: '主线路暂不可用',
        body: `${resolution.unavailablePrimary.key.name || resolution.unavailablePrimary.key.provider} · ${resolution.unavailablePrimary.routeId || '未配置'} 当前不可用，改用 ${resolution.key.name || resolution.key.provider} · ${resolution.routeId}？`,
        confirmLabel: '改用备用线路',
    }), []);

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
        projectId?: string;
        origin?: GenerationHistoryItem['origin'];
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
            projectId: payload.projectId,
            ...(payload.origin ? { origin: payload.origin } : {}),
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
        projectId: item.projectId,
        origin: item.origin,
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
        // 结果节点上的生成记录决定重跑走哪个执行器（不再有 operation 中间节点）。
        const operationCapability = capabilityId ? getWorkflowOperationCapability(capabilityId) : undefined;
        if (operationCapability?.executor === 'local-transform' && operationCapability.mediaType === 'video') {
            const { rerunWorkflowVideoOperation } = await import('./services/workflowVideoOperations');
            await rerunWorkflowVideoOperation(projectId, nodeId, {
                getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
                onProjectChange: next => { useWorkflowStore.getState().updateProject(projectId, next); },
                loadCreativeHostResource,
            });
            return { status: 'completed' };
        }
        if (operationCapability?.executor === 'local-transform' && operationCapability.mediaType === 'audio') {
            const { rerunWorkflowAudioOperation } = await import('./services/workflowAudioOperations');
            await rerunWorkflowAudioOperation(projectId, nodeId, {
                getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
                onProjectChange: next => { useWorkflowStore.getState().updateProject(projectId, next); },
                loadCreativeHostResource,
            });
            return { status: 'completed' };
        }
        if (operationCapability?.mediaType === 'image' && capabilityId !== 'image.generate@1') {
            const { rerunWorkflowImageOperation } = await import('./services/workflowImageOperations');
            await rerunWorkflowImageOperation(projectId, nodeId, {
                userApiKeys, confirmRouteFallback,
                getProject: () => useWorkflowStore.getState().projects.find(item => item.id === projectId) || null,
                onProjectChange: next => { useWorkflowStore.getState().updateProject(projectId, next); },
                loadCreativeHostResource,
            });
            return { status: 'completed' };
        }
        // 转换在读取最新状态的同一同步片段内写回 store，并在开新 Take 前重新读取最新状态：
        // 批量 node.run 并行转换多个节点时，旧快照不能覆盖其他节点的转换。
        const prepared = await prepareWorkflowImageGenerateRun({ project, nodeId, createId: generateId });
        const executableNodeId = prepared.operationNodeId;
        project = useWorkflowStore.getState().projects.find(item => item.id === projectId) || prepared.project;
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
            saveHistory: payload => saveGenerationToHistory({ ...payload, projectId, origin: historyOriginFromSurface(context.surface) }),
        });
        const generatedNode = generated.nodes.find(item => item.id === executableNodeId);
        const failureMessage = generatedNode?.metadata.status === 'error' ? generatedNode.metadata.error : undefined;
        if (failureMessage) {
            const normalized = normalizeWorkflowExecutionError(new Error(failureMessage), context.runId);
            return { status: 'failed', error: { code: normalized.code, message: normalized.message }, canonicalInput };
        }
        // 停止后节点回到 idle；被新 run 取代时 generationRequestId 已换成别的 run。两者都没有产物，不能报 completed。
        const supersededBy = generatedNode?.metadata.generationRequestId;
        if (!generatedNode || generatedNode.metadata.status === 'idle' || (supersededBy && context.runId && supersededBy !== context.runId)) {
            return { status: 'cancelled', canonicalInput };
        }
        const registerNodeArtifact = (resultNode: WorkflowNode, artifactId: string) => resultNode.metadata.storageKey
            ? registerWorkflowArtifact({
                artifactId,
                storageKey: resultNode.metadata.storageKey,
                kind: resultNode.type === 'video' ? 'video' : resultNode.type === 'audio' ? 'audio' : 'image',
                mimeType: resultNode.metadata.mimeType,
                name: resultNode.metadata.name || resultNode.title,
                prompt: resultNode.metadata.prompt,
                modelId: resultNode.metadata.config?.modelId,
                taskId: resultNode.metadata.generationProviderTaskId,
                byteSize: resultNode.metadata.bytes,
                width: resultNode.metadata.naturalWidth,
                height: resultNode.metadata.naturalHeight,
                durationMs: resultNode.metadata.durationMs,
            })
            : undefined;
        const committedArtifact = generatedNode?.metadata.storageKey && context.runId
            ? registerNodeArtifact(generatedNode, context.runId)
            : undefined;
        // 多张生成折叠成同一批次：每张都登记成可取回的产物，Agent 不再只拿到封面一张。
        const outputNodes = collectWorkflowRunOutputNodes(project, generated, executableNodeId);
        const outputs = outputNodes && context.runId ? {
            ...outputNodes,
            artifacts: outputNodes.nodeIds.flatMap((resultId, index) => {
                const resultNode = generated.nodes.find(item => item.id === resultId);
                const artifact = resultNode && (resultId === executableNodeId && committedArtifact
                    ? committedArtifact
                    : registerNodeArtifact(resultNode, index === 0 && !committedArtifact ? context.runId! : context.runId + ':' + index));
                return artifact ? [{ ...artifact, nodeId: resultId }] : [];
            }),
        } : undefined;
        return { status: 'completed', canonicalInput, ...(committedArtifact ? { artifact: committedArtifact } : {}), ...(outputs ? { outputs } : {}) };
    }, [assetLibrary.items, confirmRouteFallback, saveGenerationToHistory, userApiKeys]);

    const workflowExecutor = useMemo(() => createWorkflowExecutor({
        runNode: async (command, context) => {
            const result = await handleRunWorkflowNode(command, context);
            recordWorkflowRunInTimeline(command.projectId, command.nodeId, context.surface, result);
            return result;
        },
        stopNode: ({ projectId, nodeId }) => {
            if (cancelWorkflowGeneration(projectId, nodeId)) return;
            // No live request behind this node (interrupted run, lost tab, recovery
            // gave up): Stop must still free it, via the same billing-aware stopped
            // patch as the UI path so a possible upstream charge is never hidden.
            const latest = useWorkflowStore.getState().projects.find(item => item.id === projectId);
            const stopped = latest ? stopOrphanedWorkflowNode(latest, nodeId) : null;
            if (stopped) useWorkflowStore.getState().updateProject(projectId, { nodes: stopped.nodes });
        },
    }), [handleRunWorkflowNode]);
    // 只有写入者标签页处理中断节点与续接；只读标签页看到的 loading 可能正由写入者在跑。
    const workflowWriterState = useWorkflowWriterState();
    useEffect(() => {
        if (workflowWriterState !== 'writer' || !apiKeysLoaded || !activeWorkflowProjectId) return;
        const project = workflowProjects.find(item => item.id === activeWorkflowProjectId);
        if (!project) return;
        const canResume = userApiKeys.length > 0;
        // 刷新前的 loading 节点若无法续接会永远转圈。每个项目只在本会话首次进入时清理一次，
        // 之后的 loading 都来自本会话的真实运行，避免误伤其它执行器正在跑的节点。
        if (!interruptCheckedProjects.current.has(project.id)) {
            interruptCheckedProjects.current.add(project.id);
            const interruptedIds = new Set(findInterruptedWorkflowNodes(project, { canResume }).map(node => node.id));
            if (interruptedIds.size > 0) {
                const { message } = normalizeWorkflowExecutionError(new Error(canResume ? '页面刷新后生成已中断，请重新运行。' : '缺少可用的 API Key，无法恢复刷新前的生成任务。'));
                const latest = useWorkflowStore.getState().projects.find(item => item.id === project.id);
                if (latest) {
                    useWorkflowStore.getState().updateProject(project.id, {
                        nodes: latest.nodes.map(item => interruptedIds.has(item.id) && item.metadata.status === 'loading'
                            ? { ...item, metadata: { ...item.metadata, ...terminalGenerationPatch({ kind: 'interrupted', error: message }) } }
                            : item),
                    });
                }
            }
        }
        if (!canResume) return;
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
                        // 允许后续重新触发恢复；错误文案走统一归类，不暴露原始异常。
                        recoveryTasks.current.delete(recoveryKey);
                        const message = normalizeWorkflowExecutionError(error, 'recovery_' + providerTaskId).message;
                        const latest = useWorkflowStore.getState().projects.find(item => item.id === project.id);
                        if (latest) {
                            useWorkflowStore.getState().updateProject(project.id, {
                                nodes: latest.nodes.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, ...terminalGenerationPatch({ kind: 'failed', error: message }) } } : item),
                            });
                        }
                    }
                })();
            });
    }, [activeWorkflowProjectId, apiKeysLoaded, userApiKeys, workflowExecutor, workflowProjects, workflowWriterState]);
    const pendingRunRef = React.useRef<{ projectId: string; nodeId: string; promptIntent?: PromptIntent } | null>(null);
    const runWorkflowNodeFromUi = useCallback((projectId: string, nodeId: string, promptIntent?: PromptIntent) => {
        const node = useWorkflowStore.getState().projects.find(item => item.id === projectId)?.nodes.find(item => item.id === nodeId);
        if (!node) return;
        const capabilityId = node.metadata.operation?.capabilityId;
        const capability = capabilityId ? getWorkflowOperationCapability(capabilityId) : undefined;
        const run = () => { void workflowExecutor.runNode({ projectId, nodeId, ...(promptIntent ? { promptIntent } : {}) }, { surface: 'ui' }); };
        if (!requiresExternalGenerationGate(node, capability)) { run(); return; }
        if (!userApiKeys.length) {
            // Keep the user's intent: open Settings now and resume this run (still gated) once a key exists.
            pendingRunRef.current = { projectId, nodeId, promptIntent };
            toast.show(language === 'en' ? 'Add an AI service API key in Settings; this node will continue once it is saved.' : '还没有可用的 AI 服务。在设置里添加 API Key 后会自动继续这次生成。', 'warning');
            setIsSettingsPanelOpen(true);
            return;
        }
        // Non-blocking: the canvas stays usable while the user decides, and an
        // unanswered request cancels itself instead of holding the node.
        const baseDetails = getGenerationGateDetails(node, capability, userApiKeys);
        const project = useWorkflowStore.getState().projects.find(item => item.id === projectId);
        // 操作节点（recipe）走各自的参数，不做参考预检；运行时仍会兜底校验。
        const details = project && !node.metadata.operation
            ? applyPlanChecks(baseDetails, buildGenerationPlanChecks({ node, project, keys: userApiKeys, mode: baseDetails.mediaType }))
            : baseDetails;
        const blocked = Boolean(details.blockers?.length);
        void requestUiConfirm({
            title: blocked ? '暂时无法生成' : details.mediaType === 'video' ? '开始生成视频？' : '开始生成图片？',
            body: buildGenerationGateSummary(details),
            plan: { items: [details] },
            confirmDisabled: blocked,
            confirmLabel: '生成',
            ...(blocked ? { cancelLabel: '关闭' } : {}),
            onDismissed: (reason) => toast.show(reason === 'replaced'
              ? (language === 'en' ? 'Another confirmation took its place, so nothing was submitted for this one. Press Run again if you still want it.' : '已有新的确认请求，本次未提交任何任务。如仍需要，请重新点击运行。')
              : reason === 'unmounted'
                ? (language === 'en' ? 'The confirmation closed and nothing was submitted. Press Run again.' : '确认窗口已关闭，未提交任何任务。请重新点击运行。')
                : (language === 'en' ? 'The generation request expired and nothing was submitted. Press Run again.' : '生成确认已过期，未提交任何任务。请重新点击运行。'), 'warning'),
        }).then(approved => { if (approved) run(); });
    }, [language, toast, userApiKeys, workflowExecutor]);

    useEffect(() => {
        const pendingRun = pendingRunRef.current;
        if (!pendingRun || !userApiKeys.length) return;
        pendingRunRef.current = null;
        runWorkflowNodeFromUi(pendingRun.projectId, pendingRun.nodeId, pendingRun.promptIntent);
    }, [runWorkflowNodeFromUi, userApiKeys.length]);

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

    // Agent 的 models.list / generate 按当前 Key 判断可运行模型；media.import 从素材库取素材。只在内存里读，不进命令结果。
    const userApiKeysRef = React.useRef(userApiKeys);
    userApiKeysRef.current = userApiKeys;
    const assetItemsRef = React.useRef(assetLibrary.items);
    assetItemsRef.current = assetLibrary.items;
    useEffect(() => {
        setWorkflowUserApiKeysProvider(() => userApiKeysRef.current);
        setWorkflowAssetLookup(assetId => {
            const asset = assetItemsRef.current.find(item => item.id === assetId);
            return asset ? { id: asset.id, name: asset.name, mimeType: asset.mimeType, width: asset.width, height: asset.height } : undefined;
        });
        return () => { setWorkflowUserApiKeysProvider(undefined); setWorkflowAssetLookup(undefined); };
    }, []);

    const handleWorkflowNodeTool = useCallback(async (projectId: string, nodeId: string, tool: string, args: Record<string, unknown>) => {
        // 画布二次处理工具服务含 ffmpeg 等重型依赖，懒加载避免拖进主 chunk。
        const { runWorkflowNodeTool } = await import('./services/workflowNodeTools');
        if (tool === 'reverse-prompt') {
            const project = useWorkflowStore.getState().projects.find(item => item.id === projectId);
            const node = project?.nodes.find(item => item.id === nodeId);
            if (!project || !node || (node.type !== 'image' && node.type !== 'video')) throw new Error('反推提示词只支持图片或视频节点');
            let href: string;
            let mimeType: string;
            let width = node.metadata.naturalWidth;
            let height = node.metadata.naturalHeight;
            if (node.type === 'video') {
                const poster = await loadWorkflowMediaBlob(node.metadata.posterStorageKey, node.metadata.poster);
                const frame = poster ? null : await (async () => {
                    const video = await loadWorkflowMediaBlob(node.metadata.storageKey, node.metadata.href, node.metadata.artifactRef);
                    if (!video) throw new Error('视频媒体不存在，无法反推');
                    return extractVideoFrame(video, 'first');
                })();
                const blob = poster || frame!.blob;
                href = await workflowBlobToDataUrl(blob);
                mimeType = 'image/png';
                width = poster ? width : frame!.width;
                height = poster ? height : frame!.height;
            } else {
                const blob = await loadWorkflowMediaBlob(node.metadata.storageKey, node.metadata.href, node.metadata.artifactRef);
                if (!blob) throw new Error('图片媒体不存在，无法反推');
                href = await workflowBlobToDataUrl(blob);
                mimeType = node.metadata.mimeType || blob.type || 'image/png';
            }
            const route = await resolveRouteMappingForSubmit(
                { kind: 'runtime-capability', capability: 'image-understanding' },
                userApiKeys,
                confirmRouteFallback,
            );
            const prompt = await reversePromptStreamWithProvider(href, mimeType, route.routeId, route.key, () => undefined, undefined, language, { width, height });
            if (!prompt.trim()) throw new Error('视觉模型没有返回提示词');
            const latest = useWorkflowStore.getState().projects.find(item => item.id === projectId);
            if (!latest) throw new Error('项目已切换或删除');
            const next = {
                ...latest,
                nodes: latest.nodes.map(item => item.id === nodeId ? { ...item, metadata: { ...item.metadata, prompt } } : item),
                draftVersion: (latest.draftVersion || 1) + 1,
                updatedAt: new Date().toISOString(),
            };
            useWorkflowStore.getState().updateProject(projectId, { nodes: next.nodes, draftVersion: next.draftVersion, updatedAt: next.updatedAt });
            return { status: 'committed' as const, project: next };
        }
        if (tool === 'filter') {
            const project = useWorkflowStore.getState().projects.find(item => item.id === projectId);
            const node = project?.nodes.find(item => item.id === nodeId);
            if (!project || !node || node.type !== 'image') throw new Error('滤镜只支持图片节点');
            const raw = args.filters;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('filter 需要 filters 对象');
            const filters = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
            const next = {
                ...project,
                nodes: project.nodes.map(item => item.id === nodeId ? { ...item, metadata: { ...item.metadata, filters } } : item),
                draftVersion: (project.draftVersion || 1) + 1,
                updatedAt: new Date().toISOString(),
            };
            useWorkflowStore.getState().updateProject(projectId, { nodes: next.nodes, draftVersion: next.draftVersion, updatedAt: next.updatedAt });
            return { status: 'committed' as const, project: next };
        }
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


    const hasAiService = userApiKeys.length > 0;
    const studioRuntimeStatus = useMemo(() => hasAiService ? {
        tone: 'ready' as const,
        label: language === 'zho' ? '就绪' : 'Ready',
        detail: language === 'zho' ? 'AI 服务已配置，可以生成。' : 'AI service configured — ready to generate.',
    } : {
        tone: 'warning' as const,
        label: language === 'zho' ? 'AI 服务未配置' : 'No AI service',
        detail: language === 'zho' ? '点这里在设置里添加一个 API Key，之后就能生成。' : 'Click to add an API key in Settings, then you can generate.',
    }, [hasAiService, language]);
    const studioMenuModel: StudioMenuModel = useMemo(() => ({
        mode: activeView,
        title: activeWorkflowTitle,
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
            setActiveByIndex: (index: number, origin?: CanvasSwitchOrigin | null) => {
                const target = workflowProjects[index];
                if (!target) return;
                if (target.id === activeWorkflowProjectId) return;
                void runCanvasSwitch(() => workflowSetActiveProject(target.id), { origin });
            },
        },
    }), [activeView, canvasView, activeWorkflowTitle, resolvedTheme, themeMode, language, setActiveView, setThemeMode, setLanguage, studioRuntimeStatus, workflowProjects, activeWorkflowIndex, activeWorkflowProjectId, workflowCreateProject, workflowDeleteProjects, workflowRenameProject, workflowSetActiveProject]);

    const main = (
        // One global right drawer spans Canvas and Reverse; Agent is the
        // connection/control page beside them.
        <div
            className="studio-layout relative flex h-full min-h-0 min-w-0"
            data-drawer-open={canvasView === 'spatial' && rightOpen ? 'true' : 'false'}
            data-drawer-docked={!mediumViewport ? 'true' : 'false'}
        >
            <div className="studio-layout__surface relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
                {/* Three top-level surfaces. Agent is connection management only;
                    the built-in assistant remains in the right drawer beside the
                    two Workflow views. */}
                {canvasView === 'reverse' ? (
                    // Cut：视频剪辑器 + 故事版子页（素材从当前画布节点派生，写入落到画布真节点；右侧是同一个 Agent，此时抽屉不挂载对话，避免同一项目起两个内核）。
                    <Suspense fallback={<div className="grid h-full place-content-center text-sm opacity-40">{language === 'zho' ? '正在加载 Cut...' : 'Loading Cut...'}</div>}>
                        <CutPage
                            language={language}
                            project={activeWorkflowProject}
                            onCreateProject={() => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow')}
                            onFocusNode={handleFocusNodeFromDrawer}
                            onNotify={(message, level) => toast.show(message, level)}
                            chat={activeWorkflowProject ? (
                                <IrisAgentPanel
                                    project={activeWorkflowProject}
                                    onActivityChange={() => undefined}
                                    onOpenSettings={() => setIsSettingsPanelOpen(true)}
                                    assetLibrary={assetLibrary}
                                    userApiKeys={userApiKeys}
                                    onAddApiKey={handleAddApiKey}
                                    onUpdateApiKey={handleUpdateApiKey}
                                    onFocusNode={handleFocusNodeFromDrawer}
                                    composerPlaceholder={language === 'zho' ? '开始你的创作，或者 @ 引用工作流/节点/资源' : 'Start creating, or @ to reference workflows, nodes and assets'}
                                />
                            ) : (
                                <AgentDrawerEmptyState
                                    language={language}
                                    onCreateProject={() => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow')}
                                />
                            )}
                        />
                    </Suspense>
                ) : canvasView === 'agent' ? (
                    <HarkAgentWorkspace
                        project={activeWorkflowProject}
                        language={language}
                        userApiKeys={userApiKeys}
                        assetLibrary={assetLibrary}
                        onAddApiKey={handleAddApiKey}
                        onUpdateApiKey={handleUpdateApiKey}
                        onOpenSettings={() => setIsSettingsPanelOpen(true)}
                        onFocusNode={handleFocusNodeFromDrawer}
                        onCreateProject={(title, seed) => workflowCreateProject(title || (language === 'zho' ? '未命名工作流' : 'Untitled workflow'), seed)}
                    />
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
                <WorkflowSessionGuard language={language} />
            </div>

            <StudioRightDrawer
                open={canvasView === 'spatial' && rightOpen}
                onOpenChange={setRightOpen}
                outerGap={0}
                width={rightWidth}
                minWidth={280}
                maxWidth={640}
                onWidthChange={setRightWidth}
                flush
                docked={!mediumViewport}
                inlineChromeTabs={['agent']}
                activeTab={rightTab}
                onTabChange={tab => setRightTab(tab as 'agent' | 'hosts')}
                tabs={[
                    { id: 'agent', label: language === 'zho' ? '对话' : 'Chat', icon: undefined },
                ]}
            >
                {rightTab === 'agent' && canvasView === 'spatial' && (<AgentDrawerSections projectTitle={activeWorkflowProject?.title} language={language} chatHasHeader={Boolean(activeWorkflowProject)}>{activeWorkflowProject ? (
                    <IrisAgentPanel
                        project={activeWorkflowProject}
                        onActivityChange={() => undefined}
                        onOpenSettings={() => setIsSettingsPanelOpen(true)}
                        assetLibrary={assetLibrary}
                        userApiKeys={userApiKeys}
                        onAddApiKey={handleAddApiKey}
                        onUpdateApiKey={handleUpdateApiKey}
                        onFocusNode={handleFocusNodeFromDrawer}
                    />
                ) : (
                    // Project-less onboarding folded into the drawer's empty state:
                    // pick an external host or create the first project in place.
                    <AgentDrawerEmptyState
                        language={language}
                        onCreateProject={() => workflowCreateProject(language === 'zho' ? '未命名工作流' : 'Untitled workflow')}
                    />
                )}</AgentDrawerSections>)}
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
                <ExtensionInstallPrompt isDark={resolvedTheme === 'dark'} t={t} />
            </Suspense>
            <ToastStack toasts={toast.toasts} onDismiss={toast.dismiss} />
            <StudioHub language={language} historyItems={workflowSharedMedia} onRemoveHistory={id => setGenerationHistory(prev => prev.filter(item => item.id !== id))} />
            <ConfirmHost />
            {/* 开发环境 + mock 模型（VITE_IRIS_MOCK=1）：右上角红色 MOCK 角标，截图 / 录屏一眼区分 mock 与真实模型。生产构建里整段被裁掉。 */}
            {import.meta.env.DEV && import.meta.env.VITE_IRIS_MOCK === '1' && <div className="iris-mock-badge" data-testid="iris-mock-badge" aria-hidden="true">MOCK</div>}
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
