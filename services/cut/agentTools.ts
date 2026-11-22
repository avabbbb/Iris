// Agent 读写 Cut 的工具（只在网页内置 Agent 注册）。所有写操作都经 cutStore（与 UI 同一套 action，
// 可撤销），整批校验后一次提交，回执带 diff。Cut 页没打开也能用：store 是 headless 的，
// 需要媒体的操作（导入、快照、代理、导出）临时持有懒加载的媒体引擎，用完即释放。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

export const CUT_TOOL_NAMES = [
  'iris_cut_get_timeline', 'iris_cut_get_assets', 'iris_cut_get_inspector', 'iris_cut_get_subtitles', 'iris_cut_snapshot_frame',
  'iris_cut_edit', 'iris_cut_subtitles', 'iris_cut_import', 'iris_cut_proxy', 'iris_cut_playback', 'iris_cut_export',
] as const;

/** 给系统提示词用的一段工具说明。 */
export const CUT_TOOL_DOCS = `## Cut（视频剪辑页）工具
- iris_cut_get_timeline：读取当前画布项目的 Cut 时间线（轨道、片段 in/out/start/duration/speed/volume、播放头、选择、fps 与分辨率）。改时间线前先读。
- iris_cut_get_assets：素材箱（类型、时长、尺寸、大小、是否离线、代理状态）。sourceId 用于 add_clip。
- iris_cut_get_inspector：某个片段（clipId，缺省为当前选择）的属性：变换 / 不透明度 / 关键帧 / 文字样式 / 音频 / 速度。
- iris_cut_get_subtitles：所有字幕条（id、起止秒、文字）与统一字幕样式。
- iris_cut_snapshot_frame：渲染时间线在 t 秒的一帧给你看（含文字与字幕），用来检查效果。
- iris_cut_edit：批量编辑（operations 数组，按顺序执行，任一步失败整批不生效，成功 = 一个撤销步骤）。op：add_clip、move_clip、trim_clip、split、delete_clips、delete_side（剪映 Q/W）、duplicate_clip、reorder_clip、set_clip（volume 0–2、speed 0.25–4、text、textStyle、transform{scale,x,y,opacity}）、set_keyframe（property=opacity|scale|x|y，time 为片段内秒数）、remove_keyframes、add_track、remove_track、set_track（muted）、undo / redo 用 iris_cut_playback 以外的 action=undo|redo。
- iris_cut_subtitles：字幕增删改与批量样式（action=add|update|delete|split|merge|replace_all|style|import_srt|export_srt）。style 一次作用于全部字幕（字体、字号、颜色、描边、底色、位置 x/y）。
- iris_cut_import：把画布节点（nodeId）或 http(s) 地址导入素材箱，默认同时放到时间线末尾。
- iris_cut_proxy：为视频素材生成 / 删除预览代理（540 或 720p，后台转码，导出仍用原片）。
- iris_cut_playback：seek（秒）/ play / pause / undo / redo。play 只在 Cut 页打开时生效。
- iris_cut_export：导出 MP4（H.264/AAC）并作为视频节点放回画布；时间较长时会阻塞到完成。
时间都是秒；片段 id、轨道 id、素材 id 都取自读工具的结果，不要猜。
- 审批：读工具直接执行；编辑按审批模式；删片段（delete_clips / delete_side）、删轨道、删字幕、replace_all / import_srt 整体替换字幕每次都要用户确认，被拒绝就不要换个写法重试。委派回合只能做调用方声明权限以内的操作。`;

export interface CutAgentToolDependencies {
  projectId: string;
}

const OPERATION = Type.Object({
  op: Type.String({ description: 'add_clip | move_clip | trim_clip | split | delete_clips | delete_side | duplicate_clip | reorder_clip | set_clip | set_keyframe | remove_keyframes | add_track | remove_track | set_track' }),
}, { additionalProperties: true, description: '一步操作；其余字段见工具说明（clipId、trackId、sourceId、start、end、time、duration、in、volume、speed、text、textStyle、transform、property、value、kind、side、clipIds、ripple、index、muted）' });

