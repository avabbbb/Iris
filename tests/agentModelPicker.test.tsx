import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UserApiKey } from '../types';

const { fetchModelsForProvider } = vi.hoisted(() => ({ fetchModelsForProvider: vi.fn() }));
vi.mock('../services/modelFetcher', () => ({ fetchModelsForProvider }));

import { AgentModelPicker, supportedThinkingLevels, thinkingChipSuffix } from '../components/agent/AgentModelPicker';
import { act } from 'react';
import { markReasoningUnsupported, readAgentThinkingLevel, writeAgentThinkingLevel, type AgentThinkingLevel } from '../services/agentThinking';

const agentText = (routeId: string) => ({ target: { kind: 'runtime-capability' as const, capability: 'agent-text' as const }, routeId, order: 0 });

describe('AgentModelPicker', () => {
  it('imports every model from a key + base URL and routes the agent to the first text model', async () => {
    fetchModelsForProvider.mockResolvedValue({
      ok: true,
      effectiveBaseUrl: 'https://api.example.com/v1',
      models: [
        { id: 'img-1', name: 'img-1', capability: 'image' },
        { id: 'chat-a', name: 'Chat A', capability: 'text' },
        { id: 'chat-b', name: 'Chat B', capability: 'text' },
      ],
    });
    const onAddApiKey = vi.fn();
    render(<AgentModelPicker userApiKeys={[]} onAddApiKey={onAddApiKey} onUpdateApiKey={vi.fn()} open onOpenChange={vi.fn()} language="zho" />);

    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /导入全部模型/ }));

    await waitFor(() => expect(onAddApiKey).toHaveBeenCalledOnce());
    expect(fetchModelsForProvider).toHaveBeenCalledWith('openai_compatible', 'sk-test', 'https://api.example.com');
    const payload = onAddApiKey.mock.calls[0][0];
    expect(payload).toMatchObject({ provider: 'openai_compatible', key: 'sk-test', baseUrl: 'https://api.example.com/v1', name: 'api.example.com' });
    expect(payload.models).toHaveLength(3);
    expect(payload.capabilities).toEqual(expect.arrayContaining(['text', 'image']));
    expect(payload.routeMappings).toEqual([agentText('chat-a')]);
  });

  it('shows an error instead of saving when no models come back', async () => {
    fetchModelsForProvider.mockResolvedValue({ ok: false, models: [], error: 'API Key 无效' });
    const onAddApiKey = vi.fn();
    render(<AgentModelPicker userApiKeys={[]} onAddApiKey={onAddApiKey} open onOpenChange={vi.fn()} language="zho" />);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://bad.example.com' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByRole('button', { name: /导入全部模型/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('API Key 无效');
    expect(onAddApiKey).not.toHaveBeenCalled();
  });

  it('switches the agent model and leaves only one agent-text mapping', () => {
    const keys: UserApiKey[] = [
      { id: 'k1', provider: 'openai_compatible', capabilities: ['text'], key: 'a', baseUrl: 'https://one.example.com/v1', models: [{ id: 'm1', name: 'm1', capability: 'text' }], routeMappings: [agentText('m1')], createdAt: 0, updatedAt: 0 },
      { id: 'k2', provider: 'openai_compatible', capabilities: ['text'], key: 'b', baseUrl: 'https://two.example.com/v1', models: [{ id: 'm2', name: 'm2', capability: 'text' }], createdAt: 0, updatedAt: 0 },
    ];
    const onUpdateApiKey = vi.fn();
    const onOpenChange = vi.fn();
    render(<AgentModelPicker userApiKeys={keys} onUpdateApiKey={onUpdateApiKey} open onOpenChange={onOpenChange} language="zho" />);

    expect(screen.getByRole('option', { name: /m1/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: 'm2' } });
    expect(screen.queryByRole('option', { name: /m1/ })).not.toBeInTheDocument();
    // 点模型 = 展开它的思考强度子菜单；选一档才同时选中模型与强度。
    fireEvent.click(screen.getByRole('option', { name: /m2/ }));
    expect(onUpdateApiKey).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('menu', { name: /思考强度 · m2/ })).getByRole('menuitemradio', { name: '不思考' }));

    expect(onUpdateApiKey).toHaveBeenCalledWith('k1', { routeMappings: [] });
    expect(onUpdateApiKey).toHaveBeenCalledWith('k2', { routeMappings: [agentText('m2')] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('is keyboard-first: typing filters without a click, ↑/↓ moves the highlight across groups, Enter picks, Esc clears then closes', () => {
    const keys: UserApiKey[] = [
      { id: 'ds', provider: 'openai_compatible', capabilities: ['text'], key: 'a', baseUrl: 'https://api.deepseek.com/v1', models: [
        { id: 'deepseek/deepseek-chat', name: 'deepseek/deepseek-chat', capability: 'text' },
        { id: 'deepseek/deepseek-reasoner', name: 'deepseek/deepseek-reasoner', capability: 'text' },
      ], routeMappings: [agentText('deepseek/deepseek-chat')], createdAt: 0, updatedAt: 0 },
      { id: 'or', provider: 'openai_compatible', capabilities: ['text'], key: 'b', baseUrl: 'https://openrouter.ai/api/v1', models: [
        { id: 'deepseek/deepseek-v3', name: 'deepseek/deepseek-v3', capability: 'text' },
        { id: 'openai/gpt-4o', name: 'openai/gpt-4o', capability: 'text' },
      ], createdAt: 0, updatedAt: 0 },
    ];
    const onUpdateApiKey = vi.fn();
    const onOpenChange = vi.fn();
    render(<AgentModelPicker userApiKeys={keys} onUpdateApiKey={onUpdateApiKey} open onOpenChange={onOpenChange} language="zho" />);

    const search = screen.getByRole('combobox', { name: '搜索模型' });
    expect(document.activeElement).toBe(search);
    const highlighted = () => document.querySelector('[data-listbox-active="true"]');
    // 打开时高亮当前模型
    expect(highlighted()).toBe(screen.getByRole('option', { name: /deepseek-chat/ }));

    fireEvent.change(document.activeElement!, { target: { value: 'deepseek' } });
    expect(screen.queryByRole('option', { name: /gpt-4o/ })).not.toBeInTheDocument();
    expect(highlighted()).toBe(screen.getByRole('option', { name: /deepseek-chat/ }));
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(highlighted()).toBe(screen.getByRole('option', { name: /deepseek-reasoner/ }));
    expect(search).toHaveAttribute('aria-activedescendant', highlighted()!.id);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    // 跨分组（第二个 Key）继续往下，分组标题不占位
    expect(highlighted()).toBe(screen.getByRole('option', { name: /deepseek-v3/ }));
    fireEvent.keyDown(search, { key: 'ArrowUp' });

    // 输入法组字中的 Enter 不选
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(onUpdateApiKey).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'reasoner' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    // Enter 展开子菜单并把焦点送进去；Esc 只收起子菜单，不关浮层。
    const submenu = screen.getByRole('menu', { name: /思考强度 · deepseek\/deepseek-reasoner/ });
    expect(submenu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: /思考强度/ })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.click(document.activeElement!);
    expect(onUpdateApiKey).toHaveBeenCalledWith('ds', { routeMappings: [agentText('deepseek/deepseek-reasoner')] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('forwards typing from elsewhere in the picker into the search and Esc closes when the search is empty', () => {
    const keys: UserApiKey[] = [
      { id: 'k1', provider: 'openai_compatible', capabilities: ['text'], key: 'a', baseUrl: 'https://one.example.com/v1', models: [{ id: 'alpha', name: 'alpha', capability: 'text' }, { id: 'beta', name: 'beta', capability: 'text' }], createdAt: 0, updatedAt: 0 },
    ];
    const onOpenChange = vi.fn();
    render(<AgentModelPicker userApiKeys={keys} onUpdateApiKey={vi.fn()} open onOpenChange={onOpenChange} language="zho" />);
    const add = screen.getByRole('button', { name: '添加 Key' });
    add.focus();
    fireEvent.keyDown(add, { key: 'b' });
    const search = screen.getByRole('combobox', { name: '搜索模型' });
    expect(search).toHaveValue('b');
    expect(document.activeElement).toBe(search);
    expect(screen.queryByRole('option', { name: /alpha/ })).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cascades a thinking submenu per model: hover / → opens it, ← closes it, picking a level sets model and level', () => {
    localStorage.removeItem('iris.agent.thinking');
    const keys: UserApiKey[] = [
      { id: 'k1', provider: 'openai_compatible', capabilities: ['text'], key: 'a', baseUrl: 'https://one.example.com/v1', models: [
        { id: 'chat-think', name: 'chat-think', capability: 'text' },
        { id: 'chat-plain', name: 'chat-plain', capability: 'text' },
      ], routeMappings: [agentText('chat-think')], createdAt: 0, updatedAt: 0 },
    ];
    const onUpdateApiKey = vi.fn();
    const onOpenChange = vi.fn();
    act(() => markReasoningUnsupported('chat-plain'));
    const { rerender } = render(<AgentModelPicker userApiKeys={keys} onUpdateApiKey={onUpdateApiKey} open onOpenChange={onOpenChange} language="zho" />);
    const search = screen.getByRole('combobox', { name: '搜索模型' });

    // 悬停展开；只列该模型支持的档（非 OpenAI / OpenRouter 不单列「极简」）。
    fireEvent.mouseEnter(screen.getByRole('option', { name: /chat-think/ }));
    const submenu = screen.getByRole('menu', { name: '思考强度 · chat-think' });
    expect(within(submenu).getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['不思考', '低', '中', '高']);
    expect(within(submenu).getByRole('menuitemradio', { name: '不思考' })).toHaveAttribute('aria-checked', 'true');
    // 不支持思考参数的模型没有子菜单，点它直接选中。
    fireEvent.mouseEnter(screen.getByRole('option', { name: /chat-plain/ }));
    expect(screen.queryByRole('menu', { name: /思考强度/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /chat-plain/ })).not.toHaveAttribute('aria-haspopup');

    // 键盘：→ 展开高亮模型的子菜单，← 收起回到搜索框。
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    expect(screen.getByRole('menu', { name: '思考强度 · chat-think' }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('低');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.queryByRole('menu', { name: /思考强度/ })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(search);

    fireEvent.keyDown(search, { key: 'ArrowRight' });
    fireEvent.click(within(screen.getByRole('menu', { name: '思考强度 · chat-think' })).getByRole('menuitemradio', { name: '高' }));
    expect(readAgentThinkingLevel('chat-think')).toBe('high');
    expect(onUpdateApiKey).toHaveBeenCalledWith('k1', { routeMappings: [agentText('chat-think')] });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // 胶囊带非默认强度后缀；回到默认就不显示。
    rerender(<AgentModelPicker userApiKeys={keys} onUpdateApiKey={onUpdateApiKey} open={false} onOpenChange={onOpenChange} language="zho" />);
    expect(screen.getByTestId('agent-model-effort')).toHaveTextContent('· 高');
    expect(screen.getByRole('button', { name: '选择模型' })).toHaveAttribute('title', 'chat-think · 思考强度 高');
    act(() => writeAgentThinkingLevel('chat-think', 'off'));
    expect(screen.queryByTestId('agent-model-effort')).not.toBeInTheDocument();
  });

  it('lists 极简 only for providers that accept it and nothing for models that rejected the parameter', () => {
    localStorage.removeItem('iris.agent.thinking');
    expect(supportedThinkingLevels('gpt', { provider: 'openai', baseUrl: '' })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(supportedThinkingLevels('x', { provider: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1' })).toContain('minimal');
    expect(supportedThinkingLevels('ds', { provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' })).not.toContain('minimal');
    act(() => markReasoningUnsupported('ds'));
    expect(supportedThinkingLevels('ds', { provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1' })).toEqual([]);
  });

  it('lists only the levels the model supports and maps a stored level to the nearest one', () => {
    localStorage.removeItem('iris.agent.thinking');
    const info = { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', capability: 'text' as const, thinkingLevels: ['off', 'high', 'max'] as AgentThinkingLevel[], thinkingSource: 'api' as const };
    const key = { provider: 'openai_compatible' as const, baseUrl: 'https://api.deepseek.com/v1' };
    expect(supportedThinkingLevels(info, key)).toEqual(['off', 'high', 'max']);
    // API 字段优先于「极简只给 OpenAI / OpenRouter」的规则。
    expect(supportedThinkingLevels({ ...info, thinkingLevels: ['minimal', 'low'] }, key)).toEqual(['minimal', 'low']);
    // 存的「中」就近夹到「高」，胶囊后缀与实际发送一致。
    act(() => writeAgentThinkingLevel('deepseek-v4-pro', 'medium'));
    expect(thinkingChipSuffix(info, 'zho')).toBe('· 高');
    act(() => writeAgentThinkingLevel('deepseek-v4-pro', 'max'));
    expect(thinkingChipSuffix(info, 'zho')).toBe('· 最大');
  });
});
