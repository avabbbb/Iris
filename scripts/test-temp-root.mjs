import { parse, resolve } from 'node:path';

const isGitHubActions = () => process.env.GITHUB_ACTIONS === 'true';

function requiredDriveRoot() {
  const configured = process.env.IRIS_TEST_DRIVE?.trim().replace(/:?\\?$/, '').toUpperCase();
  if (!configured || !/^[A-Z]$/.test(configured)) return null;
  return `${configured}:\\`;
}

export function assertTestPath(targetPath, label = 'Test path') {
  const absolutePath = resolve(targetPath);
  if (process.platform !== 'win32') return absolutePath;

  const driveRoot = parse(absolutePath).root.toUpperCase();
  if (driveRoot === 'C:\\') throw new Error(`${label} must not use C: ${absolutePath}`);
  const pinnedRoot = !isGitHubActions() ? requiredDriveRoot() : null;
  if (pinnedRoot && driveRoot !== pinnedRoot) {
    throw new Error(`${label} must use ${pinnedRoot.slice(0, 2)} for local Windows runs: ${absolutePath}`);
  }
  return absolutePath;
}

export function resolveTestTempRoot(projectDir, leaf = '') {
  const configuredRoot = process.env.IRIS_TEST_TMP_ROOT?.trim();
  const runnerTemp = isGitHubActions() ? process.env.RUNNER_TEMP?.trim() : '';
  // GitHub's checkout directory can carry broad inherited ACLs. Keep test
  // discovery records and their ACL snapshots in the runner-owned temp area.
  const baseRoot = configuredRoot
    ? resolve(configuredRoot)
    : runnerTemp
      ? resolve(runnerTemp, 'iris-tests')
      : resolve(projectDir, '.tmp');
  return assertTestPath(resolve(baseRoot, leaf), 'Test temporary files');
}
