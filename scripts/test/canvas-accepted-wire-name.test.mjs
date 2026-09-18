// Canvas publishes a few form fields without the record they belong to and then
// refuses the request that sends them the way it documents them. The in-page
// executor writes those fields under the record Canvas accepts. Each route named
// here has to be a real catalog route carrying exactly those fields, so the
// correction cannot outlive or misname the contract it corrects.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const catalog = JSON.parse(readFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), "utf8"));
const source = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");

function wrappers() {
  const block = /const ACCEPTED_RECORD_WRAPPERS = \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(block, "the executor still names its accepted record wrappers");
  // eslint-disable-next-line no-new-func
  return new Function(`return {${block[1]}}`)();
}

test("every corrected route is a real catalog route carrying exactly those fields", () => {
  const byTool = new Map(catalog.operations.map((operation) => [operation.toolName, operation]));
  const named = wrappers();
  assert.ok(Object.keys(named).length > 0);
  for (const [toolName, wrapper] of Object.entries(named)) {
    const operation = byTool.get(toolName);
    assert.ok(operation, `${toolName} is a catalog route`);
    assert.equal(operation.readOnly, false, `${toolName} is a change`);
    const form = (operation.parameters || []).filter((parameter) => parameter.location === "form");
    for (const field of wrapper.fields) {
      assert.ok(form.some((parameter) => parameter.wireName === field),
        `${toolName} publishes ${field} as a bare form field`);
    }
  }
});

test("the executor applies the accepted wire name when it writes a form body", () => {
  assert.match(source, /wireName: acceptedWireName\(operation, parameter\.wireName\)/);
});
