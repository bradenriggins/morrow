import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { categoriesForBinding, createEditPermission } from "../../connector/extension/src/edit-policy.js";
import { executeMoodleLessonPageListInPage } from "../../connector/extension/src/moodle-lesson-read.js";
import { executeMoodleLessonPageWriteInPage } from "../../connector/extension/src/moodle-lesson-executor.js";

const root = new URL("../..", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
const entry = (key) => catalog.operations.filter((operation) => operation.key === key);

const OPERATIONS = Object.freeze({
  create: { key: "moodle.form.lesson.page.create.v1", toolName: "moodle_create_lesson_page", provider: "moodle", readOnly: false },
  update: { key: "moodle.form.lesson.page.update.v1", toolName: "moodle_update_lesson_page", provider: "moodle", readOnly: false },
  move: { key: "moodle.form.lesson.page.move.v1", toolName: "moodle_move_lesson_page", provider: "moodle", readOnly: false },
  delete: { key: "moodle.form.lesson.page.delete.v1", toolName: "moodle_delete_lesson_page", provider: "moodle", readOnly: false },
});
const LIST_OPERATION = Object.freeze({
  key: "moodle.form.lesson.pages.read.v1",
  toolName: "moodle_list_lesson_pages",
  provider: "moodle",
  readOnly: true,
});

test("the four Moodle Lesson page writes are cataloged, routed and held out of a standing delete grant", () => {
  for (const [kind, operation] of Object.entries(OPERATIONS)) {
    const listed = entry(operation.key);
    assert.equal(listed.length, 1, operation.key);
    assert.equal(listed[0].toolName, operation.toolName);
    assert.equal(listed[0].provider, "moodle");
    assert.equal(listed[0].readOnly, false);
    assert.equal(listed[0].reviewTool, "moodle_list_lesson_pages");
    assert.equal(listed[0].dataClass, "course");
    assert.equal(listed[0].inputSchema.additionalProperties, false);
    assert.ok(listed[0].inputSchema.required.includes("expected_digest"), operation.toolName);
    assert.ok(listed[0].inputSchema.required.includes("expected_jump_changes"), operation.toolName);
    assert.match(listed[0].description, /expected_jump_changes/);
    assert.match(listed[0].description, /no signed-in Moodle site has run it/);
    assert.equal(listed[0].destructive === true, kind === "delete");
    assert.equal(listed[0].irreversible === true, kind === "delete");
  }
  const deletion = entry(OPERATIONS.delete.key)[0];
  assert.ok(deletion.inputSchema.required.includes("expected_invalid_jumps"));
  assert.match(deletion.description, /a page that no longer exists/);
  assert.match(deletion.description, /moodle_list_lesson_pages refuses to read this Lesson/);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleLessonPageWriteInPage \} from "\.\/moodle-lesson-executor\.js";/);
  assert.match(worker, /func: executeMoodleLessonPageWriteInPage/);
  for (const operation of Object.values(OPERATIONS)) assert.ok(worker.includes(`"${operation.key}"`), operation.key);

  const executor = readFileSync(new URL("connector/extension/src/moodle-lesson-executor.js", root), "utf8");
  assert.equal(executor.includes('"/mod/lesson/view.php"'), false, "the executor must never build a view.php route");

  const options = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const option = (toolName) => options.find((item) => item.id === `action:moodle:${toolName}`);
  assert.equal(option("moodle_delete_lesson_page").availability, "review");
  assert.match(option("moodle_delete_lesson_page").reviewReason, /every page whose jump the deletion breaks/);
  assert.equal(option("moodle_delete_lesson_page").destructive, true);
  for (const toolName of ["moodle_create_lesson_page", "moodle_update_lesson_page", "moodle_move_lesson_page"]) {
    assert.equal(option(toolName).availability, "edit", toolName);
  }
  assert.equal(option("moodle_delete_lesson_page").tier, "destructive");
  assert.equal(option("moodle_move_lesson_page").group, "Moodle · Lesson Page");
});

