import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { RETIRED_PHRASES, findRetiredPhrases } from "./lib/retired-claims.mjs";

/**
 * The gate on Morrow's four claim documents. Each test compares a document against the source that
 * makes the claim true: the packages that ship, the files a link points at, the signal list the
 * course audit returns. This keeps a document from describing a Morrow that does not exist.
 *
 * Paths resolve from this file, so a scratch copy of the tree can be checked by copying this test
 * and `lib/retired-claims.mjs` into `<copy>/scripts/test/` and running the copy.
 */
const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");
const present = (relativePath) => existsSync(new URL(relativePath, root));

const CLAIM_DOCS = ["README.md", "LIMITATIONS.md", "ARCHITECTURE.md", "docs/brand/MORROW-BRAND.md"];
const BLACKBOARD_PACKAGE = "packages/blackboard-learn-api/package.json";
const MOODLE_EXECUTOR = "connector/extension/src/moodle-executor.js";
const COURSE_AUDIT = "packages/mcp-server/src/course-audit.ts";

const collapse = (value) => value.replace(/\s+/g, " ").trim();

/** Sentences with their line numbers. A line break ends a sentence, so a list item stands alone. */
function sentences(text) {
  const found = [];
  let line = 1;
  let start = 0;
  const boundary = /[.!?]["”’')\]]*(?=\s|$)|\n/g;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    const value = collapse(text.slice(start, end));
    if (value) found.push({ text: value, line });
    line += (text.slice(start, end).match(/\n/g) ?? []).length;
    start = end;
  }
  const tail = collapse(text.slice(start));
  if (tail) found.push({ text: tail, line });
  return found;
}

