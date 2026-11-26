import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { SettingsPanel } from '../components/SettingsPanel';
import { DEEPSEEK_EXT_SETTINGS_KEY, loadDeepSeekExtensionSettings } from '../services/deepseekExtensions';
import { translations } from '../utils/translations';

const zhT = (key: string, ...args: unknown[]): string => {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, translations.zho as unknown);
  return String(typeof value === 'function' ? value(...args) : (value ?? key));
};

function renderSettings() {
  return render(
    <SettingsPanel
      isOpen
      onClose={() => undefined}
      resolvedTheme="dark"
      userApiKeys={[]}
      onAddApiKey={() => undefined}
      onDeleteApiKey={() => undefined}
      onUpdateApiKey={() => undefined}
      onSetDefaultApiKey={() => undefined}
      t={zhT}
      clearKeysOnExit={false}
      setClearKeysOnExit={() => undefined}
    />,
  );
}

function openDrawerWithBaseUrl(url: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /添加 AI 服务|添加 API Key|添加供应商/i }));
  const input = screen.getByPlaceholderText('https://your-api-endpoint.com') as HTMLInputElement;
  fireEvent.change(input, { target: { value: url } });
  return screen.getByTestId('key-dialog-more-settings');
}

describe('DeepSeek server extensions placement (progressive disclosure)', () => {
  beforeEach(() => localStorage.removeItem(DEEPSEEK_EXT_SETTINGS_KEY));

  it('is not rendered at the top level of the AI services tab', () => {
    renderSettings();
    expect(screen.queryByTestId('deepseek-extensions')).toBeNull();
    expect(screen.queryByText('DeepSeek 服务端扩展')).toBeNull();
  });

  it('appears inside the 更多设置 section of a DeepSeek official service', () => {
    renderSettings();
    const more = openDrawerWithBaseUrl('https://api.deepseek.com');
    const card = within(more).getByTestId('deepseek-extensions');
    expect(within(card).getByText('DeepSeek 服务端扩展')).toBeTruthy();
    expect(within(card).getByText('api.deepseek.com')).toBeTruthy();
    // 默认值不变：标题开、联网关、安全审核关。
    expect((within(card).getByTestId('deepseek-ext-title') as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByTestId('deepseek-ext-web-search') as HTMLInputElement).checked).toBe(false);
    expect((within(card).getByTestId('deepseek-ext-safety-check') as HTMLInputElement).checked).toBe(false);
  });

  it('is absent for a non-DeepSeek service', () => {
    renderSettings();
    const more = openDrawerWithBaseUrl('https://api.example.com/v1');
    expect(within(more).queryByTestId('deepseek-extensions')).toBeNull();
    expect(screen.queryByTestId('deepseek-extensions')).toBeNull();
  });

  it('hides again when the base URL leaves api.deepseek.com', () => {
    renderSettings();
    openDrawerWithBaseUrl('https://api.deepseek.com/v1');
    expect(screen.getByTestId('deepseek-extensions')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('https://your-api-endpoint.com'), { target: { value: 'https://api.deepseek.com.evil.example/v1' } });
    expect(screen.queryByTestId('deepseek-extensions')).toBeNull();
  });

  it('toggling still writes the same global setting key', () => {
    renderSettings();
    openDrawerWithBaseUrl('https://api.deepseek.com');
    fireEvent.click(screen.getByTestId('deepseek-ext-web-search'));
    expect(JSON.parse(localStorage.getItem(DEEPSEEK_EXT_SETTINGS_KEY) || '{}')).toMatchObject({ title: true, webSearch: true, safetyCheck: false });
    expect(loadDeepSeekExtensionSettings().webSearch).toBe(true);
    expect((screen.getByTestId('deepseek-ext-web-search') as HTMLInputElement).checked).toBe(true);
  });
});
