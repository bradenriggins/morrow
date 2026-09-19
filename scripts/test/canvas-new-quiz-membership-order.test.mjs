// A New Quiz create or delete is reviewed against the set of New Quizzes the
// course held. The review sorts that set; the in-page executor reads the course
// list in Canvas's own order. Both have to compare it in one order, or every
// create and delete fails as stale in any course holding more than one New Quiz.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const executor = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");
const review = readFileSync(resolve(root, "packages/mcp-server/src/new-quiz-lifecycle.ts"), "utf8");

/** The comparator each side sorts a membership with, read from its own source. */
function comparator(source, name) {
  const found = new RegExp(`${name}[\\s\\S]*?sort\\(\\((left, right)\\) => ([^)]*?)\\)`, "u").exec(source);
  assert.ok(found, `${name} still sorts its membership`);
  return found[2].trim();
}

test("the review and the executor sort a New Quiz membership the same way", () => {
  const executorOrder = comparator(executor, "function newQuizIdOrder");
  const reviewOrder = comparator(review, "function quizIds");
  assert.equal(executorOrder, reviewOrder);
});

test("the executor compares the membership it sorted, not Canvas's listing order", () => {
  assert.match(executor, /const before = newQuizIdOrder\(await newQuizMembership\(url, expiresAt\)\);/);
  assert.match(executor, /const reviewed = newQuizIdOrder\(guard\.before_quiz_ids\.map\(String\)\);/);
  assert.match(executor, /before\.some\(\(id, index\) => id !== reviewed\[index\]\)/);
});

test("the order is the one that puts a shorter id first", () => {
  const order = (ids) => [...ids].sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(order(["100", "9", "20"]), ["9", "20", "100"]);
});