test("a granted Moodle Lesson page edit names only the fields it writes", async () => {
  const binding = {
    sourceBindingId: "moodle:course-2", provider: "moodle", origin: "https://moodle.example.edu",
    siteUrl: "https://moodle.example.edu", principalFingerprint: "a".repeat(64), courseId: "2", sessionGeneration: 1,
  };
  const permission = await createEditPermission({
    binding, catalogDigest: "b".repeat(64), revision: 1, operations: catalog.operations,
    enabledCategories: ["action:moodle:moodle_create_lesson_page", "action:moodle:moodle_update_lesson_page", "action:moodle:moodle_move_lesson_page"],
  });
  const rule = (toolName) => permission.rules.find((item) => item.toolName === toolName);
  // A move changes no field of any page, and the identity and approval
  // arguments are never granted as editable fields.
  assert.deepEqual(rule("moodle_move_lesson_page").allowedChangedFields, []);
  assert.deepEqual(rule("moodle_create_lesson_page").allowedChangedFields, ["answers", "contents", "page_type", "title"]);
  assert.deepEqual(rule("moodle_update_lesson_page").allowedChangedFields, ["answers", "contents", "title"]);
  const granted = new Set(permission.rules.flatMap((item) => item.allowedChangedFields));
  for (const field of ["page_id", "after_page_id", "expected_jump_changes", "expected_invalid_jumps", "expected_digest"]) {
    assert.equal(granted.has(field), false, field);
  }
});

