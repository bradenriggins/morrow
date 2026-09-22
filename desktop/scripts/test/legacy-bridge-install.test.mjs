import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGACY_BRIDGE_OVERLAY_FILES } from '../lib/legacy-bridge-overlay.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BACKGROUND = `import { recoverSignedCourseReadinessRootCheckpoint } from './domains/launch/course-health-journey.js';\n\nif (requiredAuthoritiesReady) {\n  try {\n    setupMessageRouter();\n  } catch (err) {}\n}\n`;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

async function worktreeFixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'morrow-legacy-install-worktree-'));
  const repository = resolve(directory, 'repository');
  const extension = resolve(repository, 'extension');
  const worktree = resolve(directory, 'worktree');
  const catalogPath = resolve(directory, 'catalog.json');
  await mkdir(extension, { recursive: true });
  await writeFile(resolve(extension, 'background.js'), BACKGROUND);
  git(repository, 'init', '--quiet');
  git(repository, 'config', 'user.email', 'morrow-test@example.test');
  git(repository, 'config', 'user.name', 'Morrow Test');
  git(repository, 'add', 'extension/background.js');
  git(repository, 'commit', '--quiet', '-m', 'fixture');
  git(repository, 'worktree', 'add', '--quiet', '-b', 'install-test', worktree, 'HEAD');
  const revision = git(worktree, 'rev-parse', 'HEAD');
  await writeFile(catalogPath, `${JSON.stringify({
    schema: 'morrow.source-catalog.v1',
    source: { id: 'morrow-legacy', revision },
    digest: 'a'.repeat(64),
  })}\n`);
  const gitExcludeValue = git(worktree, 'rev-parse', '--git-path', 'info/exclude');
  const excludePath = isAbsolute(gitExcludeValue) ? gitExcludeValue : resolve(worktree, gitExcludeValue);
  return { directory, repository, worktree, catalogPath, revision, excludePath };
}

function install(fixture) {
  return execFileSync(process.execPath, [resolve(ROOT, 'scripts/install-morrow-legacy-bridge.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MORROW_LEGACY_ROOT: fixture.worktree,
      MORROW_LEGACY_CATALOG_PATH: fixture.catalogPath,
      MORROW_LEGACY_BRIDGE_TOKEN: 't'.repeat(48),
      MORROW_LEGACY_EXPECTED_REVISION: fixture.revision,
    },
    stdio: 'pipe',
  });
}

test('legacy Bridge reinstall replaces a broadly readable bearer-token config with one private file', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'morrow-legacy-install-'));
  const donor = resolve(directory, 'donor');
  const extension = resolve(donor, 'extension');
  const config = resolve(extension, 'morrow-gateway-bridge.local.js');
  const catalogPath = resolve(directory, 'catalog.json');
  try {
    await mkdir(extension, { recursive: true });
    await writeFile(resolve(extension, 'background.js'), BACKGROUND);
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
    await writeFile(config, 'export const leaked = true;\n', { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(config, 0o644);

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

    const installed = await readFile(config, 'utf8');
    assert.match(installed, /"token": "t{48}"/u);
    assert.doesNotMatch(installed, /leaked/u);
    if (process.platform !== 'win32') assert.equal((await stat(config)).mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy Bridge install resolves the repository exclude path from a real Git worktree', async () => {
  const fixture = await worktreeFixture();
  try {
    const dotGit = await stat(resolve(fixture.worktree, '.git'));
    assert.equal(dotGit.isFile(), true);
    install(fixture);

    const extension = resolve(fixture.worktree, 'extension');
    assert.match(await readFile(resolve(extension, 'background.js'), 'utf8'), /installMorrowGatewayBridge/u);
    for (const filename of LEGACY_BRIDGE_OVERLAY_FILES) {
      assert.deepEqual(
        await readFile(resolve(extension, filename)),
        await readFile(resolve(ROOT, 'integrations/morrow-legacy/extension', filename)),
      );
    }
    const configPath = resolve(extension, 'morrow-gateway-bridge.local.js');
    assert.match(await readFile(configPath, 'utf8'), /"token": "t{48}"/u);
    if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o077, 0);
    const exclude = await readFile(fixture.excludePath, 'utf8');
    for (const filename of [...LEGACY_BRIDGE_OVERLAY_FILES, 'morrow-gateway-bridge.local.js']) {
      assert.match(exclude, new RegExp(`/extension/${filename.replaceAll('.', '\\.')}`));
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('legacy Bridge install preserves every destination when exclude admission fails', async () => {
  const fixture = await worktreeFixture();
  try {
    const extension = resolve(fixture.worktree, 'extension');
    const paths = [...LEGACY_BRIDGE_OVERLAY_FILES, 'morrow-gateway-bridge.local.js'];
    for (const filename of paths) await writeFile(resolve(extension, filename), `preserve:${filename}\n`);
    const before = new Map(await Promise.all(paths.map(async (filename) => [
      filename,
      { bytes: await readFile(resolve(extension, filename)), mode: (await stat(resolve(extension, filename))).mode },
    ])));
    const backgroundBefore = await readFile(resolve(extension, 'background.js'));
    const outsidePath = resolve(fixture.directory, 'outside-exclude');
    await writeFile(outsidePath, 'preserve outside exclude\n');
    await rm(fixture.excludePath);
    await symlink(outsidePath, fixture.excludePath);

    assert.throws(() => install(fixture));
    assert.deepEqual(await readFile(resolve(extension, 'background.js')), backgroundBefore);
    for (const [filename, saved] of before) {
      assert.deepEqual(await readFile(resolve(extension, filename)), saved.bytes);
      assert.equal((await stat(resolve(extension, filename))).mode, saved.mode);
    }
    assert.equal(await readFile(outsidePath, 'utf8'), 'preserve outside exclude\n');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
