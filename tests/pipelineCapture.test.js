import { describe, expect, it } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCaptureUrl, CAPTURE_BROWSER_ARGS, captureRequestAllowed, captureSandboxEnabled, guardCaptureContext, normalizeCaptureArgs } from '../tools/iris/pipeline/capture.js';

const root = mkdtempSync(join(tmpdir(), 'capture-'));
writeFileSync(join(root, 'page.html'), '<h1>x</h1>');

describe('capture.ui argument boundary', () => {
  it('only opens loopback pages or files inside an authorized folder', () => {
    expect(assertCaptureUrl('http://localhost:5173/app', [root])).toBe('http://localhost:5173/app');
    expect(assertCaptureUrl('http://127.0.0.1:3000', [root])).toBe('http://127.0.0.1:3000/');
    expect(() => assertCaptureUrl('https://example.com', [root])).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));
    expect(() => assertCaptureUrl('http://192.168.1.2', [root])).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));
    expect(assertCaptureUrl(pathToFileURL(join(root, 'page.html')).href, [root])).toMatch(/^file:/);
    expect(() => assertCaptureUrl(pathToFileURL('/etc/hosts').href, [root])).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));
    expect(() => assertCaptureUrl(pathToFileURL(join(root, 'page.html')).href, [])).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));
    expect(() => assertCaptureUrl('javascript:alert(1)', [root])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('normalizes steps, adds a final screenshot, and checks every step against the same boundary', () => {
    const plan = normalizeCaptureArgs({ url: 'http://localhost:5173', steps: [{ action: 'click', selector: '#go' }, { action: 'wait', ms: '200' }] }, [root]);
    expect(plan).toEqual({
      url: 'http://localhost:5173/', mode: 'screenshot', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
      steps: [{ action: 'click', selector: '#go' }, { action: 'wait', ms: 200 }, { action: 'screenshot' }],
    });
    expect(normalizeCaptureArgs({ url: 'http://localhost', mode: 'video', steps: [] }, [root]).steps).toEqual([]);
    expect(() => normalizeCaptureArgs({ url: 'http://localhost', steps: [{ action: 'goto', url: 'https://evil.test' }] }, [root])).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));
    expect(() => normalizeCaptureArgs({ url: 'http://localhost', steps: [{ action: 'eval', script: '1' }] }, [root])).toThrow(/action/);
    expect(() => normalizeCaptureArgs({ url: 'http://localhost', steps: [{ action: 'wait', ms: 60000 }] }, [root])).toThrow(/wait.ms/);
    expect(() => normalizeCaptureArgs({ url: 'http://localhost', viewport: { width: 50, height: 800 } }, [root])).toThrow(/viewport.width/);
    expect(() => normalizeCaptureArgs({ url: 'http://localhost', mode: 'gif' }, [root])).toThrow(/mode/);
  });
});

describe('capture.ui browser boundary', () => {
  it('applies one rule to every request the page makes', () => {
    const allowed = url => captureRequestAllowed(url, [root]).ok;
    expect(allowed('http://localhost:5173/assets/app.js')).toBe(true);
    expect(allowed('ws://127.0.0.1:5173/hmr')).toBe(true);
    expect(allowed('data:image/png;base64,AAAA')).toBe(true);
    expect(allowed('about:blank')).toBe(true);
    expect(allowed(pathToFileURL(join(root, 'missing.css')).href)).toBe(true);
    expect(allowed('https://fonts.googleapis.com/css')).toBe(false);
    expect(allowed('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(allowed('wss://evil.test/socket')).toBe(false);
    expect(allowed(pathToFileURL('/etc/passwd').href)).toBe(false);
    expect(allowed('chrome://settings')).toBe(false);
    expect(captureRequestAllowed('http://localhost', []).ok).toBe(true);
    expect(captureRequestAllowed(pathToFileURL(join(root, 'page.html')).href, []).ok).toBe(false);
  });

  it('follows symlinks before deciding a file is inside the authorized folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'capture-outside-'));
    writeFileSync(join(outside, 'secret.html'), 'secret');
    try { symlinkSync(outside, join(root, 'escape')); } catch { return; }
    const linked = pathToFileURL(join(root, 'escape', 'secret.html')).href;
    expect(captureRequestAllowed(linked, [root]).ok).toBe(false);
    expect(() => assertCaptureUrl(linked, [root])).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));
  });

  it('keeps the Chromium sandbox on unless explicitly disabled', () => {
    expect(captureSandboxEnabled({})).toBe(true);
    expect(captureSandboxEnabled({ IRIS_CAPTURE_NO_SANDBOX: '0' })).toBe(true);
    expect(captureSandboxEnabled({ IRIS_CAPTURE_NO_SANDBOX: '1' })).toBe(false);
    expect(CAPTURE_BROWSER_ARGS.some(arg => arg.startsWith('--host-resolver-rules=MAP * ~NOTFOUND'))).toBe(true);
  });

  it('blocks out-of-bounds requests and fails on out-of-bounds navigation, responses and sockets', async () => {
    const handlers = {};
    const listeners = {};
    let routeHandler;
    let socketHandler;
    const context = {
      route: async (_match, handler) => { routeHandler = handler; },
      routeWebSocket: async (_match, handler) => { socketHandler = handler; },
      on: (event, handler) => { listeners[event] = handler; },
      pages: () => [],
    };
    const boundary = await guardCaptureContext(context, [root]);
    const routed = (url, navigation = false) => {
      const calls = [];
      routeHandler({ request: () => ({ url: () => url, isNavigationRequest: () => navigation }), continue: () => calls.push('continue'), abort: reason => calls.push(`abort:${reason}`) });
      return calls;
    };
    expect(routed('http://localhost:5173/app.js')).toEqual(['continue']);
    expect(routed('https://cdn.example.com/lib.js')).toEqual(['abort:blockedbyclient']);
    // 子资源被拦不算违规：本地开发页常引用外部字体 / 统计脚本。
    expect(() => boundary.assertClean()).not.toThrow();

    const socket = { url: () => 'wss://evil.test/s', connectToServer: () => { handlers.connected = true; }, close: info => { handlers.closed = info; } };
    socketHandler(socket);
    expect(handlers.connected).toBeUndefined();
    expect(handlers.closed).toMatchObject({ code: 1008 });
    expect(() => boundary.assertClean()).toThrow(expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }));

    const fresh = await guardCaptureContext(context, [root]);
    expect(routed('https://evil.test/login', true)).toEqual(['abort:blockedbyclient']);
    expect(() => fresh.assertClean()).toThrow(/evil\.test/);

    const redirect = await guardCaptureContext(context, [root]);
    listeners.response({ url: () => 'https://evil.test/after-redirect' });
    expect(redirect.violations[0]).toMatchObject({ kind: 'response' });

    const nav = await guardCaptureContext(context, [root]);
    const pageListeners = {};
    listeners.page({ on: (event, handler) => { pageListeners[event] = handler; } });
    pageListeners.framenavigated({ url: () => 'chrome-error://chromewebdata/' });
    expect(nav.violations).toEqual([]);
    pageListeners.framenavigated({ url: () => 'http://10.0.0.5/' });
    expect(nav.violations[0]).toMatchObject({ kind: 'navigation' });
  });
});
