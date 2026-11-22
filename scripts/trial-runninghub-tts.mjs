#!/usr/bin/env node
// 真实 Provider trial：用 RunningHub 上的 MiniMax speech 合成一句配音，走同一条 pipeline 命令边界，
// 再出一版带字幕的 draft。需要 RUNNINGHUB_API_KEY（不会打印）；会产生少量真实扣费。
// 走 HTTP(S)_PROXY 注入 Key 的环境里需加 NODE_USE_ENV_PROXY=1（Node 22 的 fetch 默认不读代理变量）。
// 用法：node scripts/trial-runninghub-tts.mjs [--model speech-2.8-turbo] [--voice Wise_Woman]
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
if (!process.env.RUNNINGHUB_API_KEY) { console.error('缺少 RUNNINGHUB_API_KEY'); process.exit(2); }

const outDir = join(ROOT, '.tmp', 'trial-runninghub');
rmSync(outDir, { recursive: true, force: true });
const home = join(outDir, 'runtime');
const authorized = join(outDir, 'authorized-folder');
mkdirSync(authorized, { recursive: true });
process.env.IRIS_PIPELINE_HOME = home;
process.env.IRIS_PIPELINE_ALLOWED_ROOTS = authorized;
const shot = join(authorized, 'shot.png');
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:d=1', '-frames:v', '1', shot]);

const { Pipeline } = await import(pathToFileURL(join(ROOT, 'tools/iris/pipeline/index.js')).href);
const pipeline = new Pipeline({ home });
const ctx = mutationId => ({ caller: 'cli', mutationId, trustedConfirmation: true });
const ok = (response, label) => {
  if (!response?.ok) { console.error(`${label} 失败`, JSON.stringify(response?.error, null, 2)); process.exit(1); }
  return response.result;
};

const line = { id: 'L1', speechText: '截图进去，宣传片出来。', displayText: '截图进去，宣传片出来' };
const started = Date.now();
const run = ok(await pipeline.execute('pipeline.run.start', { projectId: 'trial', brief: { keyLine: line.displayText, aspect: '9:16', language: 'zh-CN', durationSec: 5 }, budget: { maxTasks: 4, maxRounds: 1 }, budgetConfirmed: true }, ctx('start')), 'run.start');
const asset = ok(await pipeline.execute('asset.import', { runId: run.runId, path: shot }, ctx('import')), 'asset.import').artifacts[0];
const tts = ok(await pipeline.execute('audio.tts', {
  runId: run.runId, lines: [line],
  voice: { route: 'runninghub', model: arg('model', 'speech-2.8-turbo'), voiceId: arg('voice', 'Wise_Woman'), speed: 1, pitch: 0 },
}, ctx('tts')), 'audio.tts');
const voiced = tts.lines[0];
const total = voiced.durationMs + 800;
const v1 = ok(await pipeline.execute('composition.patch', { runId: run.runId, baseVersion: 0, ops: [
  { op: 'add', track: 'visual', clip: { id: 'shot', kind: 'image', artifactId: asset.artifactId, startMs: 0, durationMs: total } },
  { op: 'add', track: 'captions', clip: { id: 'cap', lineId: 'L1', displayText: line.displayText, startMs: 300, durationMs: voiced.durationMs } },
  { op: 'add', track: 'audio', clip: { id: 'vo', role: 'voice', artifactId: voiced.artifactId, startMs: 300, durationMs: voiced.durationMs } },
] }, ctx('patch')), 'patch');
const draft = ok(await pipeline.execute('composition.render', { runId: run.runId, version: v1.version, preset: 'draft' }, ctx('render')), 'render');
const probe = ok(await pipeline.execute('media.probe', { runId: run.runId, artifactId: draft.artifactId }), 'probe');
const trace = ok(await pipeline.execute('pipeline.run.get', { runId: run.runId }), 'run.get');
const ttsStep = trace.steps.find(step => step.tool === 'audio.tts');
const summary = {
  runId: run.runId, route: 'runninghub', model: arg('model', 'speech-2.8-turbo'),
  voiceMs: voiced.durationMs, voiceSha256: voiced.sha256, costMicros: tts.costMicros,
  ttsStep: { status: ttsStep?.status, costMicros: ttsStep?.costMicros },
  draft: { path: draft.path, durationMs: probe.durationMs, silences: probe.silences?.length ?? null },
  elapsedMs: Date.now() - started,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
