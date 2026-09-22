// Zero left behind, proven by reading the sandbox rather than by trusting the run's own cleanup.
// Every collection this harness can create in is listed and searched for its mark; whatever is
// still there is removed and the course is read again.
import { connect, SANDBOX } from "./connect.mjs";
import { makeTools } from "./lib/tools.mjs";
import { loadLedger, recordRow } from "./ledger.mjs";

const COURSE = SANDBOX.courseId;
// This harness's own marks only. Another lane's fixtures (MORROW_QA_, MORROW_TEST_) are not
// matched here and are never touched.
const MARK = /MORROWPROOF|MORROWSWEEP/i;

/**
 * A title can be a mark on an object this harness made, or a title it wrote over an object the
 * course already held: a write phase proves an update against a real record, and the record keeps
 * the new title afterwards. Deleting by title alone would destroy that real content.
 *
 * So an object is only removable when its own identifier carries the mark, which happens when
 * Canvas derived the identifier from a title this harness chose at creation. A marked title on an
 * identifier the harness never generated is reported for a person to rename back, never deleted.
 */
const madeHere = (identifier) => MARK.test(String(identifier ?? ""));
const ledger = loadLedger();
const { client, close } = await connect("morrow-proof-clean");
const { log, read, change } = makeTools(client, new URL("verify-clean.log", import.meta.url));

// Each collection this harness writes into, how its rows are named, and how one is removed.
const PLACES = [
  { key: "pages", list: ["canvas_list_pages_courses", { course_id: COURSE }], name: (row) => row.title,
    remove: (row) => ["canvas_delete_page_courses", { course_id: COURSE, url_or_id: String(row.url) }] },
  { key: "assignments", list: ["canvas_list_assignments_assignments", { course_id: COURSE }], name: (row) => row.name,
    remove: (row) => ["canvas_delete_assignment", { course_id: COURSE, id: String(row.id) }] },
  { key: "discussions", list: ["canvas_list_discussion_topics_courses", { course_id: COURSE }], name: (row) => row.title,
    remove: (row) => ["canvas_delete_topic_courses", { course_id: COURSE, topic_id: String(row.id) }] },
  { key: "quizzes", list: ["canvas_list_quizzes_in_course", { course_id: COURSE }], name: (row) => row.title,
    remove: (row) => ["canvas_delete_quiz", { course_id: COURSE, id: String(row.id) }] },
  { key: "modules", list: ["canvas_list_modules", { course_id: COURSE }], name: (row) => row.name,
    remove: (row) => ["canvas_delete_module", { course_id: COURSE, id: String(row.id) }] },
  { key: "assignment_groups", list: ["canvas_list_assignment_groups", { course_id: COURSE }], name: (row) => row.name,
    remove: (row) => ["canvas_destroy_assignment_group", { course_id: COURSE, assignment_group_id: String(row.id) }] },
  { key: "sections", list: ["canvas_list_course_sections", { course_id: COURSE }], name: (row) => row.name,
    remove: (row) => ["canvas_delete_section", { id: String(row.id) }] },
  { key: "group_categories", list: ["canvas_list_group_categories_for_context_courses", { course_id: COURSE }], name: (row) => row.name,
    remove: (row) => ["canvas_delete_group_category", { group_category_id: String(row.id) }] },
  { key: "rubrics", list: ["canvas_list_rubrics_courses", { course_id: COURSE }], name: (row) => row.title,
    // Canvas's rubric delete is published under the name `canvas_delete_single`, which names no
    // noun at all; the route is DELETE /v1/courses/{course_id}/rubrics/{id}.
    remove: (row) => ["canvas_delete_single", { course_id: COURSE, id: String(row.id) }] },
];

const found = async () => {
  const left = [];
  for (const place of PLACES) {
    const answer = await read(place.list[0], place.list[1]);
    const rows = Array.isArray(answer.data) ? answer.data : [];
    for (const row of rows) {
      if (!MARK.test(String(place.name(row) ?? ""))) continue;
      const identifier = String(row.url ?? row.id ?? "");
      // Pages carry a slug Canvas derived from the title they were created with. Everything else
      // is addressed by a numeric id that carries no mark, so those are matched by title as before
      // and are only ever objects a create proof made.
      const removable = place.key !== "pages" || madeHere(identifier);
      left.push({ place: place.key, id: identifier, name: place.name(row), row, removable, remove: place.remove(row) });
    }
  }
  return left;
};

try {
  const before = await found();
  await log(`marked objects still in the sandbox: ${before.length}`);
  const removed = [];
  const renamedRealContent = before.filter((entry) => entry.removable === false);
  for (const entry of before.filter((candidate) => candidate.removable !== false)) {
    const answer = await change(`clean.${entry.place}`, entry.remove[0], entry.remove[1]);
    removed.push({ place: entry.place, id: entry.id, name: entry.name, outcome: answer.outcome });
    await log(`${entry.place} ${entry.name}: ${answer.outcome}`);
  }
  for (const entry of renamedRealContent) {
    await log(`${entry.place} ${entry.name}: left alone, its identifier ${entry.id} was not made by this harness`);
  }
  // Read the course again. What it still holds is what this harness really left.
  const after = await found();
  const stillRemovable = after.filter((entry) => entry.removable !== false);
  recordRow(ledger, "cleanup:verified-against-canvas", {
    phase: 1, kind: "cleanup", verdict: stillRemovable.length === 0 ? "PASS" : "FAIL",
    ...(stillRemovable.length ? { reason: `${stillRemovable.length} object(s) this harness made remain: ${stillRemovable.map((row) => `${row.place}:${row.name}`).join(", ")}.` } : {}),
    ...(after.length > stillRemovable.length
      ? { carriesAMarkedTitleButWasNotMadeHere: after.filter((row) => row.removable === false).map((row) => ({ place: row.place, id: row.id, title: row.name })) }
      : {}),
    readback: { source: "canvas", markedBefore: before.length, removed, markedAfter: after.length, removableAfter: stillRemovable.length },
    sandbox: { courseId: COURSE, mark: SANDBOX.mark },
  });
  await log(`marked objects after cleanup: ${after.length}`);
  console.log(JSON.stringify({ before: before.length, after: after.length }, null, 1));
} finally {
  await close();
}
