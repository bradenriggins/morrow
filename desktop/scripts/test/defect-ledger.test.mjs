import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LEDGER = fileURLToPath(new URL("../../docs/implementation/DEFECT-ERADICATION-LEDGER.md", import.meta.url));
const STATUSES = new Set(["OPEN", "IMPLEMENTED", "VERIFIED"]);

const ledger = readFileSync(LEDGER, "utf8");
const lines = ledger.split("\n");

/** Table rows keyed by identifier: `| 12 | P2 | R6 | ... | STATUS |`. */
function tableRows() {
  const rows = new Map();
  const duplicates = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\| (\d+) \| (P[0-9]) \| (R[0-9]+) \| .* \| ([A-Z_]+) \|$/u);
    if (!match) continue;
    const id = Number(match[1]);
    if (rows.has(id)) duplicates.push(`${id} at lines ${rows.get(id).line} and ${index + 1}`);
    rows.set(id, { line: index + 1, status: match[4] });
  }
  return { rows, duplicates };
}

/** Closure headings keyed by identifier: `### 12: ...`. */
function closureHeadings() {
  const headings = new Map();
  const duplicates = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^### (\d+)(?: \(([^)]*)\))?:/u);
    if (!match) continue;
    const id = Number(match[1]);
    if (match[2]) continue; // A dated addendum such as `### 311 (reconfirmation, ...)` extends the primary entry.
    if (headings.has(id)) duplicates.push(`${id} at lines ${headings.get(id)} and ${index + 1}`);
    headings.set(id, index + 1);
  }
  return { headings, duplicates };
}

/** Identifiers the accounting appendix declares as never assigned. */
function unassignedIdentifiers() {
  const start = lines.findIndex((line) => line === "## Identifier accounting");
  assert.notEqual(start, -1, "the ledger must carry an identifier accounting appendix");
  const identifiers = new Set();
  for (let index = start + 1; index < lines.length && !lines[index].startsWith("## "); index += 1) {
    const match = lines[index].match(/^\| ([0-9, –-]+) \| Never assigned\./u);
    if (!match) continue;
    for (const part of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      const range = part.match(/^(\d+)[–-](\d+)$/u);
      const [from, to] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)];
      assert.ok(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from <= to, `malformed identifier entry ${part}`);
      for (let id = from; id <= to; id += 1) {
        assert.equal(identifiers.has(id), false, `identifier ${id} is accounted for twice`);
        identifiers.add(id);
      }
    }
  }
  return identifiers;
}

test("every defect has exactly one table row and at most one closure heading", () => {
  const { duplicates: duplicateRows } = tableRows();
  const { duplicates: duplicateHeadings } = closureHeadings();
  assert.deepEqual(duplicateRows, [], "duplicate ledger rows");
  assert.deepEqual(duplicateHeadings, [], "duplicate closure headings");
});

test("every closure heading closes a defect that has a table row with a known status", () => {
  const { rows } = tableRows();
  const { headings } = closureHeadings();
  const orphaned = [...headings].filter(([id]) => !rows.has(id)).map(([id, line]) => `${id} at line ${line}`);
  assert.deepEqual(orphaned, [], "closure headings without a table row");
  const unknown = [...rows].filter(([, row]) => !STATUSES.has(row.status)).map(([id, row]) => `${id}: ${row.status}`);
  assert.deepEqual(unknown, [], "rows with an unknown status");
});

test("every identifier up to the highest row is a row or an accounted gap, never both or neither", () => {
  const { rows } = tableRows();
  const unassigned = unassignedIdentifiers();
  const highest = Math.max(...rows.keys());
  const missing = [];
  const contradicted = [];
  for (let id = 1; id <= highest; id += 1) {
    const hasRow = rows.has(id);
    const accounted = unassigned.has(id);
    if (!hasRow && !accounted) missing.push(id);
    if (hasRow && accounted) contradicted.push(id);
  }
  assert.deepEqual(missing, [], "identifiers with neither a row nor an accounting entry");
  assert.deepEqual(contradicted, [], "identifiers with both a row and an accounting entry");
  const beyond = [...unassigned].filter((id) => id > highest);
  assert.deepEqual(beyond, [], "accounting entries beyond the highest row");
});
