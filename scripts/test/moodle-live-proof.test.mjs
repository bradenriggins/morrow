import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildChecklist, capabilitiesIn, writeClass } from "../moodle-live-proof.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HARNESS = join(root, "scripts/moodle-live-proof.mjs");
const CHECKLIST = "docs/implementation/MOODLE-LIVE-PROOF-CHECKLIST.md";
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const catalog = JSON.parse(read("connector/extension/generated/moodle-browser-catalog.json"));
const writes = catalog.operations.filter((operation) => operation.readOnly !== true);

function runHarness(argv, { timeout = 300_000 } = {}) {
  return spawnSync(process.execPath, [HARNESS, ...argv], { cwd: root, encoding: "utf8", timeout });
}

test("the harness proves one Moodle write against the local fixture and reaches no Moodle site", { timeout: 320_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-live-proof-test-"));
  try {
    const content = "<p>Reviewed fixture text</p>";
    const run = runHarness([
      "--operation=moodle_update_label",
      `--arguments=${JSON.stringify({ module_id: 11, content })}`,
      `--output-dir=${directory}`,
    ]);
    const receipts = readdirSync(directory).filter((name) => name.endsWith("-receipt.json"));
    assert.equal(receipts.length, 1, `the harness wrote ${receipts.length} receipts\n${run.stdout}\n${run.stderr}`);
    const raw = readFileSync(join(directory, receipts[0]), "utf8");
    const receipt = JSON.parse(raw);
    assert.equal(run.status, 0, `the harness failed: ${receipt.error || run.stderr}`);

    assert.equal(receipt.schema, "morrow.moodle-live-proof.v1");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.stage, "completed");
    assert.equal(receipt.evidenceClass, "local_fixture");
    assert.equal(receipt.connector.mode, "harness_bridge_client");
    assert.match(receipt.connector.note, /packaged extension service worker did not run/);
    assert.deepEqual(receipt.operation, {
      key: "moodle.form.course.modedit.label.write.v1",
      toolName: "moodle_update_label",
      writeClass: "native form",
      reviewTool: "moodle_get_label",
      summary: catalog.operations.find((operation) => operation.toolName === "moodle_update_label").summary,
      documentation: catalog.operations.find((operation) => operation.toolName === "moodle_update_label").documentation,
    });

    assert.match(receipt.target.origin, /^https:\/\/127\.0\.0\.1:\d+$/, "the fixture proof must bind the local fixture only");
    assert.equal(receipt.target.courseId, "2");
    // The fixture roster holds one learner, Marisol Okonkwo, and the saved label names her by
    // her given name alone. The read that reaches the assistant must carry the course-local
    // label, never the name, and the rest of the sentence must survive untouched.
    assert.equal(
      receipt.exactTargetBeforeChange.data.content,
      "<p>Fixture text before the reviewed change. Student A1 asked about it.</p>",
    );
    assert.doesNotMatch(raw, /Marisol|Okonkwo/iu, "a learner name reached the receipt");
    assert.match(receipt.exactTargetBeforeChange.snapshotDigest, /^[a-f0-9]{64}$/);

    assert.equal(receipt.requestReview.effectState, "awaiting_approval");
    assert.equal(receipt.requestReview.dispatchBeforeApprovalRefused, true);
    assert.equal(receipt.requestReview.reviewPageStatus, 200);
    assert.equal(receipt.requestReview.reviewPageNamesCourse, true);
    assert.deepEqual(receipt.requestReview.authorization, { kind: "review" });
    assert.equal(receipt.requestReview.frozenArguments.content, content);
    assert.equal(receipt.requestReview.frozenArguments.expected_digest, receipt.exactTargetBeforeChange.snapshotDigest);

    assert.deepEqual(receipt.dispatch, { state: "verified", dispatchAttempt: 1, bridgeWriteCommands: 1, providerPosts: 1 });
    assert.equal(receipt.replay.refused, true);
    assert.equal(receipt.replay.dispatchAttemptAfterReplay, 1);
    assert.deepEqual(receipt.operationJournal.writeEffects, [{ publicToolName: "moodle_update_label", state: "verified", dispatchAttempt: 1 }]);

    assert.equal(receipt.authoritativeSavedResult.source, "fresh_read_after_the_change");
    assert.equal(receipt.authoritativeSavedResult.data.content, content);
    assert.equal(receipt.authoritativeSavedResult.data.name, receipt.exactTargetBeforeChange.data.name);
    assert.deepEqual(receipt.authoritativeSavedResult.changedFields, ["content"]);
    assert.notEqual(receipt.authoritativeSavedResult.snapshotDigest, receipt.exactTargetBeforeChange.snapshotDigest);

    assert.equal(receipt.roleAndCapability.role, "fixture editing teacher");
    assert.equal(receipt.fixture.postsRefusedForADroppedControl, 0, "the write dropped a protected native control");
    assert.ok(receipt.fixture.protectedControlsRequiredByEveryPost.includes("availability"), "the fixture must require the protected controls back");
    assert.equal(receipt.providerRequestLog.filter((route) => route.startsWith("POST /course/modedit.php")).length, 1);
    assert.ok(receipt.providerRequestLog.some((route) => route.startsWith("POST /admin/roles/check.php")), "the roster capability proof must run");
    assert.equal(receipt.providerRequestLog.some((route) => route.startsWith("GET /mod/label/view.php")), false, "no read may open the activity view route");

    const hosts = [...raw.matchAll(/https?:\/\/([^/"\\\s]+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(hosts)].filter((host) => !/^127\.0\.0\.1(?::\d+)?$/.test(host)), ["github.com"], "the only address outside the fixture is the catalog's source link");
    assert.equal(raw.includes("fixture-session"), false, "no session key may reach a receipt");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a saved change with no answer is recorded as unknown, never as a passed proof", { timeout: 320_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-live-proof-unknown-"));
  try {
    const run = runHarness([
      "--operation=moodle_update_label",
      `--arguments=${JSON.stringify({ module_id: 11, content: "<p>Answer lost in transit</p>" })}`,
      "--fixture-fault=lost-response",
      `--output-dir=${directory}`,
    ]);
    assert.equal(run.status, 1, "an unverified change must fail the proof");
    const receipts = readdirSync(directory).filter((name) => name.endsWith("-receipt.json"));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(readFileSync(join(directory, receipts[0]), "utf8"));

    assert.equal(receipt.status, "failed");
    assert.equal(receipt.fixtureFault, "lost-response");
    assert.equal(receipt.dispatch.state, "applied_or_unknown");
    assert.equal(receipt.dispatch.dispatchAttempt, 1, "an unknown outcome is never dispatched again");
    assert.equal(receipt.dispatch.bridgeWriteCommands, 1, "an unknown outcome is never sent again");
    assert.ok(receipt.dispatch.providerPosts >= 1, "the fixture must record the POST the change sent");
    assert.equal(receipt.replay.refused, true);
    assert.equal(receipt.replay.dispatchAttemptAfterReplay, 1);
    const write = receipt.bridgeCommands.find((command) => command.kind === "invoke_write");
    assert.equal(write.problem, "write_outcome_unknown", "a sent change with no verified readback is the unknown outcome");
    assert.match(receipt.error, /did not reach one verified dispatch: applied_or_unknown/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the harness refuses a proof it cannot run here, and writes no receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-live-proof-refusal-"));
  try {
    const refusals = [
      [["--operation=moodle_get_label", `--output-dir=${directory}`], /is a read/],
      [["--operation=moodle_not_a_tool", `--output-dir=${directory}`], /is not in connector\/extension\/generated\/moodle-browser-catalog\.json/],
      [["--operation=moodle_update_forum", `--output-dir=${directory}`], /needs --target=site with an authorized disposable Moodle site/],
      [["--operation=moodle_update_label", "--target=site", `--output-dir=${directory}`], /--site=<https origin>/],
    ];
    for (const [argv, expected] of refusals) {
      const run = runHarness(argv, { timeout: 60_000 });
      assert.equal(run.status, 1, `${argv[0]} should refuse: ${run.stdout}`);
      assert.match(run.stderr, expected);
    }
    assert.deepEqual(readdirSync(directory), [], "a refused proof must write no receipt");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the checked-in checklist matches the catalog it describes", () => {
  assert.equal(
    read(CHECKLIST),
    buildChecklist(),
    `${CHECKLIST} has drifted. Run: node scripts/moodle-live-proof.mjs --write-checklist`,
  );
});

test("the checklist carries every catalog write once, with its class, review read and evidence state", () => {
  const checklist = read(CHECKLIST);
  const rows = [...checklist.matchAll(/^\| `(moodle_[a-z0-9_]+)` \| ([A-Za-z -]+) \| `(moodle_[a-z0-9_]+)` \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map(([, toolName, className, reviewTool, capability, evidence]) => ({ toolName, className, reviewTool, capability: capability.trim(), evidence: evidence.trim() }));
  assert.equal(rows.length, writes.length, `${CHECKLIST} lists ${rows.length} of ${writes.length} catalog writes`);
  assert.equal(new Set(rows.map((row) => row.toolName)).size, rows.length, `${CHECKLIST} lists a write more than once`);

  for (const operation of writes) {
    const row = rows.find((entry) => entry.toolName === operation.toolName);
    assert.ok(row, `${CHECKLIST} is missing ${operation.toolName}`);
    assert.equal(row.className, writeClass(operation.key), `${CHECKLIST} states the wrong write class for ${operation.toolName}`);
    assert.equal(row.reviewTool, operation.reviewTool, `${CHECKLIST} states the wrong review read for ${operation.toolName}`);
    const capabilities = capabilitiesIn(operation.description);
    if (capabilities.length) {
      for (const capability of capabilities) {
        assert.ok(row.capability.includes(`\`${capability}\``), `${CHECKLIST} omits ${capability} for ${operation.toolName}`);
      }
    } else {
      assert.match(row.capability, /^not stated/, `${CHECKLIST} states a capability the catalog does not for ${operation.toolName}`);
    }
    assert.match(
      row.evidence,
      /^(?:fixture-only|signed-in checked, )/,
      `${CHECKLIST} must state fixture-only or the signed-in evidence for ${operation.toolName}`,
    );
  }
});

test("every write the checklist calls signed-in checked is one the README places in that group", () => {
  const checklist = read(CHECKLIST);
  const readme = read("README.md");
  const start = readme.indexOf("### Checked on a signed-in Moodle test course");
  const end = readme.indexOf("### Implemented and locally tested only");
  assert.ok(start !== -1 && end > start, "README.md no longer carries the two Moodle evidence groups");
  const signedIn = readme.slice(start, end);
  const claimed = [...checklist.matchAll(/^\| `(moodle_[a-z0-9_]+)` \|.*\| signed-in checked, ([^|]+) \|$/gm)];
  assert.ok(claimed.length > 0, `${CHECKLIST} should carry the writes that already have signed-in evidence`);
  for (const [, toolName, evidence] of claimed) {
    assert.ok(signedIn.includes(`\`${toolName}\``), `${CHECKLIST} claims signed-in evidence for ${toolName}, which README.md does not`);
    const receiptPath = /`(output\/live-moodle\/[^`]+\.json)`/.exec(evidence)?.[1];
    if (receiptPath) {
      assert.ok(
        read("docs/implementation/THREE-LMS-BRIDGE-PARITY.md").includes(receiptPath),
        `${CHECKLIST} names ${receiptPath}, which the parity record does not`,
      );
    }
  }
});
