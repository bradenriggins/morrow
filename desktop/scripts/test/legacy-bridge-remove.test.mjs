import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGACY_BRIDGE_OVERLAY_FILES } from '../lib/legacy-bridge-overlay.mjs';
import { removeLegacyBridgeOverlay } from '../lib/legacy-bridge-removal.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BACKGROUND = `import { recoverSignedCourseReadinessRootCheckpoint } from './domains/launch/course-health-journey.js';\n\nif (requiredAuthoritiesReady) {\n  try {\n    setupMessageRouter();\n  } catch (err) {}\n}\n`;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function installedFixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'morrow-legacy-remove-'));
  const donor = resolve(directory, 'donor');
  const extension = resolve(donor, 'extension');
  const catalogPath = resolve(directory, 'catalog.json');
  await mkdir(extension, { recursive: true });
  await writeFile(resolve(extension, 'background.js'), BACKGROUND);
  await writeFile(resolve(donor, 'preserve.txt'), 'preserve donor work\n');
  git(donor, 'init', '--quiet');
  git(donor, 'config', 'user.email', 'morrow-test@example.test');
  git(donor, 'config', 'user.name', 'Morrow Test');
  git(donor, 'add', 'extension/background.js');
  git(donor, 'commit', '--quiet', '-m', 'fixture');
  const revision = git(donor, 'rev-parse', 'HEAD');
  await writeFile(catalogPath, `${JSON.stringify({
    schema: 'morrow.source-catalog.v1',
    source: { id: 'morrow-legacy', revision },
    digest: 'a'.repeat(64),
  })}\n`);
  execFileSync(process.execPath, [resolve(ROOT, 'scripts/install-morrow-legacy-bridge.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MORROW_LEGACY_ROOT: donor,
      MORROW_LEGACY_CATALOG_PATH: catalogPath,
      MORROW_LEGACY_BRIDGE_TOKEN: 't'.repeat(48),
      MORROW_LEGACY_EXPECTED_REVISION: revision,
    },
    stdio: 'pipe',
  });
  return { directory, donor, extension, revision };
}

async function savedState(fixture) {
  const files = new Map();
  for (const filename of [...LEGACY_BRIDGE_OVERLAY_FILES, 'morrow-gateway-bridge.local.js']) {
    files.set(filename, await readFile(resolve(fixture.extension, filename)));
  }
  return {
    background: await readFile(resolve(fixture.extension, 'background.js')),
    exclude: await readFile(resolve(fixture.donor, '.git/info/exclude')),
    files,
  };
}

test('legacy Bridge removal preserves donor edits and removes only exact installed bytes', async () => {
  const fixture = await installedFixture();
  try {
    await appendFile(resolve(fixture.extension, 'background.js'), '// preserve user background edit\n');
    execFileSync(process.execPath, [resolve(ROOT, 'scripts/remove-morrow-legacy-bridge.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        MORROW_LEGACY_ROOT: fixture.donor,
        MORROW_LEGACY_EXPECTED_REVISION: fixture.revision,
      },
      stdio: 'pipe',
    });
    assert.equal(await readFile(resolve(fixture.extension, 'background.js'), 'utf8'), `${BACKGROUND}// preserve user background edit\n`);
    assert.equal(await readFile(resolve(fixture.donor, 'preserve.txt'), 'utf8'), 'preserve donor work\n');
    for (const filename of [...LEGACY_BRIDGE_OVERLAY_FILES, 'morrow-gateway-bridge.local.js']) {
      await assert.rejects(readFile(resolve(fixture.extension, filename)), { code: 'ENOENT' });
    }
    const exclude = await readFile(resolve(fixture.donor, '.git/info/exclude'), 'utf8');
    for (const filename of [...LEGACY_BRIDGE_OVERLAY_FILES, 'morrow-gateway-bridge.local.js']) {
      assert.doesNotMatch(exclude, new RegExp(`/extension/${filename.replaceAll('.', '\\.')}`));
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('legacy Bridge removal refuses unknown overlay bytes before changing the donor', async () => {
  const fixture = await installedFixture();
  try {
    const backgroundBefore = await readFile(resolve(fixture.extension, 'background.js'));
    const unknownPath = resolve(fixture.extension, LEGACY_BRIDGE_OVERLAY_FILES[0]);
    await appendFile(unknownPath, '// user-owned unknown bytes\n');
    const unknownBefore = await readFile(unknownPath);
    assert.throws(() => execFileSync(process.execPath, [resolve(ROOT, 'scripts/remove-morrow-legacy-bridge.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        MORROW_LEGACY_ROOT: fixture.donor,
        MORROW_LEGACY_EXPECTED_REVISION: fixture.revision,
      },
      stdio: 'pipe',
    }));
    assert.deepEqual(await readFile(resolve(fixture.extension, 'background.js')), backgroundBefore);
    assert.deepEqual(await readFile(unknownPath), unknownBefore);
    await readFile(resolve(fixture.extension, 'morrow-gateway-bridge.local.js'));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('legacy Bridge removal refuses a linked background without touching its target', async () => {
  const fixture = await installedFixture();
  try {
    const backgroundPath = resolve(fixture.extension, 'background.js');
    const targetPath = resolve(fixture.directory, 'outside.js');
    const source = await readFile(backgroundPath);
    await rename(backgroundPath, targetPath);
    await symlink(targetPath, backgroundPath);
    assert.throws(() => execFileSync(process.execPath, [resolve(ROOT, 'scripts/remove-morrow-legacy-bridge.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        MORROW_LEGACY_ROOT: fixture.donor,
        MORROW_LEGACY_EXPECTED_REVISION: fixture.revision,
      },
      stdio: 'pipe',
    }));
    assert.deepEqual(await readFile(targetPath), source);
    await readFile(resolve(fixture.extension, LEGACY_BRIDGE_OVERLAY_FILES[0]));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('legacy Bridge removal restores every exact file when a later step fails', async () => {
  const fixture = await installedFixture();
  try {
    const before = await savedState(fixture);
    await assert.rejects(removeLegacyBridgeOverlay({
      legacyRootValue: fixture.donor,
      expectedRevision: fixture.revision,
      repositoryRoot: ROOT,
      afterMutation: async (step) => {
        if (step === 'files') throw new Error('injected removal failure');
      },
    }), /injected removal failure/u);
    assert.deepEqual(await readFile(resolve(fixture.extension, 'background.js')), before.background);
    assert.deepEqual(await readFile(resolve(fixture.donor, '.git/info/exclude')), before.exclude);
    for (const [filename, bytes] of before.files) {
      assert.deepEqual(await readFile(resolve(fixture.extension, filename)), bytes);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
