// Canvas answers a few documented reads with a redirect to the object itself,
// inside its own site. The catalog admits those reads and the in-page executor
// follows one hop for exactly them, so the two rules have to name the same
// operations: a read the catalog admits but the executor refuses to follow
// answers nothing, and one the executor follows but the catalog never admits
// can never be asked for.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { canvasRedirectRead } from "../../packages/canvas-api-catalog/dist/index.js";

const root = resolve(import.meta.dirname, "../..");
const catalog = JSON.parse(readFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), "utf8"));
const source = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");

/** The executor's own rule, read from the shipped source. */
function executorRedirectRead(operation) {
  const body = /function redirectRead\(operation\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(body, "the executor still names its redirect reads in redirectRead");
  // eslint-disable-next-line no-new-func
  return new Function("operation", `${body[1]}`)(operation);
}

test("the catalog and the in-page executor name the same redirect reads", () => {
  const admitted = catalog.operations.filter((operation) => canvasRedirectRead(operation)).map((operation) => operation.toolName);
  assert.ok(admitted.length > 0, "the catalog still carries Canvas's documented redirect reads");
  const followed = catalog.operations.filter((operation) => executorRedirectRead(operation)).map((operation) => operation.toolName);
  assert.deepEqual(followed, admitted);
});

test("the executor follows a redirect only for those reads and refuses a foreign answer", () => {
  assert.match(source, /redirect: followsRedirect \? "follow" : "error"/);
  assert.match(source, /canvas_redirect_origin_refused/);
});
