import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repositoryRoot, "scripts", "validate-source-rights.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("source-rights CLI requires an exact reviewed public input", async () => {
  const root = await mkdtemp(join(tmpdir(), "morrow-source-rights-"));
  const file = join(root, "canvas-tool.js");
  const manifest = join(root, "manifest.json");
  const inputs = join(root, "inputs.json");
  const source = Buffer.from("export const canvasTool = true;\n");
  try {
    await writeFile(file, source);
    await writeFile(manifest, `${JSON.stringify({
      schema: "morrow.source-rights.v1",
      files: [{
        path: "canvas-tool.js",
        sha256: sha256(source),
        disposition: "clean_reimplementation",
        review: "rights-review: generic public adapter",
      }],
    })}\n`);
    await writeFile(inputs, `${JSON.stringify({ files: ["canvas-tool.js"] })}\n`);
    const output = execFileSync(process.execPath, [
      scriptPath,
      "--manifest", manifest,
      "--inputs", inputs,
      "--root", root,
    ], { encoding: "utf8" });
    assert.match(output, /public-source-rights=ok files=1/);

    const privateSource = Buffer.from("const example-kitInternal = true;\n");
    await writeFile(file, privateSource);
    await writeFile(manifest, `${JSON.stringify({
      schema: "morrow.source-rights.v1",
      files: [{
        path: "canvas-tool.js",
        sha256: sha256(privateSource),
        disposition: "clean_reimplementation",
        review: "rights-review: generic public adapter",
      }],
    })}\n`);
    assert.throws(() => execFileSync(process.execPath, [
      scriptPath,
      "--manifest", manifest,
      "--inputs", inputs,
      "--root", root,
    ], { encoding: "utf8", stdio: "pipe" }), /digest drift|private marker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
