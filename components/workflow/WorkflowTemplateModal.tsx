import { Button, ConfigProvider, Input, Modal, theme as antdTheme } from 'antd';
import { BookmarkPlus, Download, LayoutTemplate, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { WORKFLOW_TEMPLATES, buildWorkflowTemplate, type WorkflowTemplateId } from './templates';
import {
  createCustomTemplateFromSubgraph,
  deleteCustomWorkflowTemplate,
  instantiateTemplateAt,
  listCustomWorkflowTemplates,
  parseImportedWorkflowTemplate,
  relocateSeedToAnchor,
  saveCustomWorkflowTemplate,
  type CustomWorkflowTemplate,
} from './customTemplates';
import type { WorkflowConnection, WorkflowNode, WorkflowPoint } from './types';

export function WorkflowTemplateModal({
  open,
  language = 'zho',
  initialMode = 'browse',
  selectedNodes,
  allNodes,
  allConnections,
  anchor,
  onInsert,
  onClose,
}: {
  open: boolean;
  language?: 'en' | 'zho';
  initialMode?: 'browse' | 'save';
  selectedNodes: WorkflowNode[];
  allNodes: WorkflowNode[];
  allConnections: WorkflowConnection[];
  anchor: WorkflowPoint;
  onInsert: (payload: { nodes: WorkflowNode[]; connections: WorkflowConnection[]; label: string }) => void;
  onClose: () => void;
}) {
  const dark = useResolvedTheme() === 'dark';
  const en = language === 'en';
  const L = (zh: string, enText: string) => (en ? enText : zh);
  const [tab, setTab] = useState<'builtin' | 'custom' | 'save'>(initialMode === 'save' ? 'save' : 'builtin');
  const [customTemplates, setCustomTemplates] = useState<CustomWorkflowTemplate[]>([]);
  const [search, setSearch] = useState('');
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [saveScope, setSaveScope] = useState<'selection' | 'all'>(selectedNodes.length > 0 ? 'selection' : 'all');
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTab(initialMode === 'save' ? 'save' : 'builtin');
    setSaveScope(selectedNodes.length > 0 ? 'selection' : 'all');
    setError(null);
    void listCustomWorkflowTemplates().then(setCustomTemplates);
  }, [open, initialMode, selectedNodes.length]);

  const query = search.trim().toLowerCase();
  const filteredBuiltins = WORKFLOW_TEMPLATES.filter(tpl => {
    if (!query) return true;
    return tpl.title.zho.toLowerCase().includes(query)
      || tpl.title.eng.toLowerCase().includes(query)
      || tpl.description.zho.toLowerCase().includes(query)
      || tpl.description.eng.toLowerCase().includes(query);
  });
  const filteredCustom = customTemplates.filter(tpl => {
    if (!query) return true;
    return tpl.name.toLowerCase().includes(query) || tpl.description.toLowerCase().includes(query);
  });

  const handleInsertBuiltin = (id: WorkflowTemplateId, title: string) => {
    const seed = buildWorkflowTemplate(id, '', language);
    const placed = relocateSeedToAnchor(seed, anchor);
    onInsert({ ...placed, label: title });
    onClose();
  };

  const handleInsertCustom = (tpl: CustomWorkflowTemplate) => {
    const placed = instantiateTemplateAt(tpl, anchor);
    onInsert({ ...placed, label: tpl.name });
    onClose();
  };

  const handleSaveCurrent = async () => {
    setError(null);
    const sourceNodes = saveScope === 'selection' && selectedNodes.length > 0 ? selectedNodes : allNodes;
    try {
      const tpl = createCustomTemplateFromSubgraph({
        name: saveName || L('我的工作流模板', 'My Workflow Blueprint'),
        description: saveDesc,
        nodes: sourceNodes,
        connections: allConnections,
      });
      const updated = await saveCustomWorkflowTemplate(tpl);
      setCustomTemplates(updated);
      setSaveName('');
      setSaveDesc('');
      setTab('custom');
    } catch (err) {
      setError(err instanceof Error ? err.message : L('保存模板失败', 'Failed to save template'));
    }
  };

  const handleExportTemplate = (tpl: CustomWorkflowTemplate) => {
    const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${tpl.name.replace(/[\\/:*?"<>|]+/g, '_')}.iris-template.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleImportFile = async (file: File) => {
    setError(null);
    try {
      const raw = JSON.parse(await file.text());
      const tpl = parseImportedWorkflowTemplate(raw);
      const updated = await saveCustomWorkflowTemplate(tpl);
      setCustomTemplates(updated);
      setTab('custom');
    } catch (err) {
      setError(err instanceof Error ? err.message : L('导入模板失败', 'Failed to import template'));
    }
  };

  const handleDeleteCustom = async (id: string) => {
    const updated = await deleteCustomWorkflowTemplate(id);
    setCustomTemplates(updated);
  };

  return (
    <ConfigProvider theme={{
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: { colorPrimary: '#19c8b9', fontFamily: 'inherit' },
    }}>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        centered
        width={760}
        destroyOnHidden
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><LayoutTemplate size={16} />{L('Tapflow 工作流模板库', 'Workflow Blueprint Library')}</span>}
      >
        <div className="wf-template-modal" data-workflow-overlay data-testid="workflow-template-modal">
          <div className="wf-template-modal__head">
            <div className="wf-template-modal__tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'builtin'} className={tab === 'builtin' ? 'is-active' : undefined} onClick={() => setTab('builtin')}>
                {L(`内置蓝图 (${WORKFLOW_TEMPLATES.length})`, `Blueprints (${WORKFLOW_TEMPLATES.length})`)}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'is-active' : undefined} onClick={() => setTab('custom')}>
                {L(`我的模板 (${customTemplates.length})`, `My Templates (${customTemplates.length})`)}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'save'} className={tab === 'save' ? 'is-active' : undefined} onClick={() => setTab('save')}>
                <BookmarkPlus size={12} style={{ display: 'inline', marginRight: 4 }} />
                {L('保存当前为模板', 'Save as Template')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {tab !== 'save' && (
                <Input
                  size="small"
                  style={{ width: 180 }}
                  placeholder={L('搜索模板…', 'Search templates…')}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              )}
              <Button size="small" icon={<Upload size={13} />} onClick={() => importInputRef.current?.click()}>
                {L('导入 JSON', 'Import JSON')}
              </Button>
              <input
                ref={importInputRef}
                hidden
                type="file"
                accept=".json,.iris-template.json,application/json"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                  e.currentTarget.value = '';
                }}
              />
            </div>
          </div>

          {error && <div role="alert" className="workflow-image-tool__error">{error}</div>}

          {tab === 'builtin' && (
            <div className="wf-template-grid">
              {filteredBuiltins.map(tpl => (
                <div key={tpl.id} className="wf-template-card" data-testid={`wf-template-card-${tpl.id}`}>
                  <div className="wf-template-card__head">
                    <strong style={{ fontSize: 12 }}>{en ? tpl.title.eng : tpl.title.zho}</strong>
                    {tpl.category && <span className="wf-template-card__badge">{tpl.category}</span>}
                  </div>
                  <p className="wf-template-card__desc">{en ? tpl.description.eng : tpl.description.zho}</p>
                  <div className="wf-template-card__actions">
                    <Button type="primary" size="small" icon={<Plus size={12} />} onClick={() => handleInsertBuiltin(tpl.id, en ? tpl.title.eng : tpl.title.zho)}>
                      {L('插入到画布', 'Insert to Canvas')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'custom' && (
            <div className="wf-template-grid">
              {filteredCustom.length ? filteredCustom.map(tpl => (
                <div key={tpl.id} className="wf-template-card" data-testid={`wf-custom-template-${tpl.id}`}>
                  <div className="wf-template-card__head">
                    <strong style={{ fontSize: 12 }}>{tpl.name}</strong>
                    <span className="wf-template-card__badge">{tpl.nodes.length} {L('节点', 'nodes')}</span>
                  </div>
                  <p className="wf-template-card__desc">{tpl.description}</p>
                  <div className="wf-template-card__actions">
                    <Button type="primary" size="small" icon={<Plus size={12} />} onClick={() => handleInsertCustom(tpl)}>
                      {L('复用插入', 'Remix')}
                    </Button>
                    <Button size="small" icon={<Download size={12} />} onClick={() => handleExportTemplate(tpl)} title={L('导出分享 JSON', 'Export JSON')} />
                    <Button size="small" danger icon={<Trash2 size={12} />} onClick={() => void handleDeleteCustom(tpl.id)} title={L('删除', 'Delete')} />
                  </div>
                </div>
              )) : (
                <p className="workflow-image-tool__hint" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 24 }}>
                  {L('还没有自定义模板。可在画布选中一组节点后点「保存当前为模板」，或导入他人分享的 .iris-template.json。', 'No custom templates yet. Save any canvas subgraph or import a .iris-template.json file.')}
                </p>
              )}
            </div>
          )}

          {tab === 'save' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  size="small"
                  type={saveScope === 'selection' ? 'primary' : 'default'}
                  disabled={selectedNodes.length === 0}
                  onClick={() => setSaveScope('selection')}
                >
                  {L(`仅所选节点 (${selectedNodes.length})`, `Selected nodes (${selectedNodes.length})`)}
                </Button>
                <Button
                  size="small"
                  type={saveScope === 'all' ? 'primary' : 'default'}
                  disabled={allNodes.length === 0}
                  onClick={() => setSaveScope('all')}
                >
                  {L(`整个画布 (${allNodes.length})`, `Entire canvas (${allNodes.length})`)}
                </Button>
              </div>
              <Input
                placeholder={L('模板名称（例如：三机位角色一致性短片）', 'Template name (e.g. 3-Shot Character Commercial)')}
                value={saveName}
                maxLength={60}
                onChange={e => setSaveName(e.target.value)}
              />
              <Input.TextArea
                rows={2}
                placeholder={L('简短说明这个模板的适用场景与节点顺序（可选）', 'Short description of when to use this blueprint (optional)')}
                value={saveDesc}
                maxLength={180}
                onChange={e => setSaveDesc(e.target.value)}
              />
              <p className="workflow-image-tool__hint">
                {L('模板保存在本机浏览器 IndexedDB 中，自动剥离临时运行状态与媒体原件，只保留可复用的节点拓扑、提示词、电影机位与连线关系。', 'Saved locally in IndexedDB. Transient runtime state is stripped; node topology, prompts, camera rigs and wires are preserved.')}
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="primary" disabled={allNodes.length === 0} onClick={() => void handleSaveCurrent()}>
                  {L('保存到我的模板库', 'Save to My Templates')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </ConfigProvider>
  );
}
