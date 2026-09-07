import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  executeMoodleCourseParticipantsInPage,
  executeMoodleEnrolmentMethodsInPage,
  executeMoodleParticipantEnrolmentInPage,
} from "../../connector/extension/src/moodle-participants-read.js";

const PRIVATE_SESSION = "moodle-private-session";
const CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
const PARTICIPANTS = Object.freeze({
  key: "moodle.form.enrol.participants.read.v1",
  toolName: "moodle_get_course_participants",
  provider: "moodle",
  readOnly: true,
});
const METHODS = Object.freeze({
  key: "moodle.form.enrol.methods.read.v1",
  toolName: "moodle_get_enrolment_methods",
  provider: "moodle",
  readOnly: true,
});
const ENROLMENT = Object.freeze({
  key: "moodle.form.enrol.participant.read.v1",
  toolName: "moodle_get_participant_enrolment",
  provider: "moodle",
  readOnly: true,
});

test("the three participant and enrolment reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const operation of [PARTICIPANTS, METHODS, ENROLMENT]) {
    const entries = catalog.operations.filter((entry) => entry.key === operation.key);
    assert.equal(entries.length, 1, `${operation.toolName} needs exactly one catalog entry`);
    assert.equal(entries[0].toolName, operation.toolName);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].dataClass, "learner");
    assert.equal(entries[0].morrowPrivate, undefined);
    for (const capability of CAPABILITIES) {
      assert.ok(entries[0].description.includes(capability), `${operation.toolName} must state ${capability}`);
    }
  }
  // The redaction roster stays a private source tool: it is not one of these.
  const roster = catalog.operations.find((entry) => entry.toolName === "moodle_get_course_participant_roster");
  assert.equal(roster.morrowPrivate, true);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleCourseParticipantsInPage, executeMoodleEnrolmentMethodsInPage, executeMoodleParticipantEnrolmentInPage \} from "\.\/moodle-participants-read\.js";/);
  assert.match(worker, /MOODLE_COURSE_PARTICIPANTS_OPERATION_KEY = "moodle\.form\.enrol\.participants\.read\.v1"/);
  assert.match(worker, /MOODLE_ENROLMENT_METHODS_OPERATION_KEY = "moodle\.form\.enrol\.methods\.read\.v1"/);
  assert.match(worker, /MOODLE_PARTICIPANT_ENROLMENT_OPERATION_KEY = "moodle\.form\.enrol\.participant\.read\.v1"/);
  assert.match(worker, /func: executeMoodleCourseParticipantsInPage/);
  assert.match(worker, /func: executeMoodleEnrolmentMethodsInPage/);
  assert.match(worker, /func: executeMoodleParticipantEnrolmentInPage/);
});