/** Heading sections, plus the text before the first heading as the document intro. */
function headingSections(text) {
  const found = [];
  const headings = [...text.matchAll(/^#{1,6} .*$/gm)];
  const intro = text.slice(0, headings.length > 0 ? headings[0].index : text.length);
  if (collapse(intro)) found.push({ heading: "(document intro)", line: 1, text: intro });
  for (const [index, heading] of headings.entries()) {
    const next = headings[index + 1];
    found.push({
      heading: collapse(heading[0]),
      line: text.slice(0, heading.index).split("\n").length,
      text: text.slice(heading.index, next ? next.index : text.length),
    });
  }
  return found;
}

/** Markdown heading anchors, slugged the way GitHub and most Markdown viewers slug them. */
function anchors(markdown) {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map(([, heading]) =>
      heading
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .trim()
        .replace(/\s+/g, "-"),
    ),
  );
}

test("the claim documents use none of the retired phrases", () => {
  const found = CLAIM_DOCS.flatMap((doc) =>
    findRetiredPhrases(read(doc)).map((hit) => `${doc}:${hit.line} "${hit.phrase}" in: ${hit.sentence}`),
  );
  assert.deepEqual(found, [], "these phrases are retired; scripts/test/lib/retired-claims.mjs says what each one got wrong");
});

test("the documented platform coverage matches the packages that ship", (t) => {
  if (present(BLACKBOARD_PACKAGE)) {
    for (const doc of ["ARCHITECTURE.md", "LIMITATIONS.md"]) {
      assert.match(read(doc), /Blackboard/, `${BLACKBOARD_PACKAGE} ships, so ${doc} must state the Blackboard route and its evidence`);
    }
  } else {
    t.diagnostic(`${BLACKBOARD_PACKAGE} is absent; the Blackboard coverage rule does not apply`);
  }

  if (present(MOODLE_EXECUTOR)) {
    assert.match(read("ARCHITECTURE.md"), /Moodle/, `${MOODLE_EXECUTOR} ships, so ARCHITECTURE.md must describe the Moodle route`);
  } else {
    t.diagnostic(`${MOODLE_EXECUTOR} is absent; the Moodle coverage rule does not apply`);
  }
});

test("every section that describes Blackboard says no live tenant has been tested", () => {
  // The qualifier is checked per section, not per sentence, because that is how the documents carry
  // it: `ARCHITECTURE.md` states it once for its Blackboard section and says it covers the section.
  const qualifier = /no live [^.]*tenant has been tested|no live tenant has run|no live-tenant evidence|live-untested|live-unverified|mocked-HTTPS/i;
  const unqualified = [];
  for (const doc of ["ARCHITECTURE.md", "LIMITATIONS.md"]) {
    for (const section of headingSections(read(doc))) {
      if (!/Blackboard/.test(section.text)) continue;
      if (qualifier.test(section.text)) continue;
      unqualified.push(`${doc}:${section.line} ${section.heading}`);
    }
  }
  assert.deepEqual(unqualified, [], "a section that describes Blackboard must state that no live Blackboard tenant has been tested");
});

test("no document claims a tested live Blackboard tenant", () => {
  const untested = /no live Blackboard tenant has been tested/i;
  // Only a claim that binds Blackboard to live evidence fails. The canonical platform sentence
  // names Canvas live proof and the untested Blackboard tenant together, and it must keep passing.
  const claimsLiveEvidence = [
    /(?<!\bno )\blive Blackboard tenant has been tested/i,
    /\bBlackboard\b[^.;]{0,80}\b(?:is|was|are|were|has been|have been)\s+(?:live[- ]?(?:tested|verified)|verified (?:on|against) a live|tested (?:on|against) a live|proved (?:on|against) a live)/i,
  ];
  const problems = [];
  for (const doc of CLAIM_DOCS) {
    const text = read(doc);
    if (!/Blackboard/.test(text)) continue;
    if (!untested.test(text)) {
      problems.push(`${doc} describes Blackboard without stating that no live Blackboard tenant has been tested`);
    }
    for (const sentence of sentences(text)) {
      for (const pattern of claimsLiveEvidence) {
        if (pattern.test(sentence.text)) problems.push(`${doc}:${sentence.line} ${sentence.text}`);
      }
    }
  }
  assert.deepEqual(problems, [], "the Blackboard route is proved against local mocked-HTTPS tests only");
});

test("every repo-relative link in the claim documents resolves", () => {
  const broken = [];
  for (const doc of CLAIM_DOCS) {
    const text = read(doc);
    const docDirectory = new URL(doc, root);
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const [path, fragment] = target.split("#");
      const file = path === "" ? new URL(doc, root) : new URL(decodeURI(path), docDirectory);
      if (!existsSync(file)) {
        broken.push(`${doc}:${line} -> ${target} (no such file)`);
        continue;
      }
      if (!fragment || !file.pathname.endsWith(".md")) continue;
      if (!anchors(readFileSync(file, "utf8")).has(fragment.toLowerCase())) {
        broken.push(`${doc}:${line} -> ${target} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, [], "a link in a claim document points at a file or heading that does not exist");
});

test("the course audit guidance names exactly the signals the audit returns", () => {
  const source = read(COURSE_AUDIT);
  const declared = source.match(/export const COURSE_AUDIT_SOURCE_SIGNAL_NAMES = \[([\s\S]*?)\] as const;/);
  assert.ok(declared, `${COURSE_AUDIT} must export COURSE_AUDIT_SOURCE_SIGNAL_NAMES; the claim gate reads it as the authority`);
  const signals = [...declared[1].matchAll(/"([a-z0-9_]+)"/g)].map(([, name]) => name);
  assert.ok(signals.length > 0, `${COURSE_AUDIT} declares no source signals`);

  const listed = source.match(/observed_source_signals\\`:([\s\S]*?)\\`\./);
  assert.ok(listed, `${COURSE_AUDIT} guidance must list the signals it returns under observed_source_signals`);
  const named = [...listed[1].matchAll(/\\`([a-z0-9_]+)/g)].map(([, name]) => name);
  assert.deepEqual(named, signals, `${COURSE_AUDIT} guidance names a different signal set than the audit returns`);

  const guidance = source.slice(source.indexOf("## Accessibility work"));
  assert.match(guidance, /needs human review/, `${COURSE_AUDIT} must keep the human-review limit on every signal`);
  assert.match(guidance, /does not establish[^.]*conformance/i, `${COURSE_AUDIT} must keep the no-conformance limit`);
});

test("no claim document widens what the course audit detects", () => {
  const source = read(COURSE_AUDIT);
  const signals = [...source.match(/export const COURSE_AUDIT_SOURCE_SIGNAL_NAMES = \[([\s\S]*?)\] as const;/)[1].matchAll(/"([a-z0-9_]+)"/g)].map(([, name]) => name);
  const signalSet = new Set(signals);

  const detection = /\b(detect|detects|detected|find|finds|report|reports|return|returns|list|lists|scan|scans|show|shows)\b/i;
  const auditSubject = /\b(audit|audits|signal|signals)\b/i;
  const limit = /\b(signal|signals|limited|saved|human review|not a violation)\b|does not establish/i;
  const partial = /\b(for example|such as|among|including|one of)\b/i;
  const identifier = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
  const toolName = /^(morrow|canvas|moodle|blackboard)_/;
  const conformance = /\b(conformance|conformant|compliance|compliant)\b/i;
  const negated = /\b(no|not|never|cannot|without|neither|nor)\b/i;

  const problems = [];
  for (const doc of CLAIM_DOCS) {
    for (const sentence of sentences(read(doc))) {
      const where = `${doc}:${sentence.line}`;
      if (conformance.test(sentence.text) && !negated.test(sentence.text)) {
        problems.push(`${where} claims conformance: ${sentence.text}`);
      }
      if (!detection.test(sentence.text) || !auditSubject.test(sentence.text)) continue;
      if (!limit.test(sentence.text)) {
        problems.push(`${where} states what the audit detects without its saved-source signal limit: ${sentence.text}`);
      }
      const namedIdentifiers = [...sentence.text.matchAll(identifier)]
        .map(([, name]) => name)
        .filter((name) => !toolName.test(name));
      const unknown = namedIdentifiers.filter((name) => !signalSet.has(name));
      if (unknown.length > 0) {
        problems.push(`${where} names signals the audit does not return: ${unknown.join(", ")}`);
      }
      const namedSignals = namedIdentifiers.filter((name) => signalSet.has(name));
      if (namedSignals.length > 0 && !partial.test(sentence.text)) {
        const missing = signals.filter((name) => !namedSignals.includes(name));
        if (missing.length > 0) {
          problems.push(`${where} names part of the signal set as if it were all of it; missing: ${missing.join(", ")}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `${COURSE_AUDIT} is the authority for what the audit detects`);
});

const CANVAS_CATALOG = "connector/extension/generated/canvas-api-catalog.json";
const EDIT_POLICY = "connector/extension/src/edit-policy.js";
const ITEM_BANK_COVERAGE = "docs/implementation/NEW-QUIZZES-ITEM-BANKS-COVERAGE.md";
const PROOF_HARNESS_LEDGER = "proof-harness/ledger.json";
const ITEM_BANK_FAN_OUT = "packages/mcp-server/src/item-bank-fan-out.ts";

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const numberValue = (word) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase()));

const itemBankOperations = () => JSON.parse(read(CANVAS_CATALOG)).operations
  .filter((operation) => operation.family === "new-quizzes-item-banks");

/** The lines of a text that talk about Item Banks: a Markdown paragraph or list item, or one line of source. */
const itemBankUnits = (text) => text.split("\n").filter((line) => /Item Banks?\b/.test(line));

test("the claim documents count the Item Bank reads and changes the catalog carries", () => {
  const operations = itemBankOperations();
  const reads = operations.filter((operation) => operation.readOnly === true).length;
  const changes = operations.length - reads;
  const problems = [];
  for (const doc of CLAIM_DOCS) {
    for (const match of read(doc).matchAll(/\b([A-Za-z]+|\d+) (?:Item Bank )?reads and ([A-Za-z]+|\d+) (?:course-bound|owner-write)\b/g)) {
      if (numberValue(match[1]) !== reads || numberValue(match[2]) !== changes) {
        problems.push(`${doc}: "${match[0]}", but the catalog carries ${reads} reads and ${changes} changes`);
      }
    }
  }
  assert.deepEqual(problems, [], `${CANVAS_CATALOG} is the authority for the Item Bank operation counts`);
});

test("the README counts the Item Bank changes the Edit policy offers and the ones it keeps change by change", async () => {
  const { categoriesForBinding } = await import(new URL(EDIT_POLICY, root).href);
  const operations = JSON.parse(read(CANVAS_CATALOG)).operations.map((operation) => ({ ...operation, provider: "canvas" }));
  const bank = categoriesForBinding({ provider: "canvas", courseId: "42" }, operations)
    .filter((category) => category.id.startsWith("action:canvas:canvas_item_bank_"));
  const edit = bank.filter((category) => category.availability === "edit").length;
  const review = bank.filter((category) => category.availability === "review").length;
  const paragraph = itemBankUnits(read("README.md")).find((line) => /standing Edit grant/.test(line)) || "";
  const standing = paragraph.match(/\b([A-Za-z]+|\d+) of (?:them|the [A-Za-z]+ changes) can hold a standing Edit grant/);
  const oneByOne = paragraph.match(/\b([A-Za-z]+|\d+) (?:of them )?are approved change by change/);
  assert.ok(standing && oneByOne, "README.md must state how many Item Bank changes can hold a standing Edit grant and how many are approved change by change");
  assert.deepEqual([numberValue(standing[1]), numberValue(oneByOne[1])], [edit, review],
    `${EDIT_POLICY} offers ${edit} Item Bank changes for Edit and keeps ${review} change by change`);
});

test("the Item Bank live status follows the attended record, never the proof harness", () => {
  const coverage = read(ITEM_BANK_COVERAGE);
  const start = coverage.indexOf("\n## Item Banks");
  const table = coverage.slice(start, coverage.indexOf("\n## ", start + 1));
  assert.ok([...table.matchAll(/\| proven \|\s*$/gm)].length > 0, `${ITEM_BANK_COVERAGE} records no Item Bank task proven live`);
  const harness = Object.values(JSON.parse(read(PROOF_HARNESS_LEDGER)).rows);
  const harnessProvedAChange = harness.some((row) => String(row.id).startsWith("canvas_item_bank_") && row.kind === "write" && row.verdict === "PASS");

  const unproven = /live-unverified|live-untested|no (?:connected|Morrow-connected) Canvas tenant has (?:proved|answered)|no retained live Canvas receipt/i;
  const aboutTheRoutes = /Item Banks?\b|private (?:route|operation)s?|frame contract/i;
  const problems = [];
  for (const file of [...CLAIM_DOCS, COURSE_AUDIT, ITEM_BANK_FAN_OUT]) {
    for (const unit of itemBankUnits(read(file))) {
      for (const sentence of sentences(unit)) {
        if (unproven.test(sentence.text) && aboutTheRoutes.test(sentence.text)) {
          problems.push(`${file} calls the Item Bank routes unproven: ${sentence.text}`);
        }
        if (!harnessProvedAChange && sentence.text.includes(PROOF_HARNESS_LEDGER)) {
          problems.push(`${file} cites ${PROOF_HARNESS_LEDGER} for Item Banks, where no Item Bank change ran: ${sentence.text}`);
        }
      }
    }
  }
  for (const doc of ["README.md", "LIMITATIONS.md"]) {
    if (!itemBankUnits(read(doc)).some((line) => line.includes("NEW-QUIZZES-ITEM-BANKS-COVERAGE.md"))) {
      problems.push(`${doc} states the Item Bank live status without citing ${ITEM_BANK_COVERAGE}`);
    }
  }
  assert.deepEqual(problems, [], `${ITEM_BANK_COVERAGE} is the attended record of what Item Banks proved live`);
});

test("the New Quiz question and settings limits follow the attended record", () => {
  const coverage = read(ITEM_BANK_COVERAGE);
  const provenRow = (task) => coverage.split("\n").some((line) => line.startsWith(`| ${task}`) && /\| proven \|\s*$/.test(line));
  const neverRun = /none of these three has run against a live Canvas course/i;
  const claims = [
    { task: "Create each of the 12 question types", stale: neverRun },
    { task: "Change a question's type", stale: neverRun },
    { task: "Delete a question", stale: neverRun },
    {
      task: "Edit points, answer choices (add and remove)",
      stale: /would add, remove, rename, or duplicate any provider interaction UUID|has not verified the provider's handling of newly generated interaction UUIDs/i,
    },
    { task: "Settings: shuffle questions, time limit", stale: /every documented setting combination is live-unverified/i },
  ];
  const limitations = collapse(read("LIMITATIONS.md"));
  const problems = claims
    .filter(({ task, stale }) => provenRow(task) && stale.test(limitations))
    .map(({ task, stale }) => `LIMITATIONS.md says ${stale} although ${ITEM_BANK_COVERAGE} marks "${task}" proven`);
  assert.deepEqual(problems, []);
});
