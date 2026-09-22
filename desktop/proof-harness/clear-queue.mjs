// A run at this scale leaves operations unresolved, and an unresolved operation holds its target:
// the next change to the same object is answered with the request already waiting instead of a new
// approval. This closes what is still open so the sandbox can be tidied and the next run starts clean.
import { connect, SANDBOX } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";
import { loadLedger, recordRow } from "./ledger.mjs";

const COURSE = SANDBOX.courseId;
const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-queue");
const { log, callTool } = makeTools(client, new URL("clear-queue.log", import.meta.url));

const openOperations = async () => {
  const listed = await callTool("morrow_operation_list", { course_id: COURSE });
  const held = listed?.structuredContent ?? {};
  const rows = held.operations ?? held.data?.operations ?? [];
  return (Array.isArray(rows) ? rows : []).filter((row) => !["verified", "closed_by_person", "cancelled", "failed"].includes(String(row.state)));
};

try {
  const before = await openOperations();
  await log(`operations still open: ${before.length}`);
  let closed = 0;
  for (const row of before) {
    const id = row.operationId ?? row.id;
    if (!id) continue;
    // Only a request that was never sent is cancelled here. Closing one that may have landed
    // needs a person to state what they saw in Canvas, which this harness must never claim on
    // their behalf, so those are left open and reported instead.
    const neverSent = String(row.state) === "awaiting_approval" && Number(row.dispatchAttempt ?? 0) === 0;
    if (!neverSent) continue;
    const answer = await callTool("morrow_operation_cancel", { operation_id: id }).catch(() => null);
    if (answer && !answer.isError) closed += 1;
  }
  const after = await openOperations();
  const needsPerson = after.filter((row) => !(String(row.state) === "awaiting_approval" && Number(row.dispatchAttempt ?? 0) === 0));
  // Everything that could be cancelled was. What is left needs a person to say what Canvas shows,
  // which is the platform behaving correctly, so it is not counted as a failure here.
  const cancellableLeft = after.filter((row) => String(row.state) === "awaiting_approval" && Number(row.dispatchAttempt ?? 0) === 0);
  recordRow(ledger, "queue:closed-after-write-phase", {
    phase: 1, kind: "maintenance", verdict: cancellableLeft.length === 0 ? "PASS" : "FAIL",
    ...(cancellableLeft.length ? { reason: `${cancellableLeft.length} request(s) that were never sent could not be cancelled.` } : {}),
    readback: { source: "morrow-journal", openBefore: before.length, cancelled: closed, openAfter: after.length,
      leftForAPerson: needsPerson.length },
    ...(needsPerson.length ? { note: "Morrow requires a person to state what they saw in Canvas before an operation that may have landed is closed. This harness does not claim that on their behalf." } : {}),
    sandbox: { courseId: COURSE },
  });
  await log(`closed ${closed}; still open ${after.length}`);
  console.log(JSON.stringify({ before: before.length, closed, after: after.length }));
} finally {
  await close();
}
