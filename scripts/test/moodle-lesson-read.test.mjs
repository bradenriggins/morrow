import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleLessonPageInPage, executeMoodleLessonPageListInPage } from "../../connector/extension/src/moodle-lesson-read.js";

const LIST_OPERATION = Object.freeze({
  key: "moodle.form.lesson.pages.read.v1",
  toolName: "moodle_list_lesson_pages",
  provider: "moodle",
  readOnly: true,
});

const PAGE_OPERATION = Object.freeze({
  key: "moodle.form.lesson.page.read.v1",
  toolName: "moodle_get_lesson_page",
  provider: "moodle",
  readOnly: true,
});

const LIST_PROOF = Object.freeze({
  list_source: "mod_lesson_edit_page",
  page_source: "mod_lesson_editpage_form",
  exact_module_binding: "course_modedit_form",
  required_capability: "mod/lesson:manage",
  page_form_capability: "mod/lesson:edit",
  jump_source: "editpage_form_stored_answers",
  learner_progress: "not_recorded",
  page_content: "not_returned",
  view_route: "never_opened",
  page_limit: 100,
  answer_limit: 40,
  page_request_count: 7,
});

const PAGE_PROOF = Object.freeze({
  list_source: "mod_lesson_edit_page",
  page_source: "mod_lesson_editpage_form",
  exact_module_binding: "course_modedit_form",
  required_capability: "mod/lesson:manage",
  page_form_capability: "mod/lesson:edit",
  jump_source: "editpage_form_stored_answers",
  learner_progress: "not_recorded",
  file_bearing_text: "refused",
  view_route: "never_opened",
  page_limit: 100,
  answer_limit: 40,
});

test("Moodle Lesson page reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));

  const listed = catalog.operations.filter((entry) => entry.key === "moodle.form.lesson.pages.read.v1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].toolName, "moodle_list_lesson_pages");
  assert.equal(listed[0].provider, "moodle");
  assert.equal(listed[0].readOnly, true);
  assert.equal(listed[0].dataClass, "course");
  assert.equal(listed[0].reviewTool, undefined);
  assert.match(listed[0].description, /mod\/lesson:manage/);
  assert.match(listed[0].description, /mod\/lesson:edit/);
  assert.match(listed[0].description, /never opens \/mod\/lesson\/view\.php/);
  assert.match(listed[0].description, /no signed-in Moodle site has run it/);

  const single = catalog.operations.filter((entry) => entry.key === "moodle.form.lesson.page.read.v1");
  assert.equal(single.length, 1);
  assert.equal(single[0].toolName, "moodle_get_lesson_page");
  assert.equal(single[0].readOnly, true);
  assert.equal(single[0].dataClass, "course");
  assert.match(single[0].description, /never opens \/mod\/lesson\/view\.php/);
  assert.match(single[0].description, /draft-file reference or embedded media/);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleLessonPageInPage, executeMoodleLessonPageListInPage \} from "\.\/moodle-lesson-read\.js";/);
  assert.match(worker, /MOODLE_LESSON_PAGE_LIST_OPERATION_KEY = "moodle\.form\.lesson\.pages\.read\.v1"/);
  assert.match(worker, /MOODLE_LESSON_PAGE_OPERATION_KEY = "moodle\.form\.lesson\.page\.read\.v1"/);
  assert.match(worker, /func: executeMoodleLessonPageListInPage/);
  assert.match(worker, /func: executeMoodleLessonPageInPage/);

  const reader = readFileSync(new URL("connector/extension/src/moodle-lesson-read.js", root), "utf8");
  assert.equal(reader.includes("/mod/lesson/view.php\""), false, "the reader must never build a view.php route");
});

