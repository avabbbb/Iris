// Tapflow-style Custom Workflow Templates (local-first IndexedDB persistence via localforage).
// Supports:
// - Capturing any selected subgraph or full canvas into a clean, portable template (no transient state)
// - Instantiating / remixing any template onto an existing canvas with remapped IDs & anchor offset
// - Exporting and importing `.iris-template.json` files (zero server DB required)

import localforage from 'localforage';
import { nanoid } from 'nanoid';
import type { WorkflowConnection, WorkflowNode, WorkflowPoint } from './types';

export type CustomTemplateCategory = 'film' | 'product' | 'character' | 'video-edit' | 'relight' | 'custom';

export interface WorkflowTemplateNodeSnapshot {
  templateNodeId: string;
  type: WorkflowNode['type'];
  title: string;
  /** Relative offset from bounding box top-left. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  anchor?: WorkflowNode['anchor'];
  shot?: WorkflowNode['shot'];
  metadata: {
    content?: string;
    prompt?: string;
    config?: WorkflowNode['metadata']['config'];
    cameraRig?: WorkflowNode['metadata']['cameraRig'];
    colorTag?: WorkflowNode['metadata']['colorTag'];
    pinned?: boolean;
    storyboardTag?: WorkflowNode['metadata']['storyboardTag'];
    scriptBreakdown?: WorkflowNode['metadata']['scriptBreakdown'];
  };
}

export interface WorkflowTemplateConnectionSnapshot {
  fromTemplateNodeId: string;
  toTemplateNodeId: string;
  kind?: WorkflowConnection['kind'];
  order?: number;
}

export interface CustomWorkflowTemplate {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  category: CustomTemplateCategory;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowTemplateNodeSnapshot[];
  connections: WorkflowTemplateConnectionSnapshot[];
}

const TEMPLATE_STORE_KEY = 'custom_templates_v1';
let templateDb: LocalForage | null = null;

function getTemplateDb(): LocalForage {
  if (!templateDb) {
    templateDb = localforage.createInstance({ name: 'iris_custom_templates_v1', storeName: 'templates' });
  }
  return templateDb;
}

/**
 * Capture a set of nodes + their internal edges into a clean reusable template.
 * Strips runtime status, temporary URLs, storageKeys, errors, and generation history.
 */
export function createCustomTemplateFromSubgraph(input: {
  name: string;
  description?: string;
  category?: CustomTemplateCategory;
  nodes: readonly WorkflowNode[];
  connections: readonly WorkflowConnection[];
  now?: string;
}): CustomWorkflowTemplate {
  const cleanName = input.name.trim() || '自定义工作流模板';
  const eligible = input.nodes.filter(node => node.type !== 'plugin:agent-session' && node.type !== 'plugin:context-card');
  if (!eligible.length) {
    throw new Error('没有可保存为模板的节点');
  }
  const minX = Math.min(...eligible.map(node => node.position.x));
  const minY = Math.min(...eligible.map(node => node.position.y));
  const idMap = new Map<string, string>();
  eligible.forEach((node, index) => idMap.set(node.id, `tpl_n_${index + 1}`));

  const nodes: WorkflowTemplateNodeSnapshot[] = eligible.map(node => ({
    templateNodeId: idMap.get(node.id)!,
    type: node.type,
    title: node.title,
    offsetX: Math.round(node.position.x - minX),
    offsetY: Math.round(node.position.y - minY),
    width: node.width,
    height: node.height,
    ...(node.anchor ? { anchor: { kind: node.anchor.kind, approved: false } } : {}),
    ...(node.shot ? { shot: { ...node.shot, anchorNodeIds: undefined } } : {}),
    metadata: {
      ...(node.metadata.content !== undefined ? { content: node.metadata.content } : {}),
      ...(node.metadata.prompt !== undefined ? { prompt: node.metadata.prompt } : {}),
      ...(node.metadata.config ? { config: { ...node.metadata.config } } : {}),
      ...(node.metadata.cameraRig ? { cameraRig: { ...node.metadata.cameraRig } } : {}),
      ...(node.metadata.colorTag ? { colorTag: node.metadata.colorTag } : {}),
      ...(node.metadata.pinned ? { pinned: true } : {}),
      ...(node.metadata.storyboardTag ? { storyboardTag: node.metadata.storyboardTag } : {}),
      ...(node.metadata.scriptBreakdown ? { scriptBreakdown: JSON.parse(JSON.stringify(node.metadata.scriptBreakdown)) } : {}),
    },
  }));

  const connections: WorkflowTemplateConnectionSnapshot[] = input.connections
    .filter(edge => idMap.has(edge.fromNodeId) && idMap.has(edge.toNodeId))
    .map(edge => ({
      fromTemplateNodeId: idMap.get(edge.fromNodeId)!,
      toTemplateNodeId: idMap.get(edge.toNodeId)!,
      ...(edge.kind ? { kind: edge.kind } : {}),
      ...(edge.order !== undefined ? { order: edge.order } : {}),
    }));

  const timestamp = input.now || new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `tpl_${nanoid(10)}`,
    name: cleanName,
    description: (input.description || '').trim() || `${nodes.length} 个节点 · ${connections.length} 条连线`,
    category: input.category || 'custom',
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes,
    connections,
  };
}

