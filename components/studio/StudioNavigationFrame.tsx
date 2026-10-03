import React, { useEffect, useState } from 'react';
import { Bot, ChevronLeft, ChevronRight, LayoutDashboard, Plus, Settings, Table2 } from 'lucide-react';
import type { CanvasView } from '../../types';
import './StudioNavigationFrame.css';

export interface StudioNavigationProject {
  id: string;
  title: string;
}

interface StudioNavigationFrameProps {
  language: 'en' | 'zho';
  canvasView: CanvasView;
  projects: StudioNavigationProject[];
  activeProjectId: string | null;
  onCanvasViewChange: (view: CanvasView) => void;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
  onOpenSettings: () => void;
  children: React.ReactNode;
}

const STORAGE_KEY = 'iris.navigation.sidebarCollapsed.v1';

export const StudioNavigationFrame: React.FC<StudioNavigationFrameProps> = ({
  language,
  canvasView,
  projects,
  activeProjectId,
  onCanvasViewChange,
  onSelectProject,
  onCreateProject,
  onOpenSettings,
  children,
}) => {
  const isChinese = language === 'zho';
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(collapsed)); } catch { /* storage may be unavailable */ }
  }, [collapsed]);

  const modes: Array<{ id: CanvasView; label: string; icon: React.ReactNode }> = [
    { id: 'spatial', label: isChinese ? '画布' : 'Canvas', icon: <LayoutDashboard size={18} /> },
    { id: 'table', label: 'Table', icon: <Table2 size={18} /> },
    { id: 'agent', label: 'Agent', icon: <Bot size={18} /> },
  ];

  const activeProject = projects.find(project => project.id === activeProjectId);

  return (
    <div className="studio-navigation-frame">
      <aside className="studio-left-rail" aria-label={isChinese ? '主导航' : 'Primary navigation'}>
        <div className="studio-left-rail__brand" aria-hidden="true">
          <img src="/favicon.png" alt="" />
        </div>

        <nav className="studio-left-rail__modes" aria-label={isChinese ? '工作区' : 'Workspace'}>
          {modes.map(mode => (
            <button
              key={mode.id}
              type="button"
              className={`studio-left-rail__button ${canvasView === mode.id ? 'is-active' : ''}`}
              onClick={() => onCanvasViewChange(mode.id)}
              title={mode.label}
              aria-label={mode.label}
              aria-current={canvasView === mode.id ? 'page' : undefined}
            >
              {mode.icon}
              <span>{mode.label}</span>
            </button>
          ))}
        </nav>

        <div className="studio-left-rail__footer">
          <button
            type="button"
            className="studio-left-rail__button"
            onClick={onCreateProject}
            title={isChinese ? '新建工作流' : 'New workflow'}
            aria-label={isChinese ? '新建工作流' : 'New workflow'}
          >
            <Plus size={18} />
            <span>{isChinese ? '新建' : 'New'}</span>
          </button>
          <button
            type="button"
            className="studio-left-rail__button"
            onClick={onOpenSettings}
            title={isChinese ? '设置' : 'Settings'}
            aria-label={isChinese ? '设置' : 'Settings'}
          >
            <Settings size={18} />
            <span>{isChinese ? '设置' : 'Settings'}</span>
          </button>
        </div>
      </aside>

      <div className="studio-navigation-frame__body">
        <div className="studio-navigation-frame__content">
          <aside
            className={`studio-project-sidebar ${collapsed ? 'is-collapsed' : ''}`}
            aria-label={isChinese ? '项目侧栏' : 'Project sidebar'}
          >
            <div className="studio-project-sidebar__header">
              {!collapsed && (
                <div className="studio-project-sidebar__heading">
                  <span className="studio-project-sidebar__eyebrow">IRIS</span>
                  <strong>{isChinese ? '工作流' : 'Workflows'}</strong>
                </div>
              )}
              <button
                type="button"
                className="studio-project-sidebar__collapse"
                onClick={() => setCollapsed(value => !value)}
                aria-label={collapsed ? (isChinese ? '展开侧栏' : 'Expand sidebar') : (isChinese ? '收起侧栏' : 'Collapse sidebar')}
                title={collapsed ? (isChinese ? '展开侧栏' : 'Expand sidebar') : (isChinese ? '收起侧栏' : 'Collapse sidebar')}
              >
                {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
              </button>
            </div>

            {!collapsed && (
              <>
                <button type="button" className="studio-project-sidebar__new" onClick={onCreateProject}>
                  <Plus size={14} />
                  <span>{isChinese ? '新建工作流' : 'New workflow'}</span>
                </button>

                <div className="studio-project-sidebar__list" role="list">
                  {projects.map(project => (
                    <button
                      key={project.id}
                      type="button"
                      role="listitem"
                      className={`studio-project-sidebar__item ${project.id === activeProjectId ? 'is-active' : ''}`}
                      onClick={() => onSelectProject(project.id)}
                      title={project.title}
                    >
                      <span className="studio-project-sidebar__dot" aria-hidden="true" />
                      <span className="studio-project-sidebar__item-title">{project.title || (isChinese ? '未命名工作流' : 'Untitled workflow')}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>

          <section className="studio-navigation-frame__stage">
            {children}
          </section>
        </div>

        <footer className="studio-navigation-frame__status" aria-label={isChinese ? '工作区状态' : 'Workspace status'}>
          <span>{canvasView === 'spatial' ? (isChinese ? '画布' : 'Canvas') : canvasView === 'table' ? 'Table' : 'Agent'}</span>
          <span className="studio-navigation-frame__status-separator" aria-hidden="true" />
          <span className="studio-navigation-frame__status-project">{activeProject?.title || (isChinese ? '未选择工作流' : 'No workflow selected')}</span>
          <span className="studio-navigation-frame__status-fill" />
          <span>{isChinese ? '本地优先' : 'Local-first'}</span>
        </footer>
      </div>
    </div>
  );
};
