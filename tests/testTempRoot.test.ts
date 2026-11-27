import { afterEach, describe, expect, it } from 'vitest';
import { assertTestPath, resolveTestTempRoot } from '../scripts/test-temp-root.mjs';

const originalGitHubActions = process.env.GITHUB_ACTIONS;
const originalRunnerTemp = process.env.RUNNER_TEMP;
const originalConfiguredRoot = process.env.IRIS_TEST_TMP_ROOT;
const originalTestDrive = process.env.IRIS_TEST_DRIVE;

afterEach(() => {
  if (originalGitHubActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = originalGitHubActions;
  if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
  else process.env.RUNNER_TEMP = originalRunnerTemp;
  if (originalConfiguredRoot === undefined) delete process.env.IRIS_TEST_TMP_ROOT;
  else process.env.IRIS_TEST_TMP_ROOT = originalConfiguredRoot;
  if (originalTestDrive === undefined) delete process.env.IRIS_TEST_DRIVE;
  else process.env.IRIS_TEST_DRIVE = originalTestDrive;
});

describe('test temporary path policy', () => {
  it('accepts non-C local Windows drives by default and rejects C', () => {
    if (process.platform !== 'win32') return;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.RUNNER_TEMP;
    delete process.env.IRIS_TEST_TMP_ROOT;
    delete process.env.IRIS_TEST_DRIVE;

    expect(resolveTestTempRoot('H:\\workspace', 'vitest')).toBe('H:\\workspace\\.tmp\\vitest');
    expect(resolveTestTempRoot('D:\\Github\\Iris', 'vitest')).toBe('D:\\Github\\Iris\\.tmp\\vitest');
    expect(() => assertTestPath('C:\\temp', 'Test files')).toThrow('must not use C:');
  });

  it('enforces an explicit IRIS_TEST_DRIVE pin when configured locally', () => {
    if (process.platform !== 'win32') return;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.RUNNER_TEMP;
    delete process.env.IRIS_TEST_TMP_ROOT;
    process.env.IRIS_TEST_DRIVE = 'H';

    expect(resolveTestTempRoot('H:\\workspace', 'vitest')).toBe('H:\\workspace\\.tmp\\vitest');
    expect(() => assertTestPath('D:\\temp', 'Test files')).toThrow('must use H:');
  });

  it('accepts a non-C GitHub runner path without weakening the C guard', () => {
    if (process.platform !== 'win32') return;
    process.env.GITHUB_ACTIONS = 'true';
    process.env.RUNNER_TEMP = 'D:\\a\\_temp';
    delete process.env.IRIS_TEST_TMP_ROOT;
    delete process.env.IRIS_TEST_DRIVE;

    expect(resolveTestTempRoot('D:\\a\\Iris\\Iris', 'vitest')).toBe('D:\\a\\_temp\\iris-tests\\vitest');
    expect(() => assertTestPath('C:\\runner-temp', 'Runner files')).toThrow('must not use C:');
  });
});
