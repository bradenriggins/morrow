import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

const REPORT_PATH = "artifacts/canvas-api/canvas-admission-report.json";
const PROVEN = "docs/implementation/PROVEN-WORKFLOW-REUSE.md";
const REMAINING = "docs/implementation/MORROW-REMAINING-WORK.md";

const report = JSON.parse(read(REPORT_PATH));
const catalog = JSON.parse(read("artifacts/canvas-api/canvas-api-catalog.json"));

/**
 * Reads one number out of a document. The pattern has to match exactly once: an edit that removes
 * the sentence, duplicates it, or changes its wording fails here instead of leaving a stale count
 * in a published document.
 */
function documentNumbers(text, claim) {
  const matches = [...text.matchAll(new RegExp(claim.pattern.source, `${claim.pattern.flags}g`))];
  assert.equal(
    matches.length,
    1,
    `${claim.label}: expected exactly one match for ${claim.pattern}. Regenerate with pnpm canvas:admission:report and rewrite the sentence.`,
  );
  return matches[0].slice(1).map((value) => Number(value.replaceAll(",", "")));
}

function assertDocumentClaims(text, claims) {
  for (const claim of claims) {
    assert.deepEqual(documentNumbers(text, claim), claim.expected, `${claim.label} does not match ${REPORT_PATH}`);
  }
}

const itemBankOperations = catalog.operations.filter((operation) => operation.service === "item_bank");

const provenClaims = [
  {
    label: "catalog totals",
    pattern: /The current generated Canvas catalog has ([\d,]+) operations: ([\d,]+) reads and ([\d,]+) writes\./,
    expected: [report.totals.operations, report.totals.reads, report.totals.writes],
  },
  {
    label: "held before dispatch",
    pattern: /^\| Held before dispatch \| (\d+) \|/m,
    expected: [report.admission.held],
  },
  {
    label: "held for course_scope_required",
    pattern: /\| (\d+) have no course anywhere in the route,/,
    expected: [report.admission.heldByReason.course_scope_required],
  },
  {
    label: "held for account_authority_required",
    pattern: /, (\d+) name a Canvas account, the whole Canvas instance, an LTI registration, or a developer key,/,
    expected: [report.admission.heldByReason.account_authority_required],
  },
  {
    label: "held for cross_course_object_requires_resolution",
    pattern: /, (\d+) name a group, file, folder, calendar item, outcome, or section that Canvas can attach to any course,/,
    expected: [report.admission.heldByReason.cross_course_object_requires_resolution],
  },
  {
    label: "held for learner_scope_requires_separate_authority",
    pattern: /, (\d+) name one person's own record,/,
    expected: [report.admission.heldByReason.learner_scope_requires_separate_authority],
  },
  {
    label: "held for provider_contract_incomplete",
    pattern: /, (\d+) have an incomplete provider contract,/,
    expected: [report.admission.heldByReason.provider_contract_incomplete],
  },
  {
    label: "held for self_scope_not_supported",
    pattern: /, (\d+) change a personal bookmark or course nickname,/,
    expected: [report.admission.heldByReason.self_scope_not_supported],
  },
  {
    label: "held for multi_step_upload_requires_reviewed_transfer",
    pattern: /, (\d+) are unfinished Canvas upload pre-flights,/,
    expected: [report.admission.heldByReason.multi_step_upload_requires_reviewed_transfer],
  },
  {
    label: "admitted before dispatch",
    pattern: /^\| Admitted before dispatch \| (\d+) \|/m,
    expected: [report.admission.admitted],
  },
  {
    label: "admitted through a direct course target or proved course object",
    pattern: /\| (\d+) use a direct course target:[^|]+The other (\d+) use declared course-ownership reads/,
    expected: [
      report.admission.admittedByCourseTargetKind.course_path,
      report.admission.admittedByCourseTargetKind.semantic_course_object,
    ],
  },
  {
    label: "structurally exact readback",
    pattern: /^\| Structurally exact readback \| (\d+) \|/m,
    expected: [report.readback.stateCounts.structurally_exact],
  },
  {
    label: "readback route tiers",
    pattern: /: (\d+) read the same route, (\d+) read the created child, (\d+) read the parent collection, and (\d+) use named readbacks/,
    expected: [
      report.readback.routeTierCounts.exact,
      report.readback.routeTierCounts.created_child,
      report.readback.routeTierCounts.parent_collection,
      report.readback.routeTierCounts.mismatched,
    ],
  },
  {
    label: "no safe generic read route, capability baseline row",
    pattern: /^\| No safe generic read route \| (\d+) \| The planner finds no read of the written object,/m,
    expected: [report.readback.stateCounts.unavailable],
  },
  {
    label: "no exact post-write reader",
    pattern: /^\| No exact post-write reader \| (\d+) \|/m,
    expected: [report.readback.stateCounts.blocked],
  },
  {
    label: "pinned admission and readback split",
    pattern: /pins the (\d+) \/ (\d+) \/ (\d+) \/ (\d+) \/ (\d+) split/,
    expected: [
      report.admission.held,
      report.admission.admitted,
      report.readback.stateCounts.structurally_exact,
      report.readback.stateCounts.unavailable,
      report.readback.stateCounts.blocked,
    ],
  },
  {
    label: "readback work that remains, opening count",
    pattern: /^(\d+) of the (\d+) admitted writes have no exact generic postcondition\./m,
    expected: [report.readback.admittedWritesWithoutExactReadback.length, report.admission.admitted],
  },
  {
    label: "readback work that remains, split",
    pattern: /: (\d+) have no safe read route at all, and (\d+) are stopped by a named blocker\./,
    expected: [report.readback.stateCounts.unavailable, report.readback.stateCounts.blocked],
  },
  {
    label: "Item Bank operation split",
    pattern: /The current catalog exposes (\d+) Item Bank operations: (\d+) reads and (\d+) owner writes\./,
    expected: [
      itemBankOperations.length,
      itemBankOperations.filter((operation) => operation.readOnly).length,
      itemBankOperations.filter((operation) => !operation.readOnly).length,
    ],
  },
  {
    label: "no safe generic read route, gap table row",
    pattern: /^\| No safe generic read route \| (\d+) \| Canvas has no read of the written object,/m,
    expected: [report.readback.stateCounts.unavailable],
  },
];

