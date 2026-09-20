// One focused proof of undo: a page is created, Canvas is asked whether it is there, the undo is
// asked for with the correcting change stated, and Canvas is asked again. The verdict is whatever
// Canvas says, and the ledger keeps the reason either way.
import { connect, SANDBOX, SOURCE_BINDING } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";
import { loadLedger, recordRow } from "./ledger.mjs";

const COURSE = SANDBOX.courseId;
const mark = `${SANDBOX.mark}UNDO${String(Math.floor(Date.now() / 1000))}`;
const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-undo");
const { log, read, change, callTool } = makeTools(client, new URL("prove-undo.log", import.meta.url));

try {
  const title = `${mark} page`;
  const made = await change("undo.create", "canvas_create_page_courses", {
    course_id: COURSE, wiki_page_title: title, wiki_page_body: "<p>undo me</p>", wiki_page_published: false,
  });
  const before = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: title });
  const saved = (Array.isArray(before.data) ? before.data : [])[0];
  if (!made.operationId || !saved) {
    recordRow(ledger, "morrow_operation_undo", { phase: 1, kind: "tool", verdict: "BLOCKED",
      reason: `The page this proof needs was not created (${made.outcome}), so undo could not be asked for.` });
    await log(`undo: blocked, create was ${made.outcome}`);
  } else {
    const answer = await callTool("morrow_operation_undo", {
      operation_id: made.operationId,
      correction_tool: "canvas_delete_page_courses",
      correction_arguments: { course_id: COURSE, url_or_id: String(saved.url), _morrow: { source_binding_id: SOURCE_BINDING } },
    }, 600_000).catch((error) => ({ threw: String(error).slice(0, 200) }));
    const after = await read("canvas_list_pages_courses", { course_id: COURSE, search_term: title });
    const gone = (Array.isArray(after.data) ? after.data : []).length === 0;
    const problem = answer?.structuredContent?.data?.code ?? answer?.threw ?? null;
    recordRow(ledger, "morrow_operation_undo", {
      phase: 1, kind: "tool", verdict: gone ? "PASS" : "FAIL",
      ...(gone ? {} : { reason: `Morrow refused to correct a change it had verified: ${problem}. Canvas still holds the page.` }),
      readback: { source: "canvas", pageGoneAfterUndo: gone, problem, operationId: made.operationId, createOutcome: made.outcome },
      sandbox: { courseId: COURSE, mark },
    });
    await log(`undo: ${gone ? "PASS" : "FAIL"} (${problem ?? "no problem code"})`);
    // Whatever undo did or did not do, the page this proof made does not stay.
    if (!gone) {
      const removed = await change("undo.cleanup", "canvas_delete_page_courses", { course_id: COURSE, url_or_id: String(saved.url) });
      await log(`undo cleanup: ${removed.outcome}`);
    }
  }
} finally {
  await close();
}
