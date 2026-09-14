import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_BRIDGE_OVERLAY_FILES,
  parseLocalConfig,
  unpatchBackground,
} from './legacy-bridge-overlay.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PINNED_DONOR_REVISION = '7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4';
const LOCAL_CONFIG = 'morrow-gateway-bridge.local.js';
const EXCLUDE_ENTRIES = Object.freeze([
  ...LEGACY_BRIDGE_OVERLAY_FILES.map((filename) => `/extension/${filename}`),
  `/extension/${LOCAL_CONFIG}`,
]);

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
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

async function readExactFile(path, { label, maxBytes, optional = false }) {
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
    return {
      bytes: Buffer.concat(chunks, bytes),
      mode: openedAfter.mode & 0o777,
    };
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function textOf(file, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
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

async function publishExclusive(path, bytes, mode) {
  const parent = dirname(path);
  const temporary = resolve(parent, `.${basename(path)}.morrow-remove-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, path);
    await unlink(temporary);
    await syncDirectory(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function withoutOwnedExcludeEntries(source) {
  const lines = source.match(/[^\n]*(?:\n|$)/gu) || [];
  return lines.filter((line) => {
    const value = line.replace(/\r?\n$/u, '');
    return !EXCLUDE_ENTRIES.includes(value);
  }).join('');
}

async function restoreMoved(path, backup, expectedBytes, label) {
  const current = await readExactFile(path, { label, maxBytes: expectedBytes.length + 1, optional: true });
  if (current) {
    if (!current.bytes.equals(expectedBytes)) throw new Error(`${label} rollback found an unknown replacement`);
    await unlink(path);
  }
  await link(backup, path);
  await unlink(backup);
  await syncDirectory(dirname(path));
}

export async function removeLegacyBridgeOverlay({
  legacyRootValue,
  expectedRevision = PINNED_DONOR_REVISION,
  repositoryRoot = ROOT,
  afterMutation = async () => undefined,
} = {}) {
  const suppliedRoot = resolve(String(legacyRootValue || '').trim());
  if (!String(legacyRootValue || '').trim()) throw new Error('MORROW_LEGACY_ROOT is required');
  const legacyRoot = await realpath(suppliedRoot);
  const repositoryTop = await realpath(git(legacyRoot, 'rev-parse', '--show-toplevel'));
  if (repositoryTop !== legacyRoot) throw new Error('MORROW_LEGACY_ROOT must be the exact donor checkout root');
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision) || git(legacyRoot, 'rev-parse', 'HEAD') !== expectedRevision) {
    throw new Error(`Morrow legacy checkout is not the expected revision ${expectedRevision}`);
  }
  git(legacyRoot, 'ls-files', '--error-unmatch', 'extension/background.js');

  const extensionRoot = resolve(legacyRoot, 'extension');
  if (await realpath(extensionRoot) !== extensionRoot) throw new Error('Morrow legacy extension path must be canonical');
  const backgroundPath = resolve(extensionRoot, 'background.js');
  const background = await readExactFile(backgroundPath, { label: 'Morrow legacy background', maxBytes: 4 * 1024 * 1024 });
  const backgroundSource = textOf(background, 'Morrow legacy background');
  const unpatchedSource = unpatchBackground(backgroundSource);
  if (unpatchedSource === backgroundSource) throw new Error('Morrow legacy background does not contain the exact installed overlay');

  const installed = [];
  for (const filename of LEGACY_BRIDGE_OVERLAY_FILES) {
    const sourcePath = resolve(repositoryRoot, 'integrations/morrow-legacy/extension', filename);
    const expected = await readExactFile(sourcePath, { label: `reviewed ${filename}`, maxBytes: 2 * 1024 * 1024 });
    const path = resolve(extensionRoot, filename);
    const actual = await readExactFile(path, { label: `installed ${filename}`, maxBytes: 2 * 1024 * 1024 });
    if (!actual.bytes.equals(expected.bytes)) throw new Error(`installed ${filename} does not match the reviewed overlay bytes`);
    installed.push({ filename, path, expected: actual.bytes });
  }
  const configPath = resolve(extensionRoot, LOCAL_CONFIG);
  const config = await readExactFile(configPath, { label: 'installed legacy Bridge configuration', maxBytes: 16 * 1024 });
  const configValue = parseLocalConfig(textOf(config, 'installed legacy Bridge configuration'));
  if (configValue.donorRevision !== expectedRevision) {
    throw new Error('installed legacy Bridge configuration does not match the donor revision');
  }
  installed.push({ filename: LOCAL_CONFIG, path: configPath, expected: config.bytes });

  const gitPathValue = git(legacyRoot, 'rev-parse', '--git-path', 'info/exclude');
  const excludePath = isAbsolute(gitPathValue) ? gitPathValue : resolve(legacyRoot, gitPathValue);
  const exclude = await readExactFile(excludePath, { label: 'Git exclude file', maxBytes: 1024 * 1024, optional: true });
  const excludeSource = exclude ? textOf(exclude, 'Git exclude file') : null;
  const nextExcludeSource = excludeSource === null ? null : withoutOwnedExcludeEntries(excludeSource);

  const transactionRoot = await mkdtemp(resolve(extensionRoot, '.morrow-legacy-remove-'));
  await chmod(transactionRoot, 0o700);
  const backgroundBackup = resolve(transactionRoot, 'background.js');
  const excludeBackup = `${excludePath}.morrow-remove-${randomUUID()}`;
  const moved = [];
  let backgroundPublished = false;
  let excludeMoved = false;
  let excludePublished = false;
  let committed = false;
  try {
    await rename(backgroundPath, backgroundBackup);
    const movedBackground = await readExactFile(backgroundBackup, { label: 'saved Morrow legacy background', maxBytes: background.bytes.length + 1 });
    if (!movedBackground.bytes.equals(background.bytes)) throw new Error('Morrow legacy background changed before removal');
    await publishExclusive(backgroundPath, Buffer.from(unpatchedSource, 'utf8'), background.mode);
    backgroundPublished = true;
    await afterMutation('background');

    if (exclude && nextExcludeSource !== excludeSource) {
      await rename(excludePath, excludeBackup);
      excludeMoved = true;
      const movedExclude = await readExactFile(excludeBackup, { label: 'saved Git exclude file', maxBytes: exclude.bytes.length + 1 });
      if (!movedExclude.bytes.equals(exclude.bytes)) throw new Error('Git exclude file changed before removal');
      await publishExclusive(excludePath, Buffer.from(nextExcludeSource, 'utf8'), exclude.mode);
      excludePublished = true;
      await afterMutation('exclude');
    }

    for (const entry of installed) {
      const backup = resolve(transactionRoot, entry.filename);
      await rename(entry.path, backup);
      moved.push({ ...entry, backup });
      const saved = await readExactFile(backup, { label: `saved ${entry.filename}`, maxBytes: entry.expected.length + 1 });
      if (!saved.bytes.equals(entry.expected)) throw new Error(`installed ${entry.filename} changed before removal`);
    }
    await syncDirectory(extensionRoot);
    await afterMutation('files');
    committed = true;
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...moved].reverse()) {
      try {
        await restoreMoved(entry.path, entry.backup, entry.expected, `installed ${entry.filename}`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (excludeMoved) {
      try {
        await restoreMoved(
          excludePath,
          excludeBackup,
          Buffer.from(excludePublished ? nextExcludeSource : excludeSource, 'utf8'),
          'Git exclude file',
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await restoreMoved(
        backgroundPath,
        backgroundBackup,
        Buffer.from(backgroundPublished ? unpatchedSource : backgroundSource, 'utf8'),
        'Morrow legacy background',
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Legacy Bridge removal failed and rollback was incomplete');
    throw error;
  } finally {
    if (committed) {
      await rm(transactionRoot, { recursive: true, force: true });
      if (excludeMoved) await rm(excludeBackup, { force: true });
      await syncDirectory(extensionRoot);
      if (excludeMoved) await syncDirectory(dirname(excludePath));
    } else {
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({ legacyRoot, revision: expectedRevision, removedFiles: installed.map((entry) => entry.filename) });
}