/** Every readback blocker the code can return needs its own row in the gap table. */
const BLOCKER_ROWS = Object.freeze({
  content_migration_update_has_no_cataloged_fields: "Content migration update has no cataloged fields",
  discussion_or_conversation_content: "Discussion or conversation content",
  external_tool_update_has_no_cataloged_fields: "External tool update has no cataloged fields",
  favorite_list_is_effective_not_explicit_state: "Favorite list is effective, not explicit, state",
  module_item_reader_mutates_progress: "Module item reader mutates progress",
  module_progression_state_has_no_current_user_reader: "Module progression has no current-user reader",
  student_grade_or_submission_state: "Student grade or submission state",
  summary_state_has_no_narrow_reader: "Summary state has no narrow reader",
});

for (const [reason, label] of Object.entries(BLOCKER_ROWS)) {
  provenClaims.push({
    label: `blocked readback row for ${reason}`,
    pattern: new RegExp(`^\\| ${label} \\| (\\d+) \\|`, "m"),
    expected: [report.readback.blockedByReason[reason]],
  });
}

const remainingClaims = [
  {
    label: "remaining Canvas admission summary",
    pattern: /The catalog has ([\d,]+) operations, with (\d+) writes held[^.]+\. Of the \d+ admitted writes, (\d+) lack exact generic readback\./,
    expected: [
      report.totals.operations,
      report.admission.held,
      report.readback.admittedWritesWithoutExactReadback.length,
    ],
  },
];

