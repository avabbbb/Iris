// @vitest-environment node
// 扩展弹窗「状态岛」（1.8）：irisBridgeStatus → 胶囊 / 展开 / 成功 / 出错，以及步骤行与两段进度。
// 只映射 service worker 已经写出的状态与消息，不假设新的后端状态。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importDestination, isFresh, islandModel, statusFlow, transferProgress } from '../extension/popup/island-model.js';

const states = model => model.steps.map(step => step.state);
const segs = model => model.segments.map(segment => [segment.state, segment.percent]);

describe('popup status island model', () => {
  it('is a pill when idle, connecting or connected', () => {
    expect(islandModel(undefined)).toMatchObject({ mode: 'pill', tone: 'idle', steps: [], segments: [] });
    expect(islandModel({ state: 'connecting', message: '正在连接 Iris Desktop…' })).toMatchObject({ mode: 'pill', tone: 'sun', flow: 'connect' });
    expect(islandModel({ state: 'connected', message: 'Iris Desktop 已连接' })).toMatchObject({ mode: 'pill', tone: 'mint' });
  });

  it('expands while reading media with an indeterminate import stage', () => {
    const model = islandModel({ state: 'importing', message: '正在读取所选媒体…' });
    expect(model.mode).toBe('expanded');
    expect(model.flow).toBe('import');
    expect(states(model)).toEqual(['active', 'pending', 'pending']);
    expect(segs(model)).toEqual([['active', null], ['pending', null]]);
  });

  it('reads the transfer percent the worker already reports', () => {
    expect(transferProgress('正在传输 42%（1.2 MB / 3 MB）')).toEqual({ percent: 42, sent: '1.2 MB', total: '3 MB' });
    expect(transferProgress('正在读取所选媒体…')).toBeNull();
    const mid = islandModel({ state: 'importing', message: '正在传输 42%（1.2 MB / 3 MB）' });
    expect(states(mid)).toEqual(['done', 'active', 'pending']);
    expect(mid.steps[1].detail).toMatchObject({ percent: 42 });
    expect(segs(mid)).toEqual([['active', 42], ['pending', null]]);
    const sent = islandModel({ state: 'importing', message: '正在传输 100%（3 MB / 3 MB）' });
    expect(states(sent)).toEqual(['done', 'done', 'active']);
    expect(segs(sent)).toEqual([['done', 100], ['active', null]]);
  });

  it('only gives reverse prompts two honest stages', () => {
    const running = islandModel({ state: 'importing', message: '正在读取图片并反推提示词…' });
    expect(running.flow).toBe('reverse');
    expect(states(running)).toEqual(['active', 'pending']);
    expect(segs(running)).toEqual([['active', null], ['pending', null]]);
    const done = islandModel({ state: 'imported', message: '反推完成：在插件弹窗中查看' }, running, { live: true });
    expect(done).toMatchObject({ mode: 'success', flow: 'reverse' });
    expect(states(done)).toEqual(['done', 'done']);
  });

  it('celebrates only a completion it saw live, otherwise shows the collapsed pill', () => {
    const status = { state: 'imported', message: '已发送到网页画布', receipt: { name: 'a.png' } };
    expect(islandModel(status, null, { live: true })).toMatchObject({ mode: 'success', tone: 'mint', destination: 'web' });
    expect(islandModel(status)).toMatchObject({ mode: 'pill', tone: 'mint' });
    expect(importDestination({ message: '已发送到活动 Workflow', receipt: { destinationProjectId: 'p1' } })).toBe('workflow');
    expect(importDestination({ message: '已发送到浏览器导入箱' })).toBe('inbox');
  });

  it('marks the step that was running as failed and stays expanded on error', () => {
    const running = islandModel({ state: 'importing', message: '正在传输 10%（1 MB / 10 MB）' });
    const failed = islandModel({ state: 'error', message: '连接中断' }, running);
    expect(failed).toMatchObject({ mode: 'error', tone: 'coral', flow: 'import' });
    expect(states(failed)).toEqual(['done', 'failed', 'pending']);
    expect(failed.segments[0].state).toBe('failed');
    expect(islandModel({ state: 'error', message: 'x' })).toMatchObject({ mode: 'error', steps: [], segments: [] });
  });

  it('knows which flow a status belongs to and whether it is fresh', () => {
    expect(statusFlow({ state: 'importing', message: '正在读取图片并反推提示词…' })).toBe('reverse');
    expect(statusFlow({ state: 'error' })).toBeNull();
    expect(isFresh({ updatedAt: 1000 }, 2000)).toBe(true);
    expect(isFresh({ updatedAt: 1000 }, 9000)).toBe(false);
    expect(isFresh({}, 9000)).toBe(false);
  });

  it('has every label key in both locales', () => {
    const zh = JSON.parse(readFileSync('extension/_locales/zh_CN/messages.json', 'utf8'));
    const en = JSON.parse(readFileSync('extension/_locales/en/messages.json', 'utf8'));
    const samples = [
      islandModel({ state: 'importing', message: '正在读取所选媒体…' }),
      islandModel({ state: 'imported', message: '已发送到网页画布' }),
      islandModel({ state: 'importing', message: '正在读取图片并反推提示词…' }),
      islandModel({ state: 'imported', message: '反推完成' }),
    ];
    const keys = new Set(samples.flatMap(model => [...model.steps, ...model.segments].map(item => item.labelKey)));
    for (const key of ['island_dest_web', 'island_dest_workflow', 'island_dest_inbox', 'island_step_deliver', 'island_step_send']) keys.add(key);
    for (const key of keys) {
      expect(zh[key]?.message, 'zh_CN ' + key).toBeTruthy();
      expect(en[key]?.message, 'en ' + key).toBeTruthy();
    }
  });
});