test("Moodle Lesson page reads return the complete graph and refuse a file-bearing page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-lesson-read-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const PRIVATE_DRAFT_ITEM = "987654321";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  // One Lesson: a branch table, two plain content pages, a multichoice question
  // page, an end-of-branch page, an essay page with no answer control, and a
  // short-answer page whose answers are plain text controls.
  const editorAnswer = (text) => ({ kind: "editor", text });
  const pages = () => [
    {
      id: 101, qtype: 20, title: "Choose a path", contents: "<p>Pick a path.</p>",
      slots: [
        { answer: editorAnswer("Path A"), jump: "102" },
        { answer: editorAnswer("Path B"), jump: "103" },
        { answer: editorAnswer(""), jump: "-1" },
      ],
    },
    {
      id: 102, qtype: mode === "unknown-type" ? 99 : 20, title: "Cell overview", contents: "<p>The cell.</p>",
      slots: mode === "no-jump" ? [] : mode === "empty-answers" ? [{ answer: editorAnswer(""), jump: "-1" }] : mode === "answer-flood"
        ? Array.from({ length: 41 }, (_, index) => ({ answer: editorAnswer(`Branch ${index}`), jump: "-1" }))
        : [
          { answer: editorAnswer("Continue"), jump: mode === "unknown-jump" ? "-5" : mode === "foreign-jump" ? "999" : "-1" },
          { answer: editorAnswer(""), jump: "-1" },
        ],
    },
    {
      id: 103, qtype: 3, title: "Organelle check", contents: "<p>Which one makes ATP?</p>",
      slots: [
        { answer: editorAnswer("Mitochondria"), response: "Correct.", score: "1", jump: "104" },
        { answer: editorAnswer("Ribosome"), response: "Try again.", score: "0", jump: "0" },
        { answer: editorAnswer(""), response: "", score: "0", jump: "-1" },
      ],
    },
    { id: 104, qtype: 21, title: "Back to the menu", contents: "<p>End of this branch.</p>", slots: [{ answer: null, jump: "101" }] },
    { id: 105, qtype: 10, title: "Reflection", contents: "<p>Write a paragraph.</p>", slots: [{ answer: null, score: "1", jump: "-9" }] },
    {
      id: 106, qtype: 20, title: "Media page", contents: '<p><img src="draftfile.php/999/private-diagram.png" alt="Diagram"></p>',
      slots: [{ answer: editorAnswer("Continue"), jump: "-1" }],
    },
    {
      id: 107, qtype: 1, title: "Name the organelle", contents: "<p>Type the answer.</p>",
      slots: [
        { answer: { kind: "text", text: "mitochondria" }, response: "Yes.", score: "1", jump: "-1" },
        { answer: { kind: "text", text: "" }, response: "", score: "0", jump: "0" },
      ],
    },
  ];

  const jumpSelect = (index, value) => {
    const options = [...new Set(["-1", "0", "-9", "101", "102", "103", "104", value])];
    return `<select name="jumpto[${index}]">${options.map((option) => `<option value="${escape(option)}"${option === value ? ' selected="selected"' : ""}>${escape(option)}</option>`).join("")}</select>`;
  };

  const slotMarkup = (slot, index) => {
    const parts = [];
    if (slot.answer && slot.answer.kind === "editor") {
      parts.push(`<textarea name="answer_editor[${index}][text]">${escape(slot.answer.text)}</textarea>`);
      parts.push(`<input type="hidden" name="answer_editor[${index}][format]" value="1">`);
      parts.push(`<input type="hidden" name="answer_editor[${index}][itemid]" value="${PRIVATE_DRAFT_ITEM}">`);
    }
    if (slot.answer && slot.answer.kind === "text") {
      parts.push(`<input type="text" name="answer_editor[${index}]" value="${escape(slot.answer.text)}">`);
    }
    if (slot.response !== undefined) {
      parts.push(`<textarea name="response_editor[${index}][text]">${escape(slot.response)}</textarea>`);
      parts.push(`<input type="hidden" name="response_editor[${index}][format]" value="1">`);
    }
    if (slot.score !== undefined) parts.push(`<input type="text" name="score[${index}]" value="${escape(slot.score)}">`);
    parts.push(jumpSelect(index, slot.jump));
    return parts.join("");
  };

  const pageForm = (page) => `<!doctype html><html><body><form method="post" action="/mod/lesson/editpage.php?pageid=${page.id}&amp;id=8&amp;qtype=${page.qtype}">
    <input type="hidden" name="returnto" value="0">
    <input type="hidden" name="id" value="8">
    <input type="hidden" name="pageid" value="${page.id}">
    <input type="hidden" name="qtype" value="${page.qtype}">
    <input type="hidden" name="edit" value="1">
    <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    <input type="text" name="title" value="${escape(page.title)}">
    <textarea name="contents_editor[text]">${escape(page.contents)}</textarea>
    <input type="hidden" name="contents_editor[format]" value="1">
    <input type="hidden" name="contents_editor[itemid]" value="${PRIVATE_DRAFT_ITEM}">
    ${page.slots.map(slotMarkup).join("")}
  </form></body></html>`;

  const editIndex = () => {
    const rows = pages().map((page) => `<tr>
      <td><a href="/mod/lesson/edit.php?id=8&amp;mode=single&amp;pageid=${page.id}" id="lesson-${page.id}">${escape(page.title)}</a></td>
      <td>Content</td><td>Next page</td>
      <td>${mode === "no-edit-links" ? "" : `<a href="/mod/lesson/editpage.php?id=8&amp;pageid=${page.id}&amp;edit=1">Edit</a>`}</td>
    </tr>`).join("");
    const flood = mode === "page-flood"
      ? Array.from({ length: 101 }, (_, index) => `<tr><td><a href="/mod/lesson/edit.php?id=8&amp;mode=single&amp;pageid=${200 + index}" id="lesson-${200 + index}">Extra ${index}</a></td><td><a href="/mod/lesson/editpage.php?id=8&amp;pageid=${200 + index}&amp;edit=1">Edit</a></td></tr>`).join("")
      : "";
    return `<!doctype html><html><body><table class="generaltable"><tbody>${mode === "page-flood" ? flood : rows}</tbody></table></body></html>`;
  };

  const modeditForm = () => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=8&amp;return=0">
    <input type="hidden" name="course" value="2"><input type="hidden" name="coursemodule" value="8">
    <input type="hidden" name="update" value="8"><input type="hidden" name="modulename" value="${mode === "wrong-type" ? "assign" : "lesson"}">
    <input type="hidden" name="instance" value="71"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
  </form></body></html>`;

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php" && target.search === "?update=8&return=0") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(modeditForm());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/lesson/edit.php" && target.search === "?id=8") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(editIndex());
      return;
    }
    if (request.method === "GET" && target.pathname === "/mod/lesson/editpage.php") {
      const page = pages().find((entry) => String(entry.id) === target.searchParams.get("pageid"));
      if (!page || target.searchParams.get("id") !== "8" || target.searchParams.get("edit") !== "1") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(pageForm(page));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const listPages = (args = { course_id: 2, module_id: 8 }, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleLessonPageListInPage,
      JSON.stringify({ operation: LIST_OPERATION, arguments: args, binding, expiresAt }),
    );
    const readPage = (args, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleLessonPageInPage,
      JSON.stringify({ operation: PAGE_OPERATION, arguments: args, binding, expiresAt }),
    );
    const sourceRequests = () => requests.filter((entry) => entry.pathname.startsWith("/mod/lesson/") || entry.pathname === "/course/modedit.php").length;

    const beforeInvalid = sourceRequests();
    assert.deepEqual(await listPages({ course_id: 2, module_id: 8, extra: true }), { ok: false, sent: false, error: "moodle_lesson_pages_arguments_invalid" });
    assert.deepEqual(await listPages({ course_id: 2, module_id: 8 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_lesson_pages_arguments_invalid" });
    assert.deepEqual(await readPage({ course_id: 2, module_id: 8 }), { ok: false, sent: false, error: "moodle_lesson_page_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    const graph = await listPages();
    assert.equal(graph.ok, true, JSON.stringify(graph));
    assert.equal(graph.complete, true);
    assert.match(graph.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(graph.data, {
      schema: "morrow.moodle-lesson-page-list.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 8,
      lesson_id: 71,
      page_count: 7,
      pages: [
        {
          page_id: 101, position: 1, title: "Choose a path", page_type: "branchtable", page_type_id: 20, page_kind: "content",
          jumps: [{ index: 0, target: "page", page_id: 102 }, { index: 1, target: "page", page_id: 103 }],
          branch_target_page_ids: [102, 103],
        },
        {
          page_id: 102, position: 2, title: "Cell overview", page_type: "branchtable", page_type_id: 20, page_kind: "content",
          jumps: [{ index: 0, target: "next_page" }], branch_target_page_ids: [],
        },
        {
          page_id: 103, position: 3, title: "Organelle check", page_type: "multichoice", page_type_id: 3, page_kind: "question",
          jumps: [{ index: 0, target: "page", page_id: 104 }, { index: 1, target: "this_page" }],
          branch_target_page_ids: [104],
        },
        {
          page_id: 104, position: 4, title: "Back to the menu", page_type: "endofbranch", page_type_id: 21, page_kind: "structure",
          jumps: [{ index: 0, target: "page", page_id: 101 }], branch_target_page_ids: [101],
        },
        {
          page_id: 105, position: 5, title: "Reflection", page_type: "essay", page_type_id: 10, page_kind: "question",
          jumps: [{ index: 0, target: "end_of_lesson" }], branch_target_page_ids: [],
        },
        {
          page_id: 106, position: 6, title: "Media page", page_type: "branchtable", page_type_id: 20, page_kind: "content",
          jumps: [{ index: 0, target: "next_page" }], branch_target_page_ids: [],
        },
        {
          page_id: 107, position: 7, title: "Name the organelle", page_type: "shortanswer", page_type_id: 1, page_kind: "question",
          jumps: [{ index: 0, target: "next_page" }], branch_target_page_ids: [],
        },
      ],
      proof: LIST_PROOF,
    });
    const serializedGraph = JSON.stringify(graph);
    for (const secret of [PRIVATE_SESSION, PRIVATE_DRAFT_ITEM, "Mitochondria", "Pick a path", "draftfile.php"]) {
      assert.equal(serializedGraph.includes(secret), false, `the page list leaked ${secret}`);
    }

    const question = await readPage({ course_id: 2, module_id: 8, page_id: 103 });
    assert.equal(question.ok, true, JSON.stringify(question));
    assert.deepEqual(question.data, {
      schema: "morrow.moodle-lesson-page.v1",
      provider: "moodle",
      course_id: 2,
      module_id: 8,
      lesson_id: 71,
      page_id: 103,
      position: 3,
      page_count: 7,
      title: "Organelle check",
      page_type: "multichoice",
      page_type_id: 3,
      page_kind: "question",
      contents_text: "<p>Which one makes ATP?</p>",
      contents_format: "1",
      answer_count: 2,
      answers: [
        { index: 0, answer_text: "Mitochondria", answer_format: "1", response_text: "Correct.", response_format: "1", score: "1", jump: { target: "page", page_id: 104 } },
        { index: 1, answer_text: "Ribosome", answer_format: "1", response_text: "Try again.", response_format: "1", score: "0", jump: { target: "this_page" } },
      ],
      proof: PAGE_PROOF,
    });
    assert.equal(JSON.stringify(question).includes(PRIVATE_SESSION), false);
    assert.equal(JSON.stringify(question).includes(PRIVATE_DRAFT_ITEM), false);

    const essay = await readPage({ course_id: 2, module_id: 8, page_id: 105 });
    assert.equal(essay.ok, true, JSON.stringify(essay));
    assert.deepEqual(essay.data.answers, [
      { index: 0, answer_text: null, answer_format: null, response_text: null, response_format: null, score: "1", jump: { target: "end_of_lesson" } },
    ]);

    const shortAnswer = await readPage({ course_id: 2, module_id: 8, page_id: 107 });
    assert.equal(shortAnswer.ok, true, JSON.stringify(shortAnswer));
    assert.deepEqual(shortAnswer.data.answers, [
      { index: 0, answer_text: "mitochondria", answer_format: null, response_text: "Yes.", response_format: "1", score: "1", jump: { target: "next_page" } },
    ]);

    assert.deepEqual(await readPage({ course_id: 2, module_id: 8, page_id: 106 }), { ok: false, sent: false, error: "moodle_lesson_page_file_reference_unsupported" });
    assert.deepEqual(await readPage({ course_id: 2, module_id: 8, page_id: 999 }), { ok: false, sent: false, error: "moodle_lesson_page_not_in_lesson" });

    for (const [failure, expected] of [
      ["unknown-type", "moodle_lesson_pages_page_type_unsupported"],
      ["unknown-jump", "moodle_lesson_pages_page_jump_unsupported"],
      ["foreign-jump", "moodle_lesson_pages_jump_target_unknown"],
      ["no-jump", "moodle_lesson_pages_page_jump_missing"],
      ["empty-answers", "moodle_lesson_pages_page_answers_missing"],
      ["no-edit-links", "moodle_lesson_pages_unavailable"],
      ["wrong-type", "moodle_lesson_pages_target_unavailable"],
    ]) {
      mode = failure;
      assert.deepEqual(await listPages(), { ok: false, sent: false, error: expected }, failure);
    }
    for (const bound of ["answer-flood", "page-flood"]) {
      mode = bound;
      assert.deepEqual(await listPages(), { ok: false, sent: false, complete: false, error: "moodle_lesson_pages_incomplete" }, bound);
    }
    for (const [failure, expected] of [
      ["empty-answers", "moodle_lesson_page_answers_missing"],
      ["unknown-type", "moodle_lesson_page_type_unsupported"],
      ["unknown-jump", "moodle_lesson_page_jump_unsupported"],
      ["foreign-jump", "moodle_lesson_page_jump_target_unknown"],
    ]) {
      mode = failure;
      assert.deepEqual(await readPage({ course_id: 2, module_id: 8, page_id: 102 }), { ok: false, sent: false, error: expected }, failure);
    }
    mode = "complete";

    assert.equal(requests.some((entry) => entry.pathname === "/mod/lesson/view.php"), false, "no request may open the Lesson view route");
    assert.equal(requests.some((entry) => entry.pathname.startsWith("/mod/lesson/") && /(?:^|[?&])mode=/.test(entry.search)), false, "the reader must not send a mode parameter to edit.php");
    assert.equal(requests.some((entry) => entry.method !== "GET" && entry.pathname.startsWith("/mod/lesson/")), false, "both readers are GET only");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
