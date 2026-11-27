import { BookOpen, Camera, Sparkles, Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AssetFolder, AssetLibrary, UserApiKey, GenerationMode, PromptEnhanceMode, PromptEnhanceResult } from '../../types';
import { PromptBar } from '../PromptBar';
import { CameraControlPopover, type CameraControlValue } from './CameraControlPopover';
import { applyCameraFragmentToPrompt, summarizeCameraControl } from './cameraControl';
import { useMenuKeyboard } from '../../hooks/useListboxKeyboard';
import { editorJSONToText, extractMentions, type MentionData } from '../MediaMentionExtension';
import type { AssetSuggestion } from '../MentionList';
import type { ReferencePickerWorkflowItem } from '../studio/AssetReferencePicker';
import { resolveWorkflowDefaultModel } from '../../services/workflowPromptPolicy';
import { getWorkflowOperationCapability, localizeOperationLabel, localizeParameterControl, parseWorkflowOperationParameters, type WorkflowOperationCapability, type WorkflowOperationUiLanguage } from './operationRegistry';
import { createPromptIntent, type PromptIntent, type PromptIntentAction } from './promptIntent';
import { mentionRegionsFromDocument, setMentionRegionInDocument } from './referenceRegion';
import { ReferenceRegionPopover } from './ReferenceRegionPopover';
import {
  filterWorkflowInputIds,
  getOrderedImageReferences,
  resolveWorkflowMentionIds,
  toImageReferenceChips,
  toWorkflowMentionItems,
} from './references';
import type { WorkflowConnection, WorkflowGenerationConfig, WorkflowNode, WorkflowNodeMetadata } from './types';
import { promptAssetFromQuickPrompt } from '../../services/promptAsset';
import { SlashMenu } from './SlashMenu';
import { shouldOpenPromptSlashMenu, stripTrailingSlash, type SlashShortcut } from './slashShortcuts';

export interface WorkflowModelOptions {
  text: string[];
  image: string[];
  video: string[];
}

