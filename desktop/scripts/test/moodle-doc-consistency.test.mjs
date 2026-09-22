import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

const catalog = JSON.parse(read("connector/extension/generated/moodle-browser-catalog.json"));
const catalogToolNames = catalog.operations.map((operation) => operation.toolName);
const catalogCounts = {
  total: catalog.operations.length,
  reads: catalog.operations.filter((operation) => operation.readOnly === true).length,
  writes: catalog.operations.filter((operation) => operation.readOnly !== true).length,
};

const README = "README.md";
const LIMITATIONS = "LIMITATIONS.md";
const PARITY = "docs/implementation/THREE-LMS-BRIDGE-PARITY.md";
const SCOPE = "docs/implementation/MOODLE-FULL-FUNCTIONALITY.md";

const SURFACE_HEADING = "## Moodle capability surface";
const LIVE_HEADING = "### Checked on a signed-in Moodle test course";
const FIXTURE_HEADING = "### Implemented and locally tested only, not yet checked on a signed-in Moodle site";

function section(text, heading, stopPattern) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `${heading} is missing`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(stopPattern);
  return end === -1 ? rest : rest.slice(0, end);
}

function toolNamesIn(text) {
  return [...text.matchAll(/`(moodle_[a-z0-9_]+)`/g)].map((match) => match[1]);
}

test("the documented Moodle surface lists every catalog operation exactly once", () => {
  const surface = section(read(README), SURFACE_HEADING, /\n## /);
  const documented = toolNamesIn(surface);
  const duplicates = documented.filter((name, index) => documented.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], `${README} lists these Moodle tools more than once`);

  const missing = catalogToolNames.filter((name) => !documented.includes(name));
  assert.deepEqual(missing, [], `add these catalog tools to "${SURFACE_HEADING}" in ${README}`);

  const unknown = documented.filter((name) => !catalogToolNames.includes(name));
  assert.deepEqual(unknown, [], `${README} names Moodle tools that the catalog does not expose`);
});

test("the two Moodle evidence groups partition the catalog", () => {
  const surface = section(read(README), SURFACE_HEADING, /\n## /);
  const live = toolNamesIn(section(surface, LIVE_HEADING, /\n### /));
  const fixtureOnly = toolNamesIn(section(surface, FIXTURE_HEADING, /\n### /));

  const overlap = live.filter((name) => fixtureOnly.includes(name));
  assert.deepEqual(overlap, [], "a Moodle tool cannot be both signed-in checked and fixture-only");
  assert.equal(live.length + fixtureOnly.length, catalogCounts.total, "every catalog tool needs one evidence group");

  const claimed = new Set([...live, ...fixtureOnly]);
  assert.deepEqual(catalogToolNames.filter((name) => !claimed.has(name)), []);

  const readme = read(README);
  assert.ok(
    readme.includes(`${live.length} of the ${catalogCounts.total} operations were saved and checked on a signed-in Moodle test course`),
    `the ${README} platform table must state ${live.length} signed-in checked operations`,
  );
  assert.ok(
    readme.includes(`The other ${fixtureOnly.length} pass local browser fixtures only`),
    `the ${README} platform table must state ${fixtureOnly.length} fixture-only operations`,
  );

  const limitations = read(LIMITATIONS);
  assert.ok(
    limitations.includes(`The Moodle catalog holds ${catalogCounts.total} operations, and only ${live.length} of them have been checked on a signed-in Moodle test course`),
    `${LIMITATIONS} must state ${live.length} of ${catalogCounts.total} signed-in checked operations`,
  );
  assert.ok(
    limitations.includes(`The remaining ${fixtureOnly.length} Moodle operations are implemented and pass local browser fixtures only`),
    `${LIMITATIONS} must state ${fixtureOnly.length} fixture-only operations`,
  );
  assert.ok(limitations.includes("No signed-in Moodle site has run them."), `${LIMITATIONS} must keep the fixture-only statement`);
});

test("every documented Moodle operation count matches the catalog", () => {
  const counted = `${catalogCounts.total} operations: ${catalogCounts.reads} reads and ${catalogCounts.writes} writes`;

  const parity = read(PARITY);
  assert.ok(parity.includes(`The Moodle source catalog has ${counted} at this checkpoint.`), `${PARITY} states a stale Moodle operation count; the catalog has ${counted}`);
  assert.ok(parity.includes("An operation count describes implementation breadth only."), `${PARITY} must keep the breadth-only sentence`);

  const readme = read(README);
  assert.ok(readme.includes(`The Moodle catalog exposes ${counted}.`), `${README} states a stale Moodle operation count; the catalog has ${counted}`);
  assert.ok(readme.includes("That count describes implementation breadth only."), `${README} must keep the breadth-only sentence`);
});

test("no Moodle module with a catalog route is documented as Missing", () => {
  const scope = read(SCOPE);
  const rows = [...scope.matchAll(/^\| `([a-z0-9]+)` \| ([^|]+)\|/gm)];
  assert.ok(rows.length >= 23, "the core module work list is missing or changed shape");

  const documentedAsMissing = rows
    .filter((row) => row[2].trim().startsWith("Missing"))
    .map((row) => row[1]);
  const routed = documentedAsMissing.filter((component) => catalog.operations.some((operation) => operation.key.includes(`.${component}.`)));
  assert.deepEqual(routed, [], `these modules have catalog routes and cannot be documented as Missing in ${SCOPE}`);
});

test("the Moodle checkpoint table carries a row for every catalog surface it once omitted", () => {
  const checkpoint = section(read(SCOPE), "## Current checkpoint", /\n## /);
  for (const row of ["IMS content package", "SCORM package", "Assignment submission summary", "Forum posts"]) {
    assert.ok(checkpoint.includes(`| ${row} |`), `add a "${row}" row to the Current checkpoint table in ${SCOPE}`);
  }
});
