import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_BRIDGE_OVERLAY_FILES,
  patchBackground,
  renderLocalConfig,
  unpatchBackground,
} from './lib/legacy-bridge-overlay.mjs';
import { replaceExactPrivateStateFile } from '../packages/gateway-core/dist/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const legacyRootValue = resolve(required('MORROW_LEGACY_ROOT'));
const legacyRoot = await realpath(legacyRootValue);
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

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left, right) {
  // ctime can gain precision after a fresh write without any file mutation.
  return sameFile(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

async function inspectFile(path, { label, maxBytes, optional = false }) {
  let handle;
  try {
    const namedBefore = await lstat(path);
    if (!namedBefore.isFile() || namedBefore.nlink !== 1 || namedBefore.size > maxBytes
      || (typeof process.getuid === 'function' && namedBefore.uid !== process.getuid())) {
      throw new Error(`${label} is not one owned bounded regular file`);
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || !sameFile(namedBefore, openedBefore)) {
      throw new Error(`${label} changed before it could be inspected`);
    }
    const chunks = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw new Error(`${label} exceeds its byte limit`);
      chunks.push(Buffer.from(chunk.subarray(0, read.bytesRead)));
    }
    const openedAfter = await handle.stat();
    const namedAfter = await lstat(path);
    if (!sameStableFile(openedBefore, openedAfter) || !sameStableFile(openedAfter, namedAfter)
      || bytes !== openedAfter.size) {
      throw new Error(`${label} changed while it was inspected`);
    }
    return Object.freeze({ exists: true, bytes: Buffer.concat(chunks, bytes), mode: openedAfter.mode & 0o777 });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return Object.freeze({ exists: false, bytes: null, mode: null });
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function textOf(snapshot, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function sameSnapshot(left, right) {
  return left.exists === right.exists
    && (!left.exists || (left.mode === right.mode && left.bytes.equals(right.bytes)));
}

async function assertCurrent(path, expected, label, maxBytes) {
  const current = await inspectFile(path, { label, maxBytes, optional: true });
  if (!sameSnapshot(current, expected)) throw new Error(`${label} changed after installation admission`);
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(path, bytes, mode, expected, label) {
  await assertCurrent(path, expected, label, Math.max(bytes.length, expected.bytes?.length || 0) + 1);
  const temporary = resolve(dirname(path), `.${randomUUID()}.morrow-legacy-install`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
    const installed = await inspectFile(path, { label, maxBytes: bytes.length + 1 });
    if (!installed.bytes.equals(bytes) || installed.mode !== mode) throw new Error(`${label} did not retain exact installed bytes`);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function restoreChange(change) {
  const current = await inspectFile(change.path, {
    label: change.label,
    maxBytes: Math.max(change.after.length, change.before.bytes?.length || 0) + 1,
    optional: true,
  });
  if (sameSnapshot(current, change.before)) return;
  if (!current.exists || !current.bytes.equals(change.after)) {
    throw new Error(`${change.label} rollback found an unknown replacement`);
  }
  if (change.before.exists) {
    await atomicReplace(change.path, change.before.bytes, change.before.mode, current, change.label);
  } else {
    await unlink(change.path);
    await syncDirectory(dirname(change.path));
  }
}

const repositoryTop = await realpath(git('rev-parse', '--show-toplevel'));
if (repositoryTop !== legacyRoot) throw new Error('MORROW_LEGACY_ROOT must be the exact donor worktree root');
const actualRevision = git('rev-parse', 'HEAD');
if (actualRevision !== expectedRevision) {
  throw new Error(`Morrow legacy checkout is ${actualRevision}; expected ${expectedRevision}`);
}
const status = git('status', '--porcelain=v1', '--untracked-files=no');
if (status && !status.split('\n').every((line) => line.endsWith(' extension/background.js'))) {
  throw new Error(`Morrow legacy has unrelated tracked changes:\n${status}`);
}
git('ls-files', '--error-unmatch', 'extension/background.js');

const commonPathValue = git('rev-parse', '--git-common-dir');
const commonPath = await realpath(isAbsolute(commonPathValue) ? commonPathValue : resolve(legacyRoot, commonPathValue));
const gitExcludeValue = git('rev-parse', '--git-path', 'info/exclude');
const excludePath = isAbsolute(gitExcludeValue) ? resolve(gitExcludeValue) : resolve(legacyRoot, gitExcludeValue);
const expectedExcludePath = resolve(commonPath, 'info/exclude');
if (excludePath !== expectedExcludePath || await realpath(dirname(excludePath)) !== dirname(expectedExcludePath)) {
  throw new Error('Git returned an exclude path outside the admitted donor repository');
}

const extensionRoot = resolve(legacyRoot, 'extension');
if (await realpath(extensionRoot) !== extensionRoot) throw new Error('Morrow legacy extension path is not canonical');
await access(extensionRoot, constants.R_OK | constants.W_OK);
await access(dirname(excludePath), constants.R_OK | constants.W_OK);

const catalogSnapshot = await inspectFile(catalogPath, {
  label: 'Morrow legacy source catalog',
  maxBytes: 16 * 1024 * 1024,
});
const catalog = JSON.parse(textOf(catalogSnapshot, 'Morrow legacy source catalog'));
if (
  catalog?.schema !== 'morrow.source-catalog.v1'
  || catalog?.source?.id !== 'morrow-legacy'
  || catalog?.source?.revision !== expectedRevision
  || !/^[0-9a-f]{64}$/.test(String(catalog?.digest || ''))
) throw new Error('MORROW_LEGACY_CATALOG_PATH is not the pinned Morrow legacy source catalog');

const backgroundPath = resolve(extensionRoot, 'background.js');
const backgroundBefore = await inspectFile(backgroundPath, { label: 'Morrow legacy background', maxBytes: 4 * 1024 * 1024 });
const original = textOf(backgroundBefore, 'Morrow legacy background');
const patched = patchBackground(original);
unpatchBackground(patched);

const integrationRoot = resolve(ROOT, 'integrations/morrow-legacy/extension');
const overlays = [];
for (const filename of LEGACY_BRIDGE_OVERLAY_FILES) {
  const source = await inspectFile(resolve(integrationRoot, filename), { label: `reviewed ${filename}`, maxBytes: 2 * 1024 * 1024 });
  const path = resolve(extensionRoot, filename);
  const before = await inspectFile(path, { label: `installed ${filename}`, maxBytes: 2 * 1024 * 1024, optional: true });
  overlays.push({ filename, path, before, after: source.bytes, mode: 0o644 });
}

const localConfigPath = resolve(extensionRoot, 'morrow-gateway-bridge.local.js');
const configBefore = await inspectFile(localConfigPath, {
  label: 'Morrow legacy Bridge configuration',
  maxBytes: 16 * 1024,
  optional: true,
});
const localConfig = Buffer.from(renderLocalConfig({
  url: `ws://127.0.0.1:${port}/morrow-bridge/v1`,
  token,
  donorRevision: expectedRevision,
  catalogDigest: catalog.digest,
}), 'utf8');

const excludeBefore = await inspectFile(excludePath, { label: 'Git exclude file', maxBytes: 1024 * 1024, optional: true });
let exclude = excludeBefore.exists ? textOf(excludeBefore, 'Git exclude file') : '';
for (const entry of [
  ...LEGACY_BRIDGE_OVERLAY_FILES.map((filename) => `/extension/${filename}`),
  '/extension/morrow-gateway-bridge.local.js',
]) {
  if (!exclude.split(/\r?\n/).includes(entry)) {
    exclude += `${exclude.endsWith('\n') || !exclude ? '' : '\n'}${entry}\n`;
  }
}
const excludeAfter = Buffer.from(exclude, 'utf8');

const changes = [];
try {
  if (!excludeBefore.exists || !excludeBefore.bytes.equals(excludeAfter)) {
    const change = { path: excludePath, before: excludeBefore, after: excludeAfter, label: 'Git exclude file' };
    changes.push(change);
    await atomicReplace(excludePath, excludeAfter, excludeBefore.mode ?? 0o644, excludeBefore, change.label);
  }
  for (const overlay of overlays) {
    if (overlay.before.exists && overlay.before.bytes.equals(overlay.after) && overlay.before.mode === overlay.mode) continue;
    const change = { path: overlay.path, before: overlay.before, after: overlay.after, label: `installed ${overlay.filename}` };
    changes.push(change);
    await atomicReplace(overlay.path, overlay.after, overlay.mode, overlay.before, change.label);
  }

  if (!configBefore.exists || !configBefore.bytes.equals(localConfig)
    || (process.platform !== 'win32' && (configBefore.mode & 0o077) !== 0)) {
    const change = { path: localConfigPath, before: configBefore, after: localConfig, label: 'Morrow legacy Bridge configuration' };
    changes.push(change);
    await assertCurrent(localConfigPath, configBefore, change.label, 16 * 1024);
    replaceExactPrivateStateFile(localConfigPath, localConfig, {
      label: change.label,
      minBytes: 1,
      maxBytes: 16 * 1024,
    });
    const installed = await inspectFile(localConfigPath, { label: change.label, maxBytes: 16 * 1024 });
    if (!installed.bytes.equals(localConfig) || (process.platform !== 'win32' && (installed.mode & 0o077) !== 0)) {
      throw new Error('Morrow legacy Bridge configuration did not retain exact private bytes');
    }
  }

  const patchedBytes = Buffer.from(patched, 'utf8');
  if (!backgroundBefore.bytes.equals(patchedBytes)) {
    const change = { path: backgroundPath, before: backgroundBefore, after: patchedBytes, label: 'Morrow legacy background' };
    changes.push(change);
    await atomicReplace(backgroundPath, patchedBytes, backgroundBefore.mode, backgroundBefore, change.label);
  }
} catch (error) {
  const rollbackErrors = [];
  for (const change of [...changes].reverse()) {
    try {
      await restoreChange(change);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  if (rollbackErrors.length) {
    throw new AggregateError([error, ...rollbackErrors], 'Legacy Bridge installation failed and rollback was incomplete');
  }
  throw error;
}

process.stdout.write([
  'Morrow legacy bridge overlay installed.',
  `revision=${expectedRevision}`,
  `catalog=${catalog.digest}`,
  `url=ws://127.0.0.1:${port}/morrow-bridge/v1`,
  'Reload the unpacked extension in Chrome after starting @morrow/legacy-bridge-mcp.',
  'The tracked background.js change is deliberate and removable with pnpm bridge:legacy:remove.',
  '',
].join('\n'));
