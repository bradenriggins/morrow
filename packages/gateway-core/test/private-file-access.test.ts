import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenPrivateDirectory, privateDirectoryAccessAccepted, privateFileAccessAccepted, type WindowsPrivateFileAccessClassification } from "../src/private-file-access.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ readonly root: string; readonly file: string }> {
  const root = await mkdtemp(join(tmpdir(), "morrow-private-file-"));
  roots.push(root);
  const parent = join(root, "private");
  const file = join(parent, "credential.secret");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await writeFile(file, "secret\n", { mode: 0o600 });
  return { root, file };
}

describe("privateFileAccessAccepted", () => {
  it("requires POSIX private directory mode bits and trusted ancestors", async () => {
    const { root, file } = await fixture();
    const directory = dirname(file);
    expect(privateDirectoryAccessAccepted(directory, { platform: "darwin", trustedRoot: root })).toBe(true);
    await (await import("node:fs/promises")).chmod(directory, 0o750);
    expect(privateDirectoryAccessAccepted(directory, { platform: "darwin", trustedRoot: root })).toBe(false);
  });

  it("requires private Windows directory DACL classification", async () => {
    const { file } = await fixture();
    const directory = dirname(file);
    expect(privateDirectoryAccessAccepted(directory, { platform: "win32", classifyWindowsAcl: () => "private" })).toBe(true);
    expect(privateDirectoryAccessAccepted(directory, { platform: "win32", classifyWindowsAcl: () => "additional_principal_access_allow" })).toBe(false);
  });

  it("hardens one app-owned directory and rejects Windows ACL failures", async () => {
    const { file } = await fixture();
    const directory = dirname(file);
    await (await import("node:fs/promises")).chmod(directory, 0o755);
    expect(hardenPrivateDirectory(directory, { platform: "darwin" })).toBe(true);
    expect(privateDirectoryAccessAccepted(directory, { platform: "darwin" })).toBe(true);
    expect(hardenPrivateDirectory(directory, { platform: "win32", applyWindowsPrivateAcl: () => false, classifyWindowsAcl: () => "private" })).toBe(false);
    expect(hardenPrivateDirectory(directory, { platform: "win32", applyWindowsPrivateAcl: () => true, classifyWindowsAcl: () => "additional_principal_access_allow" })).toBe(false);
  });

  it("requires POSIX private mode bits", async () => {
    const { file } = await fixture();
    expect(privateFileAccessAccepted(file, 0o100600, { platform: "darwin" })).toBe(true);
    expect(privateFileAccessAccepted(file, 0o100640, { platform: "linux" })).toBe(false);
  });

  it("rejects a POSIX parent that another principal can write", async () => {
    const { file } = await fixture();
    await (await import("node:fs/promises")).chmod(dirname(file), 0o733);
    expect(privateFileAccessAccepted(file, 0o100600, { platform: "linux" })).toBe(false);
  });

  it("requires private Windows DACL classification for both the file and its immediate parent", async () => {
    const { file } = await fixture();
    const classified: string[] = [];
    expect(privateFileAccessAccepted(file, 0o100666, {
      platform: "win32",
      classifyWindowsAcl: (path) => { classified.push(path); return "private"; },
    })).toBe(true);
    expect(classified).toEqual([file, dirname(file)]);
  });

  it("fails closed for every non-private Windows ACL classification", async () => {
    const { file } = await fixture();
    const failures: readonly WindowsPrivateFileAccessClassification[] = [
      "additional_principal_access_allow", "untrusted_owner", "unresolved_identity", "unavailable",
    ];
    for (const classification of failures) {
      expect(privateFileAccessAccepted(file, 0o100600, { platform: "win32", classifyWindowsAcl: () => classification })).toBe(false);
    }
  });

  it("rejects a symlinked ancestor under an explicit trusted root", async () => {
    const { root } = await fixture();
    const privateRoot = join(root, "trusted");
    const realCredentials = join(root, "real-credentials");
    const linkedCredentials = join(privateRoot, "credentials");
    const leaf = join(linkedCredentials, "blackboard");
    await mkdir(realCredentials, { recursive: true, mode: 0o700 });
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    await symlink(realCredentials, linkedCredentials);
    await mkdir(leaf, { recursive: true, mode: 0o700 });
    const secret = join(leaf, "credential.secret");
    await writeFile(secret, "secret\n", { mode: 0o600 });
    expect(privateFileAccessAccepted(secret, 0o100600, { platform: "darwin", trustedRoot: privateRoot })).toBe(false);
  });

  it("fails closed when the file or immediate parent does not pass lstat", async () => {
    const { root, file } = await fixture();
    expect(privateFileAccessAccepted(join(root, "missing.secret"), 0o100600, { platform: "win32", classifyWindowsAcl: () => "private" })).toBe(false);
    const linked = join(root, "linked");
    await symlink(join(root, "private"), linked);
    expect(privateFileAccessAccepted(join(linked, "credential.secret"), 0o100600, { platform: "win32", classifyWindowsAcl: () => "private" })).toBe(false);
    expect(file).toContain("credential.secret");
  });
});
