#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildSourceCatalog } from "../packages/gateway-core/dist/index.js";
import { sha256Json } from "../packages/contracts/dist/index.js";

const PINNED_COMMIT = "7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4";
const PDF_ESTIMATE_CANVAS_TOOL_COUNT = 270;

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveLegacyRoot() {
  if (process.env.MORROW_LEGACY_ROOT?.trim()) return resolve(process.env.MORROW_LEGACY_ROOT);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  const blocks = worktrees.trim().split(/\n\n+/);
  for (const block of blocks) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const commit = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1];
    if (path && commit === PINNED_COMMIT) return resolve(path);
  }
  throw new Error("MORROW_LEGACY_ROOT is required when the pinned donor worktree is not present");
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function assertPinnedSourceFiles(root, commit, relativePaths) {
  for (const relativePath of relativePaths) {
    const expectedBlob = git(root, "rev-parse", `${commit}:${relativePath}`);
    const actualBlob = execFileSync("git", ["hash-object", resolve(root, relativePath)], {
      encoding: "utf8",
    }).trim();
    assert.equal(actualBlob, expectedBlob, `Legacy Morrow source differs from ${commit}:${relativePath}`);
  }
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
  const legacyRoot = resolveLegacyRoot();
  const expectedCommit = String(process.env.MORROW_LEGACY_EXPECTED_COMMIT || PINNED_COMMIT).trim();
  const expectedCount = process.env.MORROW_LEGACY_EXPECTED_CANVAS_TOOLS === undefined
    ? undefined
    : Number(process.env.MORROW_LEGACY_EXPECTED_CANVAS_TOOLS);
  const outputPath = resolve(
    process.cwd(),
    String(process.env.MORROW_LEGACY_CATALOG_OUTPUT || "artifacts/catalogs/example-legacy.canvas.json"),
  );

  const commit = git(legacyRoot, "rev-parse", "HEAD");
  assert.equal(commit, expectedCommit, "Legacy Morrow is not at the expected donor commit");
  const isBare = git(legacyRoot, "rev-parse", "--is-bare-repository") === "true";
  if (isBare) {
    assertPinnedSourceFiles(legacyRoot, commit, [
      "extension/tool-registry.js",
      "extension/providers/capability-registry.js",
      "extension/tools/admin-tools.js",
    ]);
  } else {
    const trackedStatus = git(legacyRoot, "status", "--porcelain=v1", "--untracked-files=no");
    assert.equal(trackedStatus, "", "Legacy Morrow has tracked changes; refuse a non-reproducible export");
  }

  const toolRegistry = await importModule(legacyRoot, "extension/tool-registry.js", commit);
  const capabilityRegistry = await importModule(legacyRoot, "extension/providers/capability-registry.js", commit);
  const adminTools = await importModule(legacyRoot, "extension/tools/admin-tools.js", commit);

  const providerDefinitions = toolRegistry.getToolsForProvider("canvas");
  const adminDefinitions = adminTools.ADMIN_TOOL_DEFINITIONS;
  const definitions = [
    ...providerDefinitions.map((definition) => ({
      definition,
      sourcePath: "extension/tool-registry.js",
      sourceExport: "getToolsForProvider('canvas')",
    })),
    ...adminDefinitions.map((definition) => ({
      definition,
      sourcePath: "extension/tools/admin-tools.js",
      sourceExport: "ADMIN_TOOL_DEFINITIONS",
    })),
  ];
  const capabilityRows = new Map(
    capabilityRegistry.listCapabilities("canvas").map((row) => [row.capability, row]),
  );

  const byName = new Map();
  for (const { definition } of definitions) {
    const name = String(definition?.name || "").trim();
    assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/, "Invalid Canvas tool name");
    assert.equal(byName.has(name), false, `Duplicate Canvas tool name ${name}`);
    byName.set(name, definition);
  }
  if (expectedCount !== undefined) {
    assert.equal(byName.size, expectedCount, "Canvas tool count differs from MORROW_LEGACY_EXPECTED_CANVAS_TOOLS");
  }

  const tools = [...byName.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, definition]) => {
      const capability = capabilityRows.get(name) || null;
      const source = definitions.find((entry) => entry.definition === definition);
      const readOnly = capability?.write !== true;
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
        capability: {
          family: "canvas-operation",
          provider: "canvas",
          sourcePath: source?.sourcePath || "unknown",
          sourceExport: source?.sourceExport || "unknown",
          sourceDigest: sha256Json(definition),
          behavior: {
            readOnly,
            mutating: !readOnly,
            destructive: capability?.destructive === true,
            requiresBrowser: true,
            requiresLiveCanvas: true,
          },
          authority: {
            scopeClass: "canvas",
            approvalClass: capability?.destructive === true ? "destructive" : readOnly ? "none" : "standard",
            dataClass: "unknown",
          },
          route: { backend: "morrow-extension" },
          profiles: {
            "private-full": { state: "supported" },
            "public-canvas": { state: "rights_hold", reason: "Requires an explicit publication selection." },
            sandbox: { state: "profile_limited", reason: "No synthetic fixture is attached." },
            "read-only": readOnly
              ? { state: "supported" }
              : { state: "profile_limited", reason: "Provider writes are disabled." },
          },
          evidence: {
            sourcePath: { state: "known" },
            sourceExport: { state: "known" },
            sourceDigest: { state: "known" },
            supportsDryRun: { state: "unknown", reason: "Registry export has no dry-run declaration." },
            supportsReadback: { state: "unknown", reason: "Registry export has no readback declaration." },
          },
        },
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
    `providerDefinitions=${providerDefinitions.length}`,
    `adminDefinitions=${adminDefinitions.length}`,
    `tools=${artifact.count}`,
    `pdfEstimate=${PDF_ESTIMATE_CANVAS_TOOL_COUNT}`,
    `baselineException=${artifact.count === PDF_ESTIMATE_CANVAS_TOOL_COUNT ? "none" : "pdf_canvas_count_estimate_drift"}`,
    `digest=${artifact.digest}`,
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`[morrow-catalog] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
