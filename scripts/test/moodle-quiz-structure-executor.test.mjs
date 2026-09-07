import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleQuizStructureInPage } from "../../connector/extension/src/moodle-quiz-structure-executor.js";

const operations = Object.freeze({
  read: { key: "moodle.form.mod.quiz.edit.structure.read.v1", toolName: "moodle_get_quiz_structure", provider: "moodle", readOnly: true },
  move: { key: "moodle.form.mod.quiz.edit.slot.move.write.v1", toolName: "moodle_reorder_quiz_slot", provider: "moodle", readOnly: false },
  mark: { key: "moodle.form.mod.quiz.edit.slot.maxmark.write.v1", toolName: "moodle_set_quiz_slot_mark", provider: "moodle", readOnly: false },
  pageBreak: { key: "moodle.form.mod.quiz.edit.slot.pagebreak.write.v1", toolName: "moodle_set_quiz_page_break", provider: "moodle", readOnly: false },
  remove: { key: "moodle.form.mod.quiz.edit.slot.remove.write.v1", toolName: "moodle_remove_quiz_slot", provider: "moodle", readOnly: false },
});

const PROOF = Object.freeze({
  method: "native_quiz_edit_action",
  read_route: "/mod/quiz/edit.php",
  write_route: "/mod/quiz/edit_rest.php",
  required_capability: "mod/quiz:manage",
  scope: "quiz_structure_only",
  question_bank_effect: "none",
});

test("Moodle Quiz slot operations are cataloged, routed, and add no Question bank write", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, operation.readOnly);
    assert.match(entry.description, /mod\/quiz:manage/);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\/public\/mod\/quiz\//);
    if (operation.readOnly) continue;
    assert.equal(entry.reviewTool, "moodle_get_quiz_structure");
    assert.match(entry.description, /creates, updates and deletes no Question bank entry/);
  }

  const removal = byTool.get("moodle_remove_quiz_slot");
  assert.equal(removal.destructive, true);
  assert.match(removal.description, /Removing a slot does not delete the underlying Question bank entry/);
  for (const toolName of ["moodle_get_quiz_structure", "moodle_reorder_quiz_slot", "moodle_set_quiz_slot_mark", "moodle_set_quiz_page_break"]) {
    assert.equal(byTool.get(toolName).destructive, undefined);
  }

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleQuizStructureInPage \} from "\.\/moodle-quiz-structure-executor\.js";/);
  assert.match(worker, /MOODLE_QUIZ_STRUCTURE_OPERATION_KEYS = new Set\(\[/);
  assert.match(worker, /func: executeMoodleQuizStructureInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }

  // The deterministic Question bank hold these operations must never relax.
  const executor = readFileSync(new URL("connector/extension/src/moodle-executor.js", root), "utf8");
  assert.match(executor, /moodle_question_bank_impact_unresolved/);
  assert.equal(catalog.operations.some((entry) => /^moodle_(create|update)_quiz_.*_question$/.test(entry.toolName)), false);
});

