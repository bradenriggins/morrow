import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_BRIDGE_OVERLAY_FILES,
  patchBackground,
  renderLocalConfig,
} from './lib/legacy-bridge-overlay.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const legacyRoot = resolve(required('MORROW_LEGACY_ROOT'));
const catalogPath = resolve(required('MORROW_LEGACY_CATALOG_PATH'));
const token = required('MORROW_LEGACY_BRIDGE_TOKEN');
const expectedRevision = String(
  process.env.MORROW_LEGACY_EXPECTED_REVISION || '7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4',
).trim();
const port = Number(process.env.MORROW_LEGACY_BRIDGE_PORT || 32145);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MORROW_LEGACY_BRIDGE_PORT is invalid');
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function git(...args) {
  return execFileSync('git', ['-C', legacyRoot, ...args], { encoding: 'utf8' }).trim();
}

const actualRevision = git('rev-parse', 'HEAD');
if (actualRevision !== expectedRevision) {
  throw new Error(`Morrow legacy checkout is ${actualRevision}; expected ${expectedRevision}`);
}
const status = git('status', '--porcelain=v1', '--untracked-files=no');
if (status && !status.split('\n').every((line) => line.endsWith(' extension/background.js'))) {
  throw new Error(`Morrow legacy has unrelated tracked changes:\n${status}`);
}

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (
  catalog?.schema !== 'morrow.source-catalog.v1'
  || catalog?.source?.id !== 'morrow-legacy'
  || catalog?.source?.revision !== expectedRevision
  || !/^[0-9a-f]{64}$/.test(String(catalog?.digest || ''))
) throw new Error('MORROW_LEGACY_CATALOG_PATH is not the pinned Morrow legacy source catalog');

const extensionRoot = resolve(legacyRoot, 'extension');
const backgroundPath = resolve(extensionRoot, 'background.js');
const localConfigPath = resolve(extensionRoot, 'morrow-gateway-bridge.local.js');
const integrationRoot = resolve(ROOT, 'integrations/morrow-legacy/extension');
const original = await readFile(backgroundPath, 'utf8');
const patched = patchBackground(original);
await mkdir(extensionRoot, { recursive: true });
for (const filename of LEGACY_BRIDGE_OVERLAY_FILES) {
  await copyFile(resolve(integrationRoot, filename), resolve(extensionRoot, filename));
}
await writeFile(localConfigPath, renderLocalConfig({
  url: `ws://127.0.0.1:${port}/morrow-bridge/v1`,
  token,
  donorRevision: expectedRevision,
  catalogDigest: catalog.digest,
}), { mode: 0o600 });
await writeFile(backgroundPath, patched);

const excludePath = resolve(legacyRoot, '.git/info/exclude');
let exclude = await readFile(excludePath, 'utf8').catch(() => '');
for (const entry of [
  ...LEGACY_BRIDGE_OVERLAY_FILES.map((filename) => `/extension/${filename}`),
  '/extension/morrow-gateway-bridge.local.js',
]) {
  if (!exclude.split(/\r?\n/).includes(entry)) {
    exclude += `${exclude.endsWith('\n') || !exclude ? '' : '\n'}${entry}\n`;
  }
}
await writeFile(excludePath, exclude);

process.stdout.write([
  'Morrow legacy bridge overlay installed.',
  `revision=${expectedRevision}`,
  `catalog=${catalog.digest}`,
  `url=ws://127.0.0.1:${port}/morrow-bridge/v1`,
  'Reload the unpacked extension in Chrome after starting @morrow/legacy-bridge-mcp.',
  'The tracked background.js change is deliberate and removable with pnpm bridge:legacy:remove.',
  '',
].join('\n'));
