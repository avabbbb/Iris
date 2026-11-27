import { ArrowUp, Camera, Clapperboard, Film, ImagePlus, Music2, Package, RefreshCw, Sparkles, Sun, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { WORKFLOW_TEMPLATES, buildWorkflowTemplate, matchWorkflowTemplate } from './templates';
import type { WorkflowTemplateId, WorkflowTemplateSeed } from './templates';

const ICONS: Record<WorkflowTemplateId, typeof Sparkles> = {
  'text-to-image': Sparkles,
  'reference-edit': ImagePlus,
  'storyboard-video': Clapperboard,
  'product-scene': Package,
  'character-turnaround': UserRound,
  'multi-angle-studio': Camera,
  'commercial-three-shot': Film,
  'video-extend-retake': RefreshCw,
  'relight-portrait': Sun,
  'music-beat-edit': Music2,
};

export function WorkflowStartScreen({ language, onStart, onBlank, onSample }: {
  language: string;
  onStart: (seed: WorkflowTemplateSeed) => void;
  onBlank: () => void;
  onSample?: () => void;
}) {
  const zh = language === 'zho';
  const [prompt, setPrompt] = useState('');
  const trimmed = prompt.trim();
  const matched = trimmed ? matchWorkflowTemplate(trimmed) : null;
  const matchedTemplate = matched ? WORKFLOW_TEMPLATES.find(item => item.id === matched) : undefined;
  const submit = () => { if (matched) onStart(buildWorkflowTemplate(matched, prompt, language)); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <div className={'workflow-start'} data-testid={'workflow-start'}>
      <h1>{zh ? '想做点什么？' : 'What do you want to make?'}</h1>
      <p>{zh ? '一句话描述，Iris 会搭好节点和连线，你确认后再生成。' : 'Describe it in one sentence. Iris wires the nodes; you run them when ready.'}</p>
      <div className={'workflow-start-composer'}>
        <textarea
          value={prompt}
          rows={3}
          autoFocus
          aria-label={zh ? '一句话描述你想做的内容' : 'Describe what you want to make'}
          placeholder={zh ? '例如：清晨的海边，一个女孩追着风筝奔跑，做成 5 秒短片' : 'e.g. A girl chasing a kite at dawn, as a 5 second clip'}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type={'button'} className={'workflow-start-send'} disabled={!trimmed} onClick={submit} aria-label={zh ? '开始' : 'Start'}><ArrowUp size={18} /></button>
      </div>
      <p className={'workflow-start-hint'} aria-live={'polite'}>
        {matchedTemplate
          ? (zh ? '将按「' + matchedTemplate.title.zho + '」搭建，回车开始' : 'Will use “' + matchedTemplate.title.eng + '”. Press Enter to start')
          : (zh ? '或者直接选一个模板' : 'Or pick a template')}
      </p>
      <div className={'workflow-start-templates'}>
        {WORKFLOW_TEMPLATES.filter(template => template.featuredOnStart !== false).map(template => {
          const Icon = ICONS[template.id];
          return (
            <button key={template.id} type={'button'} className={matched === template.id ? 'workflow-start-card is-active' : 'workflow-start-card'} onClick={() => onStart(buildWorkflowTemplate(template.id, prompt, language))}>
              <Icon size={18} />
              <strong>{zh ? template.title.zho : template.title.eng}</strong>
              <span>{zh ? template.description.zho : template.description.eng}</span>
              <em>{zh ? template.samplePrompt.zho : template.samplePrompt.eng}</em>
            </button>
          );
        })}
      </div>
      <div className={'workflow-start-actions'}>
        {onSample && <button type={'button'} className={'workflow-start-blank'} data-testid={'workflow-open-sample'} onClick={onSample}>{zh ? '打开示例画布（示例，免 Key）' : 'Open sample canvas (sample, no key)'}</button>}
        <button type={'button'} className={'workflow-start-blank'} onClick={onBlank}>{zh ? '新建画布' : 'New canvas'}</button>
      </div>
    </div>
  );
}
