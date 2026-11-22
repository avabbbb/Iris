import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import localforage from 'localforage';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/localSkillRegistry', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/localSkillRegistry')>();
  return { ...actual, createLocalSkillRegistry: vi.fn(async () => null) };
});

import { ProductionSkillDeck } from '../components/agent/ProductionSkillDeck';
import { listBundledProductionSkills, type ProductionSkillAttachment } from '../services/productionSkillCatalog';
import { skillSystemContext, userSkillAttachment } from '../services/userSkillContext';
import { useSkillHubStore } from '../stores/useSkillHubStore';
import { DISABLED_SKILLS_KEY, MINE_SKILLS_KEY, useUserSkillsStore } from '../stores/useUserSkillsStore';

async function resetSkillStores() {
  await localforage.removeItem(MINE_SKILLS_KEY);
  await localforage.removeItem(DISABLED_SKILLS_KEY);
  useUserSkillsStore.setState({ skills: [], disabledIds: new Set(), favoriteIds: new Set(), loaded: false });
  await localforage.removeItem('iris.skill.favorites.v1');
  useSkillHubStore.setState({
    hubUrl: '', hubStatus: 'idle', hubError: undefined, hubSkills: [], localSkills: [], registryStatus: 'unavailable',
    refreshLocal: vi.fn(async () => undefined),
  });
}

function renderDeck(props: Partial<React.ComponentProps<typeof ProductionSkillDeck>> = {}) {
  const dropTargetRef = createRef<HTMLDivElement>();
  const onChange = vi.fn();
  const utils = render(<div ref={dropTargetRef}><ProductionSkillDeck onChange={onChange} dropTargetRef={dropTargetRef} open onOpenChange={vi.fn()} {...props} /></div>);
  return { ...utils, onChange, dropTargetRef };
}

describe('user Skill store (CRUD + persistence)', () => {
  beforeEach(resetSkillStores);

  it('create / update / remove / restore / enable survive a reload', async () => {
    const store = useUserSkillsStore.getState();
    const created = await store.create({ name: '分镜助手', description: '把剧本拆成分镜', prompt: '按镜头拆分', enabled: true });
    await useUserSkillsStore.getState().update(created.id, { prompt: '按镜头拆分，每镜 3 秒' });
    await useUserSkillsStore.getState().setEnabled(created.id, false);
    await useUserSkillsStore.getState().setEnabled('flovart.vox-director', false);

    useUserSkillsStore.setState({ skills: [], disabledIds: new Set(), loaded: false });
    await useUserSkillsStore.getState().load();
    const reloaded = useUserSkillsStore.getState();
    expect(reloaded.skills).toHaveLength(1);
    expect(reloaded.skills[0]).toMatchObject({ name: '分镜助手', prompt: '按镜头拆分，每镜 3 秒', enabled: false });
    expect(reloaded.disabledIds.has('flovart.vox-director')).toBe(true);

    const removed = await reloaded.remove(created.id);
    expect(useUserSkillsStore.getState().skills).toHaveLength(0);
    await useUserSkillsStore.getState().restore(removed!);
    expect(useUserSkillsStore.getState().skills[0].id).toBe(created.id);
  });

  it('rejects empty names and instructions', async () => {
    await expect(useUserSkillsStore.getState().create({ name: ' ', description: '', prompt: 'x', enabled: true })).rejects.toThrow('名称');
    await expect(useUserSkillsStore.getState().create({ name: 'a', description: '', prompt: ' ', enabled: true })).rejects.toThrow('指令');
  });
});

describe('Agent picks up user Skill changes', () => {
  beforeEach(resetSkillStores);

  it('binds the instructions, changes fingerprint on edit, falls back when disabled', async () => {
    const skill = await useUserSkillsStore.getState().create({ name: '口播', description: '', prompt: '用口语化短句', enabled: true });
    const before = userSkillAttachment(skill);
    expect(skillSystemContext(before)).toContain('用口语化短句');
    const edited = await useUserSkillsStore.getState().update(skill.id, { prompt: '用书面语' });
    const after = userSkillAttachment(edited);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(skillSystemContext(after)).toContain('用书面语');
    await useUserSkillsStore.getState().setEnabled(skill.id, false);
    expect(skillSystemContext(after)).toBe('口播');
  });
});

