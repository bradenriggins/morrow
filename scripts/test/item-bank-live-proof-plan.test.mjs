import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

const PLAN = "docs/implementation/ITEM-BANK-LIVE-PROOF-PLAN.md";
const LIMITATIONS = "LIMITATIONS.md";
const HANDOFF = "docs/implementation/MORROW-1.0-HANDOFF-2026-09-06.md";

const plan = read(PLAN);
const executor = read("connector/extension/src/item-bank-executor.js");
const executorLines = executor.split("\n");
const catalog = JSON.parse(read("connector/extension/generated/canvas-api-catalog.json"));
const itemBankReads = catalog.operations
  .filter((operation) => operation.service === "item_bank" && operation.readOnly === true)
  .map((operation) => operation.toolName)
  .sort();

const backticked = (pattern) => [...new Set([...plan.matchAll(pattern)].map((match) => match[1]))];
// A citation is a repository source path, optionally with the line range the
// plan attaches meaning to.
const citations = [...plan.matchAll(/`([A-Za-z0-9_./-]+\.(?:js|ts|mjs|json|md))(?::(\d+)-(\d+))?`/g)]
  .map((match) => ({ path: match[1], start: Number(match[2] ?? 0), end: Number(match[3] ?? 0) }))
  // Record filenames the person will create are not repository paths.
  .filter((citation) => citation.path.includes("/") && !citation.path.startsWith("output/"));

test("the plan names the five steps in order", () => {
  const headings = [...plan.matchAll(/^## Step (\d) — (.+)$/gm)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(headings, [
    "1 Frame observation",
    "2 Read proof",
    "3 Fan-out proof",
    "4 Write proof",
    "5 Uncertain outcome",
  ], `${PLAN} must keep its five steps, in this order`);
});

test("every source file the plan cites exists, and every cited line range is inside it", () => {
  assert.ok(citations.length >= 8, "the plan should cite the source its observations decide");
  for (const citation of citations) {
    assert.ok(existsSync(new URL(citation.path, root)), `${PLAN} cites ${citation.path}, which does not exist`);
    if (citation.end === 0) continue;
    const lines = read(citation.path).split("\n").length;
    assert.ok(citation.end <= lines, `${PLAN} cites ${citation.path}:${citation.start}-${citation.end}, which is past the end of that file`);
  }
});

test("every document the plan links to resolves", () => {
  const links = [...plan.matchAll(/\]\(([^)]+\.md)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 3, "the plan links to the documents its record updates");
  for (const link of links) {
    assert.ok(existsSync(new URL(link, new URL(PLAN, root))), `${PLAN} links to ${link}, which does not exist`);
  }
});

test("the executor lines the plan sends a person to look at still hold that guard", () => {
  const between = (start, end) => executorLines.slice(start - 1, end).join("\n");
  assert.match(between(9, 11), /current_user|principalId/, "item-bank-executor.js:9-11 is the principal check");
  assert.match(between(12, 13), /banks\.build_token/, "item-bank-executor.js:12-13 is the credential read");
  assert.match(between(14, 23), /backend_url/, "item-bank-executor.js:14-23 is the API host derivation");
  assert.match(between(24, 32), /document\.referrer/, "item-bank-executor.js:24-32 is the referrer check");
  assert.match(between(36, 44), /item_banks_scope/, "item-bank-executor.js:36-44 is the course claim");
  assert.match(plan, /`connector\/extension\/src\/item-bank-executor\.js:12-44`/, "the plan states which range the frame observation decides");
});

test("the credential bounds the plan tells a person to record are the executor's own", () => {
  const bounds = executor.match(/token\.length < (\d+) \|\| token\.length > (\d+)/);
  assert.ok(bounds, "the executor must still bound the credential length");
  assert.match(plan, new RegExp(`${bounds[1]} to ${bounds[2]} characters`), `${PLAN} must state the executor's own length bounds`);
});

test("the plan's read proof covers every Item Bank read the catalog exposes", () => {
  const named = backticked(/`(canvas_item_bank_[a-z_]+)`/g).sort();
  const catalogTools = catalog.operations.filter((operation) => operation.service === "item_bank").map((operation) => operation.toolName);
  const editCategories = [...read("connector/extension/src/edit-policy.js").matchAll(/id: "(canvas_item_bank_[a-z_]+)"/g)].map((match) => match[1]);
  const unknown = named.filter((name) => !catalogTools.includes(name) && !editCategories.includes(name));
  assert.deepEqual(unknown, [], `${PLAN} names Item Bank tools and categories that no source exposes`);
  const missing = itemBankReads.filter((name) => !named.includes(name));
  assert.deepEqual(missing, [], `${PLAN} step 2 must record every Item Bank read`);
});

