import { create } from 'zustand';

/**
 * Context Card 的来源高亮：Context 关系默认不画连线，只在选中 / 悬停卡片时高亮它的来源节点。
 * 键是「卡片 id + 触发方式」，同一张卡片悬停和选中互不覆盖。只在内存里，不进文档。
 */
interface ContextCardHighlightState {
  byKey: Record<string, string[]>;
  set: (key: string, nodeIds: readonly string[] | null) => void;
}

export const useContextCardHighlightStore = create<ContextCardHighlightState>(set => ({
  byKey: {},
  set: (key, nodeIds) => set(state => {
    const next = { ...state.byKey };
    if (nodeIds && nodeIds.length) next[key] = [...nodeIds];
    else delete next[key];
    return { byKey: next };
  }),
}));

export function setContextCardHighlight(key: string, nodeIds: readonly string[] | null) {
  useContextCardHighlightStore.getState().set(key, nodeIds);
}

/** 这个节点现在是否是某张被选中 / 悬停的 Context Card 的来源。 */
export function useIsContextCardSource(nodeId: string): boolean {
  return useContextCardHighlightStore(state => Object.values(state.byKey).some(ids => ids.includes(nodeId)));
}