test("the Canvas admission report regenerates byte-identically from the catalog and the built contract", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("scripts/canvas-admission-report.mjs", root)), "--check"],
    { cwd: fileURLToPath(root), encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `pnpm canvas:admission:check failed. Run pnpm canvas:admission:report and update the documents.\n${result.stderr}`,
  );
  assert.equal(report.schema, "morrow.canvas-admission-report.v1");
  assert.equal(report.catalogDigest, catalog.catalogDigest);
});

test("the Canvas admission report accounts for every write exactly once", () => {
  const sum = (counts) => Object.values(counts).reduce((total, value) => total + value, 0);
  assert.equal(report.admission.admitted + report.admission.held, report.totals.writes);
  assert.equal(sum(report.admission.admittedByCourseTargetKind), report.admission.admitted);
  assert.equal(sum(report.admission.heldByReason), report.admission.held);
  assert.equal(sum(report.admission.heldByRouteFamily), report.admission.held);
  assert.equal(sum(report.readback.stateCounts), report.admission.admitted);
  assert.equal(sum(report.readback.routeTierCounts), report.admission.admitted);
  assert.equal(sum(report.readback.blockedByReason), report.readback.stateCounts.blocked);
  assert.equal(
    report.readback.routeTierCounts.none,
    report.readback.stateCounts.unavailable + report.readback.stateCounts.blocked,
  );
  assert.equal(
    report.readback.admittedWritesWithoutExactReadback.length,
    report.admission.admitted - report.readback.stateCounts.structurally_exact,
  );
  // A plan that reads a different resource is only acceptable for the named Canvas readbacks, which
  // have their own per-target evaluators.
  assert.deepEqual(report.readback.mismatchedPlanTools, report.readback.namedReadbackTools);
  assert.deepEqual(
    Object.keys(report.readback.blockedByReason).sort(),
    Object.keys(BLOCKER_ROWS).sort(),
    "add a gap-table row in PROVEN-WORKFLOW-REUSE.md for every readback blocker the code can return",
  );
});

test("PROVEN-WORKFLOW-REUSE.md quotes the generated report", () => {
  const text = read(PROVEN);
  assertDocumentClaims(text, provenClaims);
  assert.ok(
    text.includes("Current source of truth for these counts is `artifacts/canvas-api/canvas-admission-report.json`"),
    `${PROVEN} must name the generated report as the source of these counts`,
  );
  assert.doesNotMatch(
    text,
    /known semantic target/,
    `${PROVEN} must not describe any Canvas write as a known semantic target: that admission branch no longer exists`,
  );
});

test("MORROW-REMAINING-WORK.md quotes the generated report", () => {
  assertDocumentClaims(read(REMAINING), remainingClaims);
});

test("a document edit that changes a quoted number or breaks an anchor fails loudly", () => {
  const proven = read(PROVEN);
  const heldClaim = provenClaims.find((claim) => claim.label === "held before dispatch");

  const wrongNumber = proven.replace(
    `| Held before dispatch | ${report.admission.held} |`,
    "| Held before dispatch | 999 |",
  );
  assert.notEqual(wrongNumber, proven);
  assert.throws(() => assertDocumentClaims(wrongNumber, [heldClaim]), /does not match/);

  const brokenAnchor = proven.replace(`| Held before dispatch | ${report.admission.held} |`, "| Held | many |");
  assert.notEqual(brokenAnchor, proven);
  assert.throws(() => assertDocumentClaims(brokenAnchor, [heldClaim]), /expected exactly one match/);

  const duplicatedAnchor = `${proven}\n| Held before dispatch | ${report.admission.held} |\n`;
  assert.throws(() => assertDocumentClaims(duplicatedAnchor, [heldClaim]), /expected exactly one match/);

  const remaining = read(REMAINING);
  const rewordedSummary = remaining.replace("writes held for semantic scope, personal scope, transfer, provider-contract, or exact-readback reasons", "writes still need work");
  assert.notEqual(rewordedSummary, remaining);
  assert.throws(() => assertDocumentClaims(rewordedSummary, remainingClaims), /expected exactly one match/);
});