/**
 * Materialize any custom template (or built-in node list) at a target anchor position
 * with fresh unique IDs, ready to apply onto an existing canvas via `applyOps`.
 */
export function instantiateTemplateAt(
  template: Pick<CustomWorkflowTemplate, 'nodes' | 'connections'>,
  anchor: WorkflowPoint,
): { nodes: WorkflowNode[]; connections: WorkflowConnection[] } {
  const idMap = new Map<string, string>();
  const nodes: WorkflowNode[] = template.nodes.map(snap => {
    const freshId = nanoid();
    idMap.set(snap.templateNodeId, freshId);
    return {
      id: freshId,
      type: snap.type,
      title: snap.title,
      position: {
        x: Math.round(anchor.x + snap.offsetX),
        y: Math.round(anchor.y + snap.offsetY),
      },
      width: snap.width,
      height: snap.height,
      isVisible: true,
      isLocked: false,
      ...(snap.anchor ? { anchor: { ...snap.anchor } } : {}),
      ...(snap.shot ? { shot: { ...snap.shot } } : {}),
      metadata: {
        status: 'idle',
        origin: 'user',
        ...snap.metadata,
        ...(snap.metadata.config ? { config: { ...snap.metadata.config } } : {}),
        ...(snap.metadata.cameraRig ? { cameraRig: { ...snap.metadata.cameraRig } } : {}),
      },
    };
  });

  const connections: WorkflowConnection[] = template.connections
    .filter(edge => idMap.has(edge.fromTemplateNodeId) && idMap.has(edge.toTemplateNodeId))
    .map(edge => ({
      id: nanoid(),
      fromNodeId: idMap.get(edge.fromTemplateNodeId)!,
      toNodeId: idMap.get(edge.toTemplateNodeId)!,
      kind: edge.kind || 'data',
      ...(edge.order !== undefined ? { order: edge.order } : {}),
    }));

  return { nodes, connections };
}

/**
 * Remap an arbitrary set of already-built WorkflowNodes + connections (such as from
 * `buildWorkflowTemplate`) to fresh IDs placed around `anchor`.
 */
