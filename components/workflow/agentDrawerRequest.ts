/**
 * Cross-view request to open the workflow right drawer on the Agent tab.
 *
 * The right drawer's open/tab state lives inside WorkflowWorkspace. Other
 * surfaces (the Agent diagnostics page, the canvas's own "open assistant"
 * affordance) ask for the drawer through here. The workspace subscribes while
 * mounted and also consumes any request issued while it was unmounted, so a
 * request made from another view is honored on return.
 */
let requestNonce = 0;
const listeners = new Set<() => void>();

/**
 * Where the drawer should land once open: a persisted message entry or a tool
 * call (canvas session cards ask for this when a trace row is clicked). The
 * chat panel consumes it and scrolls to the matching message / tool step.
 */
export interface WorkflowAgentDrawerTarget {
  entryId?: string;
  toolCallId?: string;
}
let pendingTarget: WorkflowAgentDrawerTarget | null = null;

export function requestWorkflowAgentDrawer(target?: WorkflowAgentDrawerTarget) {
  if (target && (target.entryId || target.toolCallId)) pendingTarget = { ...(target.entryId ? { entryId: target.entryId } : {}), ...(target.toolCallId ? { toolCallId: target.toolCallId } : {}) };
  requestNonce += 1;
  listeners.forEach(listener => listener());
}

/** Take the pending scroll target (if any); only the chat panel calls this. */
export function consumeWorkflowAgentDrawerTarget(): WorkflowAgentDrawerTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

/**
 * Clear a pending request and report whether one was waiting. Both the mount
 * path and the live subscriber call this so a handled request cannot fire
 * again on a later mount.
 */
export function consumeWorkflowAgentDrawerRequest(): boolean {
  if (requestNonce === 0) return false;
  requestNonce = 0;
  return true;
}


/** Subscribe to live requests while the workspace is mounted. */
export function subscribeWorkflowAgentDrawer(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
