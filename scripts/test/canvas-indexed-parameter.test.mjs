// Canvas writes a repeated record with its index in the field name and publishes
// that index as the letter X. The letter is a placeholder, never a field name:
// a request that sends it literally writes a field Canvas ignores, so the values
// never reach the change. The in-page executor writes each element at its own
// index, and every catalog parameter published that way has to go through it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const catalog = JSON.parse(readFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), "utf8"));
const source = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");

test("every catalog parameter published with the index placeholder is a change field", () => {
  const indexed = catalog.operations.flatMap((operation) => (operation.parameters || [])
    .filter((parameter) => String(parameter.wireName || "").includes("[X]"))
    .map((parameter) => ({ toolName: operation.toolName, wireName: parameter.wireName, readOnly: operation.readOnly })));
  assert.ok(indexed.length > 0, "the catalog still carries Canvas's indexed parameters");
  for (const parameter of indexed) {
    assert.equal(parameter.readOnly, false, `${parameter.toolName} ${parameter.wireName} is a change field`);
  }
});

test("the executor writes each element at its own index instead of the placeholder", () => {
  assert.match(source, /if \(normalized\.includes\("\[X\]"\)\) \{/);
  assert.match(source, /name\.replace\("\[X\]", `\[\$\{index\}\]`\)/);

  const body = /function appendIndexedValue\(target, name, value\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(body, "the executor still names appendIndexedValue");
  const written = [];
  // eslint-disable-next-line no-new-func
  new Function("target", "name", "value", "appendValue", body[1])(
    null,
    "appointment_group[new_appointments][X]",
    [["2026-10-06T15:00:00Z", "2026-10-06T16:00:00Z"], ["2026-10-07T15:00:00Z", "2026-10-07T16:00:00Z"]],
    (_target, field, entry) => written.push([field, entry]),
  );
  assert.deepEqual(written, [
    ["appointment_group[new_appointments][0]", ["2026-10-06T15:00:00Z", "2026-10-06T16:00:00Z"]],
    ["appointment_group[new_appointments][1]", ["2026-10-07T15:00:00Z", "2026-10-07T16:00:00Z"]],
  ]);
});
