// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { IrisAgentService } from '../agent/iris.js';

// 不起真实内核：用一个可控的假 kernel 验证 turnId 路由、排队与取消。
function fakeKernel() {
  const listeners = new Set();
  const kernel = {
    sends: [],
    cancels: 0,
    pending: [],
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
    send(text) {
      kernel.sends.push(text);
      const { promise, resolve, reject } = Promise.withResolvers();
      kernel.pending.push({ text, resolve, reject });
      return promise;
    },
    cancel() {
      kernel.cancels += 1;
      const current = kernel.pending.shift();
      current?.reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    },
    finish(snapshot = {}) { kernel.pending.shift()?.resolve({ ok: true, ...snapshot }); },
    close: async () => undefined,
  };
  return kernel;
}

function serviceWith(kernel) {
  const service = new IrisAgentService({ databasePath: ':memory:', streamFn: () => undefined });
  service.getSession = async projectId => { service.sessions.set(String(projectId), Promise.resolve(kernel)); return kernel; };
  return service;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Iris Agent turns are routed by turnId', () => {
  it('only forwards events of the turn that is running', async () => {
    const kernel = fakeKernel();
    const service = serviceWith(kernel);
    const seenA = [];
    const seenB = [];
    await service.subscribeTurn('p', 'turn-a', event => seenA.push(event.type));
    await service.subscribeTurn('p', 'turn-b', event => seenB.push(event.type));
    const a = service.send('p', 'first', [], undefined, { turnId: 'turn-a' });
    const b = service.send('p', 'second', [], undefined, { turnId: 'turn-b' });
    await tick();
    expect(service.turnState('turn-a')).toBe('running');
    expect(service.turnState('turn-b')).toBe('queued');
    kernel.emit({ type: 'agent_start' });
    kernel.finish();
    await a;
    await tick();
    expect(service.turnState('turn-b')).toBe('running');
    kernel.emit({ type: 'agent_end' });
    kernel.finish();
    await b;
    expect(seenA).toEqual(['agent_start']);
    expect(seenB).toEqual(['agent_end']);
    expect(service.turnState('turn-a')).toBeUndefined();
  });

  it('cancels a queued turn without starting it and leaves the running turn alone', async () => {
    const kernel = fakeKernel();
    const service = serviceWith(kernel);
    const a = service.send('p', 'first', [], undefined, { turnId: 'turn-a' });
    const b = service.send('p', 'second', [], undefined, { turnId: 'turn-b' });
    const c = service.send('p', 'third', [], undefined, { turnId: 'turn-c' });
    await tick();
    expect(await service.cancel('p', 'turn-b')).toEqual({ cancelled: true, state: 'queued' });
    expect(kernel.cancels).toBe(0);
    kernel.finish();
    await a;
    await expect(b).rejects.toMatchObject({ code: 'TURN_CANCELLED' });
    await tick();
    expect(kernel.sends).toEqual(['first', 'third']);
    kernel.finish();
    await c;
  });

  it('cancels the running turn by id and ignores ids from other projects or finished turns', async () => {
    const kernel = fakeKernel();
    const service = serviceWith(kernel);
    const a = service.send('p', 'first', [], undefined, { turnId: 'turn-a' });
    await tick();
    expect(await service.cancel('other', 'turn-a')).toEqual({ cancelled: false, state: 'unknown' });
    expect(await service.cancel('p', 'turn-a')).toEqual({ cancelled: true, state: 'running' });
    await expect(a).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await service.cancel('p', 'turn-a')).toEqual({ cancelled: false, state: 'unknown' });
  });

  it('keeps the old project-wide cancel for clients that send no turnId', async () => {
    const kernel = fakeKernel();
    const service = serviceWith(kernel);
    const a = service.send('p', 'first');
    expect(a.turnId).toMatch(/[0-9a-f-]{36}/);
    await tick();
    expect(service.activeTurn('p')).toBe(a.turnId);
    expect(await service.cancel('p')).toEqual({ cancelled: true, state: 'running' });
    await expect(a).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects invalid and duplicate turn ids', async () => {
    const kernel = fakeKernel();
    const service = serviceWith(kernel);
    await expect(service.send('p', 'x', [], undefined, { turnId: 'has space' })).rejects.toMatchObject({ code: 'TURN_ID_INVALID' });
    const a = service.send('p', 'first', [], undefined, { turnId: 'dup' });
    await expect(service.send('p', 'again', [], undefined, { turnId: 'dup' })).rejects.toMatchObject({ code: 'TURN_ID_IN_USE' });
    await tick();
    kernel.finish();
    await a;
  });
});
