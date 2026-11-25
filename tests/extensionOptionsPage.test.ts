// @vitest-environment node
// 插件设置页（1.7）：Provider 列表与画布设置同源；设置页只经 service worker 拿掩码视图，不直接碰存储、加密或网络；
// popup / options 用到的文案在中英两份 _locales 里都存在。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDER_BASE_URLS, PROVIDER_LABELS, PROVIDER_PRESETS } from '../extension/options/provider-presets.js';

const read = (path: string) => readFileSync(path, 'utf8');

function objectLiteral(source: string, declaration: string): Record<string, string> {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('};', start));
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*([A-Za-z_]+):\s*'([^']*)',/gm)) result[match[1]] = match[2];
  return result;
}

describe('provider list parity with the canvas Settings', () => {
  it('labels match services/aiGateway.ts PROVIDER_LABELS', () => {
    expect(PROVIDER_LABELS).toEqual(objectLiteral(read('services/aiGateway.ts'), 'export const PROVIDER_LABELS'));
  });

  it('default base URLs match components/SettingsPanel.tsx providerBaseUrl', () => {
    expect(PROVIDER_BASE_URLS).toEqual(objectLiteral(read('components/SettingsPanel.tsx'), 'const providerBaseUrl'));
  });

  it('presets mirror the built-in SettingsPanel presets (except the script-backed custom config)', () => {
    const settings = read('components/SettingsPanel.tsx');
    const block = settings.slice(settings.indexOf('const PROVIDER_PRESETS'), settings.indexOf('export const SettingsPanel'));
    const presets = [...block.matchAll(/id: '([^']+)',[\s\S]*?provider: '([^']+)',[\s\S]*?capabilities: \[([^\]]*)\]/g)]
      .map(([, id, provider, caps]) => ({ id, provider, capabilities: caps.split(',').map(cap => cap.trim().replace(/'/g, '')).filter(Boolean) }));
    // 「自定义配置」的 id 是常量 USER_SCRIPT_PRESET_ID（不是字面量），正则不会匹配到它。
    expect(presets.length).toBe(4);
    expect(PROVIDER_PRESETS.map(({ id, provider, capabilities }) => ({ id, provider, capabilities }))).toEqual(presets);
    for (const preset of PROVIDER_PRESETS) {
      if (preset.provider !== 'custom') expect(preset.baseUrl).toBe(PROVIDER_BASE_URLS[preset.provider as keyof typeof PROVIDER_BASE_URLS]);
    }
  });
});

describe('options page boundary', () => {
  it('is registered as the options page and shipped by the build', () => {
    const manifest = JSON.parse(read('extension/manifest.json'));
    expect(manifest.options_ui).toEqual({ page: 'options/options.html', open_in_tab: true });
    expect(read('extension/build.mjs')).toContain("'options'");
  });

  it('never touches storage, crypto or the network directly', () => {
    const options = read('extension/options/options.js') + read('extension/options/provider-presets.js');
    expect(options).not.toMatch(/fetch\(|XMLHttpRequest|indexedDB|crypto\.subtle|storage\.local\.|storage\.session|console\./);
    expect(read('extension/options/options.html')).not.toMatch(/<script(?![^>]*src="options\.js")/);
  });
});

describe('locales', () => {
  it('every data-i18n key used by popup and options exists in zh_CN and en', () => {
    const zh = JSON.parse(read('extension/_locales/zh_CN/messages.json'));
    const en = JSON.parse(read('extension/_locales/en/messages.json'));
    const sources = ['extension/popup/popup.html', 'extension/options/options.html', 'extension/popup/popup.js', 'extension/options/options.js'].map(read).join('\n');
    const keys = new Set([
      ...[...sources.matchAll(/data-i18n(?:-title)?="([a-z0-9_]+)"/g)].map(match => match[1]),
      ...[...sources.matchAll(/\bt\('([a-z0-9_]+)'[,)]/g)].map(match => match[1]),
    ]);
    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      expect(zh[key]?.message, 'zh_CN ' + key).toBeTruthy();
      expect(en[key]?.message, 'en ' + key).toBeTruthy();
    }
  });
});