describe('Skill Hub picker UI', () => {
  it('从模板 prefills the editor; 导入 parses SKILL.md front matter', async () => {
    const { parseSkillImport } = await import('../components/agent/skillHubParts');
    expect(parseSkillImport('---\nname: 分镜\ndescription: 拆镜头\n---\n# 分镜\n按镜头拆', 'SKILL.md')).toMatchObject({ name: '分镜', description: '拆镜头' });
    expect(parseSkillImport('{"name":"口播","prompt":"写口播"}', 'x.json')).toMatchObject({ name: '口播', prompt: '写口播' });
    expect(parseSkillImport('', 'x.md')).toBeNull();
    renderDeck();
    fireEvent.click(screen.getByRole('button', { name: /创建/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /从模板/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '口播脚本' }));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('口播脚本');
    expect((screen.getByLabelText('指令') as HTMLTextAreaElement).value).toContain('30 秒');
  });

  it('喜欢 tab lists liked Skills; liking from details persists', async () => {
    renderDeck();
    const bundled = listBundledProductionSkills()[0];
    fireEvent.click(screen.getByRole('tab', { name: '喜欢' }));
    expect(await screen.findByText('点 ♡ 喜欢的 Skill 会出现在这里')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '综合' }));
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${bundled.displayName} 详情` }));
    fireEvent.click(screen.getByRole('button', { name: '喜欢' }));
    await waitFor(() => expect(useUserSkillsStore.getState().favoriteIds.has(bundled.id)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '返回 Skill 列表' }));
    fireEvent.click(screen.getByRole('tab', { name: '喜欢' }));
    expect(await screen.findByRole('group', { name: bundled.displayName })).toBeInTheDocument();
  });

  beforeEach(resetSkillStores);

  it('创建 opens the editor and saves a new Skill that appears under 我的 Skill', async () => {
    renderDeck();
    fireEvent.click(screen.getByRole('button', { name: /创建/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建空白' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '海报文案' } });
    fireEvent.change(screen.getByLabelText('指令'), { target: { value: '写三条海报标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('写三条海报标题', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: '返回 Skill 列表' }));
    fireEvent.click(screen.getByRole('tab', { name: '我的' }));
    // 列表从持久化 store 异步加载并会重渲染 region：每次重新取 region 再找条目，慢机器（Windows release gate）上也稳定。
    await waitFor(() => {
      const mine = screen.getByRole('region', { name: '我的 Skill' });
      expect(within(mine).getByRole('group', { name: '海报文案' })).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('详情 opens the built-in Skill details (read-only)', async () => {
    renderDeck();
    const bundled = listBundledProductionSkills()[0];
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${bundled.displayName} 详情` }));
    expect(await screen.findByText('SKILL.md 预览')).toBeInTheDocument();
    expect(screen.getByText(/内置 Skill 随 Iris 发布/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除|编辑/ })).not.toBeInTheDocument();
  });

  it('edit, then delete with confirm and undo', async () => {
    const skill = await useUserSkillsStore.getState().create({ name: '旧名', description: '', prompt: '旧指令', enabled: true });
    renderDeck();
    fireEvent.click(await screen.findByRole('button', { name: '查看 旧名 详情' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(useUserSkillsStore.getState().skills[0].name).toBe('新名'));

    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    const confirm = screen.getByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
    await screen.findByText('已删除「新名」');
    expect(useUserSkillsStore.getState().skills).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(useUserSkillsStore.getState().skills.map(item => item.id)).toEqual([skill.id]));
  });

  it('disabling the attached Skill detaches it; editing it refreshes the attachment', async () => {
    const skill = await useUserSkillsStore.getState().create({ name: '镜头', description: '', prompt: 'A', enabled: true });
    const attachment: ProductionSkillAttachment = userSkillAttachment(skill);
    const { onChange, rerender, dropTargetRef } = renderDeck({ attachment });
    await act(async () => { await useUserSkillsStore.getState().update(skill.id, { prompt: 'B' }); });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: skill.id, contentHash: userSkillAttachment(useUserSkillsStore.getState().skills[0]).contentHash })));
    onChange.mockClear();
    rerender(<div ref={dropTargetRef}><ProductionSkillDeck onChange={onChange} dropTargetRef={dropTargetRef} open onOpenChange={vi.fn()} attachment={userSkillAttachment(useUserSkillsStore.getState().skills[0])} /></div>);
    await act(async () => { await useUserSkillsStore.getState().setEnabled(skill.id, false); });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
  });

  it('Hub: + installs, installed rows show 已添加, uninstall needs a confirm', async () => {
    const installFromHub = vi.fn(async () => undefined);
    const uninstallSkill = vi.fn(async () => undefined);
    useSkillHubStore.setState({
      hubUrl: 'https://hub.example',
      hubStatus: 'ready',
      hubSkills: [
        { id: 'community.storyboard', name: '分镜', version: '1.0.0', description: '分镜 Skill' },
        { id: 'community.voice', name: '配音', version: '1.0.0', description: '配音 Skill' },
      ],
      localSkills: [{ id: 'community.voice', name: '配音', description: '', version: '1.0.0', kind: 'production', trustTier: 'community', location: 'app', packageDir: '', contentHash: null, fileCount: 1 }],
      installFromHub,
      uninstallSkill,
    });
    renderDeck();
    const hub = await screen.findByRole('region', { name: '来自 Skill Hub' });
    fireEvent.click(within(hub).getByRole('button', { name: '安装 分镜' }));
    await waitFor(() => expect(installFromHub).toHaveBeenCalledWith('community.storyboard'));
    expect(within(hub).getAllByText('已添加').length).toBeGreaterThan(0);
    fireEvent.click(within(hub).getByRole('button', { name: '查看 配音 详情' }));
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(uninstallSkill).toHaveBeenCalledWith('community.voice'));
  });
});
