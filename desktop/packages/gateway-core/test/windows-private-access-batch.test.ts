import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyWindowsPrivateAccess,
  hardenPrivateDirectory,
  privateDirectoryAccessAccepted,
  privateFileAccessAccepted,
  privateFilesAccessAccepted,
  withPrivateAccessOperation,
  type WindowsPowerShellResult,
  type WindowsPrivateFileAccessClassification,
} from "../src/private-file-access.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ readonly root: string; readonly directory: string; readonly file: string; readonly other: string }> {
  const root = await mkdtemp(join(tmpdir(), "morrow-windows-batch-"));
  roots.push(root);
  const directory = join(root, "private");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "credential.secret");
  const other = join(directory, "other.secret");
  await writeFile(file, "secret\n", { mode: 0o600 });
  await writeFile(other, "secret\n", { mode: 0o600 });
  return { root, directory, file, other };
}

interface Question {
  readonly paths: readonly string[];
  readonly applies: boolean;
}

/** Decodes the paths one encoded PowerShell question names. */
function question(encodedCommand: string): Question {
  const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
  const list = /\$morrowTargets = @\(([^)]*)\)/u.exec(script);
  if (!list) throw new Error("the question names no paths");
  return {
    paths: [...list[1]!.matchAll(/'([A-Za-z0-9+/=]*)'/gu)].map((match) => Buffer.from(match[1]!, "base64").toString("utf16le")),
    applies: script.includes("SetAccessControl("),
  };
}

/**
 * A Windows host whose answer for each path is fixed. Every question it is
 * asked is recorded, so a test can count PowerShell starts.
 */
function windowsHost(verdictFor: (path: string) => WindowsPrivateFileAccessClassification = () => "private") {
  const questions: Question[] = [];
  const runWindowsPowerShell = (encodedCommand: string): WindowsPowerShellResult => {
    const asked = question(encodedCommand);
    questions.push(asked);
    return { status: 0, stdout: asked.paths.map((path, index) => `${index} ${verdictFor(path)}\r\n`).join("") };
  };
  return { questions, options: { platform: "win32" as const, runWindowsPowerShell } };
}

describe("Windows access questions", () => {
  it("asks about a file and its parent in one PowerShell start", async () => {
    const { file } = await fixture();
    const host = windowsHost();
    expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
    expect(host.questions).toEqual([{ paths: [resolve(file), resolve(dirname(file))], applies: false }]);
  });

  it("asks about several files and their shared parent once, in one PowerShell start", async () => {
    const { file, other } = await fixture();
    const host = windowsHost();
    expect(privateFilesAccessAccepted([{ path: file, mode: 0o100600 }, { path: other, mode: 0o100600 }], host.options)).toEqual([true, true]);
    expect(host.questions).toEqual([{ paths: [resolve(file), resolve(dirname(file)), resolve(other)], applies: false }]);
  });

  it("gives each path the verdict it gets when asked alone: private, shared, missing, and a link", async () => {
    const { root, directory, file, other } = await fixture();
    const missing = join(directory, "missing.secret");
    const linkedDirectory = join(root, "linked");
    await symlink(directory, linkedDirectory);
    const linkedFile = join(linkedDirectory, "credential.secret");
    const shared = resolve(other);
    const host = windowsHost((path) => path === shared ? "additional_principal_access_allow" : path === resolve(missing) ? "unavailable" : "private");

    const alone = [file, other, missing, linkedDirectory].map((path) => classifyWindowsPrivateAccess([path], host.options)[0]);
    const together = classifyWindowsPrivateAccess([file, other, missing, linkedDirectory], host.options);
    expect(together).toEqual(alone);
    expect(together).toEqual(["private", "additional_principal_access_allow", "unavailable", "private"]);

    host.questions.length = 0;
    expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
    expect(privateFileAccessAccepted(other, 0o100600, host.options)).toBe(false);
    expect(privateFileAccessAccepted(missing, 0o100600, host.options)).toBe(false);
    expect(privateFileAccessAccepted(linkedFile, 0o100600, host.options)).toBe(false);
    expect(privateDirectoryAccessAccepted(linkedDirectory, host.options)).toBe(false);
    // A missing path or a link is refused before PowerShell is asked.
    expect(host.questions.map((entry) => entry.paths.map((path) => path.slice(root.length)))).toEqual([
      ["/private/credential.secret", "/private"],
      ["/private/other.secret", "/private"],
    ]);
  });

  it("refuses every path when an answer is malformed, partial, out of order, or the question failed", async () => {
    const { file, other } = await fixture();
    const answers: readonly WindowsPowerShellResult[] = [
      { status: 0, stdout: "private\nprivate\nprivate\n" },
      { status: 0, stdout: "0 private\n1 private\n" },
      { status: 0, stdout: "0 private\n2 private\n1 private\n" },
      { status: 0, stdout: "0 private\n1 private\n2 private\n3 private\n" },
      { status: 0, stdout: "0 private\n1 open\n2 private\n" },
      { status: 0, stdout: "0 private\n01 private\n2 private\n" },
      { status: 0, stdout: "" },
      { status: 1, stdout: "0 private\n1 private\n2 private\n" },
      { status: null, stdout: "0 private\n1 private\n2 private\n" },
    ];
    for (const answer of answers) {
      const options = { platform: "win32" as const, runWindowsPowerShell: () => answer };
      expect(classifyWindowsPrivateAccess([file, dirname(file), other], options)).toEqual(["unavailable", "unavailable", "unavailable"]);
      expect(privateFilesAccessAccepted([{ path: file, mode: 0o100600 }, { path: other, mode: 0o100600 }], options)).toEqual([false, false]);
    }
  });

  it("splits a question that would pass the Windows command-line limit, and refuses a path too long to ask about", async () => {
    const { directory } = await fixture();
    const host = windowsHost();
    const paths = Array.from({ length: 12 }, (_value, index) => join(directory, `${String(index).padStart(2, "0")}-${"x".repeat(900)}`));
    expect(classifyWindowsPrivateAccess(paths, host.options)).toEqual(paths.map(() => "private"));
    expect(host.questions.length).toBeGreaterThan(1);
    expect(host.questions.flatMap((entry) => entry.paths)).toEqual(paths.map((path) => resolve(path)));

    host.questions.length = 0;
    expect(classifyWindowsPrivateAccess([join(directory, "y".repeat(12_000))], host.options)).toEqual(["unavailable"]);
    expect(host.questions).toEqual([]);
  });
});

