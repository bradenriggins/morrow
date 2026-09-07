// One rule decides what a failed Canvas write means for the course item it
// targeted. Every layer that reports such a failure uses this rule, so the
// operation record, the problem code and the words the person reads agree.
//
// The Canvas REST API and the New Quizzes APIs answer a write they refuse with
// a 4xx before anything is saved, so a 400, 403, 404, 409 or 422 proves the
// course item is unchanged: Morrow reports the change as not sent and leaves
// the item free for another attempt. Every other ending stays uncertain. A 5xx
// comes back after the request reached the application, so the change may
// already be saved. A 408 or a 429 can arrive after the work started. A
// network, abort or parse failure leaves no answer at all, which this rule
// treats as uncertain because the status is not an integer. Morrow never sends
// an uncertain change again and tells the person Canvas may have received it.
//
// Moodle keeps its own branch in the service worker: a Moodle form post can
// answer with a validation page after the change was saved, so a Moodle status
// never decides this on its own.
//
// The uncertain half is live-unverified. A real Canvas 5xx after a committed
// write cannot be produced locally, so it is proved against fixtures only.
//
// Chrome serializes an injected function without its module scope, so the two
// in-page executors (src/canvas-content.js and src/item-bank-executor.js) each
// carry a copy of this expression.
// scripts/test/canvas-write-outcome-class.test.mjs executes every copy and
// fails if one of them disagrees with this file.
export const canvasWriteOutcomeUncertain = (status) => !(
  Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429
);

// The problem code a failed Bridge result carries back to Morrow. `unknown` is
// the service worker's own uncertainty test, which holds the Moodle branch, and
// it wins over everything else: an uncertain change is never reported as not
// sent. A Canvas write the provider refused is reported as not sent, so the
// gateway settles that record as failed and leaves the course item free. A
// Moodle failure keeps the shared failed code, because a Moodle status alone
// never proves the form post changed nothing.
export function bridgeWriteFailureCode({ unknown, sent, provider, kind, status }) {
  if (unknown) return "write_outcome_unknown";
  if (sent === false) return "canvas_request_not_sent";
  return provider === "canvas" && kind === "invoke_write" && !canvasWriteOutcomeUncertain(status)
    ? "canvas_request_not_sent"
    : "canvas_request_failed";
}
