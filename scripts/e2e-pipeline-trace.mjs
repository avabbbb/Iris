// Agent 视频流水线 P0 端到端 trace（docs/design/16-agent-video-pipeline.md §10.1）。
// 用一个“脚本化的内置 Agent”按真实工具调用跑完：
//   brief → 素材导入 → 三栏脚本 → TTS → 转写 → 对齐 → v1 → 静帧 / 小样 → probe + 看帧 → 评审 revise
//   → 定向修补 v2（锁定片段字节不变）→ 渲染 → 左右对比 → 评审 pass → 成片 → 归档，
// 外加恢复、幂等重放、缺依赖、轮数上限、预算、CLI 外部调用等边界。
// 全部使用 fake TTS 与 fixture 转写，费用为 0；只依赖本机 ffmpeg / ffprobe。
//
// 用法：node scripts/e2e-pipeline-trace.mjs [--out .tmp/pipeline-trace]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(`断言失败：${message}${details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`}`);
    error.details = details;
    throw error;
  }
}

function ok(response, label) {
  assert(response?.ok === true, `${label} 应该成功`, response?.error);
  return response.result;
}

function expectError(response, code, label) {
  assert(response?.ok === false && response.error?.code === code, `${label} 应该返回 ${code}`, response);
  return response.error;
}

function makeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const run = args => {
    const result = spawnSync(process.env.IRIS_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    assert(result.status === 0, `生成 fixture 失败：${args.join(' ')}`, String(result.stderr));
  };
  // 两张“产品截图”（竖屏 UI 尺寸）+ 一段音乐床。
  const shotA = join(dir, 'screenshot-home.png');
  const shotB = join(dir, 'screenshot-result.png');
  const music = join(dir, 'music-bed.wav');
  run(['-f', 'lavfi', '-i', 'testsrc2=s=1170x2532:d=1', '-frames:v', '1', shotA]);
  run(['-f', 'lavfi', '-i', 'smptehdbars=s=1170x2532:d=1', '-frames:v', '1', shotB]);
  run(['-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*110*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.15*sin(2*PI*165*t)':s=48000:d=30", '-ac', '2', music]);
  return { shotA, shotB, music };
}

export async function runPipelineTraceScenario({ outDir = join(ROOT, '.tmp', 'pipeline-trace'), log = console.log } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  const home = join(outDir, 'runtime');
  const authorized = join(outDir, 'authorized-folder');
  const archiveDir = join(outDir, 'archive');
  process.env.IRIS_PIPELINE_HOME = home;
  process.env.IRIS_PIPELINE_ALLOWED_ROOTS = authorized;
  const fixtures = makeFixtures(authorized);
  const { Pipeline } = await import(pathToFileURL(join(ROOT, 'tools/iris/pipeline/index.js')).href);
  const { lockedClipsUnchanged } = await import(pathToFileURL(join(ROOT, 'tools/iris/pipeline/spec.js')).href);
  const pipeline = new Pipeline({ home });
  const agent = { caller: 'built-in' };
  let counter = 0;
  const mid = label => `m-${label}-${counter += 1}`;
  const call = (command, args, context = agent) => pipeline.execute(command, args, context);
  // 模型填的 confirmed / budgetConfirmed 不生效：先拿到 CONFIRMATION_REQUIRED 的 approvalId，模拟用户在 UI 批准后同参数重试。
  const approved = async (command, args, context = agent) => {
    const first = await call(command, args, context);
    if (first.error?.code !== 'CONFIRMATION_REQUIRED') return first;
    pipeline.grantApproval(first.error.details.approval.approvalId);
    return call(command, args, context);
  };
  const checks = [];
  const check = (name, condition, details) => {
    assert(condition, name, details);
    checks.push(name);
    log(`  ✓ ${name}`);
  };

  // ---------- 1. brief + 预算一次确认 ----------
  log('1. brief → run');
  const brief = {
    audience: '做独立 App 的开发者', channel: '小红书 / 抖音竖屏', keyLine: '截图进去，宣传片出来',
    aspect: '9:16', language: 'zh-CN', durationSec: 18,
  };
  const budget = { maxTasks: 12, maxRounds: 3 };
  expectError(await call('pipeline.run.start', { projectId: 'proj-demo', brief, budget }, { ...agent, mutationId: 'start-unconfirmed' }), 'CONFIRMATION_REQUIRED', '未确认预算');
  const start = ok(await approved('pipeline.run.start', { projectId: 'proj-demo', brief, budget, budgetConfirmed: true }, { ...agent, mutationId: 'start-1' }), 'run.start');
  const runId = start.runId;
  const runGet = ok(await call('pipeline.run.get', { runId }), 'run.get');
  check('run.get 返回 runId 与 brief artifact', runGet.run.id === runId && runGet.run.briefArtifactId === start.briefArtifactId);
  const replayStart = await call('pipeline.run.start', { projectId: 'proj-demo', brief, budget, budgetConfirmed: true }, { ...agent, mutationId: 'start-1' });
  check('同 mutationId 重放 run.start 返回同一个 run', replayStart.result.runId === runId && replayStart.step.replayed === true);

  // ---------- 2. 素材 → 脚本 → 配音 → 转写 → 对齐 ----------
  log('2. 素材 / 脚本 / 配音 / 转写 / 对齐');
  expectError(await call('asset.import', { runId, path: join(ROOT, 'package.json') }, { ...agent, mutationId: mid('import-outside') }), 'PATH_NOT_AUTHORIZED', '授权文件夹外导入');
  const imported = ok(await call('asset.import', { runId, paths: [fixtures.shotA, fixtures.shotB], tags: ['product-ui'] }, { ...agent, mutationId: 'import-shots' }), 'asset.import');
  const [home_, result_] = imported.artifacts;
  check('两张截图都是带 sha256 的 durable artifact', imported.artifacts.length === 2 && imported.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && existsSync(item.path)));
  const music = ok(await call('asset.import', { runId, path: fixtures.music, kind: 'music', tags: ['music'] }, { ...agent, mutationId: 'import-music' }), 'import music').artifacts[0];

  // 三栏脚本：口播稿（送 TTS，品牌名用谐音）/ 屏幕短字（字幕，原拼写）/ 画面操作。
  const script = [
    { id: 'L1', speechText: '做完一个 App，最难的是让别人三秒看懂它', displayText: '做完 App，最难的是让人 3 秒看懂', visual: '首页截图慢推', actions: ['看懂'] },
    { id: 'L2', speechText: '把截图丢给弗洛瓦特，提问一句，它就开始剪', displayText: '截图丢给 Iris，提问一句就开剪', visual: '首页截图，提问时刻切近景', actions: ['提问'] },
    { id: 'L3', speechText: '点开结果，配音字幕和节奏都已经对好', displayText: '点开结果：配音、字幕、节奏都对好', visual: '结果卡片弹出', actions: ['点开'] },
    { id: 'L4', speechText: '截图进去，宣传片出来', displayText: '截图进去，宣传片出来', visual: '结果页 + 标语' },
  ];
  check('显示稿与口播稿分离（品牌名谐音只进 TTS）', script[1].speechText.includes('弗洛瓦特') && script[1].displayText.includes('Iris'));
  const tts = ok(await call('audio.tts', {
    runId, lines: script.map(({ id, speechText, displayText }) => ({ id, speechText, displayText })),
    voice: { route: 'fake', voiceId: 'female-calm', speed: 1, pitch: 0 }, variant: 'A',
  }, { ...agent, mutationId: 'tts-A' }), 'audio.tts');
  check('每行干声都有实测时长', tts.lines.every(line => line.durationMs > 500), tts.lines);
  const evidenceIds = [];
  for (const line of tts.lines) {
    const transcript = ok(await call('audio.transcribe', { runId, artifactId: line.artifactId, engine: 'fixture', language: 'zh' }, { ...agent, mutationId: `asr-${line.lineId}` }), `transcribe ${line.lineId}`);
    evidenceIds.push(transcript.evidenceArtifactId);
  }
  const alignment = ok(await call('timeline.align', {
    runId, lines: script.map(({ id, speechText, actions }) => ({ id, speechText, actions })), evidenceArtifactIds: evidenceIds, startMs: 400, gapMs: 300,
  }), 'timeline.align');
  check('对齐覆盖全部口播 token', alignment.matchedRatio === 1, alignment);
  const actionAt = word => alignment.lines.flatMap(line => line.actions).find(action => action.word === word)?.atMs;
  check('动作词“提问 / 点开”有毫秒时间戳', Number.isFinite(actionAt('提问')) && Number.isFinite(actionAt('点开')));

  // ---------- 3. v1：按音频时间戳排镜头 ----------
  log('3. composition.patch → v1');
  const L = Object.fromEntries(alignment.lines.map(line => [line.id, line]));
  const total = alignment.totalMs + 900;
  const resultAt = actionAt('点开');
  const ops = [
    { op: 'add', track: 'visual', clip: { id: 'shot-home', kind: 'image', artifactId: home_.artifactId, startMs: 0, durationMs: L.L3.voiceStartMs, motion: { type: 'push', amount: 0.06 } } },
    { op: 'add', track: 'visual', clip: { id: 'shot-result-page', kind: 'image', artifactId: result_.artifactId, startMs: L.L3.voiceStartMs, durationMs: total - L.L3.voiceStartMs } },
    // 故意的问题：“点开”后结果卡片只停 0.5 秒。
    { op: 'add', track: 'visual', clip: { id: 'shot-result-card', kind: 'color', color: '0xF5D547', startMs: resultAt, durationMs: 500 } },
    { op: 'add', track: 'text', clip: { id: 'title-keyline', text: brief.keyLine, startMs: L.L4.voiceStartMs, durationMs: total - L.L4.voiceStartMs, position: 'center', size: 72 } },
    ...script.map(line => ({ op: 'add', track: 'captions', clip: { id: `cap-${line.id}`, lineId: line.id, displayText: line.displayText, startMs: L[line.id].startMs, durationMs: L[line.id].endMs - L[line.id].startMs } })),
    ...tts.lines.map(line => ({ op: 'add', track: 'audio', clip: { id: `vo-${line.lineId}`, role: 'voice', artifactId: line.artifactId, startMs: L[line.lineId].voiceStartMs, durationMs: line.durationMs } })),
    { op: 'add', track: 'audio', clip: { id: 'music-bed', role: 'music', artifactId: music.artifactId, startMs: 0, durationMs: total, gainDb: -8, duck: true } },
  ];
  const v1 = ok(await call('composition.patch', {
    runId, baseVersion: 0, ops,
    // 用户已确认的部分：声线、字幕、开场镜头锁定。
    locks: ['shot-home', ...script.map(line => `cap-${line.id}`), ...tts.lines.map(line => `vo-${line.lineId}`)],
  }, { ...agent, mutationId: 'patch-v1' }), 'patch v1');
  check('生成 v1', v1.version === 1 && v1.durationMs === total);
  expectError(await call('composition.patch', { runId, baseVersion: 0, ops: [{ op: 'remove', id: 'music-bed' }] }, { ...agent, mutationId: mid('stale') }), 'VERSION_CONFLICT', '基于旧版本修补');

  // ---------- 4. 静态关键帧 + 小样 + 自检 + 看真实帧 ----------
  log('4. 渲染 v1（still + draft）→ probe → frames');
  const still = ok(await call('composition.render', { runId, version: 1, preset: 'still', atSec: 1.5 }, { ...agent, mutationId: 'still-v1' }), 'still v1');
  check('静态关键帧是 durable artifact', existsSync(still.path) && /^[a-f0-9]{64}$/.test(still.sha256));
  const draft1 = ok(await call('composition.render', { runId, version: 1, preset: 'draft' }, { ...agent, mutationId: 'draft-v1' }), 'draft v1');
  const probe1 = ok(await call('media.probe', { runId, artifactId: draft1.artifactId }), 'probe v1');
  check('小样时长与 spec 一致、无黑帧问题', Math.abs(probe1.durationMs - total) <= 200 && !probe1.issues.some(issue => issue.code === 'BLACK_FRAMES'), probe1);
  check('小样有音轨且响度可测', probe1.audio && Number.isFinite(probe1.loudnessLufs), probe1);
  expectError(await call('review.submit', {
    runId, version: 1, verdict: 'revise',
    findings: [{ atSec: resultAt / 1000, clipId: 'shot-result-card', layer: 'visual', severity: 'major', issue: '结果停留太短', fix: '延长' }],
  }, { ...agent, mutationId: mid('review-blind') }), 'FRAMES_REQUIRED', '没看帧就评审');
  const before = Math.round(resultAt / 100) / 10;
  const frames1 = ok(await call('media.frames', { runId, version: 1, times: [before - 0.3, before + 0.2, before + 0.8] }), 'frames v1');
  check('按“接触前 / 中 / 后”抽到 3 帧真实画面', frames1.frames.length === 3 && frames1.frames.every(frame => existsSync(frame.path)));

  // ---------- 5. 评审 → 定向修补 ----------
  log('5. review(v1, revise) → 定向修补 v2');
  expectError(await call('review.submit', { runId, version: 1, verdict: 'revise', findings: [{ clipId: 'shot-result-card', layer: 'visual', severity: 'major', issue: '整体不好', fix: '重做' }] }, { ...agent, mutationId: mid('vague') }), 'INVALID_FINDINGS', '空泛评审');
  const issueText = `第 ${before} 秒结果卡片只停留 0.5 秒，不足 0.8 秒，看不清`;
  const round1 = ok(await call('review.submit', {
    runId, version: 1, verdict: 'revise',
    findings: [{ atSec: before, clipId: 'shot-result-card', layer: 'visual', severity: 'major', issue: issueText, fix: '结果卡片延长到 1.2 秒并加轻推镜，其他片段不动' }],
  }, { ...agent, mutationId: 'review-1' }), 'review v1');
  check('评审范围只指向结果卡片', round1.scopeClipIds.includes('shot-result-card'), round1);
  expectError(await call('composition.patch', { runId, baseVersion: 1, reviewRoundId: round1.roundId, ops: [{ op: 'update', id: 'title-keyline', set: { size: 80 } }] }, { ...agent, mutationId: mid('scope') }), 'PATCH_OUT_OF_SCOPE', '修补超出评审范围');
  expectError(await call('composition.patch', { runId, baseVersion: 1, ops: [{ op: 'update', id: 'cap-L3', set: { displayText: '改字幕' } }] }, { ...agent, mutationId: mid('locked') }), 'CLIP_LOCKED', '改动锁定字幕');
  const v2 = ok(await call('composition.patch', {
    runId, baseVersion: 1, reviewRoundId: round1.roundId,
    ops: [{ op: 'update', id: 'shot-result-card', set: { durationMs: 1200, motion: { type: 'push', amount: 0.05 } } }],
    note: '按第 1 轮评审延长结果卡片',
  }, { ...agent, mutationId: 'patch-v2' }), 'patch v2');
  const spec1 = pipeline.store.getVersion(runId, 1).spec;
  const spec2 = pipeline.store.getVersion(runId, 2).spec;
  check('v2 只改了 findings 指向的片段', v2.diff.changed.length === 1 && v2.diff.changed[0].id === 'shot-result-card' && !v2.diff.added.length && !v2.diff.removed.length, v2.diff);
  check('锁定片段在 v1 / v2 之间逐字节一致', lockedClipsUnchanged(spec1, spec2).length === 0);
  check('v1 的渲染被标记为 rejected（废片保留）', pipeline.store.getArtifact(draft1.artifactId).rejected === true && existsSync(draft1.path));

  // ---------- 6. 渲染 v2 → 对比 → pass → 成片 ----------
  log('6. 渲染 v2 → 与 v1 对比 → review(pass) → final');
  // 恢复：模拟“渲染进行中刷新页面”——Step 已写为 running，进程中断；同一 mutationId 重放应在原 Step 上继续。
  const renderArgs = { runId, version: 2, preset: 'draft' };
  const { canonicalJson, sha256Text } = await import(pathToFileURL(join(ROOT, 'tools/iris/pipeline/store.js')).href);
  const crashed = pipeline.store.startStep({ runId, tool: 'composition.render', caller: 'built-in', mutationId: 'draft-v2', argsDigest: sha256Text(canonicalJson({ command: 'composition.render', args: renderArgs })), args: renderArgs, paid: false });
  const resumedTrace = ok(await call('pipeline.run.get', { runId }), 'run.get after crash');
  check('刷新后 trace 指出从未完成的 Step 继续', resumedTrace.resumeFrom?.stepId === crashed.id, resumedTrace.resumeFrom);
  const draft2Response = await call('composition.render', renderArgs, { ...agent, mutationId: 'draft-v2' });
  const draft2 = ok(draft2Response, 'draft v2 resume');
  check('恢复在原 Step 上完成（不新增 Step）', draft2Response.step.stepId === crashed.id && draft2Response.step.attempts === 2, draft2Response.step);
  const replay = await call('composition.render', renderArgs, { ...agent, mutationId: 'draft-v2' });
  check('同一 mutationId 重放返回同一 Step 与同一产物', replay.step.stepId === crashed.id && replay.step.replayed === true && replay.result.artifactId === draft2.artifactId);
  expectError(await call('composition.render', { ...renderArgs, preset: 'final' }, { ...agent, mutationId: 'draft-v2' }), 'IDEMPOTENCY_CONFLICT', '同 ID 不同载荷');
  ok(await call('media.probe', { runId, artifactId: draft2.artifactId }), 'probe v2');
  const frames2 = ok(await call('media.frames', { runId, version: 2, times: [before + 0.2, before + 0.8], compareWith: { version: 1 } }), 'frames v2 vs v1');
  check('v2 与 v1 左右对比帧', frames2.frames.every(frame => frame.compareVersion === 1 && existsSync(frame.comparePath)));
  expectError(await call('composition.render', { runId, version: 2, preset: 'final' }, { ...agent, mutationId: mid('final-early') }), 'REVIEW_REQUIRED', '未评审通过就出成片');
  const round2 = ok(await call('review.submit', {
    runId, version: 2, verdict: 'pass',
    findings: [{ range: [before, before + 1.2], clipId: 'shot-result-card', layer: 'visual', severity: 'minor', issue: '结果卡片停留 1.2 秒，清楚可读' }],
  }, { ...agent, mutationId: 'review-2' }), 'review v2');
  check('第 2 轮评审通过', round2.verdict === 'pass' && round2.runStatus === 'passed');
  const final2 = ok(await call('composition.render', { runId, version: 2, preset: 'final' }, { ...agent, mutationId: 'final-v2' }), 'final v2');

  // ---------- 7. 外部调用方（CLI）写同一条 trace ----------
  log('7. CLI 作为外部调用方读 trace、提交用户评审');
  const cli = (args) => {
    const result = spawnSync(process.execPath, [join(ROOT, 'tools/iris/cli.js'), ...args], { env: { ...process.env }, encoding: 'utf8' });
    return JSON.parse(result.stdout);
  };
  const cliGet = cli(['pipeline.run.get', '--runId', runId]);
  check('CLI 读取同一个 run', cliGet.ok && cliGet.data.run.id === runId, cliGet.error);
  const cliReview = cli(['review.submit', '--mutation-id', 'user-review-1', '--args-json', JSON.stringify({
    runId, version: 2, verdict: 'pass', reviewer: 'user',
    findings: [{ atSec: 0.5, clipId: 'shot-home', layer: 'visual', severity: 'minor', issue: '开场推镜节奏合适，保留' }],
  })]);
  check('CLI 提交用户评审成功', cliReview.ok, cliReview.error);

  // ---------- 8. 归档 ----------
  log('8. run.archive');
  expectError(await call('run.archive', { runId, outputDir: archiveDir }, { ...agent, mutationId: mid('archive-unconfirmed') }), 'CONFIRMATION_REQUIRED', '未确认写用户目录');
  const archive = ok(await approved('run.archive', { runId, outputDir: archiveDir, confirmed: true }, { ...agent, mutationId: 'archive-1' }), 'archive');
  const manifest = JSON.parse(readFileSync(join(archive.directory, 'manifest.json'), 'utf8'));
  const kinds = new Set(manifest.files.map(file => file.path.split('/')[0]));
  check('归档包含成片 / 各版 spec / 独立音轨 / 废片 / 评审', ['final', 'spec', 'stems', 'rejected', 'reviews.md'].every(kind => kinds.has(kind)), [...kinds]);

  // ---------- 9. trace 审计 ----------
  log('9. trace 审计');
  const trace = ok(await call('pipeline.run.get', { runId }), 'final trace');
  const tools = trace.steps.filter(step => step.status === 'succeeded').map(step => step.tool);
  const expectedOrder = ['pipeline.run.start', 'asset.import', 'audio.tts', 'audio.transcribe', 'timeline.align', 'composition.patch', 'composition.render', 'media.probe', 'media.frames', 'review.submit', 'composition.patch', 'composition.render', 'media.frames', 'review.submit', 'composition.render', 'review.submit', 'run.archive'];
  let cursor = 0;
  for (const tool of tools) if (tool === expectedOrder[cursor]) cursor += 1;
  check('Step 顺序覆盖完整 trace（含一轮 批评 → 修补）', cursor === expectedOrder.length, tools);
  check('每个 Step 都有终态', trace.steps.every(step => ['succeeded', 'failed', 'canceled', 'unknown_submit'].includes(step.status)));
  check('v1、v2 两版渲染都是 durable artifact', [draft1, draft2, final2].every(item => existsSync(item.path) && /^[a-f0-9]{64}$/.test(item.sha256)));
  check('trace 中记录了 CLI 调用方', trace.steps.some(step => step.caller === 'cli' && step.tool === 'review.submit') && trace.rounds.some(round => round.caller === 'cli' && round.reviewer === 'user'));
  check('fake 路径费用为 0，账本任务数与 TTS 行数一致', trace.spend.confirmedMicros === 0 && trace.spend.confirmedTasks === script.length, trace.spend);
  check('评审轮 1 由 v2 修补', trace.rounds[0].fixedByVersion === 2);

  // ---------- 10. 边界 ----------
  log('10. 边界：缺依赖 / 轮数上限 / 预算');
  const edge = ok(await approved('pipeline.run.start', { projectId: 'proj-demo', brief: { ...brief, keyLine: '边界测试' }, budget: { maxTasks: 1, maxRounds: 1 }, budgetConfirmed: true }, { ...agent, mutationId: 'start-edge' }), 'edge run');
  const edgeShot = ok(await call('asset.import', { runId: edge.runId, path: fixtures.shotA }, { ...agent, mutationId: 'edge-import' }), 'edge import').artifacts[0];
  ok(await call('composition.patch', { runId: edge.runId, baseVersion: 0, ops: [{ op: 'add', track: 'visual', clip: { id: 'only', kind: 'image', artifactId: edgeShot.artifactId, startMs: 0, durationMs: 1500 } }] }, { ...agent, mutationId: 'edge-v1' }), 'edge v1');
  const savedFfmpeg = process.env.IRIS_FFMPEG;
  process.env.IRIS_FFMPEG = join(outDir, 'missing', 'ffmpeg');
  const missing = expectError(await call('composition.render', { runId: edge.runId, version: 1, preset: 'draft' }, { ...agent, mutationId: 'edge-draft' }), 'CAPABILITY_UNAVAILABLE', '缺 ffmpeg');
  const blocked = ok(await call('pipeline.run.get', { runId: edge.runId }), 'edge trace');
  check('缺依赖时 run 进入 blocked 并带诊断', blocked.run.status === 'blocked' && blocked.blocker?.diagnose && missing.details?.capability === 'ffmpeg', blocked.blocker);
  expectError(await call('composition.patch', { runId: edge.runId, baseVersion: 1, ops: [{ op: 'remove', id: 'only' }] }, { ...agent, mutationId: mid('blocked') }), 'RUN_BLOCKED', 'blocked 时拒绝写入');
  if (savedFfmpeg === undefined) delete process.env.IRIS_FFMPEG; else process.env.IRIS_FFMPEG = savedFfmpeg;
  ok(await call('composition.render', { runId: edge.runId, version: 1, preset: 'draft' }, { ...agent, mutationId: 'edge-draft' }), 'edge draft retry');
  check('依赖恢复后同一 Step 重试成功并解除 blocked', ok(await call('pipeline.run.get', { runId: edge.runId }), 'edge trace 2').run.status === 'active');
  ok(await call('media.frames', { runId: edge.runId, version: 1, times: [0.5] }), 'edge frames');
  const capped = ok(await call('review.submit', { runId: edge.runId, version: 1, verdict: 'revise', findings: [{ atSec: 0.5, clipId: 'only', layer: 'visual', severity: 'minor', issue: '开场 0.5 秒画面偏暗', fix: '换亮一点的截图' }] }, { ...agent, mutationId: 'edge-review' }), 'edge review');
  check('达到最大评审轮数自动停下并说明', capped.runStatus === 'blocked' && capped.blocker?.code === 'MAX_ROUNDS', capped);
  const edgeUnblock = ok(await call('review.submit', { runId: edge.runId, version: 1, verdict: 'revise', reviewer: 'user', findings: [{ atSec: 0.5, clipId: 'only', layer: 'visual', severity: 'minor', issue: '再给一轮，换成结果页截图', fix: '替换 artifact' }] }, { caller: 'user', mutationId: 'edge-user' }), 'edge user review');
  check('用户评审可以解除卡点', edgeUnblock.runStatus === 'active');
  ok(await call('audio.tts', { runId: edge.runId, lines: [{ id: 'X1', speechText: '测试', displayText: '测试' }], voice: { route: 'fake', voiceId: 'v' } }, { ...agent, mutationId: 'edge-tts-1' }), 'edge tts');
  expectError(await call('audio.tts', { runId: edge.runId, lines: [{ id: 'X2', speechText: '超出预算', displayText: '超出预算' }], voice: { route: 'fake', voiceId: 'v' } }, { ...agent, mutationId: 'edge-tts-2' }), 'BUDGET_EXCEEDED', '超出任务预算');
  check('超出 run 预算被拦下', true);

  const summary = {
    runId,
    versions: trace.versions.map(version => ({ version: version.version, durationMs: version.durationMs, diff: version.diff, renders: version.renders.map(render => `${render.preset}${render.rejected ? ' (rejected)' : ''}`) })),
    rounds: trace.rounds.map(round => ({ round: round.round, version: round.version, reviewer: round.reviewer, caller: round.caller, verdict: round.verdict, fixedByVersion: round.fixedByVersion, findings: round.findings.map(finding => finding.issue) })),
    steps: trace.steps.map(step => `${String(step.seq).padStart(2, '0')} ${step.tool.padEnd(19)} ${step.caller.padEnd(9)} ${step.status}${step.attempts > 1 ? ` (attempts ${step.attempts})` : ''}${step.error ? ` · ${step.error.code}` : ''}`),
    archive: archive.directory,
    finalRender: final2.path,
    frames: { v1: frames1.frames.map(frame => frame.path), compare: frames2.frames.map(frame => frame.comparePath) },
    checks,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'trace.json'), JSON.stringify(trace, null, 2));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  // Rust Runtime 一致性检查（scripts/e2e-pipeline-parity.mjs）读取这两份文件。
  const parity = { dbPath: join(home, 'flovart-state.db'), tracePath: join(outDir, 'trace.parity.json') };
  writeFileSync(parity.tracePath, JSON.stringify(pipeline.trace(runId), null, 2));
  pipeline.close();
  Object.assign(summary, parity);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : undefined;
  runPipelineTraceScenario({ outDir }).then(summary => {
    console.log('\nTrace steps:');
    for (const line of summary.steps) console.log(`  ${line}`);
    console.log(`\n${summary.checks.length} checks passed. Final: ${summary.finalRender}`);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