describe("withPrivateAccessOperation", () => {
  it("asks about each private path once per operation, and again after it", async () => {
    const { directory, file, other } = await fixture();
    const host = windowsHost();
    await withPrivateAccessOperation(async () => {
      expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
      await Promise.resolve();
      expect(privateFileAccessAccepted(other, 0o100600, host.options)).toBe(true);
      expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
      expect(privateDirectoryAccessAccepted(directory, host.options)).toBe(true);
    });
    expect(host.questions.map((entry) => entry.paths)).toEqual([[resolve(file), resolve(directory)], [resolve(other)]]);

    host.questions.length = 0;
    expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
    expect(host.questions.map((entry) => entry.paths)).toEqual([[resolve(file), resolve(directory)]]);
  });

  it("asks again about a path whose answer was not private, a path Morrow hardened, and a path that names a new file", async () => {
    const { directory, file } = await fixture();
    let verdict: WindowsPrivateFileAccessClassification = "additional_principal_access_allow";
    const host = windowsHost((path) => path === resolve(file) ? verdict : "private");
    await withPrivateAccessOperation(async () => {
      expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(false);
      verdict = "private";
      expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
      expect(hardenPrivateDirectory(directory, host.options)).toBe(true);
      expect(privateDirectoryAccessAccepted(directory, host.options)).toBe(true);
      // The replacement exists before the old file goes, so it cannot reuse the old file's number.
      await writeFile(`${file}.new`, "replaced\n", { mode: 0o600 });
      await rename(`${file}.new`, file);
      expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
    });
    expect(host.questions).toEqual([
      { paths: [resolve(file), resolve(directory)], applies: false },
      { paths: [resolve(file)], applies: false },
      { paths: [resolve(directory)], applies: true },
      { paths: [resolve(file)], applies: false },
    ]);
  });

  it("does not answer for work that outlives the operation", async () => {
    const { file } = await fixture();
    const host = windowsHost();
    let later: (() => boolean) | null = null;
    await withPrivateAccessOperation(async () => {
      expect(privateFileAccessAccepted(file, 0o100600, host.options)).toBe(true);
      later = () => privateFileAccessAccepted(file, 0o100600, host.options);
    });
    await new Promise((resolveLater) => setTimeout(resolveLater, 0));
    expect(later!()).toBe(true);
    expect(host.questions).toHaveLength(2);
  });
});
