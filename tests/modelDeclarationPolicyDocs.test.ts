import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-11-27 用户决定：不内置任何模型映射，模型由用户 / Agent 声明；未知价格一律审批；
// 上游返回的能力只能作「未确认」预填。AGENTS.md 与 SUPPORT_MATRIX.md 必须同步这一口径，
// 不能再出现「RunningHub 保持内置（含预设模型与线路）」或以内置线路目录作为认证对象。
const root = join(__dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('model declaration policy docs', () => {
  it('AGENTS.md no longer mandates built-in RunningHub presets and states the declaration rule', () => {
    const agents = read('AGENTS.md');
    const section6 = agents.slice(agents.indexOf('## 6. 工程约定'), agents.indexOf('## 7.'));
    expect(section6).not.toMatch(/^- RunningHub 保持内置/m);
    expect(section6).toContain('不内置模型映射');
    expect(section6).toContain('iris.service/1');
    expect(section6).toMatch(/价格未知 → 一律走审批/);
    expect(section6).toContain('未确认');
    expect(section6).toMatch(/保留旧模型 id/);
  });

  it('SUPPORT_MATRIX certifies the RunningHub adapter + user-declared routeId, not a built-in catalog', () => {
    const matrix = read('SUPPORT_MATRIX.md');
    const section = matrix.slice(matrix.indexOf('## Runtime and provider paths'), matrix.indexOf('## Extensions and packages'));
    expect(section).not.toContain('Catalog 驱动的标准模型线路）。');
    expect(section).toContain('RunningHub 协议适配器 + 用户声明的 routeId');
    const row = section.split('\n').find(line => line.startsWith('| RunningHub image + video routes |'));
    expect(row).toBeDefined();
    expect(row).toContain('Beta (pending certification)');
    expect(row).toContain('用户声明的 routeId');
    expect(row).toContain('不构成对外承诺的内置模型列表');
  });
});
