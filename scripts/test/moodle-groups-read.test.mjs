import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleCourseGroupsInPage } from "../../connector/extension/src/moodle-groups-read.js";

const OP = { key: "moodle.page.group.membership_map.read.v1", toolName: "moodle_get_course_groups", provider: "moodle", readOnly: true };

test("Moodle group map uses the core group list and native GET member read with strict binding and bounds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-groups-")); const key = join(directory, "key.pem"); const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  let origin = ""; let browser; const requests = []; let mode = "complete"; let listDelayMs = 0;
  const response = (value) => JSON.stringify([{ data: JSON.stringify(value) }]);
  const groups = () => mode === "oversize"
    ? Array.from({ length: 501 }, (_, index) => ({ id: index + 1, courseid: 2, name: `Group ${index + 1}`, visibility: 0, participation: true }))
    : mode === "wrong-course"
      ? [{ id: 8, courseid: 9, name: "Wrong", visibility: 0, participation: true }]
      : [{ id: 8, courseid: 2, name: "Team A", visibility: 0, participation: true }, { id: 9, courseid: 2, name: "Team B", visibility: 2, participation: false }];
  const members = (groupId) => {
    if (mode === "byte-limit" && groupId === "8") return [{ name: "Student", users: [{ id: 7, name: "🙂".repeat(550_000) }] }];
    if (mode === "member-limit" && groupId === "8") return [{ name: "Student", users: Array.from({ length: 10_001 }, (_, index) => ({ id: index + 1, name: `Student ${index + 1}` })) }];
    if (mode === "bad-members" && groupId === "8") return [{ name: "Student", users: [{ id: 7, name: "Student Name" }, { id: 7, name: "Student Name" }] }];
    return groupId === "8"
      ? [{ name: "Student", users: [{ id: 7, name: "Student Name" }, { id: 3, name: "Course Teacher" }] }]
      : [{ name: "Teacher", users: [{ id: 3, name: "Course Teacher" }] }];
  };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, reply) => {
    const target = new URL(request.url || "/", origin); requests.push({ method: request.method, path: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") return reply.end(`<!doctype html><body class="course-2"><script>var M={cfg:${JSON.stringify({ wwwroot: origin, sesskey: "private-session", userId: 3, courseId: 2 })}}</script></body>`);
    if (target.pathname === "/lib/ajax/service.php") {
      assert.equal(request.method, "POST");
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const call = JSON.parse(Buffer.concat(chunks).toString())[0];
      assert.equal(call.methodname, "core_group_get_course_groups"); assert.deepEqual(call.args, { courseid: 2 });
      if (listDelayMs) await new Promise((resolve) => setTimeout(resolve, listDelayMs));
      return reply.end(response(groups()));
    }
    if (target.pathname === "/group/index.php") {
      assert.equal(request.method, "GET");
      assert.deepEqual(Object.fromEntries(target.searchParams), { id: "2", group: target.searchParams.get("group"), action: "ajax_getmembersingroup" });
      const groupId = target.searchParams.get("group");
      if (groupId !== "8" && groupId !== "9") return reply.writeHead(400).end();
      return reply.end(JSON.stringify(members(groupId)));
    }
    reply.writeHead(404).end();
  });
  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve())); origin = `https://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() }); const page = await browser.newPage({ ignoreHTTPSErrors: true }); await page.goto(`${origin}/course/view.php?id=2`);
    const run = (args = { course_id: 2 }, expiresAt = Date.now() + 60_000) => page.evaluate(executeMoodleCourseGroupsInPage, JSON.stringify({ operation: OP, arguments: args, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt }));
    const memberCount = () => requests.filter((request) => request.path === "/group/index.php").length;
    const fixtureCount = () => requests.filter((request) => request.path !== "/favicon.ico").length;
    const beforeInvalid = memberCount(); assert.deepEqual(await run({ course_id: 2, extra: true }), { ok: false, sent: false, error: "moodle_arguments_invalid" }); assert.equal(memberCount(), beforeInvalid);
    const current = await run(); assert.equal(current.ok, true, JSON.stringify(current)); assert.deepEqual(current.data, { course_id: "2", groups: [
      { id: "8", name: "Team A", visibility: 0, participation: true, membership: [{ user_id: "3", name: "Course Teacher" }, { user_id: "7", name: "Student Name" }] },
      { id: "9", name: "Team B", visibility: 2, participation: false, membership: [{ user_id: "3", name: "Course Teacher" }] },
    ] });
    assert.equal(requests.filter((request) => request.method === "POST" && request.path !== "/lib/ajax/service.php").length, 0);
    assert.equal(requests.some((request) => request.path === "/group/members.php" || request.path.includes("/mod/")), false);
    const beforeExpired = fixtureCount();
    assert.deepEqual(await run({ course_id: 2 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_arguments_invalid" });
    assert.deepEqual(await run({ course_id: 2 }, null), { ok: false, sent: false, error: "moodle_arguments_invalid" });
    assert.equal(fixtureCount(), beforeExpired);
    listDelayMs = 2_600;
    const beforeLate = memberCount();
    assert.deepEqual(await run({ course_id: 2 }, Date.now() + 1_200), { ok: false, sent: false, error: "moodle_groups_context_changed" });
    assert.equal(memberCount(), beforeLate);
    listDelayMs = 0;
    mode = "wrong-course"; assert.deepEqual(await run(), { ok: false, sent: false, error: "moodle_course_groups_invalid" });
    mode = "bad-members"; assert.deepEqual(await run(), { ok: false, sent: false, error: "moodle_course_groups_invalid" });
    mode = "oversize"; assert.deepEqual(await run(), { ok: false, sent: false, complete: false, error: "moodle_course_groups_incomplete" });
    mode = "member-limit"; assert.deepEqual(await run(), { ok: false, sent: false, complete: false, error: "moodle_course_groups_incomplete" });
    mode = "byte-limit"; assert.deepEqual(await run(), { ok: false, sent: false, complete: false, error: "moodle_course_groups_incomplete" });
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
});
