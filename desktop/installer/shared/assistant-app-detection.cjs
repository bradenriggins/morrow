const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createBoundedCommandReader } = require("./process-lifetime.cjs");

const CODEX_BUNDLE_IDENTIFIER = "com.openai.codex";
const WINDOWS_COMMAND_SHIM_ENV = "MORROW_ASSISTANT_COMMAND_SHIM";
const WINDOWS_COMMAND_SHIM_TIMEOUT_MS = 2_000;
const WINDOWS_COMMAND_SHIM_MAX_BYTES = 4 * 1024;
const WINDOWS_COMMAND_SHIM_KILL_GRACE_MS = 500;
const WINDOWS_COMMAND_SHIM_FINAL_GRACE_MS = 500;

function assistantApplicationNames(assistantId) {
  switch (assistantId) {
    case "codex": return ["Codex.app", "Codex Web GPT.app", "ChatGPT.app"];
    default: return [];
  }
}

async function detectAssistantApplication({ assistantId, applicationDirectories, exists, readBundleIdentifier }) {
  if (!Array.isArray(applicationDirectories) || typeof exists !== "function" || typeof readBundleIdentifier !== "function") {
    throw new TypeError("Assistant application detection requires application directories and readers.");
  }
  for (const directory of applicationDirectories) {
    if (typeof directory !== "string" || directory.length === 0) continue;
    for (const name of assistantApplicationNames(assistantId)) {
      const candidate = path.join(directory, name);
      if (!await exists(candidate)) continue;
      try {
        if (await readBundleIdentifier(candidate) === CODEX_BUNDLE_IDENTIFIER) return true;
      } catch {}
    }
  }
  return false;
}

function commandDirectories({ platform, home, pathValue }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const fixed = platform === "win32"
    ? [pathApi.join(home, ".local", "bin")]
    : [pathApi.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  const fromPath = String(pathValue || "").split(pathApi.delimiter)
    .filter((entry) => entry.length > 0 && pathApi.isAbsolute(entry));
  return [...new Set([...fixed.filter((entry) => pathApi.isAbsolute(entry)), ...fromPath])];
}

/**
 * `cmd.exe` receives one fixed command string. The absolute shim path stays in
 * an environment value, so spaces and command metacharacters never become
 * command syntax. Delayed expansion is disabled so exclamation marks stay in
 * the path.
 */
function windowsCommandShimInvocation(candidate, {
  environment = process.env,
  comSpec = process.env.ComSpec || path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
} = {}) {
  if (typeof candidate !== "string" || !path.win32.isAbsolute(candidate) || candidate.includes("\0")
    || typeof comSpec !== "string" || !path.win32.isAbsolute(comSpec)) {
    throw new TypeError("Windows assistant command shim paths must be absolute.");
  }
  return Object.freeze({
    executable: comSpec,
    argumentsValue: Object.freeze(["/d", "/s", "/v:off", "/c", `""%${WINDOWS_COMMAND_SHIM_ENV}%" --version"`]),
    environment: Object.freeze({ ...environment, [WINDOWS_COMMAND_SHIM_ENV]: candidate }),
  });
}

async function probeWindowsCommandShim(candidate, options = {}) {
  const invocation = windowsCommandShimInvocation(candidate, options);
  const spawnProcess = options.spawnProcess || spawn;
  const readCommand = createBoundedCommandReader({
    platform: "win32",
    spawnProcess: (executable, argumentsValue, spawnOptions) => spawnProcess(executable, argumentsValue, {
      ...spawnOptions,
      env: invocation.environment,
    }),
    ...(typeof options.terminateTree === "function" ? { terminateTree: options.terminateTree } : {}),
  });
  const output = await readCommand(invocation.executable, invocation.argumentsValue, {
    timeoutMs: options.timeoutMs ?? WINDOWS_COMMAND_SHIM_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? WINDOWS_COMMAND_SHIM_MAX_BYTES,
    killGraceMs: options.killGraceMs ?? WINDOWS_COMMAND_SHIM_KILL_GRACE_MS,
    finalGraceMs: options.finalGraceMs ?? WINDOWS_COMMAND_SHIM_FINAL_GRACE_MS,
  });
  return output !== null;
}

async function detectAssistantCommand({
  command,
  platform = process.platform,
  home = os.homedir(),
  pathValue = process.env.PATH,
  realpath = fs.realpath,
  stat = fs.stat,
  access = fs.access,
  probe,
  probeWindowsShim = probeWindowsCommandShim,
}) {
  if (typeof command !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(command)
    || typeof probe !== "function" || typeof probeWindowsShim !== "function") {
    throw new TypeError("Assistant command detection requires a command and version probe.");
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  for (const directory of commandDirectories({ platform, home, pathValue })) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      try {
        const resolved = await realpath(candidate);
        const info = await stat(resolved);
        if (!info.isFile()) continue;
        if (platform !== "win32") await access(resolved, fs.constants.X_OK);
        const available = platform === "win32" && name.toLowerCase().endsWith(".cmd")
          ? await probeWindowsShim(resolved)
          : await probe(resolved);
        if (available === true) return true;
      } catch {}
    }
  }
  return false;
}

const GEMINI_CLI_PACKAGE = "@google/gemini-cli";
const PACKAGE_MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * Whether one resolved `gemini` command belongs to the Gemini CLI package,
 * read from that package's own package.json. An npm or Homebrew link resolves
 * into the package, and npm's Windows command files sit beside the
 * node_modules folder they start.
 */
async function geminiCliPackageFound(resolved, { platform = process.platform, readFile = fs.readFile, stat = fs.stat } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates = [];
  let directory = pathApi.dirname(resolved);
  for (let depth = 0; depth < 3; depth += 1) {
    candidates.push(pathApi.join(directory, "package.json"));
    const parent = pathApi.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  candidates.push(pathApi.join(pathApi.dirname(resolved), "node_modules", "@google", "gemini-cli", "package.json"));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size > PACKAGE_MANIFEST_MAX_BYTES) continue;
      const manifest = JSON.parse(await readFile(candidate, "utf8"));
      if (manifest?.name === GEMINI_CLI_PACKAGE && typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version)) return true;
    } catch {}
  }
  return false;
}

/**
 * Finds Gemini CLI without running it. `gemini --version` registers the folder
 * it runs in as a Gemini project in the person's own ~/.gemini folder, and its
 * first start can take longer than a detection probe waits.
 */
async function detectGeminiCli(options = {}) {
  const platform = options.platform || process.platform;
  const probe = (candidate) => geminiCliPackageFound(candidate, { platform, readFile: options.readFile, stat: options.stat });
  return detectAssistantCommand({ ...options, command: "gemini", platform, probe, probeWindowsShim: probe });
}

module.exports = {
  CODEX_BUNDLE_IDENTIFIER,
  assistantApplicationNames,
  commandDirectories,
  detectAssistantApplication,
  detectAssistantCommand,
  detectGeminiCli,
  probeWindowsCommandShim,
  WINDOWS_COMMAND_SHIM_ENV,
  windowsCommandShimInvocation,
};
