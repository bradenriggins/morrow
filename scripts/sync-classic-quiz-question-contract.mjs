import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = resolve(ROOT, "packages/canvas-api-catalog/src/classic-quiz-question-contract.ts");
const TARGET_PATH = resolve(ROOT, "connector/extension/src/canvas-content.js");
const START = "  /* BEGIN GENERATED CLASSIC QUIZ QUESTION CONTRACT */";
const END = "  /* END GENERATED CLASSIC QUIZ QUESTION CONTRACT */";

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => line ? `${prefix}${line}` : "").join("\n");
}

export function generatedClassicQuizQuestionContract() {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const scriptSource = source.replace(/^export\s+(?=(?:function|const|type|interface)\b)/gm, "");
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
  if (errors.length > 0) throw new Error(`Classic Quiz question contract transpile failed with ${errors.length} errors.`);
  return [
    START,
    `  // Generated from packages/canvas-api-catalog/src/classic-quiz-question-contract.ts sha256:${digest}`,
    indent(transpiled.outputText.trim(), 2),
    END,
  ].join("\n");
}

export function synchronizedCanvasContent() {
  const target = readFileSync(TARGET_PATH, "utf8");
  const start = target.indexOf(START);
  const end = target.indexOf(END);
  if (start < 0 || end < start || target.indexOf(START, start + START.length) >= 0 || target.indexOf(END, end + END.length) >= 0) {
    throw new Error("canvas-content.js needs exactly one generated Classic Quiz question contract region.");
  }
  return `${target.slice(0, start)}${generatedClassicQuizQuestionContract()}${target.slice(end + END.length)}`;
}

export function syncClassicQuizQuestionContract({ check = false } = {}) {
  const before = readFileSync(TARGET_PATH, "utf8");
  const after = synchronizedCanvasContent();
  if (check) {
    if (before !== after) throw new Error("canvas-content.js Classic Quiz question contract is stale. Run node scripts/sync-classic-quiz-question-contract.mjs.");
    return { check: true, target: TARGET_PATH };
  }
  if (before !== after) writeFileSync(TARGET_PATH, after);
  return { check: false, target: TARGET_PATH };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(syncClassicQuizQuestionContract({ check: process.argv.includes("--check") })));
}
