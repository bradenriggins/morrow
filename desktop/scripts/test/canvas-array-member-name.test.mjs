// Canvas takes some form parameters as a list of records. The in-page executor
// names every field under such a parent with the list marker, and that set has
// to keep matching the catalog: a parent whose form parameters are all arrays is
// a list of records, and writing its fields without the marker sends Canvas a
// body it ignores.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const catalog = JSON.parse(readFileSync(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"), "utf8"));
const source = readFileSync(resolve(root, "connector/extension/src/canvas-content.js"), "utf8");

// `timetables` keys its records by section id and has its own expression.
const KEYED_BY_ID = new Set(["timetables"]);

function listShapedParents() {
  const parents = new Map();
  for (const operation of catalog.operations) {
    for (const parameter of operation.parameters || []) {
      if (parameter.location !== "form") continue;
      const match = /^([A-Za-z0-9_]+)\[/.exec(parameter.wireName || "");
      if (!match) continue;
      const seen = parents.get(match[1]) || { all: 0, arrays: 0 };
      seen.all += 1;
      if (parameter.schema?.type === "array") seen.arrays += 1;
      parents.set(match[1], seen);
    }
  }
  return [...parents]
    .filter(([name, seen]) => seen.all === seen.arrays && !KEYED_BY_ID.has(name))
    .map(([name]) => name)
    .sort();
}

test("every list-shaped Canvas parent is written with the list marker", () => {
  const expression = /const recordField = \/\^\(([^)]+)\)/.exec(source);
  assert.ok(expression, "canvasArrayMemberName must name its record parents");
  const named = new Set(expression[1].split("|"));
  const missing = listShapedParents().filter((parent) => !named.has(parent));
  assert.deepEqual(missing, [], `Canvas list parents missing the list marker: ${missing.join(", ")}`);
});
