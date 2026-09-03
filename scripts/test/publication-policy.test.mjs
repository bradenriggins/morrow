import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildSourceCatalog,
} from "../../packages/gateway-core/dist/index.js";
import { upstreamCatalogDigest } from "../../packages/contracts/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repositoryRoot, "scripts", "create-publication-policy.mjs");

test("publication policy CLI writes only explicit reviewed selections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morrow-publication-cli-"));
  const sourcePath = join(directory, "source.json");
  const selectionPath = join(directory, "selections.json");
  const outputPath = join(directory, "public-canvas.json");
  const source = buildSourceCatalog({
    id: "meridian",
    label: "ExamplePlatform fixture",
    kind: "synthetic",
    capturedAt: "2026-09-03T00:00:00.000Z",
  }, [
    {
      name: "canvas_page_get",
      description: "Read one Canvas page.",
      inputSchema: {
        type: "object",
        properties: { course_id: { type: "string" } },
        required: ["course_id"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "private_source_only",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ]);
  await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  await writeFile(selectionPath, `${JSON.stringify({
    schema: "morrow.publication-selections.v1",
    release: "1.0.0-rc.0",
    selections: [{
      publicName: "canvas_page_get",
      sourceId: "meridian",
      sourceToolName: "canvas_page_get",
    }],
  }, null, 2)}\n`, "utf8");

  try {
    const stdout = execFileSync(process.execPath, [
      scriptPath,
      "--source", sourcePath,
      "--selection", selectionPath,
      "--out", outputPath,
    ], { cwd: repositoryRoot, encoding: "utf8" });
    assert.match(stdout, /sources=1/);
    assert.match(stdout, /tools=1/);
    assert.match(stdout, /manifestDigest=[0-9a-f]{64}/);

    const manifest = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(manifest.schema, "morrow.publication-policy.v1");
    assert.equal(manifest.profile, "public-canvas");
    assert.equal(manifest.tools.length, 1);
    assert.equal(manifest.tools[0].publicName, "canvas_page_get");
    assert.equal(manifest.sources[0].catalogDigest, upstreamCatalogDigest("meridian", source.tools));
    assert.equal(JSON.stringify(manifest).includes("private_source_only"), false);

    assert.throws(() => execFileSync(process.execPath, [
      scriptPath,
      "--source", sourcePath,
      "--selection", selectionPath,
      "--out", outputPath,
    ], { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" }), /Refusing to overwrite/);

    assert.doesNotThrow(() => execFileSync(process.execPath, [
      scriptPath,
      "--source", sourcePath,
      "--selection", selectionPath,
      "--out", outputPath,
      "--force",
    ], { cwd: repositoryRoot, encoding: "utf8" }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
