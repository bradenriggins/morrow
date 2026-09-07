import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * Holds Morrow's Blackboard claims to the Blackboard operation registry. The
 * generated catalog is the source: `packages/blackboard-learn-api` writes it
 * through `scripts/blackboard-catalog.mjs`, and
 * `packages/blackboard-learn-api/test/blackboard-registry.test.ts` fails when it
 * is stale, so a tool cannot reach this file without its registry row.
 *
 * A Blackboard tool added to that registry has to be documented before these
 * tests pass: its route in the scope document, and its name in the README
 * surface when a person can reach it.
 */
const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

const SCOPE = "docs/implementation/BLACKBOARD-REST-SCOPE.md";
const README = "README.md";
const LIMITATIONS = "LIMITATIONS.md";
const SERVER_INSTRUCTIONS = "packages/mcp-server/src/server-instructions.ts";
const COURSE_AUDIT = "packages/mcp-server/src/course-audit.ts";
const CATALOG = "artifacts/blackboard/blackboard-rest-catalog.json";

const catalog = JSON.parse(read(CATALOG));
const EVIDENCE = "`api_configured_live_untested`";

/** Where a tool answers, in the exact words the scope document's table uses. */
function reachableFrom(tool) {
  if (tool.gatewayDispatchOnly) return "Gateway dispatch only";
  if (tool.private) return "Private source tool";
  return "Full surface, or `morrow_capability_read`";
}

/**
 * The Learn route a tool calls, in the exact words the scope document uses. A
 * tool with no route reads Morrow's own local state instead: the setup file, or
 * the record of the changes Morrow has already sent.
 */
function learnRoute(tool) {
  return tool.method ? `\`${tool.method} ${tool.pathTemplate}\`` : "None. Sends no Blackboard request.";
}

