import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const PNPM_ENTRY = /^pnpm\.(?:c|m)?js$/i;

const hostFileSystem = Object.freeze({
  isFile(path) {
    try { return statSync(path).isFile(); } catch { return false; }
  },
  readText(path) {
    return readFileSync(path, "utf8");
  },
});

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The JavaScript file a Windows command shim starts. npm's cmd-shim and pnpm's
 * own shims both name it as one quoted path, relative to the shim's folder
 * (`%~dp0` or `%dp0%`) or absolute.
 */
function shimEntry(shimPath, text) {
  const folder = `${win32.dirname(shimPath)}\\`;
  const entries = new Set();
  for (const match of text.matchAll(/"([^"\r\n]+\.(?:c|m)?js)"/gi)) {
    const named = match[1].replace(/%~dp0|%dp0%/gi, folder);
    if (!win32.isAbsolute(named)) continue;
    entries.add(win32.resolve(named));
  }
  if (entries.size !== 1) throw new Error(`pnpm could not start: ${shimPath} does not name one pnpm program.`);
  return [...entries][0];
}

/**
 * How to start pnpm with no shell. On Windows pnpm is usually a .cmd shim, and
 * Node starts only a real executable when no shell is used (a .cmd or .bat is
 * refused), so the shim's JavaScript entry is started with this Node instead.
 * The lookup follows PATH and PATHEXT in the order Windows uses, so it starts
 * the same pnpm a terminal would.
 */
export function pnpmCommand({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  fileSystem = hostFileSystem,
} = {}) {
  if (platform !== "win32") return { command: "pnpm", args: [] };
  const running = environmentValue(env, "NPM_EXECPATH");
  if (typeof running === "string" && win32.isAbsolute(running) && fileSystem.isFile(running)) {
    const name = win32.basename(running);
    if (PNPM_ENTRY.test(name)) return { command: execPath, args: [running] };
    if (/^pnpm\.exe$/i.test(name)) return { command: running, args: [] };
  }
  const extensions = String(environmentValue(env, "PATHEXT") || DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  const folders = String(environmentValue(env, "PATH") || "")
    .split(";")
    .map((folder) => folder.trim().replace(/^"(.*)"$/, "$1"))
    .filter((folder) => folder && win32.isAbsolute(folder));
  for (const folder of folders) {
    for (const extension of extensions) {
      const candidate = win32.join(folder, `pnpm${extension}`);
      if (!fileSystem.isFile(candidate)) continue;
      if (extension === ".exe" || extension === ".com") return { command: candidate, args: [] };
      if (extension !== ".cmd" && extension !== ".bat") continue;
      const entry = shimEntry(candidate, fileSystem.readText(candidate));
      if (!PNPM_ENTRY.test(win32.basename(entry)) || !fileSystem.isFile(entry)) {
        throw new Error(`pnpm could not start: ${candidate} names ${entry}, which is not a pnpm program on this computer.`);
      }
      return { command: execPath, args: [entry] };
    }
  }
  throw new Error("pnpm could not start: no pnpm program was found on PATH.");
}
