// 插件引导卡片：未安装时显示安装入口，"不再提醒"后隐藏；已配对且支持直连时不显示。
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

let bridgeState = { status: 'not-installed', extensionId: null as string | null, extensionVersion: null, capabilities: [] as string[] };
const listeners = new Set<() => void>();
const fakeBridge = {
  getState: () => bridgeState,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  connect: vi.fn(async () => bridgeState),
  supports: (capability: string) => bridgeState.status === 'approved' && bridgeState.capabilities.includes(capability),
  openChannel: () => null,
};
vi.mock('../services/extensionBridge', () => ({ getExtensionBridge: () => fakeBridge }));

const { ExtensionInstallPrompt } = await import('../components/extension/ExtensionInstallPrompt');
const { getExtensionPromptStore, PROMPT_DISMISS_KEY } = await import('../services/extensionInstallPrompt');
const { STAR_PROMPT_KEY, IRIS_GITHUB_URL } = await import('../services/starPrompt');

function setBridge(patch: Partial<typeof bridgeState>) {
  bridgeState = { ...bridgeState, ...patch };
  for (const listener of listeners) listener();
}

const t = (key: string) => key.split('.').pop() || key;

afterEach(() => {
  localStorage.removeItem(PROMPT_DISMISS_KEY);
  localStorage.removeItem(STAR_PROMPT_KEY);
});

describe('ExtensionInstallPrompt', () => {
  it('appears only once a reason exists, offers install, and hides for good on "never"', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ExtensionInstallPrompt isDark={false} t={t} />);
    expect(screen.queryByTestId('extension-install-prompt')).toBeNull();
    act(() => getExtensionPromptStore().note('configured'));
    expect(screen.getByTestId('extension-install-prompt')).toBeTruthy();
    fireEvent.click(screen.getByText('install'));
    expect(openSpy).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\//), '_blank', 'noopener,noreferrer');
    fireEvent.click(screen.getByText('never'));
    expect(screen.queryByTestId('extension-install-prompt')).toBeNull();
    expect(localStorage.getItem(PROMPT_DISMISS_KEY)).toBe('1');
  });

  it('invites a GitHub star once, right after pairing succeeds in this session, and remembers dismissal', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const view = render(<ExtensionInstallPrompt isDark={false} t={t} />);
    act(() => setBridge({ status: 'pending', extensionId: 'a'.repeat(32) }));
    expect(screen.queryByTestId('iris-star-prompt')).toBeNull();
    act(() => setBridge({ status: 'approved', capabilities: ['llm.fetch'] }));
    expect(screen.getByTestId('iris-star-prompt')).toBeTruthy();
    fireEvent.click(screen.getByText('action'));
    expect(openSpy).toHaveBeenCalledWith(IRIS_GITHUB_URL, '_blank', 'noopener,noreferrer');
    expect(screen.queryByTestId('iris-star-prompt')).toBeNull();
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe('1');
    view.unmount();

    // 已配对用户重新打开页面：没有经历 pending，不弹。
    setBridge({ status: 'idle', capabilities: [] });
    localStorage.removeItem(STAR_PROMPT_KEY);
    render(<ExtensionInstallPrompt isDark={false} t={t} />);
    act(() => setBridge({ status: 'approved', capabilities: ['llm.fetch'] }));
    expect(screen.queryByTestId('iris-star-prompt')).toBeNull();
  });
});
