import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchTestChromium } from "./lib/chromium-launch.mjs";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";

test("Moodle course pages refuse malformed provider rows and preserve unlimited paging", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-course-integrity-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  let origin;
  let suppliedRows = [];
  let ignoreLimit = false;
  let providerCalls = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><body><h1>Disposable Moodle fixture</h1></body>");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      providerCalls++;
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(call.methodname, "core_course_get_enrolled_courses_by_timeline_classification");
      const courses = ignoreLimit ? suppliedRows : suppliedRows.slice(call.args.offset, call.args.offset + call.args.limit);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ data: { courses } }]));
    });
  });
  let browser;
  let context;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${server.address().port}`;
    browser = await launchTestChromium();
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate((wwwroot) => { globalThis.M = { cfg: { wwwroot, userId: 3, sesskey: "dummy-browser-only" } }; }, origin);
    const read = (limit = 3, offset = 0) => page.evaluate(executeMoodleInPage, JSON.stringify({
      mode: "execute", expiresAt: Date.now() + 60_000,
      operation: { key: "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1", toolName: "moodle_list_my_courses", provider: "moodle", readOnly: true },
      binding: { origin, siteUrl: `${origin}/`, principalId: "3" }, arguments: { limit, offset },
    }));
    for (const [name, rows] of [
      ["duplicate course IDs", [{ id: 2, fullname: "First" }, { id: 2, fullname: "Duplicate" }]],
      ["oversized provider page", Array.from({ length: 4 }, (_, i) => ({ id: i + 2, fullname: `Course ${i}` }))],
      ["blank course name", [{ id: 2, fullname: "   " }]],
      ["invalid row after page limit", [{ id: 2, fullname: "First" }, { id: 3, fullname: "Second" }, { id: 4, fullname: "Third" }, { id: 0, fullname: "Invalid" }]],
    ]) {
      await t.test(name, async () => {
        suppliedRows = rows;
        ignoreLimit = true;
        const before = providerCalls;
        const result = await read();
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.error, "moodle_courses_invalid");
        assert.equal(providerCalls, before + 1);
      });
    }
    await t.test("257 courses are read without loss or repetition", async () => {
      suppliedRows = Array.from({ length: 257 }, (_, i) => ({ id: i + 2, fullname: `Course ${i + 2}` }));
      ignoreLimit = false;
      let offset = 0;
      const ids = [];
      for (;;) {
        const result = await read(100, offset);
        assert.equal(result.ok, true, JSON.stringify(result));
        ids.push(...result.data.courses.map((course) => course.id));
        if (result.data.complete) break;
        assert.ok(result.data.next_offset > offset);
        offset = result.data.next_offset;
      }
      assert.deepEqual(ids, suppliedRows.map((course) => String(course.id)));
      assert.equal(new Set(ids).size, 257);
    });
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
