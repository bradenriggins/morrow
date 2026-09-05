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

async function withMoodlePage(callback) {
  const keys = ["location", "M", "document", "fetch"];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    Object.defineProperties(globalThis, {
      location: { configurable: true, writable: true, value: { origin: "https://sandbox.moodledemo.net", pathname: "/course/view.php" } },
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

async function executeInBrowser(page, input) {
  return page.evaluate(async ({ source, value }) => {
    const execute = (0, eval)(`(${source})`);
    return execute(value);
  }, { source: executeMoodleInPage.toString(), value: input });
}

test("Moodle executor updates and creates hidden Pages from native forms in Chrome for Testing", async () => {
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
  const posts = [];
  const requests = [];
  let structureReads = 0;
  let createdPage = null;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body class="path-course course-2"><h1>Week 1</h1></body>');
      return;
    }
    if (url.pathname === "/mod/page/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body class="path-course course-2"><h1>Week 1</h1></body>');
      return;
    }
    if (url.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        structureReads += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          data: JSON.stringify({
            course: { id: 2, fullname: "Week 1" },
            section: [{ id: 7, number: 4, title: "Week 4: Evidence" }],
            cm: createdPage ? [{ id: 55, module: "page", sectionid: 7, visible: false }] : [],
          }),
        }]));
      });
      return;
    }
    if (url.pathname !== "/course/modedit.php") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      if (url.searchParams.get("add") === "page") response.end(pageCreationForm(creationDefaults));
      else if (url.searchParams.get("update") === "6") response.end(pageForm(state, 6));
      else if (url.searchParams.get("update") === "55" && createdPage) response.end(pageForm(createdPage, 55));
      else response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(values);
      if (values.get("add") === "page") {
        createdPage = {
          name: values.get("name") || "",
          content: values.get("page[text]") || "",
          revision: 1,
          visible: false,
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
    await page.goto(`${origin}/course/view.php`);
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
    assert.deepEqual(await executeMoodleInPage(listInput(Date.now() - 1)), { ok: false, sent: false, error: "moodle_execution_expired" });
    assert.equal(calls, 0);
  });
});