const STYLE_DESCRIPTION = 'fontFamily、size（占画面高比例 0.01–0.4）、color、bold、strokeColor、strokeWidth（字号比例 0–0.5）、background、backgroundColor、x（0 左–1 右）、y（0 顶–1 底）';

const impl = () => import('./agentToolsImpl');

export function createCutAgentTools(dependencies: CutAgentToolDependencies): AgentTool[] {
  const { projectId } = dependencies;
  return [
    {
      name: 'iris_cut_get_timeline',
      label: 'cut.timeline.get',
      description: '读取 Cut 时间线：轨道（叠放层级 layer 越大越在上）、片段（in/out/start/end/duration/speed/volume/text）、播放头、选择、fps、分辨率、能否撤销。',
      parameters: Type.Object({}),
      execute: async (_id, params, signal) => (await impl()).run_get_timeline(projectId, params, signal),
    },
    {
      name: 'iris_cut_get_assets',
      label: 'cut.assets.get',
      description: '读取 Cut 素材箱：sourceId、类型、时长、宽高、文件大小、来源（画布节点 / 本地文件）、是否离线、代理状态（none / generating / ready 与高度）。',
      parameters: Type.Object({}),
      execute: async (_id, params, signal) => (await impl()).run_get_assets(projectId, params, signal),
    },
    {
      name: 'iris_cut_get_inspector',
      label: 'cut.inspector.get',
      description: '读取片段属性面板：transform（静态值与播放头处的关键帧插值）、opacity、keyframes、文字 / 字幕样式、音频（音量、静音、是否有声）、速度。clipId 缺省为当前选择。',
      parameters: Type.Object({ clipId: Type.Optional(Type.String()), clipIds: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params, signal) => (await impl()).run_get_inspector(projectId, params, signal),
    },
    {
      name: 'iris_cut_get_subtitles',
      label: 'cut.subtitles.get',
      description: '读取全部字幕条（按时间排序：id、序号、起止秒、文字、单条样式覆盖）与统一字幕样式。',
      parameters: Type.Object({}),
      execute: async (_id, params, signal) => (await impl()).run_get_subtitles(projectId, params, signal),
    },
    {
      name: 'iris_cut_snapshot_frame',
      label: 'cut.frame.snapshot',
      description: '渲染时间线在 time 秒处的一帧（JPEG，长边 ≤ maxWidth，默认 960），含视频、图片、文字与字幕，用于检查画面效果。',
      parameters: Type.Object({ time: Type.Optional(Type.Number({ description: '秒；缺省为播放头' })), maxWidth: Type.Optional(Type.Number()) }),
      execute: async (_id, params, signal) => (await impl()).run_snapshot_frame(projectId, params, signal),
    },
    {
      name: 'iris_cut_edit',
      label: 'cut.edit',
      description: '批量编辑 Cut 时间线（与界面同一套操作，可撤销）。operations 按顺序执行，任一步失败整批不生效；成功返回 diff。'
        + ' add_clip{sourceId|kind=text|subtitle, trackId?, start?, duration?, in?, text?, volume?, speed?}；move_clip{clipId, start?, trackId?}；trim_clip{clipId, start?, end?}（时间线秒）；'
        + ' split{time, clipId?|trackId?}；delete_clips{clipIds, ripple?}；delete_side{time, side=left|right, clipIds?}；duplicate_clip{clipId, start?, trackId?}；reorder_clip{clipId, index}；'
        + ` set_clip{clipId, volume?, speed?, text?, textStyle?(${STYLE_DESCRIPTION}), transform?{scale,x,y,opacity}}；set_keyframe{clipId, property=opacity|scale|x|y, time(片段内秒), value}；remove_keyframes{clipId, property?, time?}；`
        + ' add_track{kind=video|audio|text|subtitle}；remove_track{trackId}；set_track{trackId, muted}。',
      parameters: Type.Object({ operations: Type.Array(OPERATION, { minItems: 1, maxItems: 200 }) }),
      execute: async (_id, params, signal) => (await impl()).run_edit(projectId, params, signal),
    },
    {
      name: 'iris_cut_subtitles',
      label: 'cut.subtitles',
      description: '字幕：action=add{start,end,text}｜update{clipId,text?,start?,end?,style?}｜delete{clipIds}｜split{clipId,cursor}（在第 cursor 个字处拆成两条）｜merge{clipId}（并入上一条）｜'
        + `replace_all{cues:[{start,end,text}]}｜style{style(${STYLE_DESCRIPTION}), clearOverrides?}（批量作用于全部字幕）｜import_srt{content}（SRT 或 VTT 文本，替换现有字幕）｜export_srt{format=srt|vtt}。`,
      parameters: Type.Object({
        action: Type.String(),
        clipId: Type.Optional(Type.String()),
        clipIds: Type.Optional(Type.Array(Type.String())),
        start: Type.Optional(Type.Number()),
        end: Type.Optional(Type.Number()),
        text: Type.Optional(Type.String()),
        cursor: Type.Optional(Type.Number()),
        style: Type.Optional(Type.Object({}, { additionalProperties: true })),
        clearOverrides: Type.Optional(Type.Boolean()),
        cues: Type.Optional(Type.Array(Type.Object({ start: Type.Number(), end: Type.Number(), text: Type.String() }))),
        content: Type.Optional(Type.String()),
        format: Type.Optional(Type.String()),
      }),
      execute: async (_id, params, signal) => (await impl()).run_subtitles(projectId, params, signal),
    },
    {
      name: 'iris_cut_import',
      label: 'cut.import',
      description: '把画布上的图片 / 视频 / 音频节点（nodeId）或 http(s) 媒体地址导入 Cut 素材箱；addToTimeline 默认 true（接到对应轨道末尾，可给 trackId / start）。',
      parameters: Type.Object({ nodeId: Type.Optional(Type.String()), url: Type.Optional(Type.String()), addToTimeline: Type.Optional(Type.Boolean()), trackId: Type.Optional(Type.String()), start: Type.Optional(Type.Number()) }),
      execute: async (_id, params, signal) => (await impl()).run_import(projectId, params, signal),
    },
    {
      name: 'iris_cut_proxy',
      label: 'cut.proxy',
      description: '预览代理：action=create{sourceId, height=540|720}（后台低分辨率转码，存 OPFS，完成后预览自动改用代理；导出仍用原片）｜clear{sourceId}｜create_all{height}（项目里所有视频）。',
      parameters: Type.Object({ action: Type.String(), sourceId: Type.Optional(Type.String()), height: Type.Optional(Type.Number()) }),
      execute: async (_id, params, signal) => (await impl()).run_proxy(projectId, params, signal),
    },
    {
      name: 'iris_cut_playback',
      label: 'cut.playback',
      description: 'action=seek{time}｜play｜pause｜undo｜redo｜select{clipIds}。play / pause 只在 Cut 页打开时有效；seek / select / undo / redo 随时可用。',
      parameters: Type.Object({ action: Type.String(), time: Type.Optional(Type.Number()), clipIds: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params, signal) => (await impl()).run_playback(projectId, params, signal),
    },
    {
      name: 'iris_cut_export',
      label: 'cut.export',
      description: '把 Cut 时间线导出为 MP4（H.264 + AAC，WebCodecs）并作为新的视频节点放回当前画布（toCanvas 默认 true）。会阻塞到导出完成，长片可能需要几分钟。',
      parameters: Type.Object({ toCanvas: Type.Optional(Type.Boolean()), fileName: Type.Optional(Type.String()) }),
      execute: async (_id, params, signal) => (await impl()).run_export(projectId, params, signal),
    },
  ];
}
