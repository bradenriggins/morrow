const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CODEX_BUNDLE_IDENTIFIER = "com.openai.codex";

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

async function detectAssistantCommand({
  command,
  platform = process.platform,
  home = os.homedir(),
  pathValue = process.env.PATH,
  realpath = fs.realpath,
  stat = fs.stat,
  access = fs.access,
  probe,
}) {
  if (typeof command !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(command) || typeof probe !== "function") {
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
        if (await probe(resolved) === true) return true;
      } catch {}
    }
  }
  return false;
}

module.exports = {
  CODEX_BUNDLE_IDENTIFIER,
  assistantApplicationNames,
  commandDirectories,
  detectAssistantApplication,
  detectAssistantCommand,
};