test("Moodle Quiz slot operations change one slot, prove the whole layout, and fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-quiz-structure-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const SESSKEY = "moodle-private-session";
  const requests = [];
  const posts = [];
  let origin = "";
  let browser;
  let state;

  const initialState = () => ({
    quizId: 7,
    sections: [40, 41],
    slots: [
      { id: 11, section: 40, page: 1, qtype: "multichoice", name: "Cell membrane transport", mark: 1 },
      { id: 12, section: 40, page: 1, qtype: "truefalse", name: "Osmosis direction", mark: 2 },
      { id: 13, section: 40, page: 2, qtype: "description", name: "Read this before you continue", mark: null },
      { id: 14, section: 41, page: 3, qtype: "essay", name: "Explain diffusion", mark: 5 },
    ],
    editable: true,
    render: "complete",
  });

  const oversizedState = () => ({
    quizId: 7,
    sections: [40],
    slots: Array.from({ length: 101 }, (_, index) => ({ id: 200 + index, section: 40, page: index + 1, qtype: "essay", name: `Question ${index + 1}`, mark: 1 })),
    editable: true,
    render: "complete",
  });

  const renumber = () => {
    let previous = null;
    let next = 0;
    for (const slot of state.slots) {
      if (slot.page !== previous) {
        previous = slot.page;
        next += 1;
      }
      slot.page = next;
    }
  };

  const formatMark = (value) => Number(value).toFixed(2);
  const renderPage = (pageNumber) => `<li class="pagenumber activity yui3-dd-drop page" id="page-${pageNumber}"><h4 class="pagetitle">Page ${pageNumber}</h4><span class="add-menu-outer"></span></li>`;
  const renderSlot = (slot, position, join) => {
    const move = state.editable ? `<a href="#" class="editing_move" data-action="move" aria-label="Move question ${position}"><i class="icon"></i></a>` : "";
    const remove = state.editable ? `<a href="edit.php?cmid=9&amp;sesskey=${SESSKEY}&amp;remove=${position}" class="cm-edit-action editing_delete" data-action="delete" title="Delete"><i class="icon"></i></a>` : "";
    const mark = slot.mark === null
      ? '<span class="instancemaxmarkcontainer infoitem"><span class="instancemaxmark decimalplaces_2"></span><span class="editing_maxmark"><i class="icon"></i></span></span>'
      : `<span class="instancemaxmarkcontainer"><span class="instancemaxmark decimalplaces_2" title="Maximum mark">${formatMark(slot.mark)}</span><span><a href="#" class="editing_maxmark" data-action="editmaxmark" title="Edit maximum mark"><i class="icon"></i></a></span></span>`;
    const splitJoin = join
      ? `<span class="page_split_join_wrapper"><a href="repaginate.php?quizid=${state.quizId}&amp;slot=${position}&amp;repag=${join === "addpagebreak" ? 2 : 1}&amp;sesskey=${SESSKEY}" class="page_split_join cm-edit-action btn btn-sm icon-no-margin" data-action="${join}" role="button"><i class="icon"></i></a></span>`
      : "";
    const question = `<div class="activityinstance"><div><a class="questionname" href="/question/bank/editquestion/question.php?id=${900 + slot.id}&amp;cmid=9"><span class="instancename">${slot.name}</span></a></div></div>`;
    return `<li class="activity ${slot.qtype} qtype_${slot.qtype} slot" id="slot-${slot.id}" data-canfinish="1"><div class="mod-indent-outer" id="mod-indent-outer-slot-${slot.id}"><span class="slotnumber">${position}</span>${question}<div class="actions">${move}${remove}${mark}</div></div>${splitJoin}</li>`;
  };
  const editPage = () => {
    const slots = state.slots;
    let sectionsHtml = "";
    for (const sectionId of state.sections) {
      const inSection = slots.filter((slot) => slot.section === sectionId);
      let items = "";
      let currentPage = null;
      for (const slot of inSection) {
        const index = slots.indexOf(slot);
        const position = index + 1;
        if (slot.page !== currentPage && state.render !== "slot-before-page") {
          items += renderPage(slot.page);
          currentPage = slot.page;
        }
        const next = slots[index + 1];
        const lastInSection = slot === inSection[inSection.length - 1];
        const offersBreak = state.editable && Boolean(next) && !lastInSection;
        const samePage = state.render === "inconsistent-break" ? false : Boolean(next) && next.page === slot.page;
        items += renderSlot(slot, position, offersBreak ? (samePage ? "addpagebreak" : "removepagebreak") : "");
      }
      sectionsHtml += `<li class="section main clearfix" id="section-${sectionId}" role="presentation" data-sectionname="Section ${sectionId}"><div class="content"><div class="section-heading"><h3><span class="sectioninstance"><span class="instancesection">Section ${sectionId}</span></span></h3></div><ul class="section img-text">${items}</ul></div></li>`;
    }
    const courseClass = state.render === "foreign-course" ? "course-9" : "course-2";
    return `<!doctype html><html><head><title>Editing quiz</title></head><body id="page-mod-quiz-edit" class="path-mod-quiz ${courseClass} pagelayout-incourse"><div class="mod-quiz-edit-content"><ul class="slots" role="presentation">${sectionsHtml}</ul></div></body></html>`;
  };

  const applyMove = (slotId, previousId, page) => {
    const index = state.slots.findIndex((slot) => slot.id === slotId);
    const [moved] = state.slots.splice(index, 1);
    if (previousId) state.slots.splice(state.slots.findIndex((slot) => slot.id === previousId) + 1, 0, moved);
    else state.slots.unshift(moved);
    moved.page = page;
    renumber();
  };
  const applyPageBreak = (slotId, value) => {
    const index = state.slots.findIndex((slot) => slot.id === slotId);
    if (value === "1") {
      state.slots[index].page = state.slots[index - 1].page;
      for (let cursor = index + 1; cursor < state.slots.length; cursor += 1) state.slots[cursor].page -= 1;
    } else {
      for (let cursor = index; cursor < state.slots.length; cursor += 1) state.slots[cursor].page += 1;
    }
    renumber();
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/quiz/edit.php") {
      if (target.searchParams.get("cmid") !== "9") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(editPage());
      return;
    }
    if (request.method === "POST" && target.pathname === "/mod/quiz/edit_rest.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(Object.fromEntries(fields.entries()));
      assert.equal(target.search, "");
      assert.equal(fields.get("sesskey"), SESSKEY);
      assert.equal(fields.get("courseid"), "2");
      assert.equal(fields.get("quizid"), "7");
      assert.equal(fields.get("class"), "resource");
      const slotId = state.driftToSlotId || Number(fields.get("id"));
      let payload = null;
      if (fields.get("action") === "DELETE") {
        state.slots.splice(state.slots.findIndex((slot) => slot.id === slotId), 1);
        renumber();
        payload = { newsummarks: "8.00", deleted: true, newnumquestions: state.slots.length };
      } else if (fields.get("field") === "move") {
        applyMove(slotId, Number(fields.get("previousid") || 0), Number(fields.get("page")));
        payload = { visible: true };
      } else if (fields.get("field") === "updatemaxmark") {
        state.slots.find((slot) => slot.id === slotId).mark = Number(fields.get("maxmark"));
        payload = { instancemaxmark: formatMark(fields.get("maxmark")), newsummarks: "9.50" };
      } else if (fields.get("field") === "updatepagebreak") {
        applyPageBreak(slotId, fields.get("value"));
        payload = { slots: Object.fromEntries(state.slots.map((slot, index) => [index + 1, { id: slot.id, slot: index + 1, page: slot.page }])) };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    state = initialState();
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleQuizStructureInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }),
    );
    const readStructure = async () => {
      const result = await execute(operations.read, { course_id: 2, module_id: 9 });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result;
    };
    const loseNextEditRestResponse = () => page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const target = new URL(parameters[0], globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && target.pathname === "/mod/quiz/edit_rest.php") {
          globalThis.fetch = nativeFetch;
          throw new TypeError("edit_rest response lost after dispatch");
        }
        return response;
      };
    });

    const slot = (values) => ({ mark_decimal_places: 2, can_reorder: true, can_set_mark: true, can_remove: true, ...values });
    const INITIAL_SLOTS = [
      slot({ slot_id: 11, position: 1, page: 1, section_id: 40, question_type: "multichoice", name: "Cell membrane transport", max_mark: "1.00", starts_new_page: true, can_set_page_break: false }),
      slot({ slot_id: 12, position: 2, page: 1, section_id: 40, question_type: "truefalse", name: "Osmosis direction", max_mark: "2.00", starts_new_page: false, can_set_page_break: true }),
      slot({ slot_id: 13, position: 3, page: 2, section_id: 40, question_type: "description", name: "Read this before you continue", max_mark: null, starts_new_page: true, can_set_mark: false, can_set_page_break: true }),
      slot({ slot_id: 14, position: 4, page: 3, section_id: 41, question_type: "essay", name: "Explain diffusion", max_mark: "5.00", starts_new_page: true, can_set_page_break: false }),
    ];
    const layout = (slots, pageCount) => ({
      schema: "morrow.moodle-quiz-structure.v1",
      course_id: 2,
      module_id: 9,
      complete: true,
      quiz_id: 7,
      section_ids: [40, 41],
      section_count: 2,
      slot_count: slots.length,
      page_count: pageCount,
      slots,
      slot_changes_available: true,
      proof: PROOF,
    });

    // The complete native layout, with the native control each change needs.
    const first = await readStructure();
    assert.deepEqual(first.data, layout(INITIAL_SLOTS, 3));
    assert.match(first.snapshot_digest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first).includes(SESSKEY), false);
    assert.equal(posts.length, 0);
    assert.equal(requests.filter((entry) => entry.pathname === "/mod/quiz/edit.php").length, 1);

    // Every refusal below happens before any native change is sent.
    const digest = first.snapshot_digest;
    const refuse = async (operation, argumentsValue, error, expiresAt) => {
      const before = posts.length;
      assert.deepEqual(await execute(operation, argumentsValue, expiresAt), { ok: false, sent: false, ...(error === "moodle_execution_expired" || error === "moodle_quiz_structure_arguments_invalid" ? {} : { status: 200 }), error });
      assert.equal(posts.length, before, `${operation.toolName} sent a native request while refusing ${error}`);
    };
    await refuse(operations.read, { course_id: 2, module_id: 9, slot_id: 11 }, "moodle_quiz_structure_arguments_invalid");
    await refuse(operations.read, { course_id: 3, module_id: 9 }, "moodle_quiz_structure_arguments_invalid");
    await refuse(operations.read, { course_id: 2, module_id: 9 }, "moodle_execution_expired", Date.now() - 1);
    await refuse(operations.mark, { course_id: 2, module_id: 9, slot_id: 12, max_mark: "two", expected_digest: digest }, "moodle_quiz_structure_arguments_invalid");
    await refuse(operations.move, { course_id: 2, module_id: 9, slot_id: 12, after_slot_id: 12, expected_digest: digest }, "moodle_quiz_structure_arguments_invalid");
    await refuse(operations.remove, { course_id: 2, module_id: 9, slot_id: 12, expected_digest: "0".repeat(64) }, "moodle_expected_digest_mismatch");
    await refuse(operations.remove, { course_id: 2, module_id: 9, slot_id: 99, expected_digest: digest }, "moodle_quiz_structure_slot_not_found");
    await refuse(operations.remove, { course_id: 2, module_id: 9, slot_id: 14, expected_digest: digest }, "moodle_quiz_structure_section_would_be_empty");
    await refuse(operations.move, { course_id: 2, module_id: 9, slot_id: 14, after_slot_id: 11, expected_digest: digest }, "moodle_quiz_structure_section_would_be_empty");
    await refuse(operations.move, { course_id: 2, module_id: 9, slot_id: 11, after_slot_id: 14, expected_digest: digest }, "moodle_quiz_structure_move_across_sections_refused");
    await refuse(operations.move, { course_id: 2, module_id: 9, slot_id: 12, after_slot_id: 11, expected_digest: digest }, "moodle_quiz_structure_change_not_needed");
    await refuse(operations.move, { course_id: 2, module_id: 9, slot_id: 11, after_slot_id: null, expected_digest: digest }, "moodle_quiz_structure_change_not_needed");
    // The mark, the page break and the removal are each undefined on a slot the
    // native page does not offer them on.
    await refuse(operations.mark, { course_id: 2, module_id: 9, slot_id: 13, max_mark: "2", expected_digest: digest }, "moodle_quiz_structure_operation_not_offered");
    await refuse(operations.pageBreak, { course_id: 2, module_id: 9, slot_id: 11, starts_new_page: true, expected_digest: digest }, "moodle_quiz_structure_operation_not_offered");
    await refuse(operations.pageBreak, { course_id: 2, module_id: 9, slot_id: 14, starts_new_page: false, expected_digest: digest }, "moodle_quiz_structure_operation_not_offered");
    await refuse(operations.pageBreak, { course_id: 2, module_id: 9, slot_id: 12, starts_new_page: false, expected_digest: digest }, "moodle_quiz_structure_change_not_needed");
    await refuse(operations.mark, { course_id: 2, module_id: 9, slot_id: 12, max_mark: "2.00", expected_digest: digest }, "moodle_quiz_structure_change_not_needed");
    await refuse(operations.mark, { course_id: 2, module_id: 9, slot_id: 12, max_mark: "2.005", expected_digest: digest }, "moodle_quiz_structure_mark_precision_refused");

    // A slot list that moved on after the reviewed read is refused.
    state.slots[0].mark = 4;
    await refuse(operations.remove, { course_id: 2, module_id: 9, slot_id: 12, expected_digest: digest }, "moodle_expected_digest_mismatch");
    state = initialState();

    // One dispatch, then the complete layout back with exactly the approved change.
    const beforeMark = await readStructure();
    const markResult = await execute(operations.mark, { course_id: 2, module_id: 9, slot_id: 12, max_mark: "3.5", expected_digest: beforeMark.snapshot_digest });
    assert.equal(markResult.ok, true, JSON.stringify(markResult));
    assert.deepEqual(markResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(markResult.data, layout(INITIAL_SLOTS.map((entry) => (entry.slot_id === 12 ? { ...entry, max_mark: "3.50" } : entry)), 3));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { sesskey: SESSKEY, courseid: "2", quizid: "7", class: "resource", field: "updatemaxmark", id: "12", maxmark: "3.5" });

    state = initialState();
    const beforeBreak = await readStructure();
    const breakResult = await execute(operations.pageBreak, { course_id: 2, module_id: 9, slot_id: 12, starts_new_page: true, expected_digest: beforeBreak.snapshot_digest });
    assert.equal(breakResult.ok, true, JSON.stringify(breakResult));
    assert.deepEqual(breakResult.data, layout([
      slot({ slot_id: 11, position: 1, page: 1, section_id: 40, question_type: "multichoice", name: "Cell membrane transport", max_mark: "1.00", starts_new_page: true, can_set_page_break: false }),
      slot({ slot_id: 12, position: 2, page: 2, section_id: 40, question_type: "truefalse", name: "Osmosis direction", max_mark: "2.00", starts_new_page: true, can_set_page_break: true }),
      slot({ slot_id: 13, position: 3, page: 3, section_id: 40, question_type: "description", name: "Read this before you continue", max_mark: null, starts_new_page: true, can_set_mark: false, can_set_page_break: true }),
      slot({ slot_id: 14, position: 4, page: 4, section_id: 41, question_type: "essay", name: "Explain diffusion", max_mark: "5.00", starts_new_page: true, can_set_page_break: false }),
    ], 4));
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1], { sesskey: SESSKEY, courseid: "2", quizid: "7", class: "resource", field: "updatepagebreak", id: "12", value: "2" });

    state = initialState();
    const beforeMove = await readStructure();
    const moveResult = await execute(operations.move, { course_id: 2, module_id: 9, slot_id: 13, after_slot_id: 11, expected_digest: beforeMove.snapshot_digest });
    assert.equal(moveResult.ok, true, JSON.stringify(moveResult));
    assert.deepEqual(moveResult.data, layout([
      slot({ slot_id: 11, position: 1, page: 1, section_id: 40, question_type: "multichoice", name: "Cell membrane transport", max_mark: "1.00", starts_new_page: true, can_set_page_break: false }),
      slot({ slot_id: 13, position: 2, page: 1, section_id: 40, question_type: "description", name: "Read this before you continue", max_mark: null, starts_new_page: false, can_set_mark: false, can_set_page_break: true }),
      slot({ slot_id: 12, position: 3, page: 1, section_id: 40, question_type: "truefalse", name: "Osmosis direction", max_mark: "2.00", starts_new_page: false, can_set_page_break: true }),
      slot({ slot_id: 14, position: 4, page: 2, section_id: 41, question_type: "essay", name: "Explain diffusion", max_mark: "5.00", starts_new_page: true, can_set_page_break: false }),
    ], 2));
    assert.equal(posts.length, 3);
    assert.deepEqual(posts[2], { sesskey: SESSKEY, courseid: "2", quizid: "7", class: "resource", field: "move", id: "13", sectionId: "40", page: "1", previousid: "11" });

    state = initialState();
    const beforeRemove = await readStructure();
    const removeResult = await execute(operations.remove, { course_id: 2, module_id: 9, slot_id: 12, expected_digest: beforeRemove.snapshot_digest });
    assert.equal(removeResult.ok, true, JSON.stringify(removeResult));
    assert.deepEqual(removeResult.data, {
      ...layout([
        slot({ slot_id: 11, position: 1, page: 1, section_id: 40, question_type: "multichoice", name: "Cell membrane transport", max_mark: "1.00", starts_new_page: true, can_set_page_break: false }),
        slot({ slot_id: 13, position: 2, page: 2, section_id: 40, question_type: "description", name: "Read this before you continue", max_mark: null, starts_new_page: true, can_set_mark: false, can_set_page_break: true }),
        slot({ slot_id: 14, position: 3, page: 3, section_id: 41, question_type: "essay", name: "Explain diffusion", max_mark: "5.00", starts_new_page: true, can_set_page_break: false }),
      ], 3),
    });
    assert.equal(posts.length, 4);
    assert.deepEqual(posts[3], { sesskey: SESSKEY, courseid: "2", quizid: "7", class: "resource", action: "DELETE", id: "12" });

    // A saved layout that is not the approved one is applied_or_unknown, so the
    // readback comparison, not the native reply, decides the outcome.
    state = initialState();
    state.driftToSlotId = 13;
    const beforeDrift = await readStructure();
    assert.deepEqual(await execute(operations.remove, { course_id: 2, module_id: 9, slot_id: 12, expected_digest: beforeDrift.snapshot_digest }), {
      ok: false,
      sent: true,
      status: 200,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_quiz_structure_write_not_verified" },
      error: "moodle_quiz_structure_write_not_verified",
    });
    assert.equal(posts.length, 5);
    assert.deepEqual(state.slots.map((entry) => entry.id), [11, 12, 14]);

    // A lost response after one dispatch is applied_or_unknown, never retried.
    state = initialState();
    const beforeLost = await readStructure();
    await loseNextEditRestResponse();
    assert.deepEqual(await execute(operations.remove, { course_id: 2, module_id: 9, slot_id: 12, expected_digest: beforeLost.snapshot_digest }), {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_quiz_structure_write_unconfirmed" },
      error: "moodle_quiz_structure_write_unconfirmed",
    });
    assert.equal(posts.length, 6);
    assert.deepEqual(state.slots.map((entry) => entry.id), [11, 13, 14]);

    // A Quiz whose native edit controls are absent exposes no Quiz record ID,
    // and every change refuses before its first native request.
    state = initialState();
    state.editable = false;
    const locked = await readStructure();
    assert.equal(locked.data.slot_changes_available, false);
    assert.equal(locked.data.slot_changes_unavailable, "quiz_edit_controls_absent");
    assert.equal(Object.hasOwn(locked.data, "quiz_id"), false);
    assert.deepEqual(locked.data.slots.map((entry) => [entry.can_reorder, entry.can_remove, entry.can_set_page_break, entry.can_set_mark]), [
      [false, false, false, true], [false, false, false, true], [false, false, false, false], [false, false, false, true],
    ]);
    for (const [operation, argumentsValue] of [
      [operations.move, { course_id: 2, module_id: 9, slot_id: 12, after_slot_id: null, expected_digest: locked.snapshot_digest }],
      [operations.mark, { course_id: 2, module_id: 9, slot_id: 12, max_mark: "3", expected_digest: locked.snapshot_digest }],
      [operations.pageBreak, { course_id: 2, module_id: 9, slot_id: 12, starts_new_page: true, expected_digest: locked.snapshot_digest }],
      [operations.remove, { course_id: 2, module_id: 9, slot_id: 12, expected_digest: locked.snapshot_digest }],
    ]) {
      await refuse(operation, argumentsValue, "moodle_quiz_structure_edit_controls_absent");
    }

    // A Quiz above the supported bound is reported as incomplete, and no change
    // is attempted against a layout Morrow cannot state in full.
    state = oversizedState();
    const oversized = await readStructure();
    assert.deepEqual(oversized.data, {
      schema: "morrow.moodle-quiz-structure.v1",
      course_id: 2,
      module_id: 9,
      complete: false,
      section_count: 1,
      slot_count: 101,
      slot_changes_available: false,
      slot_changes_unavailable: "quiz_larger_than_supported_bound",
      proof: PROOF,
    });
    await refuse(operations.remove, { course_id: 2, module_id: 9, slot_id: 200, expected_digest: oversized.snapshot_digest }, "moodle_quiz_structure_incomplete");

    // A page that does not carry the layout this reader was written for is refused.
    state = initialState();
    state.render = "slot-before-page";
    await refuse(operations.read, { course_id: 2, module_id: 9 }, "moodle_quiz_structure_layout_invalid");
    state.render = "inconsistent-break";
    await refuse(operations.read, { course_id: 2, module_id: 9 }, "moodle_quiz_structure_layout_invalid");
    state.render = "foreign-course";
    await refuse(operations.read, { course_id: 2, module_id: 9 }, "moodle_quiz_structure_target_invalid");
    state.render = "complete";

    assert.deepEqual(requests.filter((entry) => /^\/mod\/quiz\/(?:view|attempt|review|report|startattempt|summary)\.php$/.test(entry.pathname)), []);
    assert.deepEqual(requests.filter((entry) => entry.method === "POST" && entry.pathname !== "/mod/quiz/edit_rest.php"), []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
