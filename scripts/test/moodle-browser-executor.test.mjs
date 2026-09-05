import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";

const listOperation = {
  key: "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1",
  toolName: "moodle_list_my_courses",
  provider: "moodle",
  readOnly: true,
};

const pageReadOperation = {
  key: "moodle.form.course.modedit.page.read.v1",
  toolName: "moodle_get_page",
  provider: "moodle",
  readOnly: true,
};

const pageWriteOperation = {
  key: "moodle.form.course.modedit.page.write.v1",
  toolName: "moodle_update_page",
  provider: "moodle",
  readOnly: false,
};

const pageCreateReadOperation = {
  key: "moodle.form.course.modedit.page.create.read.v1",
  toolName: "moodle_get_page_creation_form",
  provider: "moodle",
  readOnly: true,
};

const pageCreateWriteOperation = {
  key: "moodle.form.course.modedit.page.create.write.v1",
  toolName: "moodle_create_page",
  provider: "moodle",
  readOnly: false,
};

const assignmentReadOperation = {
  key: "moodle.form.course.modedit.assign.read.v1",
  toolName: "moodle_get_assignment",
  provider: "moodle",
  readOnly: true,
};

const assignmentWriteOperation = {
  key: "moodle.form.course.modedit.assign.write.v1",
  toolName: "moodle_update_assignment",
  provider: "moodle",
  readOnly: false,
};

const assignmentCreateReadOperation = {
  key: "moodle.form.course.modedit.assign.create.read.v1",
  toolName: "moodle_get_assignment_creation_form",
  provider: "moodle",
  readOnly: true,
};

const assignmentCreateWriteOperation = {
  key: "moodle.form.course.modedit.assign.create.write.v1",
  toolName: "moodle_create_assignment",
  provider: "moodle",
  readOnly: false,
};

const quizQuestionsReadOperation = {
  key: "moodle.form.mod.quiz.edit.read.v1",
  toolName: "moodle_list_quiz_questions",
  provider: "moodle",
  readOnly: true,
};

const quizQuestionReadOperation = {
  key: "moodle.form.question.bank.editquestion.read.v1",
  toolName: "moodle_get_quiz_question",
  provider: "moodle",
  readOnly: true,
};

