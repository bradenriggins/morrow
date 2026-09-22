// Phase 0 guessed which operations could be proven here. Phase 1 ran them and found out. This
// rewrites the manifest's classification from what actually happened, so the coverage figure
// counts what this sandbox can prove rather than what was predicted before anything ran.
//
// Nothing is re-run and no verdict changes: only the classification, and only where a ledger row
// says why.
import { readFileSync, writeFileSync } from "node:fs";
import { loadLedger } from "./ledger.mjs";

const manifestPath = new URL("manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const ledger = loadLedger();

const REASON_CLASSES = [
  [/holds no object to address|no such object/i, "NO-FIXTURE", "The sandbox course holds no object of this kind to address the route with."],
  [/Canvas or Morrow refused this read/i, "PROVIDER-REFUSED", "Canvas refused the request for this connection, so no expected state can be read back."],
  [/privacy boundary|not callable by name/i, "HELD", "Morrow holds this route behind a named capability that applies the learner privacy boundary."],
  [/could not build the argument shape/i, "NO-FIXTURE", "The route needs an argument shape this harness cannot build from the sandbox."],
  [/held this change behind one already waiting/i, "QUEUE-COLLISION", "Another request for the same target was still waiting, so this one was not settled."],
  [/no read that shows the saved result|did not complete and Canvas confirmed nothing/i, "NO-READBACK", "Canvas has no read that shows the saved result of this change."],
  [/requires a person to state|never claims that on a person/i, "NEEDS-A-PERSON", "Settling this needs a person to state what Canvas shows."],
  [/no exercise in the harness yet/i, "NOT-EXERCISED", "This control has no exercise in the harness yet."],
  [/no second course to compare|no learner has attempted|there is no score/i, "NEEDS-LEARNER-ATTEMPT", "The object exists only after a learner attempt, and the sandbox has none."],
  // The sandbox rule: a change may only address the connected course and objects this run made.
  [/owner_excluded_outside_the_connected_course/i, "OUT-OF-SANDBOX", "The change addresses something outside the connected course, which this harness never touches."],
  [/owner_excluded_outbound|owner_excluded_learner_messages/i, "OUTBOUND", "The change leaves Canvas for someone: a ticket, a message, or another course."],
  [/owner_excluded_signed_in_person_settings/i, "PERSON-SETTINGS", "The change alters the signed-in person's own account settings rather than course content."],
  [/owner_excluded_irreversible/i, "IRREVERSIBLE", "The change cannot be undone on a person or a whole course, so it is never attempted here."],
  [/owner_excluded_institution_account/i, "OUT-OF-SANDBOX", "The change addresses the institution account, which this harness never touches."],
  [/requires_installed_lti_tool_token/i, "NO-TENANT", "The route needs a token only an installed LTI tool holds."],
  [/approval_withheld/i, "APPROVAL-WITHHELD", "Morrow withheld the approval control, so the change was never sent."],
  [/^unreachable$|\bunreachable\b/i, "NO-FIXTURE", "The sandbox course holds no object of this kind to address the route with."],
  [/sent_unchecked|applied_or_unknown/i, "NO-READBACK", "Canvas has no read that shows the saved result of this change."],
  [/not_planned/i, "NO-FIXTURE", "Morrow could not plan the change from the arguments this harness could build."],
];

const counts = {};
let changed = 0;
for (const row of manifest.operations) {
  const evidence = ledger.rows[row.id];
  if (!evidence) continue;
  if (evidence.verdict === "PASS") {
    if (row.classification !== "PROVEN") { row.classification = "PROVEN"; delete row.reason; changed += 1; }
    row.proof = "PROVEN";
    continue;
  }
  if (evidence.verdict === "FAIL") {
    row.classification = "DEFECT";
    row.reason = String(evidence.reason ?? "The operation failed and the failure is recorded in the ledger.").slice(0, 300);
    row.proof = "FAILED";
    changed += 1;
    continue;
  }
  // The sweep records why it never attempted something in `reason`, and how a dispatched change
  // ended in `state`. Both are read, so a row is classified by whichever says why.
  // A row that already carries its own classification keeps it.
  if (evidence.classification) {
    row.classification = evidence.classification;
    row.reason = String(evidence.reason ?? "").slice(0, 300);
    row.proof = "BLOCKED";
    changed += 1;
    continue;
  }
  const reason = `${String(evidence.reason ?? "")} ${String(evidence.state ?? "")}`.trim();
  const match = REASON_CLASSES.find(([pattern]) => pattern.test(reason));
  row.classification = match ? match[1] : "BLOCKED-OTHER";
  row.reason = match ? match[2] : (reason.slice(0, 300) || "Blocked, with the reason recorded in the ledger.");
  row.proof = "BLOCKED";
  changed += 1;
}
for (const row of manifest.operations) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
manifest.counts = counts;
manifest.reclassifiedAt = new Date().toISOString();
manifest.reclassification = "Classification rewritten from Phase 1 evidence. A row with no ledger evidence keeps the classification it was given before the run.";
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ changed, counts }, null, 1));
