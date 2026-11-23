import { render } from '@testing-library/react';
import { forwardRef, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// 记录节点根 motion.div 收到的动画参数（jsdom 不跑真实动画，只能检查交给 motion 的配置）。
const captured: Array<Record<string, any>> = [];
vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>();
  const strip = ({ initial: _i, animate: _a, exit: _e, transition: _t, layout: _l, variants: _v, whileHover: _wh, whileTap: _wt, ...rest }: Record<string, any>) => rest;
  const Div = forwardRef<HTMLDivElement, Record<string, any> & { children?: ReactNode }>((props, ref) => {
    if (props['data-workflow-node-id']) captured.push(props);
    return <div ref={ref} {...strip(props)} />;
  });
  return { ...actual, motion: new Proxy({}, { get: (_target, key) => (key === 'div' ? Div : (actual.motion as any)[key]) }) };
});

const { createWorkflowNode } = await import('../components/workflow/constants');
const { WORKFLOW_NODE_EXIT, WorkflowNode } = await import('../components/workflow/WorkflowNode');

const noop = () => {};

// 回归：生成 4 张后源节点在同一次提交里“成功 + 被批次隐藏”，AnimatePresence 退出它时曾沿用加载态
// transition.scale 的 repeat: Infinity（主线已去掉整节点呼吸，退出仍须自带有限过渡防回退），退出永远不结束——透明的旧节点留在原位拦截点击
// （“拖走 4 张批次，原位留下一张点不中的”）。浏览器复现与修复验证见 docs/archive/2026-11-24-docs-refresh/quality/2026-11-16-batch-alternates.md。
describe('workflow node exit', () => {
  it('gives a loading node a finite exit transition instead of inheriting the node spring', () => {
    captured.length = 0;
    const node = { ...createWorkflowNode('gen', 'image', { x: 200, y: 150 }, { status: 'loading', generationStartedAt: Date.now(), config: { mode: 'image' } }), width: 320, height: 240 };
    render(<WorkflowNode node={node} selected={false} language="zho" onPointerDown={noop} onConnectStart={noop} onResizeStart={noop} onChangeText={noop} onChangeMetadata={noop} onRun={noop} onContextMenu={noop} onReplaceMedia={noop} onRemoveMedia={noop} />);
    const props = captured.at(-1)!;
    // 加载态不再整节点呼吸缩放（DESIGN 01 §19.6），缩放过渡里不能有无限循环
    expect(props.transition.scale.repeat).toBeUndefined();
    // 退出自带有限过渡（DESIGN §14.2 退出 120–160ms），不含 repeat
    expect(props.exit).toBe(WORKFLOW_NODE_EXIT);
    expect(props.exit.transition).toBeDefined();
    expect(props.exit.transition.repeat).toBeUndefined();
    expect(props.exit.transition.duration).toBeLessThanOrEqual(0.16);
  });
});
