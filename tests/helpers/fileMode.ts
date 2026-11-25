import { accessSync, constants, statSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * 断言凭据文件只对当前用户可读写。
 * POSIX：权限位必须正好是 0600（安全要求，不放宽）。
 * Windows：Node 的 chmod 只能切换只读位，stat 永远报 0666；隔离由用户目录 ACL 继承，
 * 这里只能断言文件存在且当前用户可读写，不能用 POSIX 权限位判断。
 */
export function expectOwnerOnlyFile(file: string): void {
  if (process.platform === 'win32') {
    accessSync(file, constants.R_OK | constants.W_OK);
    expect(statSync(file).isFile()).toBe(true);
    return;
  }
  expect(statSync(file).mode & 0o777).toBe(0o600);
}
