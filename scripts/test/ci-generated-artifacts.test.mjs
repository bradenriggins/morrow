import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");

test("the exact pull-request CI command rejects stale generated provider artifacts", () => {
  assert.match(workflow, /^\s*- run: pnpm check\s*$/m);
  assert.equal(manifest.scripts.check, "pnpm audit:dependencies && pnpm generated:check && pnpm test");
  assert.equal(
    manifest.scripts["generated:check"],
    "pnpm catalog:canvas:check && pnpm canvas:admission:check && pnpm canvas:classic-question:check && pnpm moodle:identifiers:check",
  );
  assert.match(manifest.scripts["catalog:canvas:check"], /generate-canvas-api-catalog\.mjs --check/);
  assert.match(manifest.scripts["canvas:readback:check"], /sync-canvas-readback-plan\.mjs --check/);
  assert.match(manifest.scripts["canvas:admission:check"], /canvas-admission-report\.mjs --check/);
  assert.match(manifest.scripts["canvas:classic-question:check"], /sync-classic-quiz-question-contract\.mjs --check/);
  assert.match(manifest.scripts["moodle:identifiers:check"], /sync-moodle-identifier-contract\.mjs --check/);
});

test("pull-request CI executes the real Bridge browser harnesses", () => {
  assert.match(workflow, /^\s+timeout-minutes: 30$/m);
  assert.match(workflow, /^\s+run: xvfb-run -a node scripts\/run-browser-harnesses\.mjs$/m);
  assert.ok(workflow.indexOf("pnpm check") < workflow.indexOf("xvfb-run -a node scripts/run-browser-harnesses.mjs"));
});

test("pull-request CI pins its runtime and every action implementation", () => {
  assert.match(workflow, /^\s+node-version: 22\.23\.2$/m);
  for (const reference of workflow.matchAll(/uses:\s+([^\s@]+)@([^\s]+)/g)) {
    assert.match(reference[2], /^[0-9a-f]{40}$/, `${reference[1]} must use an immutable commit`);
  }
});
