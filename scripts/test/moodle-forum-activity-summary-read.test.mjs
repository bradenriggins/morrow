import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleForumActivitySummaryInPage } from "../../connector/extension/src/moodle-forum-activity-summary-read.js";

const OPERATION = Object.freeze({
  key: "moodle.form.forum.activity_summary.read.v1",
  toolName: "moodle_get_forum_activity_summary",
  provider: "moodle",
  readOnly: true,
});

test("Moodle Forum activity summary is cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const entries = catalog.operations.filter((entry) => entry.key === "moodle.form.forum.activity_summary.read.v1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolName, "moodle_get_forum_activity_summary");
  assert.equal(entries[0].provider, "moodle");
  assert.equal(entries[0].readOnly, true);
  assert.equal(entries[0].dataClass, "learner");
  assert.match(entries[0].description, /mod\/forum:viewdiscussion/);
  assert.match(entries[0].description, /never opens \/mod\/forum\/view\.php or \/mod\/forum\/discuss\.php/);
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleForumActivitySummaryInPage \} from "\.\/moodle-forum-activity-summary-read\.js";/);
  assert.match(worker, /MOODLE_FORUM_ACTIVITY_SUMMARY_OPERATION_KEY = "moodle\.form\.forum\.activity_summary\.read\.v1"/);
  assert.match(worker, /func: executeMoodleForumActivitySummaryInPage/);
});

test("Moodle Forum activity summary uses only its native read service and returns bounded totals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-forum-activity-summary-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;
  const discussion = (index, replies = 1) => ({
    discussion: 1_000 + index, numreplies: replies, id: 2_000 + index, userid: 7, userfullname: "Jane Moodle",
    useremail: "jane@example.edu", subject: "private subject", message: "private body", groupid: 9,
    numunread: 1, attachments: [{ filename: "private-file.pdf" }], totalscore: 100,
  });
  const discussions = (page) => {
    if (mode === "warning-flood") return [];
    if (mode === "over-bound") return Array.from({ length: 50 }, (_, index) => discussion((page * 50) + index));
    if (page === 0) return Array.from({ length: 50 }, (_, index) => discussion(index));
    if (page === 1) return [discussion(50, 2)];
    return [];
  };
  const warning = (itemid) => ({ item: "post", itemid, warningcode: "1", message: "You cannot see this discussion" });
  const warnings = (page) => {
    if (mode === "warning-flood") return Array.from({ length: 51 }, (_, index) => warning(9_000 + index));
    return page === 0 && mode !== "over-bound" ? [warning(8_001)] : [];
  };
  const forumForm = () => {
    const module = mode === "wrong-module" ? "99" : "8";
    const course = mode === "wrong-course" ? "9" : "2";
    const instance = mode === "missing-instance" ? "" : "71";
    const name = mode === "wrong-type" ? "assign" : "forum";
    return `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=8&amp;return=0">
      <input type="hidden" name="course" value="${course}"><input type="hidden" name="coursemodule" value="${module}">
      <input type="hidden" name="update" value="8"><input type="hidden" name="modulename" value="${name}">
      ${instance ? `<input type="hidden" name="instance" value="${instance}">` : ""}<input type="hidden" name="sesskey" value="${PRIVATE_SESSION}">
    </form></body></html>`;
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/modedit.php" && target.search === "?update=8&return=0") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(forumForm()); return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call = message[0];
      assert.equal(target.search, `?sesskey=${PRIVATE_SESSION}&info=mod_forum_get_forum_discussions`);
      assert.equal(call.index, 0); assert.equal(call.methodname, "mod_forum_get_forum_discussions");
      assert.deepEqual(call.args, { forumid: 71, sortorder: 4, page: call.args.page, perpage: 50, groupid: 0 });
      assert.ok(Number.isSafeInteger(call.args.page) && call.args.page >= 0 && call.args.page <= 10);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: { discussions: discussions(call.args.page), warnings: warnings(call.args.page) } }])); return;
    }
    response.writeHead(404).end();
  });
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const invoke = (args = { course_id: 2, module_id: 8 }) => page.evaluate(
      executeMoodleForumActivitySummaryInPage,
      JSON.stringify({ operation: OPERATION, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() + 60_000 }),
    );
    const sourceRequests = () => requests.filter((request) => request.pathname === "/course/modedit.php" || request.pathname === "/lib/ajax/service.php").length;
    const beforeInvalid = sourceRequests();
    assert.deepEqual(await invoke({ course_id: 2, module_id: 8, extra: true }), { ok: false, sent: false, error: "moodle_forum_activity_summary_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    const summary = await invoke();
    assert.equal(summary.ok, true, JSON.stringify(summary)); assert.equal(summary.complete, true);
    assert.deepEqual(summary.data, {
      schema: "morrow.moodle-forum-activity-summary.v1", provider: "moodle", course_id: 2, module_id: 8, forum_id: 71,
      discussion_count: 51, reply_count: 52,
      proof: {
        method: "mod_forum_get_forum_discussions", complete: true, exact_module_binding: "course_modedit_form",
        required_capability: "mod/forum:viewdiscussion", scope: "current_principal_permitted_discussions",
        group_scope: "native_default_permitted_groups", sort_order: "created_asc", page_size: 50,
        page_request_limit: 11, page_request_count: 2, discussion_limit: 500, reply_limit: 5_000_000,
      },
    });
    const serialized = JSON.stringify(summary);
    for (const privateValue of [PRIVATE_SESSION, "Jane Moodle", "jane@example.edu", "private subject", "private body", "private-file.pdf", '"userid":7', '"groupid":9', '"numunread":1']) {
      assert.equal(serialized.includes(privateValue), false, `result leaked ${privateValue}`);
    }
    assert.equal(requests.some((request) => request.pathname === "/mod/forum/view.php" || request.pathname === "/mod/forum/discuss.php"), false);

    for (const failure of ["wrong-module", "wrong-course", "missing-instance", "wrong-type"]) {
      mode = failure;
      const before = requests.filter((request) => request.pathname === "/lib/ajax/service.php").length;
      assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_forum_activity_summary_target_unavailable" });
      assert.equal(requests.filter((request) => request.pathname === "/lib/ajax/service.php").length, before);
    }
    mode = "over-bound";
    assert.deepEqual(await invoke(), { ok: false, sent: false, complete: false, error: "moodle_forum_activity_summary_incomplete" });
    mode = "warning-flood";
    const beforeFlood = requests.filter((request) => request.pathname === "/lib/ajax/service.php").length;
    assert.deepEqual(await invoke(), { ok: false, sent: false, error: "moodle_forum_activity_summary_response_invalid" });
    assert.equal(requests.filter((request) => request.pathname === "/lib/ajax/service.php").length, beforeFlood + 1);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
