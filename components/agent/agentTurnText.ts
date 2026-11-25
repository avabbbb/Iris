// 发给模型的用户消息会带上引用节点 ID、附带画面说明等上下文；
// 这些是写给模型的，不该原样出现在用户自己的气泡里。

const PREAMBLE = /^(\[(创作模式|首选(视频|图片)模型): [^\]]+\]\s*)+\n?/;

/** 把内核里存的用户消息还原成用户当时看到的样子：正文 + 「引用：@…」「附件：…」。 */
export function displayUserTurnText(text: string): string {
  if (!text) return text;
  const blocks = text.replace(PREAMBLE, '').split(/\n{2,}/);
  const out: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.startsWith('引用上下文：')) {
      const labels = [...trimmed.matchAll(/^- @(.+?)（/gm)].map(match => '@' + match[1]);
      if (labels.length) out.push('引用：' + labels.join('、'));
      continue;
    }
    if (trimmed.startsWith('本轮附带的本地媒体')) {
      const names = [...trimmed.matchAll(/「(.+?)」/g)].map(match => match[1]);
      if (names.length) out.push('附件：' + names.join('、'));
      continue;
    }
    if (trimmed.startsWith('已附带画面：') || trimmed.startsWith('注意：本轮附带的本地媒体')) continue;
    out.push(block);
  }
  return out.join('\n\n').trim();
}

const TOOL_LABELS: Record<string, { zho: string; en: string }> = {
  iris_workflow_inspect: { zho: '读取画布', en: 'Read canvas' },
  iris_workflow_selection_get: { zho: '读取选中节点', en: 'Read selection' },
  iris_workflow_apply: { zho: '修改画布', en: 'Edit canvas' },
  iris_note_write: { zho: '写备注', en: 'Write note' },
  iris_workflow_node_run: { zho: '运行生成', en: 'Run generation' },
  iris_workflow_node_tool: { zho: '画布工具', en: 'Canvas tool' },
  iris_image_tool: { zho: '图片工具', en: 'Image tool' },
  iris_video_tool: { zho: '视频工具', en: 'Video tool' },
  iris_audio_tool: { zho: '音频工具', en: 'Audio tool' },
  iris_node_tool_list: { zho: '工具说明', en: 'Tool manual' },
  iris_workflow_media_view: { zho: '查看画面', en: 'View media' },
  iris_workflow_search_nodes: { zho: '查找节点', en: 'Find nodes' },
  iris_workflow_focus_nodes: { zho: '定位节点', en: 'Focus nodes' },
  iris_web_search: { zho: '联网搜索', en: 'Web search' },
  iris_grep: { zho: '搜索本地文件', en: 'Search local files' },
  iris_ask: { zho: '向你提问', en: 'Question for you' },
  iris_skill_read: { zho: '读取技能', en: 'Read skill' },
  iris_memory: { zho: '项目记忆', en: 'Project memory' },
  iris_pipeline_run_start: { zho: '创建制作 run', en: 'Start run' },
  iris_pipeline_run_get: { zho: '读取制作 run', en: 'Read run' },
};

/** 工具卡标题用人话；未登记的工具（插件等）保持原名。 */
export function agentToolLabel(toolName: string | undefined, language: 'en' | 'zho'): string | undefined {
  if (!toolName) return toolName;
  return TOOL_LABELS[toolName]?.[language] || toolName;
}

/**
 * 用户消息里的本地附件缩略图：内核存的图片块里本地附件排在最前，
 * 顺序与「已附带画面：」备注一致——本地图片占 1 张，本地视频占「首/中/尾帧」的帧数（取首帧做封面）。
 */
export function userAttachmentThumbs(
  storedText: string,
  images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
): Array<{ id: string; name: string; previewUrl: string }> {
  if (!images?.length) return [];
  const notes = storedText.split(/\n{2,}/).map(block => block.trim()).find(block => block.startsWith('已附带画面：'));
  if (!notes) return [];
  const out: Array<{ id: string; name: string; previewUrl: string }> = [];
  let cursor = 0;
  for (const line of notes.split('\n').slice(1)) {
    const image = /^本地图片「(.+)」$/.exec(line.trim());
    const video = /^本地视频「(.+)」(.*)帧$/.exec(line.trim());
    const take = image ? 1 : video ? Math.max(1, video[2].split('/').filter(Boolean).length) : 0;
    if (!take) continue;
    const first = images[cursor];
    if (!first) break;
    out.push({ id: `attachment-${cursor}`, name: (image || video)![1], previewUrl: `data:${first.mimeType};base64,${first.data}` });
    cursor += take;
  }
  return out;
}

/** 已用缩略图展示附件时，正文里去掉「附件：…」那一行。 */
export function withoutAttachmentLine(displayText: string): string {
  return displayText.split(/\n{2,}/).filter(block => !block.trim().startsWith('附件：')).join('\n\n').trim();
}
