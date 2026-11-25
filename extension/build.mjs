import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(extensionRoot, '..');
const output = resolve(workspaceRoot, 'dist-extension');
if (!output.startsWith(`${workspaceRoot}${sep}`)) throw new Error('Extension output escaped the workspace');

console.log('Building thin Iris Browser Import extension…');
if (existsSync(output)) rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const entry of ['manifest.json', '_locales', 'background', 'popup', 'options', 'icons']) {
  cpSync(resolve(extensionRoot, entry), resolve(output, entry), { recursive: true });
}

console.log(`Extension ready: ${output}`);
console.log('Load this directory from chrome://extensions or edge://extensions.');
