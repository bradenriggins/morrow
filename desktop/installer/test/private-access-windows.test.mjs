import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyWindowsPrivateAccess,
  hardenPrivateDirectory,
  privateDirectoryAccessAccepted,
  privateFileAccessAccepted,
  privateFilesAccessAccepted,
} from "../../packages/gateway-core/dist/private-file-access.js";

const onWindows = process.platform === "win32";

// Real PowerShell and real access control lists: a question that names
// several paths gives each one the verdict it gets when asked alone.
test("a Windows question about several paths answers each as it would alone: private, shared, missing, and a link",
  { skip: onWindows ? false : "needs a Windows host" }, async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "morrow-private-access-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "private");
    await mkdir(directory);
    assert.equal(hardenPrivateDirectory(directory), true, "the fixture folder is private");
    const privateFile = path.join(directory, "credential.secret");
    const sharedFile = path.join(directory, "shared.secret");
    const missing = path.join(directory, "missing.secret");
    const link = path.join(root, "linked");
    await writeFile(privateFile, "secret\n");
    await writeFile(sharedFile, "shared\n");
    // Everyone (S-1-1-0) may read the shared file.
    execFileSync("icacls", [sharedFile, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore", windowsHide: true });
    await symlink(directory, link, "junction");

    const paths = [privateFile, sharedFile, missing, directory];
    const alone = paths.map((candidate) => classifyWindowsPrivateAccess([candidate])[0]);
    const together = classifyWindowsPrivateAccess(paths);
    assert.deepEqual(together, alone);
    assert.deepEqual(together, ["private", "additional_principal_access_allow", "unavailable", "private"]);

    assert.equal(privateFileAccessAccepted(privateFile, 0o100600), true);
    assert.equal(privateFileAccessAccepted(sharedFile, 0o100600), false);
    assert.equal(privateFileAccessAccepted(missing, 0o100600), false);
    assert.equal(privateFileAccessAccepted(path.join(link, "credential.secret"), 0o100600), false);
    assert.deepEqual(privateFilesAccessAccepted([
      { path: privateFile, mode: 0o100600 },
      { path: sharedFile, mode: 0o100600 },
      { path: missing, mode: 0o100600 },
    ]), [true, false, false]);
    assert.equal(privateDirectoryAccessAccepted(directory), true);
    assert.equal(privateDirectoryAccessAccepted(link), false);
  });