export function relocateSeedToAnchor(
  seed: { nodes: WorkflowNode[]; connections: WorkflowConnection[] },
  anchor: WorkflowPoint,
): { nodes: WorkflowNode[]; connections: WorkflowConnection[] } {
  if (!seed.nodes.length) return { nodes: [], connections: [] };
  const minX = Math.min(...seed.nodes.map(n => n.position.x));
  const minY = Math.min(...seed.nodes.map(n => n.position.y));
  const idMap = new Map<string, string>();
  const nodes = seed.nodes.map(node => {
    const id = nanoid();
    idMap.set(node.id, id);
    return {
      ...node,
      id,
      position: {
        x: Math.round(anchor.x + (node.position.x - minX)),
        y: Math.round(anchor.y + (node.position.y - minY)),
      },
    };
  });
  const connections = seed.connections
    .filter(edge => idMap.has(edge.fromNodeId) && idMap.has(edge.toNodeId))
    .map(edge => ({
      ...edge,
      id: nanoid(),
      fromNodeId: idMap.get(edge.fromNodeId)!,
      toNodeId: idMap.get(edge.toNodeId)!,
    }));
  return { nodes, connections };
}

/** Validate and normalize an imported `.iris-template.json` payload. */
export function parseImportedWorkflowTemplate(raw: unknown): CustomWorkflowTemplate {
  if (!raw || typeof raw !== 'object') throw new Error('无效的模板文件格式');
  const candidate = raw as Partial<CustomWorkflowTemplate>;
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) {
    throw new Error('模板中不包含任何有效节点');
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: typeof candidate.id === 'string' && candidate.id.trim() ? `tpl_${nanoid(8)}` : `tpl_${nanoid(10)}`,
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : '导入的模板',
    description: typeof candidate.description === 'string' ? candidate.description.trim() : `${candidate.nodes.length} 个节点`,
    category: (['film', 'product', 'character', 'video-edit', 'relight', 'custom'] as const).includes(candidate.category as CustomTemplateCategory)
      ? (candidate.category as CustomTemplateCategory)
      : 'custom',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : now,
    updatedAt: now,
    nodes: candidate.nodes.map((node, idx) => ({
      templateNodeId: String(node.templateNodeId || `tpl_n_${idx + 1}`),
      type: node.type || 'image',
      title: String(node.title || '节点'),
      offsetX: Number.isFinite(node.offsetX) ? Number(node.offsetX) : idx * 380,
      offsetY: Number.isFinite(node.offsetY) ? Number(node.offsetY) : 0,
      width: Number.isFinite(node.width) ? Math.max(160, Number(node.width)) : 340,
      height: Number.isFinite(node.height) ? Math.max(100, Number(node.height)) : 240,
      ...(node.anchor ? { anchor: node.anchor } : {}),
      ...(node.shot ? { shot: node.shot } : {}),
      metadata: node.metadata && typeof node.metadata === 'object' ? { ...node.metadata } : {},
    })),
    connections: Array.isArray(candidate.connections)
      ? candidate.connections.map(edge => ({
        fromTemplateNodeId: String(edge.fromTemplateNodeId || ''),
        toTemplateNodeId: String(edge.toTemplateNodeId || ''),
        ...(edge.kind ? { kind: edge.kind } : {}),
        ...(edge.order !== undefined ? { order: edge.order } : {}),
      })).filter(edge => edge.fromTemplateNodeId && edge.toTemplateNodeId)
      : [],
  };
}

export async function listCustomWorkflowTemplates(db: LocalForage = getTemplateDb()): Promise<CustomWorkflowTemplate[]> {
  const stored = await db.getItem<CustomWorkflowTemplate[]>(TEMPLATE_STORE_KEY).catch(() => null);
  return Array.isArray(stored) ? stored : [];
}

export async function saveCustomWorkflowTemplate(
  template: CustomWorkflowTemplate,
  db: LocalForage = getTemplateDb(),
): Promise<CustomWorkflowTemplate[]> {
  const current = await listCustomWorkflowTemplates(db);
  const next = [template, ...current.filter(item => item.id !== template.id)].slice(0, 60);
  await db.setItem(TEMPLATE_STORE_KEY, next);
  return next;
}

export async function deleteCustomWorkflowTemplate(
  id: string,
  db: LocalForage = getTemplateDb(),
): Promise<CustomWorkflowTemplate[]> {
  const current = await listCustomWorkflowTemplates(db);
  const next = current.filter(item => item.id !== id);
  await db.setItem(TEMPLATE_STORE_KEY, next);
  return next;
}
