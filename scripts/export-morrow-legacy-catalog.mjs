#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildSourceCatalog } from "../packages/gateway-core/dist/index.js";

const PINNED_COMMIT = "7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4";
const EXPECTED_CANVAS_TOOL_COUNT = 270;

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function capabilityAnnotations(capability) {
  if (!capability || typeof capability !== "object") return {};
  return {
    readOnlyHint: capability.write !== true,
    destructiveHint: capability.destructive === true,
    idempotentHint: false,
    openWorldHint: true,
  };
}

async function importModule(root, relativePath, commit) {
  const url = pathToFileURL(resolve(root, relativePath));
  url.searchParams.set("morrowCatalogCommit", commit);
  return import(url.href);
}

async function main() {
  const legacyRoot = resolve(requiredEnvironment("MORROW_LEGACY_ROOT"));
  const expectedCommit = String(process.env.MORROW_LEGACY_EXPECTED_COMMIT || PINNED_COMMIT).trim();
  const expectedCount = Number(process.env.MORROW_LEGACY_EXPECTED_CANVAS_TOOLS || EXPECTED_CANVAS_TOOL_COUNT);
  const outputPath = resolve(
    process.cwd(),
    String(process.env.MORROW_LEGACY_CATALOG_OUTPUT || "artifacts/catalogs/example-legacy.canvas.json"),
  );

  const commit = git(legacyRoot, "rev-parse", "HEAD");
  assert.equal(commit, expectedCommit, "Legacy Morrow is not at the expected donor commit");
  const trackedStatus = git(legacyRoot, "status", "--porcelain=v1", "--untracked-files=no");
  assert.equal(trackedStatus, "", "Legacy Morrow has tracked changes; refuse a non-reproducible export");

  const toolRegistry = await importModule(legacyRoot, "extension/tool-registry.js", commit);
  const capabilityRegistry = await importModule(legacyRoot, "extension/providers/capability-registry.js", commit);
  const adminTools = await importModule(legacyRoot, "extension/tools/admin-tools.js", commit);

  const definitions = [
    ...toolRegistry.getToolsForProvider("canvas"),
    ...adminTools.ADMIN_TOOL_DEFINITIONS,
  ];
  const capabilityRows = new Map(
    capabilityRegistry.listCapabilities("canvas").map((row) => [row.capability, row]),
  );

  const byName = new Map();
  for (const definition of definitions) {
    const name = String(definition?.name || "").trim();
    assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/, "Invalid Canvas tool name");
    assert.equal(byName.has(name), false, `Duplicate Canvas tool name ${name}`);
    byName.set(name, definition);
  }
  assert.equal(byName.size, expectedCount, "Canvas tool count differs from the expected donor surface");

  const tools = [...byName.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, definition]) => {
      const capability = capabilityRows.get(name) || null;
      return {
        name,
        ...(typeof definition.title === "string" && definition.title.trim()
          ? { title: definition.title.trim() }
          : {}),
        ...(typeof definition.description === "string" && definition.description.trim()
          ? { description: definition.description.trim() }
          : {}),
        inputSchema: definition.input_schema || definition.parameters || {
          type: "object",
          properties: {},
        },
        annotations: capabilityAnnotations(capability),
      };
    });

  const artifact = buildSourceCatalog({
    id: "example-legacy",
    label: "Morrow legacy",
    kind: "donor-export",
    repository: "example-org/example-legacy-source",
    revision: commit,
  }, tools);

  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);

  process.stdout.write([
    `wrote=${outputPath}`,
    `sourceCommit=${commit}`,
    `tools=${artifact.count}`,
    `digest=${artifact.digest}`,
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`[morrow-catalog] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
