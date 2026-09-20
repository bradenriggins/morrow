// Chrome's scripting.executeScript drops every null-valued property of an object argument.
// Measured live on 2026-09-19 in the signed-in browser: {"a":null,"b":1,"c":{"d":null,"e":"x"},
// "f":[1,null,2]} arrived in the page as {"b":1,"c":{"e":"x"},"f":[1,null,2]}: a null inside an
// array survives, a null property does not. Questions carry null properties of their own, such as
// an essay's word limits and an ordering question's shuffle rules, so an object argument silently
// changed the reviewed request on its way to the page. Every in-page executor is therefore given
// its input as text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const worker = readFileSync(resolve(root, "connector/extension/src/service-worker.js"), "utf8");

test("every executeScript argument is text, never an object", () => {
  const calls = [...worker.matchAll(/chrome\.scripting\.executeScript\(\{[\s\S]{0,900}?\n\s*\}\)/g)].map((match) => match[0]);
  assert.ok(calls.length >= 10, `found ${calls.length} injection sites`);
  for (const call of calls) {
    const args = /args:\s*\[/.exec(call);
    if (!args) continue;
    const opening = call.slice(args.index + args[0].length).trimStart();
    assert.ok(opening.startsWith("JSON.stringify("),
      `an injected argument is passed as an object, so a null property of the reviewed request is dropped:\n${call.slice(0, 300)}`);
  }
});

test("each in-page executor reads its input from text", () => {
  for (const [file, name] of [
    ["connector/extension/src/item-bank-executor.js", "executeItemBankInPage"],
    ["connector/extension/src/quiz-bank-draw-executor.js", "executeQuizBankDrawInPage"],
    ["connector/extension/src/canvas-conversations.js", "executeCanvasConversationInPage"],
    ["connector/extension/src/canvas-file-content.js", "executeCanvasCourseFileTextInPage"],
    ["connector/extension/src/canvas-new-quiz-hot-spot.js", "executeCanvasNewQuizHotSpotInPage"],
    ["connector/extension/src/canvas-file-transfer.js", "executeCanvasCourseFileTransferInPage"],
  ]) {
    const source = readFileSync(resolve(root, file), "utf8");
    const start = source.indexOf(`export async function ${name}(input) {`);
    assert.ok(start >= 0, name);
    const head = source.slice(start, start + 800);
    assert.match(head, /if \(typeof input === "string"\) \{/, name);
    assert.match(head, /input = JSON\.parse\(input\)/, name);
  }
});

test("the executors accept text and object input alike", async () => {
  const { executeItemBankInPage } = await import(`${root}/connector/extension/src/item-bank-executor.js`);
  const { executeQuizBankDrawInPage } = await import(`${root}/connector/extension/src/quiz-bank-draw-executor.js`);
  // The draw executor reads the page's own location, so it runs here with one stub for it.
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { hostname: "school.quiz-lti.instructure.com" } });
  try {
  for (const run of [executeItemBankInPage, executeQuizBankDrawInPage]) {
    // An operation that does not match this executor is refused the same way either way.
    const input = { operation: { service: "canvas", nickname: "not_this_executor" }, arguments: {} };
    const fromObject = await run(input);
    const fromText = await run(JSON.stringify(input));
    assert.deepEqual(fromText, fromObject);
    const broken = await run("{not json");
    assert.equal(broken.ok, false);
    assert.equal(broken.sent, false);
    assert.match(String(broken.error), /input_unreadable$/);
  }
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had); else delete globalThis.location;
  }
});
