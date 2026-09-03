import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LEGACY_BRIDGE_OVERLAY_FILES,
  unpatchBackground,
} from './lib/legacy-bridge-overlay.mjs';

const legacyRootValue = String(process.env.MORROW_LEGACY_ROOT || '').trim();
if (!legacyRootValue) throw new Error('MORROW_LEGACY_ROOT is required');
const legacyRoot = resolve(legacyRootValue);
const extensionRoot = resolve(legacyRoot, 'extension');
const backgroundPath = resolve(extensionRoot, 'background.js');
const source = await readFile(backgroundPath, 'utf8');
await writeFile(backgroundPath, unpatchBackground(source));
for (const filename of [
  ...LEGACY_BRIDGE_OVERLAY_FILES,
  'morrow-gateway-bridge.local.js',
]) {
  await rm(resolve(extensionRoot, filename), { force: true });
}
process.stdout.write('Morrow legacy bridge overlay removed.\n');