test("every Morrow tool the plan tells a person to call is registered", () => {
  const registered = new Set([
    ...[...read("packages/mcp-server/src/item-bank-fan-out.ts").matchAll(/registerTool\(\s*"(morrow_[a-z_]+)"/g)].map((match) => match[1]),
    ...[...read("packages/mcp-server/src/item-bank-repair.ts").matchAll(/registerTool\(\s*"(morrow_[a-z_]+)"/g)].map((match) => match[1]),
    ...[...read("packages/mcp-server/src/course-audit.ts").matchAll(/registerTool\(\s*"(morrow_[a-z_]+)"/g)].map((match) => match[1]),
    ...[...read("packages/mcp-server/src/operation-tools.ts").matchAll(/registerTool\(\s*\n?\s*"(morrow_[a-z_]+)"/g)].map((match) => match[1]),
    ...[...read("packages/mcp-server/src/server.ts").matchAll(/registerTool\(\s*\n?\s*"(morrow_[a-z_]+)"/g)].map((match) => match[1]),
    ...[...read("packages/canvas-connector-mcp/src/server.ts").matchAll(/registerTool\(\s*\n?\s*"(morrow_[a-z_]+)"/g)].map((match) => match[1]),
  ]);
  const named = backticked(/`(morrow_[a-z_]+)`/g);
  assert.ok(named.length >= 5, "the plan should name the tools a person calls");
  const unknown = named.filter((name) => !registered.has(name));
  assert.deepEqual(unknown, [], `${PLAN} names Morrow tools that are not registered`);
});

test("every refusal the plan tells a person to record exactly is one Morrow produces", () => {
  const sources = [
    executor,
    read("connector/extension/src/service-worker.js"),
    read("packages/mcp-server/src/course-audit.ts"),
  ].join("\n");
  const named = backticked(/`(item_bank_[a-z_]+|blocked_unresolved_entry)`/g)
    .filter((name) => !["item_bank_entry", "item_banks_scope", "item_bank_id"].includes(name));
  assert.ok(named.length >= 5, "the plan should name the refusals a person will see");
  const unknown = named.filter((name) => !sources.includes(`"${name}"`) && !sources.includes(`\`${name}\``));
  assert.deepEqual(unknown, [], `${PLAN} names refusals no Morrow source produces`);
});

test("the fan-out fields the plan records are the fields the record carries", () => {
  const fanOut = read("connector/extension/src/item-bank-fan-out.js");
  for (const field of ["established_at", "complete", "consumer_count", "consumers_sha256", "unreachable", "external_course_ids"]) {
    assert.match(plan, new RegExp(`\`${field}\``), `${PLAN} step 3 must record ${field}`);
    assert.ok(fanOut.includes(`${field}:`), `${field} is no longer in the fan-out record`);
  }
  const report = read("packages/mcp-server/src/item-bank-fan-out.ts");
  for (const field of ["bank_entry_count", "share_row_count", "quizzes_read", "quiz_uses_found"]) {
    assert.match(plan, new RegExp(`\`observed\\.${field}\``), `${PLAN} step 3 must record observed.${field}`);
    assert.ok(report.includes(`${field}:`), `${field} is no longer in the fan-out report`);
  }
});

test("the frame pattern and the verified write result the plan names still exist", () => {
  assert.ok(read("connector/extension/src/item-bank-frames.js").includes("export const ITEM_BANK_FRAME_HOST_PATTERN"),
    "the plan sends a person to ITEM_BANK_FRAME_HOST_PATTERN");
  assert.match(plan, /`ITEM_BANK_FRAME_HOST_PATTERN`/);
  const integration = read("packages/mcp-server/test/item-bank-repair.integration.test.ts");
  for (const field of ["verified_readback", "dispatchAttempt"]) {
    assert.ok(integration.includes(field), `${field} is no longer the shape a dispatched repair returns`);
    assert.ok(plan.includes(field), `${PLAN} step 4 must name ${field}`);
  }
});

test("the plan names the fixture tests it refuses to treat as live evidence", () => {
  const fixtureTests = backticked(/`(scripts\/test\/canvas-item-bank-[a-z-]+\.test\.mjs)`/g);
  assert.deepEqual(fixtureTests.sort(), [
    "scripts/test/canvas-item-bank-executor.test.mjs",
    "scripts/test/canvas-item-bank-fan-out.test.mjs",
    "scripts/test/canvas-item-bank-frames.test.mjs",
    "scripts/test/canvas-item-bank-guard.test.mjs",
  ], `${PLAN} must name the four fixture tests it says are not evidence about Canvas`);
  assert.match(plan, /live-unverified/, "the plan must keep the standing label");
});

test("the plan is reachable from the limitations and from the handoff", () => {
  assert.match(read(LIMITATIONS), /\(docs\/implementation\/ITEM-BANK-LIVE-PROOF-PLAN\.md\)/,
    `${LIMITATIONS} must link to ${PLAN}`);
  assert.match(read(HANDOFF), /\(ITEM-BANK-LIVE-PROOF-PLAN\.md\)/,
    `${HANDOFF} must link to ${PLAN}`);
});