function WorkflowOperationParameterPanel({ capability, parameters, onChange, language }: {
  capability: WorkflowOperationCapability;
  parameters: Record<string, unknown>;
  onChange: (parameters: Record<string, unknown>) => void;
  language?: WorkflowOperationUiLanguage;
}) {
  if (!capability.parameterControls?.length) return null;
  const update = (key: string, value: unknown) => {
    try {
      onChange(parseWorkflowOperationParameters(capability.id, { ...parameters, [key]: value }));
    } catch {
      // Keep the last valid Recipe while the user is editing a cross-field constraint.
    }
  };
  const controls = capability.parameterControls.map(control => localizeParameterControl(control, language));
  return <div className="workflow-operation-parameters" role="group" aria-label={language === 'en' ? localizeOperationLabel(capability, language) + ' parameters' : capability.label + '参数'} data-testid="workflow-operation-parameters">
    {controls.map(control => <label key={control.key}>
      <span>{control.label}</span>
      {control.kind === 'select'
        ? <select aria-label={control.label} value={String(parameters[control.key] ?? '')} onChange={event => update(control.key, event.target.value)}>
            {control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        : <span className="workflow-operation-parameters__number">
            <input
              aria-label={control.label}
              type="number"
              min={control.min}
              max={control.max}
              step={control.step}
              value={Number(parameters[control.key] || 0) * (control.scale || 1)}
              onChange={event => update(control.key, Number(event.target.value) / (control.scale || 1))}
            />
            {control.suffix && <small>{control.suffix}</small>}
          </span>}
    </label>)}
  </div>;
}

const modeFor = (node: WorkflowNode, config?: WorkflowGenerationConfig): GenerationMode => {
  const mode = config?.mode || (node.type === 'text' ? 'text' : node.type === 'video' ? 'video' : 'image');
  return mode === 'text' || mode === 'video' ? mode : 'image';
};

export function WorkflowNodePromptBar({ node, nodes, connections = [], t, theme, language, userApiKeys, dynamicModelOptions, onOpenSettings, onEnhancePrompt, isEnhancingPrompt, onChange, onPromptIntent, onRun, onStop, focusSignal, onDisconnectReference, onReorderReference, assetFolders, assetItems, assetLibrary, onSelectAsset, onSelectWorkflowReference, onAddReferenceFiles, onResolvePastedMentions, onPasteUnresolvedMentions, onSlashShortcut, onSpawnCameraNode, expanded = false, onToggleExpanded, width = 880 }: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  connections?: WorkflowConnection[];
  t: (key: string, ...args: any[]) => string;
  theme: 'light' | 'dark';
  language: 'en' | 'zho';
  userApiKeys: UserApiKey[];
  dynamicModelOptions: WorkflowModelOptions;
  onOpenSettings?: () => void;
  onEnhancePrompt?: (payload: { prompt: string; mode: PromptEnhanceMode; stylePreset?: string }) => Promise<PromptEnhanceResult>;
  isEnhancingPrompt?: boolean;
  onChange: (metadata: Partial<WorkflowNodeMetadata>) => void;
  /** 在提示词里键入 `/`（开头或空格后）时弹出与画布 `/` 同一份快捷工具菜单；选中后由 Workflow 层套用到本节点。只加弹层，不改 Prompt Bar 本体。 */
  onSlashShortcut?: (shortcut: SlashShortcut, remainingPrompt: string) => void;
  /** 3D 视角面板「派生新视角节点」：创建连好线的下游节点（不自动计费运行）。 */
  onSpawnCameraNode?: (fragment: string, value: CameraControlValue) => void;
  /** PromptBar 的稳定业务输出，不携带 Provider wire 字段或凭据。 */
  onPromptIntent?: (intent: PromptIntent) => void;
  onRun: () => void;
  onStop?: () => void;
  focusSignal?: number;
    /** 断开当前节点到指定上游节点的连线（由 Workflow 层执行 applyOps delete_connections） */
  onDisconnectReference?: (fromNodeId: string) => void;
  /** 拖拽排序 chip 时以新的节点顺序重排连接（由 Workflow 层执行 reorder_connections op） */
  onReorderReference?: (nextIds: string[]) => void;
  /** 个人素材库根文件夹（扁平数组，parentId=null 表示根级） */
  assetFolders?: AssetFolder[];
  /** 个人素材库条目（轻量索引，不含原图 dataUrl） */
  assetItems?: AssetSuggestion[];
  assetLibrary?: AssetLibrary;
  /** 选择素材时调用，返回新节点 id（或复用已存在节点 id）；未提供则禁用素材选择 */
  onSelectAsset?: (assetId: string) => string | undefined;
    onSelectWorkflowReference?: (nodeId: string) => string | undefined;
  onAddReferenceFiles?: (files: File[]) => void | Promise<void>;
  onResolvePastedMentions?: (mentions: MentionData[]) => Array<MentionData | null>;
  onPasteUnresolvedMentions?: (labels: string[]) => void;
  /** 放大编辑态（由画布居中放大），以及右上角切换回调 */
  expanded?: boolean;
  onToggleExpanded?: () => void;
    /** 根据工作流可用宽度收缩，保持底栏单行展示 */
  width?: number;
}) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryKeys = useMenuKeyboard({ open: libraryOpen, onClose: () => setLibraryOpen(false) });
  const [slashOpen, setSlashOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const operationCapability = node.metadata.operation ? getWorkflowOperationCapability(node.metadata.operation.capabilityId) : undefined;
  const isLocalOperation = operationCapability?.executor === 'local-transform';
  const config = node.metadata.config || { mode: node.type === 'text' ? 'text' : node.type === 'video' ? 'video' : 'image' };
  const generationMode = modeFor(node, config);
  // 节点配置的比例是唯一权威：config 没写时读 Operation Recipe 的参数（Agent 直接建的 Operation 只带 recipe），
  // 两处都没有才用 PromptBar 默认值。
  const recipeAspectRatio = node.metadata.operation?.recipe.parameters?.aspectRatio;
  const configuredAspectRatio = config.aspectRatio || (typeof recipeAspectRatio === 'string' && recipeAspectRatio ? recipeAspectRatio : undefined);
  const availableProductModelIds = generationMode === 'video'
    ? dynamicModelOptions?.video || []
    : dynamicModelOptions?.image || [];
  const defaultMappedModelId = resolveWorkflowDefaultModel({
    mode: generationMode,
    localOperation: operationCapability?.executor === 'local-transform',
    modelIds: availableProductModelIds,
    userApiKeys,
  });
  const mentionItems = toWorkflowMentionItems([
    ...getOrderedImageReferences(node, nodes, connections),
  ]);
  const keepConnectedMentions = (plainText: string, ids: string[]) => {
    const resolved = filterWorkflowInputIds(resolveWorkflowMentionIds(plainText, ids, mentionItems), node.id, connections);
    const operationInputIds = node.metadata.operation?.recipe.inputBindings
      ?.filter(binding => binding.role !== 'prompt_context')
      ?.map(binding => binding.sourceNodeId) || [];
    return [...new Set([...operationInputIds, ...resolved])];
  };
  const allowedReferenceTypes = operationCapability
    ? new Set(operationCapability.inputRoles.flatMap(input => input.nodeTypes))
    : null;
  const referenceItems: ReferencePickerWorkflowItem[] = nodes.filter(item => item.id !== node.id
    && item.isVisible !== false
    && (item.type === 'image' || item.type === 'video')
    && (!allowedReferenceTypes || allowedReferenceTypes.has(item.type))).map(item => ({
    id: item.id,
    label: item.title,
    elementType: item.type as 'image' | 'video',
    thumbnail: item.metadata.href,
    storageKey: item.metadata.storageKey,
    description: item.metadata.content?.trim().slice(0, 36) || item.type,
  }));
  const orderedImageRefs = getOrderedImageReferences(node, nodes, connections);
  const documentMentionIds = node.metadata.richTextDocument ? extractMentions(node.metadata.richTextDocument).map(item => item.id) : [];
  const documentRegions = mentionRegionsFromDocument(node.metadata.richTextDocument);
  const referenceChips = toImageReferenceChips(orderedImageRefs, keepConnectedMentions(node.metadata.prompt || '', documentMentionIds))
    .map(chip => documentRegions.has(chip.id) ? { ...chip, region: documentRegions.get(chip.id) } : chip);
  const [regionChipId, setRegionChipId] = useState<string | null>(null);
  const regionChip = regionChipId ? referenceChips.find(chip => chip.id === regionChipId) : undefined;
  const lastPromptIntentRef = useRef<PromptIntent | null>(null);

  const promptMention = (id: string, regions = documentRegions) => {
    const item = [...mentionItems, ...referenceItems, ...(assetItems || []).map(asset => ({
      id: `asset:${asset.id}`,
      label: asset.name,
      thumbnail: asset.thumbnail,
      elementType: asset.elementType,
      assetId: asset.id,
      sourceType: 'assetLibrary',
    }))].find(candidate => {
      const assetId = 'assetId' in candidate ? candidate.assetId : undefined;
      return candidate.id === id || assetId === id || `asset:${assetId}` === id;
    });
    const assetId = item && 'assetId' in item ? item.assetId : undefined;
    const sourceType = item && 'sourceType' in item ? item.sourceType : undefined;
    const region = regions.get(id);
    return { id, label: item?.label, elementType: item?.elementType, assetId, sourceType, ...(region ? { region } : {}) };
  };
  const emitPromptIntent = (text: string, ids: string[], requestedAction: PromptIntentAction = 'edit', document?: unknown) => {
    const regions = document === undefined ? documentRegions : mentionRegionsFromDocument(document);
    const intent = createPromptIntent({ targetNodeId: node.id, text, mentions: ids.map(id => promptMention(id, regions)), requestedAction });
    lastPromptIntentRef.current = intent;
    onPromptIntent?.(intent);
  };

  const handleReorder = (nextIds: string[]) => {
    emitPromptIntent(node.metadata.prompt || '', nextIds, 'reorder_reference');
    onReorderReference?.(nextIds);
  };

  const handleRemoveReference = (fromNodeId: string) => {
    const remaining = keepConnectedMentions(node.metadata.prompt || '', documentMentionIds).filter(id => id !== fromNodeId);
    emitPromptIntent(node.metadata.prompt || '', remaining, 'remove_reference');
    onDisconnectReference?.(fromNodeId);
  };

  const handlePromptInput = (plainText: string, document: Record<string, unknown>, mentionedElementIds: string[]) => {
    const previous = node.metadata.prompt || '';
    if (onSlashShortcut && node.type === 'image' && shouldOpenPromptSlashMenu(previous, plainText)) setSlashOpen(true);
    const mentionIds = keepConnectedMentions(plainText, mentionedElementIds);
    emitPromptIntent(plainText, mentionIds, 'edit', document);
    onChange({ prompt: plainText, richTextDocument: document as typeof node.metadata.richTextDocument });
  };
  const latestPromptIntent = () => {
    const previous = lastPromptIntentRef.current?.targetNodeId === node.id ? lastPromptIntentRef.current : undefined;
    return {
      text: previous?.text ?? node.metadata.prompt ?? '',
      ids: previous
        ? previous.mentions.map(mention => mention.id || mention.assetId).filter((id): id is string => Boolean(id))
        : keepConnectedMentions(node.metadata.prompt || '', documentMentionIds),
    };
  };
  const handleGenerate = () => {
    // 默认模型在运行提交时解析回填：不再由 effect 静默写 store（会污染撤销历史，
    // 且 undo 后会立即重填）。此时是用户主动点击，写入是合法的历史记录。
    if (!config.modelId && defaultMappedModelId) patchConfig({ modelId: defaultMappedModelId });
    const current = latestPromptIntent();
    emitPromptIntent(current.text, current.ids, 'generate');
    onRun();
  };
  const handleStop = onStop ? () => {
    const current = latestPromptIntent();
    emitPromptIntent(current.text, current.ids, 'stop');
    onStop();
  } : undefined;
  const handleSelectAsset = (assetId: string) => {
    const selected = onSelectAsset?.(assetId);
    if (selected) {
      const current = latestPromptIntent();
      emitPromptIntent(current.text, [...current.ids, selected], 'add_reference');
    }
    return selected;
  };
  const handleSelectWorkflowReference = (nodeId: string) => {
    const selected = onSelectWorkflowReference?.(nodeId);
    if (selected) {
      const current = latestPromptIntent();
      emitPromptIntent(current.text, [...current.ids, selected], 'add_reference');
    }
    return selected;
  };
  const handleAddReferenceFiles = async (files: File[]) => {
    const current = latestPromptIntent();
    emitPromptIntent(current.text, current.ids, 'add_reference');
    await onAddReferenceFiles?.(files);
  };

  // 只发增量：画布的 update_node 会把 config 再合并一层。发整份 config 时，PromptBar 在旧渲染里算出的补丁
  // （如分辨率归一化）会把这期间 Agent / CLI 写入的新比例覆盖回旧值，PromptBar 与节点配置随之分叉。
  // 节点还没有 config 时补上默认 mode，避免只剩一个字段。
  const patchConfig = (patch: Partial<WorkflowGenerationConfig>) => onChange({ config: node.metadata.config ? patch as WorkflowGenerationConfig : { ...config, ...patch } });

  const translatedPrompts = t('quickPrompts');
  const prompts = Array.isArray(translatedPrompts) ? translatedPrompts.filter((item): item is { name: string; value: string } => Boolean(item) && typeof item.name === 'string' && typeof item.value === 'string') : [];
  const promptAssets = prompts.map((item, index) => promptAssetFromQuickPrompt({ id: `quick:${index}`, title: item.name, text: item.value, modality: generationMode === 'keyframe' ? 'image' : generationMode }));
  const providerUsageLabel = [
    node.metadata.generationActualCost !== undefined
      ? `${node.metadata.generationCurrency === 'CNY' ? '¥' : '$'}${node.metadata.generationActualCost.toFixed(node.metadata.generationActualCost < 1 ? 3 : 2)}`
      : undefined,
    node.metadata.generationActualTokens !== undefined ? `${node.metadata.generationActualTokens.toLocaleString()} Token` : undefined,
  ].filter(Boolean).join(' · ') || undefined;

  const applyRegion = (region: Parameters<typeof setMentionRegionInDocument>[2]) => {
    if (!regionChip) return;
    const document = setMentionRegionInDocument(node.metadata.richTextDocument, regionChip.id, region, {
      label: regionChip.label,
      thumbnail: regionChip.thumbnail,
      elementType: regionChip.elementType,
    });
    handlePromptInput(editorJSONToText(document), document, extractMentions(document).map(item => item.id));
    setRegionChipId(null);
  };

  const cameraSummary = summarizeCameraControl({
    camera: config.camera,
    cameraMovement: config.cameraMovement,
    rig3d: node.metadata.cameraRig,
  }, language);
  const showCameraControl = !isLocalOperation && (generationMode === 'image' || generationMode === 'video');
  const isDraftVideo = generationMode === 'video' && Boolean(config.draftMode);
  const hasDraftUpgrade = isDraftVideo && node.metadata.status === 'success' && Boolean(node.metadata.storageKey || node.metadata.href || node.metadata.artifactRef);
  const toggleDraftMode = () => {
    if (isDraftVideo) {
      patchConfig({ draftMode: false, resolution: config.draftPreviousResolution || '720p' });
    } else {
      const prev = config.resolution && config.resolution !== '480p' ? config.resolution : '720p';
      patchConfig({ draftMode: true, draftPreviousResolution: prev, resolution: '480p' });
    }
  };
  const upgradeDraftToHd = () => {
    patchConfig({ draftMode: false, resolution: config.draftPreviousResolution || '1080p' });
  };

  return (
    <div data-workflow-overlay data-testid="workflow-node-prompt-bar" data-language={language} className="inline-prompt-bar workflow-node-prompt" style={{ ['--workflow-node-prompt-width' as string]: `${width}px` }} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      {operationCapability && <WorkflowOperationParameterPanel
        capability={operationCapability}
        parameters={node.metadata.operation?.recipe.parameters || {}}
        onChange={operationParameters => patchConfig({ operationParameters })}
        language={language}
      />}
      {(showCameraControl || generationMode === 'video') && !isLocalOperation && (
        <div className="wf-prompt-director-strip" data-testid="wf-prompt-director-strip">
          {showCameraControl && (
            <button
              type="button"
              className={`wf-director-pill${cameraSummary ? ' is-active' : ''}`}
              data-testid="wf-camera-control-trigger"
              aria-expanded={cameraOpen}
              onClick={() => setCameraOpen(open => !open)}
              title={language === 'en' ? 'Cinema camera, lens & 3D multi-angle rig' : '电影机身、镜头组合与 3D 多角度机位'}
            >
              <Camera size={12} />
              <span>{cameraSummary || (language === 'en' ? 'Cine Lens / 3D Angle' : '电影镜头 · 3D 视角')}</span>
            </button>
          )}
          {generationMode === 'video' && (
            <button
              type="button"
              className={`wf-director-pill${isDraftVideo ? ' is-draft' : ''}`}
              data-testid="wf-video-draft-toggle"
              aria-pressed={isDraftVideo}
              onClick={toggleDraftMode}
              title={language === 'en' ? 'Draft Mode renders fast 480p preview before upgrading to HD' : '草稿模式先以 480p 快速低成本预演运镜，满意后再升级高清'}
            >
              <Zap size={12} />
              <span>{isDraftVideo ? (language === 'en' ? 'Draft 480p' : '草稿 480p') : (language === 'en' ? 'Draft Mode' : '草稿模式')}</span>
            </button>
          )}
          {hasDraftUpgrade && (
            <button
              type="button"
              className="wf-director-pill is-upgrade"
              data-testid="wf-video-draft-upgrade"
              onClick={upgradeDraftToHd}
              title={language === 'en' ? 'Switch resolution to HD (ready to run)' : '切换为高清分辨率，确认后运行高清成片'}
            >
              <Sparkles size={12} />
              <span>{language === 'en' ? `Upgrade to ${config.draftPreviousResolution || '1080p'}` : `升级为高清 (${config.draftPreviousResolution || '1080p'})`}</span>
            </button>
          )}
        </div>
      )}
      {cameraOpen && showCameraControl && (
        <div className="wf-camera-popover-anchor">
          <CameraControlPopover
            value={{ camera: config.camera, cameraMovement: config.cameraMovement, rig3d: node.metadata.cameraRig }}
            mode={generationMode === 'video' ? 'video' : 'image'}
            language={language}
            onChange={next => {
              onChange({
                cameraRig: next.rig3d,
                config: {
                  ...config,
                  camera: next.camera,
                  cameraMovement: next.cameraMovement,
                },
              });
            }}
            onApplyToPrompt={(fragment, next) => {
              const updatedPrompt = applyCameraFragmentToPrompt(node.metadata.prompt || '', fragment);
              emitPromptIntent(updatedPrompt, keepConnectedMentions(updatedPrompt, documentMentionIds), 'edit');
              onChange({
                prompt: updatedPrompt,
                richTextDocument: undefined,
                cameraRig: next.rig3d,
                config: {
                  ...config,
                  camera: next.camera,
                  cameraMovement: next.cameraMovement,
                },
              });
            }}
            onSpawnMultiAngle={onSpawnCameraNode}
            onClose={() => setCameraOpen(false)}
          />
        </div>
      )}
      {prompts.length > 0 && <button type="button" className="workflow-node-prompt__library-button" aria-label={language === 'en' ? 'Prompt library' : '提示词库'} title={language === 'en' ? 'Prompt library' : '提示词库'} onClick={() => setLibraryOpen(open => !open)}><BookOpen size={15} /></button>}
      {slashOpen && onSlashShortcut && <div className="workflow-node-prompt__slash" data-testid="workflow-node-prompt-slash">
        <SlashMenu
          onClose={() => setSlashOpen(false)}
          onSelect={shortcut => {
            setSlashOpen(false);
            const remaining = stripTrailingSlash(node.metadata.prompt || '');
            if (remaining !== (node.metadata.prompt || '')) onChange({ prompt: remaining });
            onSlashShortcut(shortcut, remaining);
          }}
        />
      </div>}
      {libraryOpen && <div className="workflow-node-prompt__library" role="menu" aria-label={language === 'en' ? 'Prompt library' : '提示词库'} {...libraryKeys}>{promptAssets.map(asset => <button type="button" role="menuitem" key={asset.id} onClick={() => { emitPromptIntent(asset.text, [], 'edit'); onChange({ prompt: asset.text, richTextDocument: undefined }); setLibraryOpen(false); }}><strong>{asset.title}</strong><span>{asset.text}</span></button>)}</div>}
      <PromptBar
        t={t}
        theme={theme}
        language={language}
        compactMode
        prompt={node.metadata.prompt || ''}
        promptDocument={node.metadata.richTextDocument}
        setPrompt={prompt => handlePromptInput(prompt, { type: 'doc', content: prompt ? [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }] : [] }, [])}
        onPromptInputChange={({ plainText, document }) => {
          const sameDocument = !node.metadata.richTextDocument
            || JSON.stringify(document) === JSON.stringify(node.metadata.richTextDocument);
          if (plainText === (node.metadata.prompt || '') && sameDocument) return;
          handlePromptInput(plainText, document, extractMentions(document).map(item => item.id));
        }}
        onResolvePastedMentions={onResolvePastedMentions}
        onPasteUnresolvedMentions={onPasteUnresolvedMentions}
        mentionItems={mentionItems}
        referenceItems={referenceItems}
        imageReferenceChips={referenceChips}
        onImageReferenceReorder={handleReorder}
        onImageReferenceRemove={onDisconnectReference ? handleRemoveReference : undefined}
        onImageReferenceFocus={node.isLocked ? undefined : setRegionChipId}
        onGenerate={handleGenerate}
        onStop={handleStop}
        onRetry={node.metadata.status === 'error' ? handleGenerate : undefined}
        error={node.metadata.error || null}
        progressStage={node.metadata.generationMessage || (node.metadata.progress === undefined ? undefined : `${Math.round(node.metadata.progress)}%`)}
        providerUsageLabel={providerUsageLabel}
        runWithoutPrompt={Boolean(operationCapability && !operationCapability.promptRequired)}
        providerOptional={isLocalOperation}
        hideGenerationOptions={isLocalOperation}
        promptSnapshotKey={'workflow-node:' + node.id}
        runLabel={operationCapability ? (language === 'en' ? 'Run' : '运行') : undefined}
        isLoading={node.metadata.status === 'loading'}
        isSelectionActive={false}
        selectedElementCount={1}
        userEffects={[]}
        onAddUserEffect={() => undefined}
        onDeleteUserEffect={() => undefined}
        generationMode={generationMode}
        setGenerationMode={mode => patchConfig({ mode: mode === 'text' ? 'text' : mode === 'video' ? 'video' : 'image', modelId: undefined })}
        modeOptions={operationCapability
          ? [operationCapability.mediaType === 'video' ? 'video' : 'image']
          : node.type === 'video' ? ['video'] : node.type === 'text' ? ['text'] : ['image']}
        videoAspectRatio={(configuredAspectRatio as any) || '16:9'}
        setVideoAspectRatio={aspectRatio => patchConfig({ aspectRatio })}
        imageAspectRatio={(configuredAspectRatio as any) || '1:1'}
        setImageAspectRatio={aspectRatio => patchConfig({ aspectRatio })}
        videoDurationSec={config.durationSec}
        onVideoDurationSecChange={durationSec => patchConfig({ durationSec })}
        videoResolution={config.resolution}
        onVideoResolutionChange={resolution => patchConfig({ resolution })}
        videoGenerateAudio={config.generateAudio}
        onVideoGenerateAudioChange={generateAudio => patchConfig({ generateAudio })}
        videoWatermark={config.watermark}
        onVideoWatermarkChange={watermark => patchConfig({ watermark })}
        generationSubmode={config.submode}
        onGenerationSubmodeChange={submode => patchConfig({ submode })}
        generationQuality={config.quality}
        onGenerationQualityChange={quality => patchConfig({ quality })}
        webSearchEnabled={config.webSearch}
        onWebSearchToggle={webSearch => patchConfig({ webSearch })}
        realPersonCheckEnabled={config.realPersonCheck !== false}
        onRealPersonCheckToggle={realPersonCheck => patchConfig({ realPersonCheck })}
        preserveReferenceAspectRatio={config.preserveReferenceAspectRatio === true}
        onPreserveReferenceAspectRatioChange={enabled => patchConfig({ preserveReferenceAspectRatio: enabled })}
        selectedTextModel={undefined}
        selectedImageModel={generationMode === 'image' ? config.modelId || defaultMappedModelId : undefined}
        selectedVideoModel={generationMode === 'video' ? config.modelId || defaultMappedModelId : undefined}
        textModelOptions={[]}
        imageModelOptions={dynamicModelOptions.image}
        videoModelOptions={dynamicModelOptions.video}
        onImageModelChange={modelId => patchConfig({ modelId })}
        onVideoModelChange={modelId => patchConfig({ modelId })}
        apiConfigs={userApiKeys}
        userApiKeys={userApiKeys}
        onOpenSettings={onOpenSettings}
        onEnhancePrompt={onEnhancePrompt}
        isEnhancingPrompt={isEnhancingPrompt}
        isAutoEnhanceEnabled={Boolean(config.enhancePrompt)}
        onAutoEnhanceToggle={() => patchConfig({ enhancePrompt: !config.enhancePrompt })}
        batchCount={config.count || 1}
        onBatchCountChange={count => patchConfig({ count })}
        allowVideoBatch
        focusSignal={focusSignal}
        variant="inline"
        shellClassName="inline-prompt-bar-shell"
        popoverDirection="auto"
        assetFolders={assetFolders}
        assetItems={assetItems}
        assetLibrary={assetLibrary}
        onSelectWorkflowReference={onSelectWorkflowReference ? handleSelectWorkflowReference : undefined}
        onAddReferenceFiles={onAddReferenceFiles ? handleAddReferenceFiles : undefined}
        onSelectAsset={onSelectAsset ? handleSelectAsset : undefined}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
      />
      {regionChip && (
        <ReferenceRegionPopover
          label={regionChip.label}
          storageKey={regionChip.storageKey}
          href={regionChip.thumbnail}
          region={regionChip.region}
          language={language === 'en' ? 'en' : 'zh'}
          onConfirm={applyRegion}
          onClose={() => setRegionChipId(null)}
        />
      )}
    </div>
  );
}