function section(text, heading, stopPattern = /\n## /) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `${heading} is missing`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(stopPattern);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every row of the scope document's route table, by tool name. */
function inventoryRows() {
  const inventory = section(read(SCOPE), "## Route inventory");
  const rows = new Map();
  for (const line of inventory.split("\n")) {
    const match = /^\| `([a-z_]+)` \|(.*)\|$/.exec(line.trim());
    if (!match) continue;
    const cells = match[2].split("|").map((cell) => cell.trim());
    assert.equal(cells.length, 6, `${SCOPE}: the row for ${match[1]} does not have the table's seven columns`);
    rows.set(match[1], {
      module: cells[0], route: cells[1], access: cells[2],
      reachableFrom: cells[3], entitlement: cells[4], evidence: cells[5],
    });
  }
  return rows;
}

test("the scope document lists every shipped Blackboard tool with its route and evidence label", () => {
  const rows = inventoryRows();
  const documented = [...rows.keys()];
  const shipped = catalog.tools.map((tool) => tool.tool);

  assert.deepEqual(
    shipped.filter((name) => !rows.has(name)), [],
    `add these registry tools to the route inventory in ${SCOPE}`,
  );
  assert.deepEqual(
    documented.filter((name) => !shipped.includes(name)), [],
    `${SCOPE} names Blackboard tools that the registry does not ship`,
  );

  for (const tool of catalog.tools) {
    const row = rows.get(tool.tool);
    assert.deepEqual(row, {
      module: tool.module,
      route: learnRoute(tool),
      access: tool.access,
      reachableFrom: reachableFrom(tool),
      entitlement: `\`${tool.entitlement}\``,
      evidence: EVIDENCE,
    }, `${SCOPE}: the ${tool.tool} row does not match the registry`);
  }
});

test("the scope document states the registry's own counts", () => {
  const inventory = section(read(SCOPE), "## Route inventory");
  const { tools, reads, writes, private: privateTools, gatewayDispatchOnly } = catalog.counts;
  assert.ok(
    inventory.includes(`${tools} tools: ${reads} reads and ${writes} writes`),
    `${SCOPE} states a stale tool count; the registry has ${tools} tools, ${reads} reads and ${writes} writes`,
  );
  assert.ok(
    inventory.includes(`${privateTools} are private source tools`),
    `${SCOPE} states a stale private-tool count; the registry has ${privateTools}`,
  );
  assert.ok(
    inventory.includes(`${gatewayDispatchOnly}\nof those are registered only for the Gateway process`)
    || inventory.includes(`${gatewayDispatchOnly} of those are registered only for the Gateway process`),
    `${SCOPE} states a stale Gateway-dispatch count; the registry has ${gatewayDispatchOnly}`,
  );
});

test("the README Blackboard surface names every tool a person can reach, and no private one", () => {
  const surface = section(read(README), "## Blackboard capability surface");
  const named = new Set([...surface.matchAll(/`((?:morrow_blackboard|blackboard)_[a-z_]+)`/g)].map((match) => match[1]));

  const publicTools = catalog.tools.filter((tool) => !tool.private).map((tool) => tool.tool);
  assert.deepEqual(
    publicTools.filter((name) => !named.has(name)), [],
    `add these Blackboard tools to "## Blackboard capability surface" in ${README}`,
  );

  const privateTools = catalog.tools.filter((tool) => tool.private).map((tool) => tool.tool);
  assert.deepEqual(
    privateTools.filter((name) => named.has(name)), [],
    `${README} offers a private Blackboard source tool as if a person could call it`,
  );
});

test("no Blackboard claim says the route waits on a browser connection", () => {
  // The retired claim, in both orders it was written: "Blackboard is unavailable
  // until its browser connection is verified", and "Browser connection is not yet
  // verified" in a Blackboard row. The browser path is not implemented, but it is
  // not what the shipped route waits on.
  const retired = [
    /Blackboard[^.]{0,160}\bbrowser\b[^.]{0,80}\b(?:connection|session)\b[^.]{0,80}\b(?:verif|unavailable|not available)/i,
    /\bbrowser\b[^.]{0,80}\b(?:connection|session)\b[^.]{0,120}\bBlackboard\b[^.]{0,80}\b(?:verif|unavailable|not available)/i,
    /Blackboard[^.]{0,80}\b(?:is|stays|remains)\s+(?:un|not )available[^.]{0,120}\bbrowser\b/i,
  ];
  const found = [];
  for (const doc of [README, LIMITATIONS, SERVER_INSTRUCTIONS, COURSE_AUDIT, SCOPE]) {
    const text = read(doc);
    for (const pattern of retired) {
      const match = pattern.exec(text);
      if (match) found.push(`${doc}: ${match[0]}`);
    }
  }
  assert.deepEqual(found, [], "the shipped Blackboard route is the official REST integration, not a browser connection");
});

test("the scope document claims no live Blackboard tenant", () => {
  const text = read(SCOPE);
  assert.match(text, /No live Blackboard tenant has been tested/i, `${SCOPE} must state that no live Blackboard tenant has been tested`);
  assert.doesNotMatch(
    text, /(?<!\bno )\blive Blackboard tenant has been tested/i,
    `${SCOPE} must not claim a tested live Blackboard tenant`,
  );
  assert.doesNotMatch(
    text, /\bBlackboard\b[^.;]{0,80}\b(?:is|was|are|were|has been|have been)\s+(?:live[- ]?(?:tested|verified)|verified (?:on|against) a live|tested (?:on|against) a live|proved (?:on|against) a live)/i,
    `${SCOPE} must not bind Blackboard to live evidence`,
  );
});

const FOCUSED = "## Focused tests";

/**
 * The commands the focused-test section runs, and the files each one covers.
 * Every command names its files by pattern, so a Blackboard test file added
 * later runs without an edit to the document. These entries are what makes that
 * true: a Blackboard test file saved anywhere else is not run by any of them.
 */
const SUITE = [
  {
    command: "pnpm --dir packages/blackboard-learn-api exec vitest run",
    directory: "packages/blackboard-learn-api/test",
    covers: (name) => name.endsWith(".test.ts"),
  },
  {
    command: "pnpm --dir packages/mcp-server exec vitest run test/blackboard-",
    directory: "packages/mcp-server/test",
    covers: (name) => name.startsWith("blackboard-") && name.endsWith(".test.ts"),
  },
  {
    command: "node --test scripts/test/blackboard-*.test.mjs",
    directory: "scripts/test",
    covers: (name) => name.startsWith("blackboard-") && name.endsWith(".test.mjs"),
  },
  {
    command: "node --test installer/test/blackboard*.test.cjs",
    directory: "installer/test",
    covers: (name) => name.startsWith("blackboard") && name.endsWith(".test.cjs"),
  },
];

/** Every test file under one directory, ignoring build and dependency folders. */
function testFilesUnder(directory) {
  let entries;
  try {
    entries = readdirSync(new URL(`${directory}/`, root), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...testFilesUnder(path));
    else if (/\.test\.(?:ts|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** Every test file in the checkout whose subject is Blackboard. */
function blackboardTestFiles() {
  const directories = ["scripts/test", "installer/test"];
  for (const entry of readdirSync(new URL("packages/", root), { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(`packages/${entry.name}/test`);
  }
  return directories
    .flatMap(testFilesUnder)
    .filter((path) =>
      path.startsWith("packages/blackboard-learn-api/test/")
      || /blackboard/i.test(path.slice(path.lastIndexOf("/") + 1)));
}

/**
 * The focused-test section as blocks: one for each paragraph, list item, and
 * table row, with wrapped lines joined back on.
 */
function focusedBlocks() {
  const blocks = [];
  for (const line of section(read(SCOPE), FOCUSED).split("\n")) {
    const last = blocks.length - 1;
    if (line.trim() === "") blocks.push("");
    else if (/^\s/.test(line) && last >= 0 && blocks[last] !== "") blocks[last] += ` ${line.trim()}`;
    else blocks.push(line.trim());
  }
  return blocks.filter((block) => block !== "");
}

/**
 * Every test file the focused-test section runs, as a repository path: the files
 * its commands name, and the files listed under them. Prose is left out, so the
 * section can still say which file a command lost and why.
 */
function testFilesItRuns() {
  const named = new Set();
  for (const block of focusedBlocks()) {
    if (!block.includes("node --test") && !block.includes("vitest run")) continue;
    const packageDirectory = /pnpm --dir (\S+)/.exec(block)?.[1];
    for (const [, span] of block.matchAll(/`([^`\n]+)`/g)) {
      for (const [path] of span.matchAll(/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.test\.(?:ts|mjs|cjs)\b/g)) {
        if (/^(?:packages|scripts|installer)\//.test(path)) named.add(path);
        else {
          assert.ok(packageDirectory, `${SCOPE}: name ${path} from the repository root, or run it with pnpm --dir`);
          named.add(`${packageDirectory}/${path}`);
        }
      }
    }
  }
  return [...named];
}

test("every test file the focused-test section runs exists", () => {
  const missing = testFilesItRuns().filter((path) => !existsSync(new URL(path, root)));
  assert.deepEqual(
    missing, [],
    `"${FOCUSED}" in ${SCOPE} runs test files this checkout does not have; correct the command or the list under it`,
  );
});

test("every Blackboard test file is one the focused-test commands run", () => {
  const focused = section(read(SCOPE), FOCUSED);
  for (const entry of SUITE) {
    assert.ok(
      focused.includes(entry.command),
      `"${FOCUSED}" in ${SCOPE} no longer lists \`${entry.command}\`, which is how its ${entry.directory} files are run`,
    );
  }

  const unreached = blackboardTestFiles().filter((path) => {
    const directory = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(path.lastIndexOf("/") + 1);
    return !SUITE.some((entry) => entry.directory === directory && entry.covers(name));
  });
  assert.deepEqual(
    unreached, [],
    `no command in "${FOCUSED}" of ${SCOPE} runs these Blackboard test files; name each one blackboard-*, or add its command to that section and to this test`,
  );
});
