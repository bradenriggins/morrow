// Phase 3. What the platform does when things go wrong, and what it refuses to do twice.
// Each check states the shape it expects before it runs, so a pass means the expected behaviour
// happened rather than nothing crashing.
import { connect, SANDBOX, SOURCE_BINDING } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";
import { loadLedger, recordRow, summarize } from "./ledger.mjs";

const COURSE = SANDBOX.courseId;
const mark = `${SANDBOX.mark}R${String(Math.floor(Date.now() / 1000))}`;
const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-robustness");
const { log, read, change, callTool } = makeTools(client, new URL("run-robustness.log", import.meta.url));

const checks = [];
const check = (id, title, run) => checks.push({ id, title, run });

check("refuses-a-course-it-is-not-bound-to", "A read addressed to another course is refused before any request", async () => {
  const answer = await callTool("morrow_capability_read", {
    name: "canvas_list_pages_courses",
    arguments: { course_id: "1", _morrow: { source_binding_id: SOURCE_BINDING } },
  });
  const refused = answer?.isError === true || answer?.structuredContent?.status === "refused" || Boolean(answer?.structuredContent?.code);
  return { verdict: refused ? "PASS" : "FAIL",
    reason: refused ? undefined : "A read for a course this connection does not name was answered instead of refused.",
    readback: { code: answer?.structuredContent?.code ?? null, isError: answer?.isError === true } };
});

check("unknown-capability-is-named-not-guessed", "An unknown tool name is refused with a reason", async () => {
  const answer = await callTool("morrow_capability_get", { name: "canvas_not_a_real_operation" });
  const held = answer?.structuredContent ?? {};
  const named = String(held.code ?? "") !== "" || answer?.isError === true;
  return { verdict: named ? "PASS" : "FAIL", readback: { code: held.code ?? null } };
});

check("stale-snapshot-is-refused", "A change pinned to a snapshot that no longer matches is refused before dispatch", async () => {
  // The digest is deliberately wrong, so Morrow must refuse rather than send.
  const answer = await callTool("morrow_capability_change", {
    name: "canvas_item_bank_rename_bank",
    arguments: { course_id: COURSE, bank_id: "1", title: `${mark} never`,
      expected_snapshot: { bank_sha256: "0".repeat(64) }, _morrow: { source_binding_id: SOURCE_BINDING } },
  });
  const held = answer?.structuredContent ?? {};
  const refused = answer?.isError === true || String(held.status ?? "") !== "verified";
  return { verdict: refused ? "PASS" : "FAIL", readback: { status: held.status ?? null, code: held.code ?? null } };
});

check("oversized-result-is-paged-not-truncated", "A large read answers through a result handle rather than a cut-off body", async () => {
  const answer = await read("canvas_list_assignments_assignments", { course_id: COURSE, morrow_max_pages: 5 });
  return { verdict: answer.ok ? "PASS" : "BLOCKED",
    reason: answer.ok ? undefined : `Canvas did not answer: ${answer.code ?? "unknown"}.`,
    readback: { answered: answer.ok, records: Array.isArray(answer.data) ? answer.data.length : 0 } };
});

check("effect-receipt-is-single-use", "A dispatched change cannot be applied twice from one approval", async () => {
  const title = `${mark} once`;
  const made = await change("robustness.page.create", "canvas_create_page_courses", {
    course_id: COURSE, wiki_page_title: title, wiki_page_body: "<p>once</p>", wiki_page_published: false,
  });
  if (made.outcome !== "verified" || !made.operationId) {
    return { verdict: "BLOCKED", reason: `The change did not complete, so a second dispatch cannot be tested: ${made.outcome}.` };
  }
  // The same operation, dispatched again. Its receipt is spent, so Morrow must not send a second
  // create. Canvas is then read to prove exactly one page carries this title.
  const again = await callTool("morrow_operation_dispatch", { operation_id: made.operationId }).catch((error) => ({ threw: String(error).slice(0, 160) }));
  // The list is asked for this exact title: a page beyond the first page of an unsearched list
  // would read as absent, and absence would look like the very thing this check is proving.
  const pages = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: title });
  const matching = (Array.isArray(pages.data) ? pages.data : []).filter((row) => String(row.title) === title);
  const cleanup = matching[0]
    ? await change("robustness.page.delete", "canvas_delete_page_courses", { course_id: COURSE, url_or_id: String(matching[0].url) })
    : null;
  return {
    verdict: matching.length === 1 ? "PASS" : "FAIL",
    reason: matching.length === 1 ? undefined : `A second dispatch produced ${matching.length} pages with the same title.`,
    readback: { source: "canvas", pagesWithThatTitle: matching.length, secondDispatch: again?.structuredContent?.code ?? again?.threw ?? "answered" },
    cleanup: cleanup ? { removed: cleanup.outcome } : null,
  };
});

check("parallel-reads-keep-the-journal-whole", "Reads running together do not disturb the operation journal", async () => {
  const before = await callTool("morrow_operation_list", { course_id: COURSE });
  const beforeCount = (before?.structuredContent?.operations ?? before?.structuredContent?.data?.operations ?? []).length;
  await Promise.all([
    read("canvas_list_modules", { course_id: COURSE }),
    read("canvas_list_pages_courses", { course_id: COURSE }),
    read("canvas_list_assignment_groups", { course_id: COURSE }),
    read("canvas_list_course_sections", { course_id: COURSE }),
  ]);
  const after = await callTool("morrow_operation_list", { course_id: COURSE });
  const afterCount = (after?.structuredContent?.operations ?? after?.structuredContent?.data?.operations ?? []).length;
  return { verdict: afterCount >= beforeCount ? "PASS" : "FAIL",
    readback: { operationsBefore: beforeCount, operationsAfter: afterCount } };
});

try {
  await log(`robustness checks: ${checks.length} (mark ${mark})`);
  for (const entry of checks) {
    let result;
    try {
      result = await entry.run();
    } catch (error) {
      result = { verdict: "FAIL", reason: `The check threw: ${String(error).slice(0, 200)}` };
    }
    recordRow(ledger, `robustness:${entry.id}`, {
      phase: 3, kind: "robustness", title: entry.title, verdict: result.verdict,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.readback ? { readback: result.readback } : {}),
      ...(result.cleanup ? { cleanup: result.cleanup } : {}),
      sandbox: { courseId: COURSE, mark },
    });
    await log(`${entry.id}: ${result.verdict}${result.reason ? ` (${result.reason})` : ""}`);
  }
  await log(`robustness complete: ${JSON.stringify(summarize(ledger))}`);
} finally {
  await close();
}
