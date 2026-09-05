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

function pageForm(state) {
  return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=6&amp;return=0">
    <input name="update" value="6"><input name="course" value="2"><input name="modulename" value="page">
    <input name="name" value="${state.name}"><textarea name="page[text]">${state.content}</textarea><input name="page[format]" value="1">
    <input name="revision" value="${state.revision}"><input name="displayoptions[display]" value="1">
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

test("Moodle executor preserves inactive Page form values and verifies one revision increment in Chrome for Testing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-browser-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const state = {
    name: "Week 1 notes",
    content: "<p>Original content</p>",
    revision: 7,
    completion: { year: 2026, month: 9, day: 5, hour: 9, minute: 30 },
  };
  const posts = [];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body class="path-course course-2"><h1>Week 1</h1></body>');
      return;
    }
    if (url.pathname !== "/course/modedit.php") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(pageForm(state));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(values);
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
