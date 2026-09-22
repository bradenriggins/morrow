// Rows written before the verdict rule was corrected, re-judged by the same rule the runner uses
// now. Nothing is re-run: only the verdict a recorded state and detail already justified.
import { loadLedger, saveLedger } from "./ledger.mjs";

const BLOCKED_STATES = new Set(["excluded", "unreachable", "not_planned", "sent_unchecked", "applied_or_unknown",
  "approval_withheld", "approved", "unsettled", "closed_by_person", "cancelled", "refused"]);

const ledger = loadLedger();
let changed = 0;
for (const row of Object.values(ledger.rows)) {
  if (row.kind !== "write" || row.verdict !== "FAIL") continue;
  const detail = String(row.detail ?? row.reason ?? "");
  let reason = "";
  if (/waiting for approval|existing request/i.test(detail)) {
    reason = "Morrow held this change behind one already waiting on the same target; this run did not settle it.";
  } else if (/input is invalid|Check this input/i.test(detail)) {
    reason = `This harness could not build the argument shape the route requires: ${/Check this input: ([^.]+)\./.exec(detail)?.[1] ?? "see detail"}.`;
  } else if (BLOCKED_STATES.has(String(row.state))) {
    reason = `The change did not complete and Canvas confirmed nothing: ${row.state}.`;
  }
  if (reason) {
    row.verdict = "BLOCKED";
    row.reason = reason;
    row.reclassified = true;
    changed += 1;
  }
}
saveLedger(ledger);
const counts = {};
for (const row of Object.values(ledger.rows)) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
console.log(JSON.stringify({ reclassified: changed, counts }));