test("Moodle participant and enrolment reads bind one course, tokenize nothing but the user ID, and stop at every bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-participants-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  const statusField = ({ status, method, start, end }, nested = false) => {
    const inner = nested
      ? `<span class="badge" data-status="${status}" data-enrolinstancename="${method}" data-timestart="${start}" data-timeend="${end}">${status}</span>`
      : `<span class="badge">${status}</span>`;
    return `<span class="status" data-status="${status}" data-enrolinstancename="${method}" data-timestart="${start}" data-timeend="${end}">${inner}</span>`;
  };
  const roleCell = (userId, roles) => `<td class="c3"><span class="inplaceeditable inplaceeditable-user_roles" data-inplaceeditable="1" data-component="core_role" data-itemtype="user_roles" data-itemid="${userId}" data-value="[5]"><a href="#" class="quickeditlink">${roles.join(", ")}</a></span></td>`;
  const row = (userId, name, roles, enrolments, options = {}) => {
    const checkbox = options.doubleCheckbox
      ? `<input class="usercheckbox" name="user${userId}"><input class="usercheckbox" name="user${userId}">`
      : `<input class="usercheckbox" name="user${userId}" type="checkbox">`;
    const status = options.withoutEnrolments
      ? "<td class=\"c5\"></td>"
      : `<td class="c5">${enrolments.map((entry) => statusField(entry, Boolean(options.nested))).join("")}</td>`;
    return `<tr class="participant">
      <td class="c0">${checkbox}</td>
      <td class="c1"><a href="/user/view.php?id=${userId}&amp;course=2">${name}</a></td>
      <td class="c2">${name.toLowerCase().replace(/ /g, ".")}@example.edu</td>
      ${roleCell(userId, roles)}
      <td class="c4">Team A</td>
      ${status}
    </tr>`;
  };
  const table = (totalRows, rows) => `<div class="table-dynamic" data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-2" data-table-total-rows="${totalRows}"><table class="generaltable"><thead><tr><th>Select</th><th>Name</th><th>Email</th><th>Roles</th><th>Groups</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const bulkRows = (start, count) => Array.from({ length: count }, (_, index) => row(
    100 + start + index,
    `Bulk Learner ${start + index}`,
    ["Student"],
    [{ status: "Active", method: "Manual enrolments", start: "1767225600", end: "0" }],
  )).join("");
  const participantsHtml = (pageNumber) => {
    if (mode === "over-cap") return table(501, bulkRows((pageNumber - 1) * 100, 100));
    if (mode === "paged") {
      return pageNumber === 1
        ? table(102, bulkRows(0, 100))
        : table(102, row(7, "Jane Moodle", ["Student"], [{ status: "Active", method: "Manual enrolments", start: "1767225600", end: "0" }])
          + row(3, "Course Teacher", ["Teacher"], [{ status: "Active", method: "Manual enrolments", start: "1767225600", end: "0" }]));
    }
    if (mode === "no-enrolreview") {
      return table(1, row(7, "Jane Moodle", ["Student"], [], { withoutEnrolments: true }));
    }
    if (mode === "bad-row") return table(1, row(7, "Jane Moodle", ["Student"], [], { doubleCheckbox: true }));
    if (mode === "nested") {
      return table(1, row(7, "Jane Moodle", ["Student"], [{ status: "Active", method: "Manual enrolments", start: "1767225600", end: "0" }], { nested: true }));
    }
    if (mode === "wrong-total") return table(9, row(7, "Jane Moodle", ["Student"], [{ status: "Active", method: "Manual enrolments", start: "1767225600", end: "0" }]));
    if (mode === "wrong-course-table") {
      return `<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-9" data-table-total-rows="1"><table><tbody></tbody></table></div>`;
    }
    return table(2,
      row(7, "Jane Moodle", ["Student"], [
        { status: "Active", method: "Manual enrolments", start: "1767225600", end: "0" },
        { status: "Suspended", method: "Self enrolment (Student)", start: "1767225600", end: "1798761600" },
      ])
      + row(3, "Course Teacher", ["Non-editing teacher", "Teacher"], [
        { status: "Active", method: "Manual enrolments", start: "0", end: "0" },
      ]));
  };
  const instancesHtml = () => {
    const config = mode === "wrong-course-page"
      ? { wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 9 }
      : { wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 };
    const decoy = "<table class=\"admintable\"><tbody><tr><td>Navigation</td><td>Course 2</td></tr></tbody></table>";
    const instances = mode === "method-cap"
      ? Array.from({ length: 101 }, (_, index) => `<tr><td>Method ${index + 1}</td><td>0</td><td><a href="/enrol/instances.php?id=2">Edit</a></td></tr>`).join("")
      : mode === "no-table"
        ? "<tr><td>Manual enrolments</td><td>Three</td><td><a href=\"/enrol/instances.php?id=2\">Edit</a></td></tr>"
        : `<tr><td>Manual enrolments</td><td>3</td><td><a href="/enrol/instances.php?id=2">Edit</a></td></tr>
         <tr><td class="dimmed_text">Self enrolment (Student)</td><td>0</td><td><a href="/enrol/instances.php?id=2">Edit</a></td></tr>`;
    const ambiguous = mode === "ambiguous"
      ? "<table class=\"generaltable\"><tbody><tr><td>Other</td><td>4</td><td>Edit</td></tr></tbody></table>"
      : "";
    return `<!doctype html><html><body class="path-enrol course-2"><script>M.cfg = ${JSON.stringify(config)};</script>
      ${decoy}
      <div role="main"><table class="generaltable"><thead><tr><th>Name</th><th>Users</th><th>Edit</th></tr></thead><tbody>${instances}</tbody></table>${ambiguous}</div>
    </body></html>`;
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/enrol/instances.php" && target.search === "?id=2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(instancesHtml());
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php"
      && target.search === `?sesskey=${PRIVATE_SESSION}&info=core_table_get_dynamic_table_content`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(call.index, 0);
      assert.equal(call.methodname, "core_table_get_dynamic_table_content");
      assert.deepEqual(call.args, {
        component: "core_user", handler: "participants", uniqueid: "user-index-participants-2",
        sortdata: [{ sortby: "lastname", sortorder: 4 }], filters: [{ name: "courseid", jointype: 1, values: [2] }],
        jointype: 1, firstinitial: "", lastinitial: "", pagenumber: call.args.pagenumber, pagesize: 100,
        hiddencolumns: [], resetpreferences: false,
      });
      assert.ok(Number.isInteger(call.args.pagenumber) && call.args.pagenumber >= 1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ index: 0, data: { html: participantsHtml(call.args.pagenumber) } }]));
      return;
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
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const invoke = (func, operation, args, expiresAt = Date.now() + 60_000) => page.evaluate(
      func,
      JSON.stringify({ operation, arguments: args, binding, expiresAt }),
    );
    const listParticipants = (args = { course_id: 2 }, expiresAt) => invoke(executeMoodleCourseParticipantsInPage, PARTICIPANTS, args, expiresAt);
    const listMethods = (args = { course_id: 2 }, expiresAt) => invoke(executeMoodleEnrolmentMethodsInPage, METHODS, args, expiresAt);
    const readEnrolment = (args = { course_id: 2, user_id: 7 }, expiresAt) => invoke(executeMoodleParticipantEnrolmentInPage, ENROLMENT, args, expiresAt);
    const sourceRequests = () => requests.filter((entry) => entry.pathname !== "/favicon.ico" && entry.pathname !== "/course/view.php").length;
    const tableRequests = () => requests.filter((entry) => entry.pathname === "/lib/ajax/service.php").length;

    // 1. Arguments and the approval window are checked before any source call.
    const beforeInvalid = sourceRequests();
    assert.deepEqual(await listParticipants({ course_id: 2, extra: true }), { ok: false, sent: false, error: "moodle_course_participants_arguments_invalid" });
    assert.deepEqual(await listParticipants({ course_id: 9 }), { ok: false, sent: false, error: "moodle_course_participants_arguments_invalid" });
    assert.deepEqual(await listParticipants({ course_id: 2 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_course_participants_arguments_invalid" });
    assert.deepEqual(await listMethods({ course_id: 9 }), { ok: false, sent: false, error: "moodle_enrolment_methods_arguments_invalid" });
    assert.deepEqual(await readEnrolment({ course_id: 2 }), { ok: false, sent: false, error: "moodle_participant_enrolment_arguments_invalid" });
    assert.deepEqual(await readEnrolment({ course_id: 2, user_id: 0 }), { ok: false, sent: false, error: "moodle_participant_enrolment_arguments_invalid" });
    assert.equal(sourceRequests(), beforeInvalid);

    // 2. The participant list carries the user ID, role names and enrolment
    // method names, and nothing else the table rendered.
    const participants = await listParticipants();
    assert.equal(participants.ok, true, JSON.stringify(participants));
    assert.equal(participants.complete, true);
    assert.match(participants.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(participants.data, {
      schema: "morrow.moodle-course-participants.v1", provider: "moodle", course_id: 2, participant_count: 2,
      participants: [
        { user_id: "7", roles: ["Student"], enrolment_methods: ["Manual enrolments", "Self enrolment (Student)"] },
        { user_id: "3", roles: ["Non-editing teacher", "Teacher"], enrolment_methods: ["Manual enrolments"] },
      ],
      proof: {
        method: "core_table_get_dynamic_table_content", complete: true, required_capabilities: CAPABILITIES,
        participant_limit: 500, page_size: 100, page_request_limit: 5, page_request_count: 1, total_rows: 2,
      },
    });
    const participantsText = JSON.stringify(participants);
    for (const privateValue of [PRIVATE_SESSION, "Jane Moodle", "Course Teacher", "jane.moodle@example.edu", "user/view.php", "Team A"]) {
      assert.equal(participantsText.includes(privateValue), false, `the participant list leaked ${privateValue}`);
    }

    // 3. One learner's enrolment record: method, the site's own status label,
    // and the exact start and end.
    const enrolment = await readEnrolment();
    assert.equal(enrolment.ok, true, JSON.stringify(enrolment));
    assert.deepEqual(enrolment.data, {
      schema: "morrow.moodle-participant-enrolment.v1", provider: "moodle", course_id: 2,
      learner: { user_id: "7" }, enrolment_count: 2,
      enrolments: [
        { method: "Manual enrolments", status: "Active", start: "2026-01-01T00:00:00.000Z", end: null },
        { method: "Self enrolment (Student)", status: "Suspended", start: "2026-01-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z" },
      ],
      proof: {
        method: "core_table_get_dynamic_table_content", complete: true, required_capabilities: CAPABILITIES,
        participant_limit: 500, page_size: 100, page_request_limit: 5, page_request_count: 1,
      },
    });
    const enrolmentText = JSON.stringify(enrolment);
    for (const privateValue of [PRIVATE_SESSION, "Jane Moodle", "Course Teacher", "jane.moodle@example.edu"]) {
      assert.equal(enrolmentText.includes(privateValue), false, `the enrolment record leaked ${privateValue}`);
    }
    const teacher = await readEnrolment({ course_id: 2, user_id: 3 });
    assert.deepEqual(teacher.data.enrolments, [{ method: "Manual enrolments", status: "Active", start: null, end: null }]);

    // 4. A learner the whole table does not list is absent, not incomplete.
    assert.deepEqual(await readEnrolment({ course_id: 2, user_id: 99 }), { ok: false, sent: false, error: "moodle_participant_enrolment_absent" });

    // 5. The enrolment-method list reads one native GET and no learner row.
    const beforeMethods = tableRequests();
    const methods = await listMethods();
    assert.equal(methods.ok, true, JSON.stringify(methods));
    assert.deepEqual(methods.data, {
      schema: "morrow.moodle-enrolment-methods.v1", provider: "moodle", course_id: 2, method_count: 2,
      methods: [
        { name: "Manual enrolments", enabled: true, participant_count: 3 },
        { name: "Self enrolment (Student)", enabled: false, participant_count: 0 },
      ],
      proof: {
        method: "native_enrol_instances_page", complete: true, required_capabilities: CAPABILITIES, method_limit: 100,
      },
    });
    assert.equal(tableRequests(), beforeMethods, "the method list must not read the participants table");
    assert.equal(JSON.stringify(methods).includes(PRIVATE_SESSION), false);

    // 6. Every request stayed on the two proven routes. No participants page,
    // no profile page, no enrolment action.
    assert.deepEqual(
      [...new Set(requests.map((entry) => `${entry.method} ${entry.pathname}`))].filter((entry) => !entry.endsWith("/favicon.ico")).sort(),
      ["GET /course/view.php", "GET /enrol/instances.php", "POST /lib/ajax/service.php"],
    );
    assert.equal(requests.some((entry) => entry.pathname === "/user/index.php" || entry.pathname === "/user/view.php"), false);
    assert.equal(requests.some((entry) => entry.pathname === "/enrol/instances.php" && entry.search !== "?id=2"), false);

    // 7. Two pages of one course: the second page completes the list.
    mode = "paged";
    const paged = await listParticipants();
    assert.equal(paged.ok, true, JSON.stringify(paged));
    assert.equal(paged.data.participant_count, 102);
    assert.equal(paged.data.proof.page_request_count, 2);
    assert.deepEqual(paged.data.participants.at(-1), { user_id: "3", roles: ["Teacher"], enrolment_methods: ["Manual enrolments"] });
    const pagedEnrolment = await readEnrolment();
    assert.equal(pagedEnrolment.ok, true, JSON.stringify(pagedEnrolment));
    assert.equal(pagedEnrolment.data.proof.page_request_count, 2);

    // 8. A course past the bound is incomplete, never a partial list, and the
    // single-learner read that cannot reach the last row is incomplete too.
    mode = "over-cap";
    const beforeOverCap = tableRequests();
    assert.deepEqual(await listParticipants(), { ok: false, sent: false, complete: false, error: "moodle_course_participants_incomplete" });
    assert.equal(tableRequests(), beforeOverCap + 1, "the bound is reported from the table's own total, not after a scan");
    assert.deepEqual(await readEnrolment({ course_id: 2, user_id: 99 }), { ok: false, sent: false, complete: false, error: "moodle_participant_enrolment_incomplete" });

    // 9. Refusals for a table that does not prove this course, a row shape the
    // parse cannot trust, a status column the principal cannot see, and a total
    // that changes under the scan.
    mode = "wrong-course-table";
    assert.deepEqual(await listParticipants(), { ok: false, sent: false, error: "moodle_course_participants_table_proof_missing" });
    assert.deepEqual(await readEnrolment(), { ok: false, sent: false, error: "moodle_participant_enrolment_table_proof_missing" });
    mode = "bad-row";
    assert.deepEqual(await listParticipants(), { ok: false, sent: false, error: "moodle_course_participants_row_invalid" });
    mode = "no-enrolreview";
    assert.deepEqual(await listParticipants(), { ok: false, sent: false, error: "moodle_course_participants_enrolment_unavailable" });
    assert.deepEqual(await readEnrolment(), { ok: false, sent: false, error: "moodle_participant_enrolment_unavailable" });
    mode = "wrong-total";
    assert.deepEqual(await listParticipants(), { ok: false, sent: false, error: "moodle_course_participants_page_bounds_invalid" });

    // 10. A status field nested inside another counts once, not twice.
    mode = "nested";
    const nested = await listParticipants();
    assert.equal(nested.ok, true, JSON.stringify(nested));
    assert.deepEqual(nested.data.participants, [{ user_id: "7", roles: ["Student"], enrolment_methods: ["Manual enrolments"] }]);

    // 11. The enrolment-method page must prove this course, must not be
    // ambiguous, and stops at its own bound.
    mode = "wrong-course-page";
    assert.deepEqual(await listMethods(), { ok: false, sent: false, error: "moodle_enrolment_methods_page_proof_invalid" });
    mode = "ambiguous";
    assert.deepEqual(await listMethods(), { ok: false, sent: false, error: "moodle_enrolment_methods_table_ambiguous" });
    mode = "no-table";
    assert.deepEqual(await listMethods(), { ok: false, sent: false, error: "moodle_enrolment_methods_table_missing" });
    mode = "method-cap";
    assert.deepEqual(await listMethods(), { ok: false, sent: false, complete: false, error: "moodle_enrolment_methods_incomplete" });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
