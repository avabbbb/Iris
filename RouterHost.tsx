// RouterHost — 顶层路由容器
// HashRouter 兼容 Tauri / Cloudflare Pages 子路径 / GitHub Pages / Vercel
// /      → 重定向到 /app
// /app   → Workflow 主应用 (App.tsx)
import React, { lazy, Suspense, useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { HashRouter, Routes, Route, Navigate } from 'react-router';
import App from './App';
import { useWorkflowStore } from './components/workflow/store';
import { useProductionProjectionAdapter } from './components/workflow/useProductionProjectionAdapter';
import { useWorkflowWorkspaceAdapter } from './components/workflow/useWorkflowWorkspaceAdapter';
import { useUpdaterStore } from './stores/useUpdaterStore';
import { bootstrapLocalAgentConnection } from './services/agentConnectionBootstrap';
import { isDshEmbed } from './services/dshEmbedBridge';

// 懒加载：配对页 / 审批托盘不进首屏关键路径。
const IrisLinkOverlay = lazy(() => import('./components/link/IrisLinkOverlay').then(module => ({ default: module.IrisLinkOverlay })));

function isDesktopShell(): boolean {
  try { return isTauri(); } catch { return false; }
}

export function RouterHost() {
  const desktop = isDesktopShell();
  const projects = useWorkflowStore(state => state.projects);
  const activeProjectId = useWorkflowStore(state => state.activeProjectId);
  const activeProject = projects.find(project => project.id === activeProjectId) || projects[0] || null;

  useEffect(() => {
    // In the DSH embed the bridge owns bootstrap: the host posts a one-time token.
    if (isDshEmbed()) return;
    void bootstrapLocalAgentConnection().catch(error => {
      console.warn('Iris Agent auto-bootstrap unavailable.', error);
    });
  }, []);

  useWorkflowWorkspaceAdapter(activeProject);
  useProductionProjectionAdapter(activeProject?.id || null);

  useEffect(() => {
    useUpdaterStore.getState().autoCheckOnStartup();
  }, []);

  return (
      <>
        <HashRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/app" replace />} />
            <Route path="/app" element={<App />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
        {/* Iris Link（CLI ↔ 线上标签页）：只在网页端；桌面端的 CLI 走本机 loopback。 */}
        {!desktop && (
          <Suspense fallback={null}>
            <IrisLinkOverlay />
          </Suspense>
        )}
      </>
  );
}