test("Moodle Lesson page writes send one POST, require the approved graph back, and refuse a dangling jump", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-lesson-write-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const PRIVATE_DRAFT_ITEM = "987654321";
  const requests = [];
  let origin = "";
  let mode = "normal";
  let browser;

  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // The three page shapes this Lesson uses, exactly as Moodle renders them:
  // a Content page with plain text branch descriptions and no response or
  // score, a Multichoice page with HTML answer and response editors, and a
  // Short answer page whose all-other-answers slot carries a jump with no
  // answer control of its own.
  const SHAPES = {
    20: { slots: 4, answer: "text", response: false, score: false },
    3: { slots: 4, answer: "editor", response: true, score: true },
    2: { slots: 2, answer: "editor", response: true, score: true },
    1: { slots: 4, answer: "text", response: true, score: true, other: 5 },
  };
  const INITIAL = () => [
    { id: 101, qtype: 20, title: "Choose a path", contents: "<p>Pick a path.</p>", slots: [{ answer: "Path A", jump: "102" }, { answer: "Path B", jump: "103" }] },
    { id: 102, qtype: 20, title: "Cell overview", contents: "<p>The cell.</p>", slots: [{ answer: "Continue", jump: mode === "dynamic" ? "-50" : "-1" }] },
    {
      id: 103, qtype: 3, title: "Organelle check", contents: "<p>Which one makes ATP?</p>",
      slots: [
        { answer: "Mitochondria", response: "Correct.", score: "1", jump: "104" },
        { answer: "Ribosome", response: "Try again.", score: "0", jump: "0" },
      ],
    },
    { id: 104, qtype: 20, title: "Wrap up", contents: "<p>Well done.</p>", slots: [{ answer: "Back", jump: "-40" }] },
  ];
  let pages = INITIAL();
  let nextId = 201;
  const reset = () => { pages = INITIAL(); nextId = 201; };
  const find = (pageId) => pages.find((page) => String(page.id) === String(pageId));

  const jumpSelect = (index, value) => {
    const options = [...new Set(["-1", "0", "-9", "-40", ...pages.map((page) => String(page.id)), String(value)])];
    return `<select name="jumpto[${index}]">${options.map((option) => `<option value="${escape(option)}"${option === String(value) ? ' selected="selected"' : ""}>${escape(option)}</option>`).join("")}</select>`;
  };
  const slotMarkup = (shape, index, slot) => {
    const parts = [];
    if (shape.answer === "editor") {
      parts.push(`<textarea name="answer_editor[${index}][text]">${escape(slot?.answer ?? "")}</textarea>`);
      parts.push(`<input type="hidden" name="answer_editor[${index}][format]" value="1">`);
      parts.push(`<input type="hidden" name="answer_editor[${index}][itemid]" value="${PRIVATE_DRAFT_ITEM}">`);
    } else {
      parts.push(`<input type="text" name="answer_editor[${index}]" value="${escape(slot?.answer ?? "")}">`);
    }
    if (shape.response) {
      parts.push(`<textarea name="response_editor[${index}][text]">${escape(slot?.response ?? "")}</textarea>`);
      parts.push(`<input type="hidden" name="response_editor[${index}][format]" value="1">`);
    }
    if (shape.score) parts.push(`<input type="text" name="score[${index}]" value="${escape(slot?.score ?? "0")}">`);
    parts.push(jumpSelect(index, slot?.jump ?? "-1"));
    return parts.join("");
  };
  const formBody = (page, qtype, pageid, editing) => {
    const shape = SHAPES[qtype];
    const slots = Array.from({ length: shape.slots }, (_, index) => slotMarkup(shape, index, page?.slots?.[index]));
    if (shape.other !== undefined) {
      slots.push(`<input type="advcheckbox" name="enableotheranswers" value="0">`);
      slots.push(`<textarea name="response_editor[${shape.other}][text]">${escape(page?.other?.response ?? "")}</textarea>`);
      slots.push(`<input type="hidden" name="response_editor[${shape.other}][format]" value="1">`);
      slots.push(`<input type="text" name="score[${shape.other}]" value="${escape(page?.other?.score ?? "0")}">`);
      slots.push(jumpSelect(shape.other, page?.other?.jump ?? "-1"));
    }
    const query = editing ? `id=8&amp;pageid=${pageid}` : `id=8&amp;pageid=${pageid}&amp;qtype=${qtype}`;
    return `<!doctype html><html><body><form method="post" action="/mod/lesson/editpage.php?${query}">
      <input type="hidden" name="_qf__lesson_add_page_form_type" value="1">
      <input type="hidden" name="id" value="8">
      <input type="hidden" name="pageid" value="${pageid}">
      <input type="hidden" name="qtype" value="${qtype}">
      ${editing ? '<input type="hidden" name="edit" value="1">' : ""}
      <input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
      <input type="text" name="title" value="${escape(page?.title ?? "")}">
      <textarea name="contents_editor[text]">${escape(page?.contents ?? "")}</textarea>
      <input type="hidden" name="contents_editor[format]" value="1">
      <input type="hidden" name="contents_editor[itemid]" value="${PRIVATE_DRAFT_ITEM}">
      ${slots.join("")}
      <input type="submit" name="submitbutton" value="Save page">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };
  const editIndex = () => {
    const rows = pages.map((page) => `<tr>
      <td><a href="/mod/lesson/edit.php?id=8&amp;mode=single&amp;pageid=${page.id}" id="lesson-${page.id}">${escape(page.title)}</a></td>
      <td><a href="/mod/lesson/editpage.php?id=8&amp;pageid=${page.id}&amp;edit=1">Edit</a>
      ${mode === "no-move" ? "" : `<a href="/mod/lesson/lesson.php?id=8&amp;action=move&amp;pageid=${page.id}&amp;sesskey=${PRIVATE_SESSION}">Move</a>`}
      ${mode === "no-delete" ? "" : `<a href="/mod/lesson/lesson.php?id=8&amp;action=confirmdelete&amp;pageid=${page.id}&amp;sesskey=${PRIVATE_SESSION}">Delete</a>`}</td>
    </tr>`).join("");
    return `<!doctype html><html><body><table class="generaltable"><tbody>${rows}</tbody></table></body></html>`;
  };
  const modeditForm = () => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=8&amp;return=0">
    <input type="hidden" name="course" value="2"><input type="hidden" name="coursemodule" value="8">
    <input type="hidden" name="update" value="8"><input type="hidden" name="modulename" value="lesson">
    <input type="hidden" name="instance" value="71"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    <input type="text" name="name" value="Cell biology lesson">
  </form></body></html>`;

  // Moodle keeps a stored answer only while its text is set, and renumbers the
  // surviving answers from zero when it renders the page again.
  const savedSlots = (body, qtype) => {
    const shape = SHAPES[qtype];
    const slots = [];
    for (let index = 0; index < shape.slots; index += 1) {
      const answer = shape.answer === "editor" ? body.get(`answer_editor[${index}][text]`) : body.get(`answer_editor[${index}]`);
      if (typeof answer !== "string" || !answer.trim()) continue;
      slots.push({
        answer,
        ...(shape.response ? { response: body.get(`response_editor[${index}][text]`) ?? "" } : {}),
        ...(shape.score ? { score: body.get(`score[${index}]`) ?? "0" } : {}),
        jump: body.get(`jumpto[${index}]`) ?? "-1",
      });
    }
    return slots;
  };
  const otherSlot = (body, qtype) => (SHAPES[qtype].other === undefined
    ? {}
    : { other: { jump: body.get(`jumpto[${SHAPES[qtype].other}]`) ?? "-1", score: body.get(`score[${SHAPES[qtype].other}]`) ?? "0", response: body.get(`response_editor[${SHAPES[qtype].other}][text]`) ?? "" } });

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
      const pageid = target.searchParams.get("pageid");
      if (target.searchParams.get("id") !== "8") {
        response.writeHead(404).end();
        return;
      }
      if (target.searchParams.get("edit") === "1") {
        const page = find(pageid);
        if (!page) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(formBody(page, page.qtype, page.id, true));
        return;
      }
      const qtype = Number(target.searchParams.get("qtype"));
      if (!SHAPES[qtype] || (pageid !== "0" && !find(pageid))) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(formBody(null, qtype, pageid, false));
      return;
    }
    if (request.method === "POST" && (target.pathname === "/mod/lesson/editpage.php" || target.pathname === "/mod/lesson/lesson.php")) {
      if (mode === "lost") {
        // The response starts and then the connection is lost, which is the
        // shape Morrow must treat as applied or unknown.
        response.writeHead(200, { "content-type": "text/html", "content-length": "512", connection: "close" });
        response.write("<!doctype html><html><body>");
        setTimeout(() => response.socket.destroy(), 25);
        return;
      }
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const body = new URLSearchParams(raw);
        if (target.pathname === "/mod/lesson/lesson.php") {
          if (body.get("sesskey") !== PRIVATE_SESSION || body.get("id") !== "8") {
            response.writeHead(403).end();
            return;
          }
          const pageId = body.get("pageid");
          if (body.get("action") === "delete") pages = pages.filter((page) => String(page.id) !== pageId);
          if (body.get("action") === "moveit") {
            const moved = find(pageId);
            const rest = pages.filter((page) => String(page.id) !== pageId);
            const after = body.get("after");
            const at = after === "0" ? 0 : rest.findIndex((page) => String(page.id) === after) + 1;
            pages = [...rest.slice(0, at), moved, ...rest.slice(at)];
          }
        } else {
          const qtype = Number(body.get("qtype"));
          if (body.get("sesskey") !== PRIVATE_SESSION || !SHAPES[qtype] || body.get("submitbutton") !== "Save page" || body.has("cancel")) {
            response.writeHead(403).end();
            return;
          }
          if (mode === "refused") {
            response.writeHead(200, { "content-type": "text/html" });
            response.end(formBody(find(body.get("pageid")), qtype, body.get("pageid"), body.get("edit") === "1"));
            return;
          }
          const saved = { title: body.get("title"), contents: body.get("contents_editor[text]"), qtype, slots: savedSlots(body, qtype), ...otherSlot(body, qtype) };
          if (body.get("edit") === "1") {
            const page = find(body.get("pageid"));
            pages = pages.map((entry_) => (entry_ === page ? { ...entry_, ...saved, qtype: entry_.qtype } : entry_));
          } else {
            const after = body.get("pageid");
            const at = after === "0" ? 0 : pages.findIndex((page) => String(page.id) === after) + 1;
            pages = [...pages.slice(0, at), { id: nextId, ...saved }, ...pages.slice(at)];
            nextId += 1;
          }
        }
        response.writeHead(303, { location: "/mod/lesson/edit.php?id=8" });
        response.end();
      });
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
    const graph = () => page.evaluate(
      executeMoodleLessonPageListInPage,
      JSON.stringify({ operation: LIST_OPERATION, arguments: { course_id: 2, module_id: 8 }, binding, expiresAt: Date.now() + 60_000 }),
    );
    const write = (kind, args, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleLessonPageWriteInPage,
      JSON.stringify({ mode: "execute", operation: OPERATIONS[kind], arguments: args, binding, expiresAt }),
    );
    const posts = () => requests.filter((item) => item.method === "POST").length;
    const digest = async () => {
      const read = await graph();
      assert.equal(read.ok, true, JSON.stringify(read));
      return read;
    };

    // A page whose learner arrival Morrow cannot state stops every write
    // before a request is sent.
    mode = "dynamic";
    reset();
    const beforeDynamic = requests.length;
    assert.deepEqual(
      await write("delete", { course_id: 2, module_id: 8, page_id: 103, expected_jump_changes: [], expected_invalid_jumps: [], expected_digest: "a".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_dynamic_jump_refused" },
    );
    assert.equal(requests.slice(beforeDynamic).some((item) => item.method === "POST"), false);
    mode = "normal";
    reset();

    const reviewed = await digest();
    assert.deepEqual(reviewed.data.pages.map((item) => item.page_id), [101, 102, 103, 104]);

    // Refusals that send nothing.
    let sent = posts();
    assert.deepEqual(
      await write("create", { course_id: 2, module_id: 8, after_page_id: 102, page_type: "shortanswer", title: "Name it", contents: "<p>Type it.</p>", answers: [{ answer: "mitochondria", response: "Yes.", score: 1, jump: { target: "next_page" } }], expected_jump_changes: [], expected_digest: reviewed.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_jump_changes_not_approved" },
    );
    assert.deepEqual(
      await write("create", { course_id: 2, module_id: 8, after_page_id: 102, page_type: "shortanswer", title: "Name it", contents: "<p>Type it.</p>", answers: [{ answer: "mitochondria", response: "Yes.", score: 1, jump: { target: "next_page" } }], expected_jump_changes: [102], expected_digest: "b".repeat(64) }),
      { ok: false, sent: false, status: 200, error: "moodle_expected_digest_mismatch" },
    );
    assert.deepEqual(
      await write("create", { course_id: 2, module_id: 8, after_page_id: 102, page_type: "shortanswer", title: "Name it", contents: '<p><img src="draftfile.php/9/x.png" alt="x"></p>', answers: [{ answer: "mitochondria", response: "Yes.", score: 1, jump: { target: "next_page" } }], expected_jump_changes: [102], expected_digest: reviewed.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_file_reference_unsupported" },
    );
    assert.deepEqual(
      await write("create", { course_id: 2, module_id: 8, after_page_id: 102, page_type: "shortanswer", title: "Name it", contents: "<p>Type it.</p>", answers: [{ answer: "mitochondria", response: "Yes.", score: 1, jump: { target: "next_page" } }], expected_jump_changes: [102], expected_digest: reviewed.snapshot_digest, extra: true }),
      { ok: false, sent: false, error: "moodle_lesson_page_write_arguments_invalid" },
    );
    assert.equal(posts(), sent, "a refused write sends nothing");

    // Add one Short answer page after page 102. Page 102's next-page jump now
    // lands on the new page, which is the one jump change this insert makes.
    const created = await write("create", {
      course_id: 2, module_id: 8, after_page_id: 102, page_type: "shortanswer",
      title: "Name the organelle", contents: "<p>Type the answer.</p>",
      answers: [{ answer: "mitochondria", response: "Yes.", score: 1, jump: { target: "next_page" } }],
      expected_jump_changes: [102], expected_digest: reviewed.snapshot_digest,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(posts(), sent + 1, "one POST per write");
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(created.page, { page_id: 201, position: 3, title: "Name the organelle", page_type: "shortanswer" });
    assert.deepEqual(created.data.pages.map((item) => item.page_id), [101, 102, 201, 103, 104]);
    assert.deepEqual(created.data.pages[2].jumps, [{ index: 0, target: "next_page" }, { index: 5, target: "next_page" }]);
    assert.deepEqual(created.proof.jump_target_changes, [{ page_id: 102, title: "Cell overview" }]);
    assert.equal(created.proof.dispatch_count, 1);
    assert.equal(created.proof.write_route, "/mod/lesson/editpage.php");
    assert.equal(created.proof.view_route, "never_opened");
    assert.deepEqual(created.targets, [
      { field: "module_id", label: "Lesson", name: "Cell biology lesson" },
      { field: "page_id", label: "Page", name: "Name the organelle" },
      { field: "after_page_id", label: "After page", name: "Cell overview" },
    ]);
    // The graph in the result is the graph the review tool returns.
    const afterCreate = await digest();
    assert.deepEqual(afterCreate.data, created.data);
    assert.equal(afterCreate.snapshot_digest, created.snapshot_digest);
    assert.equal(JSON.stringify(created).includes(PRIVATE_SESSION), false);
    assert.equal(JSON.stringify(created).includes(PRIVATE_DRAFT_ITEM), false);

    // Add a Content page at the start of the Lesson. It has no response or
    // score control, and a True/false page must carry exactly two answers.
    reset();
    const forStart = await digest();
    sent = posts();
    assert.deepEqual(
      await write("create", { course_id: 2, module_id: 8, after_page_id: 0, page_type: "content", title: "Welcome", contents: "<p>Start here.</p>", answers: [{ answer: "Begin", response: "Not offered", score: null, jump: { target: "next_page" } }], expected_jump_changes: [], expected_digest: forStart.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_response_unsupported" },
    );
    assert.deepEqual(
      await write("create", { course_id: 2, module_id: 8, after_page_id: 0, page_type: "truefalse", title: "True or false", contents: "<p>Decide.</p>", answers: [{ answer: "True", response: "Yes.", score: 1, jump: { target: "next_page" } }], expected_jump_changes: [], expected_digest: forStart.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_answer_count_invalid" },
    );
    assert.equal(posts(), sent, "a refused create sends nothing");
    const started = await write("create", {
      course_id: 2, module_id: 8, after_page_id: 0, page_type: "content",
      title: "Welcome", contents: "<p>Start here.</p>",
      answers: [{ answer: "Begin", response: null, score: null, jump: { target: "next_page" } }],
      expected_jump_changes: [], expected_digest: forStart.snapshot_digest,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(posts(), sent + 1, "one POST per write");
    assert.deepEqual(started.data.pages.map((item) => item.page_id), [201, 101, 102, 103, 104]);
    assert.deepEqual(started.targets[2], { field: "after_page_id", label: "After page", name: "The start of the Lesson" });
    assert.deepEqual(started.proof.jump_target_changes, []);

    // Rewrite one Multichoice page. No other page sends a learner anywhere new.
    reset();
    const forUpdate = await digest();
    sent = posts();
    const updated = await write("update", {
      course_id: 2, module_id: 8, page_id: 103,
      title: "Which organelle makes ATP?", contents: "<p>Choose one.</p>",
      answers: [
        { answer: "Mitochondria", response: "Yes.", score: 2, jump: { target: "page", page_id: 104 } },
        { answer: "Ribosome", response: "Not this one.", score: 0, jump: { target: "page", page_id: 101 } },
      ],
      expected_jump_changes: [], expected_digest: forUpdate.snapshot_digest,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(posts(), sent + 1, "one POST per write");
    assert.deepEqual(updated.data.pages[2], {
      page_id: 103, position: 3, title: "Which organelle makes ATP?",
      page_type: "multichoice", page_type_id: 3, page_kind: "question",
      jumps: [{ index: 0, target: "page", page_id: 104 }, { index: 1, target: "page", page_id: 101 }],
      branch_target_page_ids: [101, 104],
    });
    assert.deepEqual(updated.proof.jump_target_changes, []);
    assert.deepEqual(find(103).slots.map((slot) => [slot.answer, slot.response, slot.score, slot.jump]), [
      ["Mitochondria", "Yes.", "2", "104"],
      ["Ribosome", "Not this one.", "0", "101"],
    ]);

    // A page Moodle refuses is reported as refused, not as uncertain.
    reset();
    const forRefusal = await digest();
    mode = "refused";
    sent = posts();
    const refused = await write("update", {
      course_id: 2, module_id: 8, page_id: 103, title: "Refused title", contents: "<p>Refused.</p>",
      answers: [{ answer: "Mitochondria", response: "Yes.", score: 1, jump: { target: "page", page_id: 104 } }, { answer: "Ribosome", response: "No.", score: 0, jump: { target: "this_page" } }],
      expected_jump_changes: [], expected_digest: forRefusal.snapshot_digest,
    });
    assert.equal(posts(), sent + 1);
    assert.equal(refused.ok, false);
    assert.equal(refused.sent, true);
    assert.equal(refused.outcomeUnknown, false);
    assert.equal(refused.error, "moodle_lesson_page_write_not_saved");
    assert.equal(refused.verification.status, "mismatch");
    mode = "normal";

    // Move one page. Its own previous-page jump and its old neighbours' jumps
    // are the pages a learner now reaches differently.
    reset();
    const forMove = await digest();
    sent = posts();
    assert.deepEqual(
      await write("move", { course_id: 2, module_id: 8, page_id: 103, after_page_id: 104, expected_jump_changes: [102], expected_digest: forMove.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_jump_changes_not_approved" },
    );
    const moved = await write("move", { course_id: 2, module_id: 8, page_id: 103, after_page_id: 104, expected_jump_changes: [102, 104], expected_digest: forMove.snapshot_digest });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(posts(), sent + 1, "one POST per write");
    assert.deepEqual(moved.data.pages.map((item) => item.page_id), [101, 102, 104, 103]);
    assert.equal(moved.proof.write_route, "/mod/lesson/lesson.php");
    assert.deepEqual(moved.proof.jump_target_changes, [{ page_id: 102, title: "Cell overview" }, { page_id: 104, title: "Wrap up" }]);

    // Delete one page. Page 101 jumps straight at it, so that jump would point
    // at a page that no longer exists and must be approved by name.
    reset();
    const forDelete = await digest();
    sent = posts();
    assert.deepEqual(
      await write("delete", { course_id: 2, module_id: 8, page_id: 103, expected_jump_changes: [102, 104], expected_invalid_jumps: [], expected_digest: forDelete.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_invalid_jumps_not_approved" },
    );
    assert.deepEqual(
      await write("delete", { course_id: 2, module_id: 8, page_id: 103, expected_jump_changes: [102, 104], expected_invalid_jumps: [101, 104], expected_digest: forDelete.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_invalid_jumps_not_approved" },
    );
    assert.equal(posts(), sent, "a refused deletion sends nothing");
    const deleted = await write("delete", { course_id: 2, module_id: 8, page_id: 103, expected_jump_changes: [102, 104], expected_invalid_jumps: [101], expected_digest: forDelete.snapshot_digest });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(posts(), sent + 1, "one POST per write");
    assert.deepEqual(deleted.data.pages.map((item) => item.page_id), [101, 102, 104]);
    assert.deepEqual(deleted.proof.invalid_jump_targets, [{ page_id: 101, title: "Choose a path" }]);
    assert.equal(deleted.proof.page_list_readback, "blocked_by_invalid_jumps");
    assert.equal(deleted.proof.reversible_by_morrow, false);
    assert.ok(deleted.proof.removes.some((line) => /learner attempt/.test(line)));
    // While that jump is left invalid the review tool refuses this Lesson, and
    // the digest of this result is what the repair is approved against.
    assert.deepEqual(await graph(), { ok: false, sent: false, error: "moodle_lesson_pages_jump_target_unknown" });
    const repaired = await write("update", {
      course_id: 2, module_id: 8, page_id: 101, title: "Choose a path", contents: "<p>Pick a path.</p>",
      answers: [{ answer: "Path A", response: null, score: null, jump: { target: "page", page_id: 102 } }, { answer: "Path B", response: null, score: null, jump: { target: "page", page_id: 104 } }],
      expected_jump_changes: [], expected_digest: deleted.snapshot_digest,
    });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.deepEqual((await digest()).data, repaired.data);

    // A lost response is applied or unknown, and is never sent again.
    reset();
    const forLost = await digest();
    sent = posts();
    mode = "lost";
    const lost = await write("delete", { course_id: 2, module_id: 8, page_id: 104, expected_jump_changes: [], expected_invalid_jumps: [103], expected_digest: forLost.snapshot_digest });
    mode = "normal";
    assert.equal(posts(), sent + 1, "one POST, and no second attempt");
    assert.deepEqual(lost, {
      ok: false, sent: true, status: 200, outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_lesson_page_write_unconfirmed" },
      error: "moodle_lesson_page_write_unconfirmed",
    });

    // Moodle offers no move or delete control for a page it will not act on.
    reset();
    const forControls = await digest();
    mode = "no-move";
    assert.deepEqual(
      await write("move", { course_id: 2, module_id: 8, page_id: 103, after_page_id: 104, expected_jump_changes: [102, 104], expected_digest: forControls.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_move_control_missing" },
    );
    mode = "no-delete";
    assert.deepEqual(
      await write("delete", { course_id: 2, module_id: 8, page_id: 103, expected_jump_changes: [102, 104], expected_invalid_jumps: [101], expected_digest: forControls.snapshot_digest }),
      { ok: false, sent: false, status: 200, error: "moodle_lesson_page_write_delete_control_missing" },
    );
    mode = "normal";

    assert.equal(requests.some((item) => item.pathname === "/mod/lesson/view.php"), false, "no request may open the Lesson view route");
    assert.equal(requests.some((item) => item.method !== "GET" && item.method !== "POST"), false, "only GET reads and POST writes are sent");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