async function withMoodlePage(callback) {
  const keys = ["location", "M", "document", "fetch"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    Object.defineProperties(globalThis, {
      location: { configurable: true, writable: true, value: { origin: "https://sandbox.moodledemo.net", pathname: "/course/view.php", href: "https://sandbox.moodledemo.net/course/view.php?id=2" } },
      M: { configurable: true, writable: true, value: { cfg: { wwwroot: "https://sandbox.moodledemo.net", sesskey: "moodle-session-secret", userId: 3, courseId: 2 } } },
      document: { configurable: true, writable: true, value: { body: { className: "path-course course-2" }, querySelector: (selector) => selector === "h1" ? { textContent: "My first course" } : null } },
    });
    await callback();
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function listInput(expiresAt = Date.now() + 60_000) {
  return {
    mode: "execute",
    operation: listOperation,
    arguments: { limit: 25, _morrow: { ignored: true } },
    binding: { origin: "https://sandbox.moodledemo.net", siteUrl: "https://sandbox.moodledemo.net/", principalId: "3", courseId: "2" },
    expiresAt,
  };
}

function pageForm(state, moduleId = 6) {
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=${moduleId}&amp;return=0">
    <input name="update" value="${moduleId}"><input name="course" value="2"><input name="modulename" value="page"><input name="section" value="4">
    <input name="name" value="${state.name}"><textarea name="page[text]">${state.content}</textarea><input name="page[format]" value="1">
    <input name="revision" value="${state.revision}"><input name="visible" value="${state.visible ? 1 : 0}"><input name="displayoptions[display]" value="1">
    <input type="checkbox" name="completionexpected[enabled]" value="1">
    <input name="completionexpected[year]" value="${state.completion.year}"><input name="completionexpected[month]" value="${state.completion.month}"><input name="completionexpected[day]" value="${state.completion.day}"><input name="completionexpected[hour]" value="${state.completion.hour}"><input name="completionexpected[minute]" value="${state.completion.minute}">
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function pageCreationForm(state) {
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?add=page&amp;course=2&amp;sectionid=7&amp;return=0">
    <input name="course" value="2"><input name="add" value="page"><input name="modulename" value="page"><input name="section" value="4"><input name="return" value="0">
    <input name="name" value="${state.name}"><textarea name="page[text]">${state.content}</textarea><input name="page[format]" value="1"><input name="visible" value="${state.visible ? 1 : 0}">
    <input name="coursecontentnotification" value="1"><input name="displayoptions[display]" value="1">
    <input type="checkbox" name="completionexpected[enabled]" value="1">
    <input name="completionexpected[year]" value="${state.completion.year}"><input name="completionexpected[month]" value="${state.completion.month}"><input name="completionexpected[day]" value="${state.completion.day}"><input name="completionexpected[hour]" value="${state.completion.hour}"><input name="completionexpected[minute]" value="${state.completion.minute}">
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function assignmentForm(state, draftId, { moduleId = 8, creation = false } = {}) {
  const action = creation ? "/course/modedit.php?add=assign&amp;course=2&amp;sectionid=7&amp;return=0" : `/course/modedit.php?update=${moduleId}&amp;return=0`;
  const identity = creation
    ? '<input name="course" value="2"><input name="add" value="assign"><input name="modulename" value="assign"><input name="section" value="4"><input name="return" value="0"><input name="coursecontentnotification" value="1">'
    : `<input name="update" value="${moduleId}"><input name="course" value="2"><input name="modulename" value="assign"><input name="section" value="4">`;
  return `<!doctype html><html><body><form method="post" action="${action}">
    ${identity}
    <input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.instructions}</textarea><input name="introeditor[format]" value="1">
    <input name="visible" value="${state.visible ? 1 : 0}">
    <div data-fieldtype="filemanager"><input type="hidden" name="introattachments" value="${draftId}"></div>
    <input name="gradepass" value="${state.gradePass}">
    <input type="checkbox" name="allowsubmissionsfromdate[enabled]" value="1"${state.availableFromEnabled ? " checked" : ""}><input name="allowsubmissionsfromdate[year]" value="2026"><input name="allowsubmissionsfromdate[month]" value="9"><input name="allowsubmissionsfromdate[day]" value="5"><input name="allowsubmissionsfromdate[hour]" value="9"><input name="allowsubmissionsfromdate[minute]" value="30">
    <input type="checkbox" name="duedate[enabled]" value="1"${state.dueDateEnabled ? " checked" : ""}><input name="duedate[year]" value="2026"><input name="duedate[month]" value="9"><input name="duedate[day]" value="5"><input name="duedate[hour]" value="9"><input name="duedate[minute]" value="30">
    <input type="checkbox" name="cutoffdate[enabled]" value="1"${state.cutoffEnabled ? " checked" : ""}><input name="cutoffdate[year]" value="2026"><input name="cutoffdate[month]" value="9"><input name="cutoffdate[day]" value="5"><input name="cutoffdate[hour]" value="9"><input name="cutoffdate[minute]" value="30">
    <input type="checkbox" name="gradingduedate[enabled]" value="1"${state.gradingDueEnabled ? " checked" : ""}><input name="gradingduedate[year]" value="2026"><input name="gradingduedate[month]" value="9"><input name="gradingduedate[day]" value="5"><input name="gradingduedate[hour]" value="9"><input name="gradingduedate[minute]" value="30">
    <input type="submit" name="submitbutton" value="Save and return to course">
  </form></body></html>`;
}

function quizEditPage() {
  return `<!doctype html><html><body><ul class="slots" role="presentation"><li class="section main clearfix" id="section-1" role="presentation"><div class="content"><ul class="section img-text">
      <li class="activity multichoice qtype_multichoice slot" id="slot-17"><div class="activityinstance"><a href="/question/bank/editquestion/question.php?id=401&amp;cmid=9&amp;returnurl=%2Fmod%2Fquiz%2Fedit.php%3Fcmid%3D9"><span class="instancename">Evidence check</span></a></div><div class="actions"><select class="form-select version-selection" data-slot-id="17"><option value="0" selected="selected">Always latest</option><option value="1">v1</option></select></div></li>
      <li class="activity random qtype_random slot" id="slot-18"><div class="activityinstance"><span class="instancename">Random evidence question</span></div></li>
      <li class="activity truefalse qtype_truefalse slot" id="slot-19"><div class="activityinstance"><a href="/question/bank/editquestion/question.php?id=402&amp;cmid=9"><span class="instancename">Unsupported question</span></a></div><div class="actions"><select class="form-select version-selection" data-slot-id="19"><option value="0">Always latest</option><option value="2" selected="selected">v2</option></select></div></li>
    </ul></div></li></ul></body></html>`;
}

function multipleChoiceQuestionForm() {
  return `<!doctype html><html><body><form method="post" action="/question/bank/editquestion/question.php">
    <input type="hidden" name="id" value="401"><input type="hidden" name="cmid" value="9"><input type="hidden" name="courseid" value="2"><input type="hidden" name="qtype" value="multichoice">
    <input name="name" value="Evidence check"><textarea name="questiontext[text]"><p>Which claim has evidence?</p></textarea><input name="questiontext[format]" value="1"><input name="questiontext[itemid]" value="971">
    <select name="status"><option value="ready" selected="selected">Ready</option><option value="draft">Draft</option></select><input name="defaultmark" value="1.00"><textarea name="generalfeedback[text]"></textarea><input name="generalfeedback[format]" value="1"><input name="generalfeedback[itemid]" value="972"><input name="idnumber" value="evidence-1">
    <select name="single"><option value="0">Multiple</option><option value="1" selected="selected">One</option></select><input type="hidden" name="shuffleanswers" value="0"><input type="checkbox" name="shuffleanswers" value="1" checked><select name="answernumbering"><option value="abc" selected="selected">a.</option></select><select name="showstandardinstruction"><option value="0">No</option><option value="1" selected="selected">Yes</option></select>
    <textarea name="answer[0][text]"><p>Use the cited source.</p></textarea><input name="answer[0][format]" value="1"><input name="fraction[0]" value="100"><textarea name="feedback[0][text]"><p>Correct.</p></textarea><input name="feedback[0][format]" value="1"><input name="answer[0][itemid]" value="973"><input name="feedback[0][itemid]" value="974">
    <textarea name="answer[1][text]"><p>Guess.</p></textarea><input name="answer[1][format]" value="1"><input name="fraction[1]" value="0"><textarea name="feedback[1][text]"></textarea><input name="feedback[1][format]" value="1"><input name="answer[1][itemid]" value="975"><input name="feedback[1][itemid]" value="976">
    <textarea name="answer[2][text]"></textarea><input name="answer[2][format]" value="1"><input name="fraction[2]" value="0"><textarea name="feedback[2][text]"></textarea><input name="feedback[2][format]" value="1"><input name="answer[2][itemid]" value="977"><input name="feedback[2][itemid]" value="978">
  </form></body></html>`;
}

async function executeInBrowser(page, input) {
  return page.evaluate(async ({ source, value }) => {
    const execute = (0, eval)(`(${source})`);
    return execute(value);
  }, { source: executeMoodleInPage.toString(), value: JSON.stringify(input) });
}

test("Moodle executor updates and creates hidden Pages and Assignments from native forms in Chrome for Testing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const state = {
    name: "Week 1 notes",
    content: "<p>Original content</p>",
    revision: 7,
    visible: true,
    completion: { year: 2026, month: 9, day: 5, hour: 9, minute: 30 },
  };
  const creationDefaults = {
    name: "",
    content: "",
    visible: true,
    completion: { year: 2026, month: 9, day: 5, hour: 9, minute: 30 },
  };
  const assignment = {
    name: "Evidence analysis",
    instructions: "<p>Original brief</p>",
    visible: true,
    availableFromEnabled: false,
    dueDateEnabled: true,
    cutoffEnabled: false,
    gradingDueEnabled: false,
    gradePass: "0.00",
  };
  const assignmentCreationDefaults = {
    name: "",
    instructions: "",
    visible: true,
    availableFromEnabled: false,
    dueDateEnabled: false,
    cutoffEnabled: false,
    gradingDueEnabled: false,
    gradePass: "",
  };
  const hiddenSectionActivity = { visible: false, visibleOld: false, stealth: false };
  const quizActivity = { visible: true, visibleOld: true };
  const posts = [];
  const assignmentPosts = [];
  const assignmentCreationPosts = [];
  const visibilityActions = [];
  const draftListIds = [];
  const requests = [];
  let structureReads = 0;
  let createdPage = null;
  let createdAssignment = null;
  let changeName = false;
  let draftId = 700;
  let draftFileCount = 0;
  let sectionVisible = false;
  let sectionHasRestrictions = false;
  let leaveHiddenActivityVisibleOnSectionHide = false;
  let quizEditNative = true;
  let moveFixture = false;
  let moveActivitySection = 7;
  let moveUnexpected = false;
  let moveUnexpectedAfter = false;
  const moveActions = [];
  const moveState = () => {
    const moved = {
      id: 59, module: "page", sectionid: String(moveActivitySection), sectionnumber: moveActivitySection === 7 ? 4 : 5,
      name: "Evidence notebook", visible: true, stealth: false, hasdelegatedsection: false,
      uservisible: true, accessvisible: true, hascmrestrictions: false, allowstealth: true,
    };
    const destination = {
      id: 60, module: "url", sectionid: "8", sectionnumber: 5, name: "Further reading", visible: true,
      stealth: false, hasdelegatedsection: false, uservisible: true, accessvisible: true, hascmrestrictions: false, allowstealth: true,
    };
    return {
      course: { id: 2, fullname: moveUnexpected ? "Unexpected course name" : "Week 1" },
      section: [
        { id: "7", number: 4, title: "Week 4: Evidence", visible: true, hasrestrictions: false, component: "", cmlist: moveActivitySection === 7 ? ["59"] : [] },
        { id: "8", number: 5, title: "Week 5: Synthesis", visible: true, hasrestrictions: false, component: null, cmlist: moveActivitySection === 7 ? ["60"] : ["60", "59"] },
      ],
      cm: moveActivitySection === 7 ? [moved, destination] : [destination, moved],
    };
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body class="path-course course-2"><h1>Week 1</h1></body>');
      return;
    }
    if (url.pathname === "/mod/page/view.php" || url.pathname === "/mod/assign/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body class="path-course course-2"><h1>Week 1</h1></body>');
      return;
    }
    if (url.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
        if (call?.methodname === "core_courseformat_update_course") {
          if (call.args.action === "cm_move") {
            moveActions.push(call.args);
            moveActivitySection = 8;
            if (moveUnexpectedAfter) moveUnexpected = true;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify([{ data: null }]));
            return;
          }
          visibilityActions.push(call.args.action);
          if (createdPage) {
            if (call.args.action === "section_hide") {
              createdPage.visibleOld = createdPage.visible;
              createdPage.visible = false;
              hiddenSectionActivity.visibleOld = hiddenSectionActivity.visible;
              if (!leaveHiddenActivityVisibleOnSectionHide) hiddenSectionActivity.visible = false;
              quizActivity.visibleOld = quizActivity.visible;
              quizActivity.visible = false;
              sectionVisible = false;
              sectionHasRestrictions = false;
            } else if (call.args.action === "section_show") {
              createdPage.visible = createdPage.visibleOld;
              hiddenSectionActivity.visible = hiddenSectionActivity.visibleOld;
              quizActivity.visible = quizActivity.visibleOld;
              sectionVisible = true;
              sectionHasRestrictions = true;
            } else {
              createdPage.visible = call.args.action === "cm_show";
              createdPage.visibleOld = createdPage.visible;
            }
            if (changeName) { createdPage.name = "Unexpected Page name"; changeName = false; }
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([{ data: null }]));
          return;
        }
        structureReads += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          data: JSON.stringify(moveFixture ? moveState() : {
            course: { id: 2, fullname: "Week 1" },
            section: [{ id: 7, number: 4, title: "Week 4: Evidence", visible: sectionVisible, hasrestrictions: sectionHasRestrictions, component: "" }],
            cm: [
              ...(createdPage ? [{ id: 55, module: "page", sectionid: 7, name: createdPage.name, visible: createdPage.visible, uservisible: true, accessvisible: createdPage.visible, hascmrestrictions: false, stealth: createdPage.visible && !sectionVisible, allowstealth: sectionVisible }] : []),
              { id: 57, module: "url", sectionid: 7, name: "Already hidden resource", visible: hiddenSectionActivity.visible, uservisible: true, accessvisible: hiddenSectionActivity.visible, hascmrestrictions: false, stealth: hiddenSectionActivity.stealth, allowstealth: sectionVisible },
              { id: 9, module: "quiz", sectionid: 7, name: "Evidence quiz", visible: quizActivity.visible, uservisible: true, accessvisible: quizActivity.visible, hascmrestrictions: false, stealth: quizActivity.visible && !sectionVisible, allowstealth: sectionVisible },
              ...(createdAssignment ? [{ id: 56, module: "assign", sectionid: 7, visible: createdAssignment.visible }] : []),
            ],
          }),
        }]));
      });
      return;
    }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        draftListIds.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("itemid"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ filecount: draftFileCount, filesize: draftFileCount, list: draftFileCount ? [{ filename: "existing.pdf" }] : [] }));
      });
      return;
    }
    if (url.pathname === "/mod/quiz/edit.php" && request.method === "GET" && url.searchParams.get("cmid") === "9") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(quizEditNative ? quizEditPage() : "<!doctype html><html><body>Quiz access denied</body></html>");
      return;
    }
    if (url.pathname === "/question/bank/editquestion/question.php" && request.method === "GET" && url.searchParams.get("id") === "401" && url.searchParams.get("cmid") === "9") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(multipleChoiceQuestionForm());
      return;
    }
    if (url.pathname !== "/course/modedit.php") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      if (url.searchParams.get("add") === "page") response.end(pageCreationForm(creationDefaults));
      else if (url.searchParams.get("add") === "assign") response.end(assignmentForm(assignmentCreationDefaults, ++draftId, { creation: true }));
      else if (url.searchParams.get("update") === "6") response.end(pageForm(state, 6));
      else if (url.searchParams.get("update") === "55" && createdPage) response.end(pageForm(createdPage, 55));
      else if (url.searchParams.get("update") === "8") response.end(assignmentForm(assignment, ++draftId));
      else if (url.searchParams.get("update") === "56" && createdAssignment) response.end(assignmentForm(createdAssignment, ++draftId, { moduleId: 56 }));
      else response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(values);
      if (values.get("add") === "assign") {
        assignmentCreationPosts.push(values);
        createdAssignment = {
          name: values.get("name") || "",
          instructions: values.get("introeditor[text]") || "",
          visible: values.get("visible") === "1",
          availableFromEnabled: values.has("allowsubmissionsfromdate[enabled]"),
          dueDateEnabled: values.has("duedate[enabled]"),
          cutoffEnabled: values.has("cutoffdate[enabled]"),
          gradingDueEnabled: values.has("gradingduedate[enabled]"),
          gradePass: "0.00",
        };
        response.writeHead(303, { location: "/mod/assign/view.php?id=56" }).end();
        return;
      }
      if (values.get("update") === "8") {
        assignmentPosts.push(values);
        assignment.instructions = values.get("introeditor[text]") || "";
        assignment.dueDateEnabled = values.has("duedate[enabled]");
        response.writeHead(303, { location: "/course/view.php" }).end();
        return;
      }
      if (values.get("add") === "page") {
        createdPage = {
          name: values.get("name") || "",
          content: values.get("page[text]") || "",
          revision: 1,
          visible: false,
          visibleOld: false,
          completion: creationDefaults.completion,
        };
        response.writeHead(303, { location: "/mod/page/view.php?id=55" }).end();
        return;
      }
      state.content = values.get("page[text]") || "";
      state.revision += 1;
      state.completion = { year: 2031, month: 1, day: 2, hour: 3, minute: 4 };
      response.writeHead(303, { location: "/course/view.php" }).end();
    });
  });
  let browser;
  let context;
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Moodle test server did not bind a port");
    const origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/course/view.php?id=2`);
    await page.evaluate((wwwroot) => {
      globalThis.M = { cfg: { wwwroot, sesskey: "synthetic-session", userId: 3, courseId: 2 } };
    }, origin);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const read = await executeInBrowser(page, {
      mode: "execute",
      operation: pageReadOperation,
      arguments: { course_id: 2, module_id: 6 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(read.ok, true);
    assert.equal(read.data.content, "<p>Original content</p>");
    state.completion.minute = 31;
    const result = await executeInBrowser(page, {
      mode: "execute",
      operation: pageWriteOperation,
      arguments: { course_id: 2, module_id: 6, content: "<p>Updated content</p>", expected_digest: read.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(result.data.content, "<p>Updated content</p>");
    assert.equal(result.data.name, "Week 1 notes");
    assert.equal(state.revision, 8);
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.equal(post.get("page[text]"), "<p>Updated content</p>");
    assert.equal(post.get("name"), "Week 1 notes");
    assert.equal(post.get("revision"), "7");
    assert.equal(post.get("page[format]"), "1");
    assert.equal(post.get("displayoptions[display]"), "1");
    assert.equal(post.get("completionexpected[enabled]"), null);
    assert.equal(post.get("completionexpected[year]"), "2026");
    assert.equal(post.get("completionexpected[month]"), "9");
    assert.equal(post.get("completionexpected[day]"), "5");
    assert.equal(post.get("completionexpected[hour]"), "9");
    assert.equal(post.get("completionexpected[minute]"), "31");

    const preparation = await executeInBrowser(page, {
      mode: "execute",
      operation: pageCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(preparation.ok, true);
    assert.match(preparation.snapshot_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(preparation.data, { course_id: 2, section_id: 7, name: "", content: "", content_format: 1, visible: true });
    assert.deepEqual(preparation.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "section_id", label: "Section", name: "Week 4: Evidence" },
    ]);

    const created = await executeInBrowser(page, {
      mode: "execute",
      operation: pageCreateWriteOperation,
      arguments: {
        course_id: 2,
        section_id: 7,
        name: "Evidence notebook",
        content: "<p>Write one claim.</p>",
        expected_digest: preparation.snapshot_digest,
      },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(created.data, {
      course_id: 2,
      module_id: 55,
      name: "Evidence notebook",
      content: "<p>Write one claim.</p>",
      content_format: 1,
      section_id: 7,
      visible: false,
    });
    assert.deepEqual(created.targets, preparation.targets);
    assert.ok(requests.includes("GET /course/modedit.php?add=page&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=55&return=0"));
    assert.equal(structureReads, 4);
    assert.equal(posts.length, 2);
    const creationPost = posts[1];
    assert.equal(creationPost.get("course"), "2");
    assert.equal(creationPost.get("add"), "page");
    assert.equal(creationPost.get("modulename"), "page");
    assert.equal(creationPost.get("section"), "4");
    assert.equal(creationPost.get("name"), "Evidence notebook");
    assert.equal(creationPost.get("page[text]"), "<p>Write one claim.</p>");
    assert.equal(creationPost.get("visible"), "0");
    assert.equal(creationPost.get("coursecontentnotification"), null);
    assert.equal(creationPost.get("page[format]"), "1");
    assert.equal(creationPost.get("displayoptions[display]"), "1");
    assert.equal(creationPost.get("completionexpected[enabled]"), null);

    const quizQuestions = await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionsReadOperation,
      arguments: { course_id: 2, module_id: 9 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(quizQuestions.ok, true);
    assert.deepEqual(quizQuestions.data.questions, [
      { slot_id: 17, position: 1, qtype: "multichoice", status: "not_exposed", version: { mode: "latest" }, question_id: 401, name: "Evidence check", inspectable: true },
      { slot_id: 18, position: 2, qtype: "random", status: "not_exposed", inspectable: false, reason: "random_slot", name: "Random evidence question" },
      { slot_id: 19, position: 3, qtype: "truefalse", status: "not_exposed", version: { mode: "pinned", number: 2 }, question_id: 402, name: "Unsupported question", inspectable: false, reason: "unsupported_type" },
    ]);
    const quizQuestion = await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionReadOperation,
      arguments: { course_id: 2, module_id: 9, slot_id: 17 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(quizQuestion.ok, true);
    assert.deepEqual(quizQuestion.data, {
      course_id: 2,
      module_id: 9,
      slot_id: 17,
      question_id: 401,
      version: { mode: "latest" },
      qtype: "multichoice",
      name: "Evidence check",
      question_text: "<p>Which claim has evidence?</p>",
      question_text_format: "1",
      status: "ready",
      default_mark: "1.00",
      general_feedback: "",
      general_feedback_format: "1",
      id_number: "evidence-1",
      details: {
        single: true,
        shuffle_answers: true,
        answer_numbering: "abc",
        show_standard_instruction: true,
        choices: [
          { text: "<p>Use the cited source.</p>", format: "1", fraction: "100", feedback: "<p>Correct.</p>", feedback_format: "1" },
          { text: "<p>Guess.</p>", format: "1", fraction: "0", feedback: "", feedback_format: "1" },
        ],
        choices_truncated: false,
      },
    });
    assert.ok(requests.includes("GET /mod/quiz/edit.php?cmid=9"));
    assert.ok(requests.includes("GET /question/bank/editquestion/question.php?id=401&cmid=9"));
    assert.doesNotMatch(JSON.stringify(quizQuestion.data), /97[1-8]|draftfile\.php/);
    const questionRequests = requests.filter((request) => request.startsWith("GET /question/bank/editquestion/question.php")).length;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionReadOperation,
      arguments: { course_id: 2, module_id: 9, slot_id: 18 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_quiz_random_slot_uninspectable" });
    assert.equal(requests.filter((request) => request.startsWith("GET /question/bank/editquestion/question.php")).length, questionRequests);
    quizEditNative = false;
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: quizQuestionsReadOperation,
      arguments: { course_id: 2, module_id: 9 },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, status: 200, error: "moodle_quiz_questions_target_invalid" });
    quizEditNative = true;

    const run = (toolName, key, params) => executeInBrowser(page, { mode: "execute", operation: { toolName, key, provider: "moodle", readOnly: toolName === "moodle_get_contents" }, arguments: params, binding, expiresAt: Date.now() + 60_000 });
    const activity = (result) => result.data.activities.find((item) => item.id === 55);
    const hiddenActivity = (result) => result.data.activities.find((item) => item.id === 57);
    const setVisible = (show, digest) => run(`moodle_${show ? "show" : "hide"}_activity`, `moodle.ajax.core_courseformat_update_course.cm_${show ? "show" : "hide"}.v1`, { course_id: 2, module_id: 55, expected_digest: digest });
    let visibility = await setVisible(true, (await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest);
    assert.equal(visibility.ok, true);
    assert.deepEqual([activity(visibility).name, activity(visibility).visible, activity(visibility).accessvisible, activity(visibility).hascmrestrictions, activity(visibility).stealth], ["Evidence notebook", true, true, false, true]);
    visibility = await setVisible(false, visibility.snapshot_digest);
    assert.equal(visibility.ok, true);
    assert.deepEqual([activity(visibility).name, activity(visibility).visible, activity(visibility).accessvisible, activity(visibility).hascmrestrictions, activity(visibility).stealth], ["Evidence notebook", false, false, false, false]);
    changeName = true;
    const renamed = await setVisible(true, visibility.snapshot_digest);
    assert.deepEqual([renamed.ok, renamed.sent, renamed.error, activity(renamed).name], [false, true, "moodle_write_not_verified", "Unexpected Page name"]);
    assert.deepEqual(visibilityActions, ["cm_show", "cm_hide", "cm_show"]);

    createdPage.name = "Evidence notebook";
    createdPage.visible = true;
    createdPage.visibleOld = true;
    sectionVisible = true;
    sectionHasRestrictions = true;
    const setSectionVisible = (show, digest) => run(`moodle_${show ? "show" : "hide"}_section`, `moodle.ajax.core_courseformat_update_course.section_${show ? "show" : "hide"}.v1`, { course_id: 2, section_id: 7, expected_digest: digest });
    let sectionVisibility = await setSectionVisible(false, (await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest);
    assert.equal(sectionVisibility.ok, true);
    assert.deepEqual([activity(sectionVisibility).visible, hiddenActivity(sectionVisibility).visible], [false, false]);
    sectionVisibility = await setSectionVisible(true, sectionVisibility.snapshot_digest);
    assert.equal(sectionVisibility.ok, true);
    assert.deepEqual([activity(sectionVisibility).visible, hiddenActivity(sectionVisibility).visible], [true, false]);
    hiddenSectionActivity.visible = true;
    hiddenSectionActivity.visibleOld = true;
    hiddenSectionActivity.stealth = true;
    const criticalDigest = (await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest;
    leaveHiddenActivityVisibleOnSectionHide = true;
    const sectionMismatch = await setSectionVisible(false, criticalDigest);
    assert.deepEqual([sectionMismatch.ok, sectionMismatch.sent, sectionMismatch.error, hiddenActivity(sectionMismatch).visible], [false, true, "moodle_write_not_verified", true]);
    assert.deepEqual(visibilityActions.slice(-3), ["section_hide", "section_show", "section_hide"]);

    await page.evaluate(() => {
      history.replaceState(null, "", "/mod/assign/view.php?id=8");
      document.querySelector("h1").textContent = "Evidence analysis";
      document.body.insertAdjacentHTML("beforeend", '<nav id="page-navbar"><ol class="breadcrumb"><li><a href="/course/view.php?id=2">Week 1</a></li></ol></nav>');
    });
    const assignmentRead = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentReadOperation,
      arguments: { course_id: 2, module_id: 8 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    const assignmentReadAgain = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentReadOperation,
      arguments: { course_id: 2, module_id: 8 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(assignmentRead.ok, true);
    assert.equal(assignmentReadAgain.ok, true);
    assert.equal(assignmentRead.targets[0].name, "Week 1");
    assert.equal(assignmentRead.snapshot_digest, assignmentReadAgain.snapshot_digest);
    assert.deepEqual(assignmentRead.data.due_date, { year: 2026, month: 9, day: 5, hour: 9, minute: 30 });
    assert.notEqual(draftListIds[0], draftListIds[1]);

    const assignmentWrite = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentWriteOperation,
      arguments: { course_id: 2, module_id: 8, instructions: "<p>Approved brief</p>", due_date: null, expected_digest: assignmentRead.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(assignmentWrite.ok, true);
    assert.deepEqual(assignmentWrite.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(assignmentWrite.data.due_date, null);
    assert.equal(assignmentPosts.length, 1);
    assert.equal(assignmentPosts[0].get("introeditor[text]"), "<p>Approved brief</p>");
    assert.equal(assignmentPosts[0].get("duedate[enabled]"), null);

    const assignmentPreparation = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentCreateReadOperation,
      arguments: { course_id: 2, section_id: 7 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(assignmentPreparation.ok, true);
    assert.deepEqual(assignmentPreparation.data, {
      course_id: 2,
      section_id: 7,
      name: "",
      instructions: "",
      instructions_format: 1,
      visible: true,
      available_from: null,
      due_date: null,
      cutoff_at: null,
      grading_due_at: null,
    });
    assert.deepEqual(assignmentPreparation.targets, preparation.targets);

    const createdAssignmentResult = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentCreateWriteOperation,
      arguments: {
        course_id: 2,
        section_id: 7,
        name: "Evidence practice",
        instructions: "<p>Read the evidence.</p>",
        available_from: null,
        due_date: null,
        cutoff_at: null,
        grading_due_at: null,
        expected_digest: assignmentPreparation.snapshot_digest,
      },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(createdAssignmentResult.ok, true);
    assert.deepEqual(createdAssignmentResult.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(createdAssignmentResult.data, {
      course_id: 2,
      module_id: 56,
      name: "Evidence practice",
      instructions: "<p>Read the evidence.</p>",
      instructions_format: 1,
      available_from: null,
      due_date: null,
      cutoff_at: null,
      grading_due_at: null,
      section_id: 7,
      visible: false,
    });
    assert.deepEqual(createdAssignmentResult.targets, assignmentPreparation.targets);
    assert.equal(assignmentCreationPosts.length, 1);
    const assignmentCreationPost = assignmentCreationPosts[0];
    assert.equal(assignmentCreationPost.get("course"), "2");
    assert.equal(assignmentCreationPost.get("add"), "assign");
    assert.equal(assignmentCreationPost.get("modulename"), "assign");
    assert.equal(assignmentCreationPost.get("section"), "4");
    assert.equal(assignmentCreationPost.get("name"), "Evidence practice");
    assert.equal(assignmentCreationPost.get("introeditor[text]"), "<p>Read the evidence.</p>");
    assert.equal(assignmentCreationPost.get("visible"), "0");
    assert.equal(assignmentCreationPost.get("coursecontentnotification"), null);
    assert.equal(assignmentCreationPost.get("gradepass"), "");
    for (const field of ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate"]) {
      assert.equal(assignmentCreationPost.get(`${field}[enabled]`), null);
    }
    assert.ok(requests.includes("GET /course/modedit.php?add=assign&course=2&sectionid=7&return=0"));
    assert.ok(requests.includes("GET /course/modedit.php?update=56&return=0"));

    moveFixture = true;
    moveActivitySection = 7;
    moveUnexpected = false;
    moveUnexpectedAfter = false;
    const moveActivity = (digest) => run("moodle_move_activity", "moodle.ajax.core_courseformat_update_course.cm_move.v1", {
      course_id: 2, module_id: 59, target_section_id: 8, expected_digest: digest,
    });
    const moveRead = await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 });
    const moved = await moveActivity(moveRead.snapshot_digest);
    assert.equal(moved.ok, true);
    assert.deepEqual(moved.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual([moved.data.activities.find((entry) => entry.id === 59).sectionid, moved.data.sections.find((entry) => entry.id === "7").cmlist, moved.data.sections.find((entry) => entry.id === "8").cmlist], ["8", [], ["60", "59"]]);
    assert.deepEqual(moved.targets, [
      { field: "course_id", label: "Course", name: "Week 1" },
      { field: "module_id", label: "Activity", name: "Evidence notebook" },
      { field: "target_section_id", label: "Destination section", name: "Week 5: Synthesis" },
    ]);
    moveActivitySection = 7;
    moveUnexpected = false;
    moveUnexpectedAfter = true;
    const moveMismatch = await moveActivity((await run("moodle_get_contents", "moodle.ajax.core_courseformat_get_state.v1", { course_id: 2 })).snapshot_digest);
    assert.deepEqual([moveMismatch.ok, moveMismatch.sent, moveMismatch.error], [false, true, "moodle_write_not_verified"]);
    assert.deepEqual(moveActions.map(({ action, courseid, ids, targetsectionid, targetcmid }) => ({ action, courseid, ids, targetsectionid, targetcmid })), [
      { action: "cm_move", courseid: 2, ids: [59], targetsectionid: 8, targetcmid: null },
      { action: "cm_move", courseid: 2, ids: [59], targetsectionid: 8, targetcmid: null },
    ]);

    draftFileCount = 1;
    const nonemptyAssignment = await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentReadOperation,
      arguments: { course_id: 2, module_id: 8 },
      binding,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(nonemptyAssignment.ok, true);
    assert.deepEqual(await executeInBrowser(page, {
      mode: "execute",
      operation: assignmentWriteOperation,
      arguments: { course_id: 2, module_id: 8, instructions: "<p>Blocked brief</p>", expected_digest: nonemptyAssignment.snapshot_digest },
      binding,
      expiresAt: Date.now() + 60_000,
    }), { ok: false, sent: false, error: "moodle_filemanager_nonempty" });
    assert.equal(assignmentPosts.length, 1);
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Moodle executor rejects expired work before it calls Moodle", async () => {
  await withMoodlePage(async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error("must not run"); };
    assert.deepEqual(await executeMoodleInPage(JSON.stringify(listInput(Date.now() - 1))), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(calls, 0);
  });
});
