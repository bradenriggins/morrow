// The New Quizzes accommodation route looks a string user_id up as a user it
// cannot find and answers 404 "Users with IDs ... were not found", so every
// accommodation Morrow sent failed. The id has to reach Canvas as a JSON number,
// exactly, even for a shard id beyond 2^53.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const executor = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");

function executorFunction(name) {
  const start = executor.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  let depth = 0;
  for (let index = executor.indexOf("{", start); index < executor.length; index += 1) {
    if (executor[index] === "{") depth += 1;
    if (executor[index] === "}" && --depth === 0) {
      return new Function(`${executor.slice(start, index + 1)}\nreturn ${name};`)();
    }
  }
  throw new Error(`${name} is unterminated`);
}

const body = executorFunction("newQuizAccommodationBody");

test("the accommodation body carries the user id as a JSON number", () => {
  const sent = JSON.parse(body({ user_id: "48901", extra_time: 10 }));
  assert.deepEqual(sent, [{ user_id: 48901, extra_time: 10 }]);
  assert.equal(typeof sent[0].user_id, "number");
});

test("a shard id beyond 2^53 reaches the wire digit for digit", () => {
  assert.equal(body({ user_id: "170000000000012345", extra_time: 5 }), '[{"user_id":170000000000012345,"extra_time":5}]');
});

test("an accommodation with only a user id is still one well-formed row", () => {
  assert.equal(body({ user_id: "7" }), '[{"user_id":7}]');
  assert.deepEqual(JSON.parse(body({ user_id: "7", reduce_choices_enabled: true, extra_attempts: 1 })),
    [{ user_id: 7, reduce_choices_enabled: true, extra_attempts: 1 }]);
});

test("a user id that is not a Canvas id is refused before anything is sent", () => {
  for (const userId of ["Student A1", "0", "1e3", "", "12 34"]) {
    assert.throws(() => body({ user_id: userId }), /new_quiz_accommodation_user_invalid/);
  }
});

test("the executor sends the accommodation through that body", () => {
  assert.match(executor, /options\.body = newQuizAccommodationBody\(newQuizAccommodation\);/);
  assert.doesNotMatch(executor, /JSON\.stringify\(\[newQuizAccommodation\]\)/);
});
