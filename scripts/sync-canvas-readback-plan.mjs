#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const modules = [
  {
    source: resolve(root, "packages/canvas-api-catalog/dist/readback-plan.js"),
    destination: resolve(root, "connector/extension/generated/canvas-readback-plan.js"),
    exportPattern: /export\s+(?:function\s+planBrowserReadback|\{\s*planBrowserReadback\s*\})/,
  },
  {
    source: resolve(root, "packages/canvas-api-catalog/dist/semantic-target.js"),
    destination: resolve(root, "connector/extension/generated/canvas-semantic-target.js"),
    exportPattern: /export\s+(?:function\s+canvasSemanticCourseTarget|\{\s*canvasSemanticCourseTarget\s*[,}])/,
  },
  {
    source: resolve(root, "packages/canvas-api-catalog/dist/operation-admission.js"),
    destination: resolve(root, "connector/extension/generated/canvas-operation-admission.js"),
    exportPattern: /export\s+(?:function\s+canvasOperationAdmission|\{\s*canvasOperationAdmission\s*[,}])/,
  },
];

const results = [];
for (const entry of modules) {
  const sourceBytes = await readFile(entry.source, "utf8").catch(() => {
    throw new Error("Canvas admission modules are not built. Run pnpm --dir packages/canvas-api-catalog build first.");
  });
  const bytes = sourceBytes
    .replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/, "\n")
    .replaceAll('from "./readback-plan.js"', 'from "./canvas-readback-plan.js"')
    .replaceAll('from "./semantic-target.js"', 'from "./canvas-semantic-target.js"');
  if (/\bnode:|\brequire\s*\(/.test(bytes) || !entry.exportPattern.test(bytes)) {
    throw new Error("Generated " + entry.destination + " must remain browser-safe ESM.");
  }
  if (check) {
    const current = await readFile(entry.destination, "utf8").catch(() => "");
    if (current !== bytes) throw new Error("Generated Canvas module is stale: " + entry.destination + ". Run pnpm canvas:readback:sync.");
  } else {
    await writeFile(entry.destination, bytes, "utf8");
  }
  results.push({ source: entry.source, destination: entry.destination, bytes: Buffer.byteLength(bytes) });
}
process.stdout.write(JSON.stringify({ check, modules: results }) + "\n");
