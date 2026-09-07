const path = require("node:path");

const CODEX_BUNDLE_IDENTIFIER = "com.openai.codex";

function assistantApplicationNames(assistantId) {
  switch (assistantId) {
    case "codex": return ["Codex.app", "Codex Web GPT.app"];
    case "claude-code": return ["Claude Code.app", "Claude.app"];
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
      if (await exists(path.join(directory, name))) return true;
    }
  }
  if (assistantId !== "codex") return false;
  for (const directory of applicationDirectories) {
    if (typeof directory !== "string" || directory.length === 0) continue;
    const candidate = path.join(directory, "ChatGPT.app");
    if (!await exists(candidate)) continue;
    try {
      if (await readBundleIdentifier(candidate) === CODEX_BUNDLE_IDENTIFIER) return true;
    } catch {}
  }
  return false;
}

module.exports = { CODEX_BUNDLE_IDENTIFIER, assistantApplicationNames, detectAssistantApplication };
