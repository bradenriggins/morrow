// Canvas caps the page size of some routes below what the request asked for and
// writes its own cap into the later-page address. A smaller page reads less at a
// time, never more, so following it does not widen the read. Refusing it stops
// the listing after one page, which made every New Quiz create and delete fail
// as stale in a course Canvas capped.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");

/** The executor's own rule, taken from the shipped source. */
function sameRequestParameters(resumed, requested) {
  const body = /function sameRequestParameters\(resumed, requested\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(body, "the executor still names sameRequestParameters");
  // eslint-disable-next-line no-new-func
  return new Function("resumed", "requested", body[1])(resumed, requested);
}

const link = (search) => new URL(`https://school.instructure.com/api/quiz/v1/courses/1/quizzes${search}`);

test("a later page Canvas capped below the asked size is followed", () => {
  assert.equal(sameRequestParameters(link("?page=2&per_page=50"), link("?per_page=100")), true);
});

test("a later page that raises the size above the asked one is refused", () => {
  assert.equal(sameRequestParameters(link("?page=2&per_page=200"), link("?per_page=100")), false);
});

test("the asked size is still followed when Canvas echoes it", () => {
  assert.equal(sameRequestParameters(link("?page=2&per_page=100"), link("?per_page=100")), true);
});

test("a later page that changes a real filter is still refused", () => {
  assert.equal(
    sameRequestParameters(link("?page=2&per_page=50&state=all"), link("?per_page=100&state=active")),
    false,
  );
});
