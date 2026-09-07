import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleForumReadInPage } from "../../connector/extension/src/moodle-forum-read.js";

const OP = { key: "moodle.form.mod.forum.export.read.v1", toolName: "moodle_get_forum_posts", provider: "moodle", readOnly: true };
const csv = (rows) => `\ufeffid,discussion,parent,userid,userfullname,created,modified,subject,message\n${rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;

test("Moodle Forum reader uses only the native export download and preserves private author fields for gateway redaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-forum-read-"));
  const key = join(directory, "key.pem"); const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = []; let origin = ""; let browser; let overRecords = false; let overBytes = false; let listDelayMs = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, path: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") return response.end(`<!doctype html><body class="course-2"><script>var M={cfg:${JSON.stringify({ wwwroot: origin, sesskey: "private-session", userId: 3, courseId: 2 })}}</script></body>`);
    if (target.pathname === "/lib/ajax/service.php" && request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString())[0];
      assert.equal(call.methodname, "mod_forum_get_forums_by_courses");
      assert.deepEqual(call.args, { courseids: [2] });
      if (listDelayMs) await new Promise((resolve) => setTimeout(resolve, listDelayMs));
      return response.end(JSON.stringify([{ data: JSON.stringify([{ id: 8, course: 2, cmid: 71 }]) }]));
    }
    if (target.pathname === "/mod/forum/export.php" && request.method === "GET" && target.search === "?id=8") return response.end(`<!doctype html><form method="post" action="/mod/forum/export.php"><input type="hidden" name="id" value="8"><input type="hidden" name="sesskey" value="private-session"><input type="hidden" name="_qf__mod_forum_form_export_form" value="1"><select name="format"><option value="xlsx">xlsx</option><option value="csv">csv</option></select><input type="submit" name="submitbutton" value="Export"></form>`);
    if (target.pathname === "/mod/forum/export.php" && request.method === "POST" && !target.search) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      assert.match(body, /name="id"\r\n\r\n8/); assert.match(body, /name="sesskey"\r\n\r\nprivate-session/); assert.match(body, /name="format"\r\n\r\ncsv/);
      response.setHeader("content-type", "text/csv");
      if (overBytes) {
        response.write(csv([[101, 44, 0, 7, "Student Ñame", 1700000000, 1700000001, "Starter", "🙂".repeat(550_000)]]));
        return response.end();
      }
      return response.end(csv(overRecords ? Array.from({ length: 10_001 }, (_, index) => [index + 1, 44, 0, 7, "Student Name", 1700000000, 1700000001, "Starter", "Body"])
        : [
        [101, 44, 0, 7, "Student Ñame", 1700000000, 1700000001, "Starter", "A quoted\nreply 🙂"],
        [102, 44, 101, 3, "Course Teacher", 1700000002, 1700000003, "Response", "Teacher reply"],
      ]));
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    origin = `https://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true }); await page.goto(`${origin}/course/view.php?id=2`);
    const run = (args = { course_id: 2, forum_module_id: 71 }, expiresAt = Date.now() + 60_000) => page.evaluate(executeMoodleForumReadInPage, JSON.stringify({ operation: OP, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt }));
    const sourceRequests = () => requests.filter((request) => request.path === "/lib/ajax/service.php" || request.path === "/mod/forum/export.php").length;
    const fixtureRequests = () => requests.filter((request) => request.path !== "/favicon.ico").length;
    const exportRequests = () => requests.filter((request) => request.path === "/mod/forum/export.php").length;
    const beforeInvalid = sourceRequests();
    assert.deepEqual(await run({ course_id: 2, forum_module_id: 71, extra: true }), { ok: false, sent: false, error: "moodle_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);
    const result = await run();
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.complete, true);
    assert.deepEqual(result.data.posts.map(({ author, subject, message, parent }) => ({ author, subject, message, parent })), [
      { author: { user_id: "7", name: "Student Ñame" }, subject: "Starter", message: "A quoted\nreply 🙂", parent: "0" },
      { author: { user_id: "3", name: "Course Teacher" }, subject: "Response", message: "Teacher reply", parent: "101" },
    ]);
    assert.deepEqual(await run({ course_id: 2, forum_module_id: 99 }), { ok: false, sent: false, error: "moodle_forum_target_unavailable" });
    const beforeExpired = fixtureRequests();
    assert.deepEqual(await run(undefined, Date.now() - 1), { ok: false, sent: false, error: "moodle_arguments_invalid" });
    assert.deepEqual(await run(undefined, null), { ok: false, sent: false, error: "moodle_arguments_invalid" });
    assert.equal(fixtureRequests(), beforeExpired);
    listDelayMs = 2_600;
    const beforeLate = exportRequests();
    assert.deepEqual(await run(undefined, Date.now() + 1_200), { ok: false, sent: false, error: "moodle_forum_export_context_changed" });
    assert.equal(exportRequests(), beforeLate);
    listDelayMs = 0;
    overRecords = true;
    assert.deepEqual(await run(), { ok: false, sent: false, complete: false, error: "moodle_forum_export_incomplete" });
    overRecords = false; overBytes = true;
    assert.deepEqual(await run(), { ok: false, sent: false, complete: false, error: "moodle_forum_export_incomplete" });
    assert.equal(requests.filter((entry) => entry.path.includes("/view.php") && entry.path !== "/course/view.php").length, 0);
    assert.equal(requests.filter((entry) => entry.method === "POST" && entry.path !== "/lib/ajax/service.php" && entry.path !== "/mod/forum/export.php").length, 0);
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
});
