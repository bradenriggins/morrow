import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = resolve(ROOT, "packages/mcp-server/src/quiz-item-payload.ts");
const TARGET_PATH = resolve(ROOT, "connector/extension/src/canvas-content.js");
const START = "  /* BEGIN GENERATED NEW QUIZ ITEM PAYLOAD CONTRACT */";
const END = "  /* END GENERATED NEW QUIZ ITEM PAYLOAD CONTRACT */";

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => line ? `${prefix}${line}` : "").join("\n");
}

export function generatedNewQuizItemPayloadContract() {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const scriptSource = source.replace(/^export\s+(?=(?:function|const)\b)/gm, "");
  const transpiled = ts.transpileModule(scriptSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
      removeComments: true,
    },
    fileName: SOURCE_PATH,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(`New Quiz payload contract transpile failed with ${errors.length} errors.`);
  return [
    START,
    `  // Generated from packages/mcp-server/src/quiz-item-payload.ts sha256:${digest}`,
    "  const NEW_QUIZ_ITEM_PAYLOAD_CONTRACT = (() => {",
    indent(transpiled.outputText.trim(), 4),
    "    return Object.freeze({ completeQuizItemPayloadReason, quizItemPayloadMessage });",
    "  })();",
    END,
  ].join("\n");
}

export function synchronizedCanvasContent() {
  const target = readFileSync(TARGET_PATH, "utf8");
  const start = target.indexOf(START);
  const end = target.indexOf(END);
  if (start < 0 || end < start || target.indexOf(START, start + START.length) >= 0 || target.indexOf(END, end + END.length) >= 0) {
    throw new Error("canvas-content.js needs exactly one generated New Quiz payload contract region.");
  }
  return `${target.slice(0, start)}${generatedNewQuizItemPayloadContract()}${target.slice(end + END.length)}`;
}

export function syncNewQuizItemPayloadContract({ check = false } = {}) {
  const before = readFileSync(TARGET_PATH, "utf8");
  const after = synchronizedCanvasContent();
  if (check) {
    if (before !== after) throw new Error("canvas-content.js New Quiz payload contract is stale. Run node scripts/sync-new-quiz-item-payload-contract.mjs.");
    return { check: true, target: TARGET_PATH };
  }
  if (before !== after) writeFileSync(TARGET_PATH, after);
  return { check: false, target: TARGET_PATH };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(syncNewQuizItemPayloadContract({ check: process.argv.includes("--check") })));
}
