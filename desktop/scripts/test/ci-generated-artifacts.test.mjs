import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
// The workflows live at the repository root, one level above the desktop product.
const repositoryRoot = new URL("../", root);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const workflow = readFileSync(new URL(".github/workflows/ci.yml", repositoryRoot), "utf8");

/** The body of one job, from its two-space header to the next one. */
function job(id) {
  const match = new RegExp(`^  ${id}:\n((?: {4,}.*\n|\n)*)`, "m").exec(workflow);
  assert.ok(match, `ci.yml must declare the ${id} job`);
  return match[1];
}

test("the exact pull-request CI command rejects stale generated provider artifacts", () => {
  assert.match(job("check-desktop"), /^\s*- run: pnpm check\s*$/m);
  assert.match(job("check-desktop"), /^ {4}defaults:\n {6}run:\n {8}working-directory: desktop$/m, "the desktop suite runs in the desktop product directory");
  assert.match(job("changes"), /^ {14}- 'desktop\/\*\*'$/m, "a change anywhere under desktop/ runs the desktop suite");
  assert.match(job("check"), /needs: \[changes, check-desktop, check-muse\]/, "the required check aggregates change detection and both suites");
  assert.match(job("check"), /if \[ "\$CHANGES" != "success" \]; then[\s\S]*?exit 1/, "a failed change detection cannot pass as skipped suites");
  assert.match(job("check"), /if \[ "\$changed" = "true" \] && \[ "\$result" != "success" \]/, "a changed product passes only when its suite succeeded");
  assert.match(job("changes"), /^ {12}desktop:\n {14}- 'desktop\/\*\*'\n {14}- '\.github\/\*\*'$/m, "a workflow change runs the desktop suite");
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
  assert.match(job("check-desktop"), /^\s+timeout-minutes: 30$/m);
  assert.match(job("check-desktop"), /^\s+run: xvfb-run -a node scripts\/run-browser-harnesses\.mjs$/m);
  assert.ok(workflow.indexOf("pnpm check") < workflow.indexOf("xvfb-run -a node scripts/run-browser-harnesses.mjs"));
});

test("pull-request CI pins its runtime and every action implementation", () => {
  assert.match(workflow, /^\s+node-version: 22\.23\.2$/m);
  for (const reference of workflow.matchAll(/uses:\s+([^\s@]+)@([^\s]+)/g)) {
    assert.match(reference[2], /^[0-9a-f]{40}$/, `${reference[1]} must use an immutable commit`);
  }
});
