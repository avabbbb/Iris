import { create } from 'zustand';

/** A canvas group handed to the side Agent panel (toolbar action '添加到 Agent'). */
export interface AgentGroupPayload {
  nodeIds: string[];
  label: string;
  batchId?: string;
}

/** A Context Card's 「继续讨论」 handed to the side Agent panel. The panel decides open-vs-new from the card itself. */
export interface AgentDiscussionPayload {
  projectId: string;
  cardNodeId: string;
}

interface AgentGroupInboxState {
  pendingGroup: AgentGroupPayload | null;
  pendingDiscussion: AgentDiscussionPayload | null;
  push: (payload: AgentGroupPayload) => void;
  consume: () => AgentGroupPayload | null;
  pushDiscussion: (payload: AgentDiscussionPayload) => void;
  consumeDiscussion: () => AgentDiscussionPayload | null;
}

export const useAgentGroupInboxStore = create<AgentGroupInboxState>((set, get) => ({
  pendingGroup: null,
  pendingDiscussion: null,
  push: payload => set({ pendingGroup: { ...payload, nodeIds: [...new Set(payload.nodeIds)] } }),
  consume: () => {
    const pending = get().pendingGroup;
    if (!pending) return null;
    set({ pendingGroup: null });
    return pending;
  },
  pushDiscussion: payload => set({ pendingDiscussion: { ...payload } }),
  consumeDiscussion: () => {
    const pending = get().pendingDiscussion;
    if (!pending) return null;
    set({ pendingDiscussion: null });
    return pending;
  },
}));

export const pushAgentGroup = (payload: AgentGroupPayload) => useAgentGroupInboxStore.getState().push(payload);

export const consumeAgentGroup = () => useAgentGroupInboxStore.getState().consume();

export const pushAgentDiscussion = (payload: AgentDiscussionPayload) => useAgentGroupInboxStore.getState().pushDiscussion(payload);
