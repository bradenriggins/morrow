import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleEnrolmentInPage } from "../../connector/extension/src/moodle-enrolment-executor.js";
import { executeMoodleCourseParticipantsInPage } from "../../connector/extension/src/moodle-participants-read.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../..", import.meta.url);
const SESSKEY = "moodle-private-session";
const COURSE_ID = 2;
const ENROL_ID = 7;
const ENROLMENT_GROUP = "Moodle · Enrolment and roles";
const PARTICIPANTS = Object.freeze({
  key: "moodle.form.enrol.participants.read.v1",
  toolName: "moodle_get_course_participants",
  provider: "moodle",
  readOnly: true,
});
const operations = Object.freeze({
  enrol: { key: "moodle.form.enrol.participant.enrol.write.v1", toolName: "moodle_enrol_participant", provider: "moodle", readOnly: false },
  suspend: { key: "moodle.form.enrol.participant.suspend.write.v1", toolName: "moodle_suspend_participant", provider: "moodle", readOnly: false },
  unenrol: { key: "moodle.form.enrol.participant.unenrol.write.v1", toolName: "moodle_unenrol_participant", provider: "moodle", readOnly: false },
  assignRole: { key: "moodle.ajax.core_update_inplace_editable.user_roles.assign.v1", toolName: "moodle_assign_role", provider: "moodle", readOnly: false },
  removeRole: { key: "moodle.ajax.core_update_inplace_editable.user_roles.remove.v1", toolName: "moodle_remove_role", provider: "moodle", readOnly: false },
});
// The words the unenrolment result uses for what Moodle takes with the person.
const UNENROL_REMOVALS = [
  "Their place in the course. They lose access to it and to everything in it",
  "Every grade and every piece of feedback they hold in this course's gradebook",
  "Their submissions, attempts and the files they uploaded in this course's activities",
  "Their completion records and their participation history in this course",
  "Their group memberships in this course",
  "Their role assignments in this course",
];

test("the five enrolment and role writes are cataloged, routed, and separated from each other", () => {
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, false);
    assert.equal(entry.reviewTool, "moodle_get_course_participants");
    assert.equal(entry.dataClass, "learner");
    assert.equal(entry.family, "learner-data");
    assert.equal(entry.inputSchema.properties.expected_digest.pattern, "^[a-f0-9]{64}$");
    assert.ok(entry.inputSchema.required.includes("user_id"), `${operation.toolName} must name one exact person`);
    for (const capability of ["moodle/course:viewparticipants", "moodle/course:enrolreview"]) {
      assert.ok(entry.description.includes(capability), `${operation.toolName} must state ${capability}`);
    }
    assert.match(entry.description, /Browser-fixture proof only; no signed-in Moodle site has run it/);
    assert.match(entry.description, /No name, email address, profile link or any other identity text leaves the browser/);
  }

  // Enrolment and role assignment stay separate concepts: neither pair of tools
  // claims to do the other's work, and each is its own approval.
  assert.match(byTool.get("moodle_enrol_participant").description, /this operation never chooses or changes a role/);
  assert.match(byTool.get("moodle_assign_role").description, /this change adds, removes and alters no enrolment/);
  assert.match(byTool.get("moodle_remove_role").description, /it never removes anyone from the course/);
  assert.equal(byTool.get("moodle_enrol_participant").documentation, "https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/manual/manage.php");
  assert.equal(byTool.get("moodle_suspend_participant").documentation, "https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/editenrolment.php");
  assert.equal(byTool.get("moodle_unenrol_participant").documentation, "https://github.com/moodle/moodle/blob/v5.2.2/public/enrol/unenroluser.php");
  assert.equal(byTool.get("moodle_assign_role").documentation, "https://github.com/moodle/moodle/blob/v5.2.2/public/user/classes/output/user_roles_editable.php");

  // The unenrolment is the destructive one, and its approval copy says exactly
  // what a full unenrolment can take with the person.
  const unenrol = byTool.get("moodle_unenrol_participant");
  assert.equal(unenrol.destructive, true);
  assert.equal(unenrol.irreversible, true);
  assert.match(unenrol.description, /a full unenrolment can remove that person's grades, submissions and participation history/);
  assert.match(unenrol.description, /Morrow cannot undo it/);
  assert.ok(unenrol.inputSchema.required.includes("acknowledge_removes_learner_record"));
  assert.equal(byTool.get("moodle_suspend_participant").destructive, undefined);
  assert.equal(byTool.get("moodle_assign_role").destructive, undefined);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleEnrolmentCandidateInPage, executeMoodleEnrolmentInPage \} from "\.\/moodle-enrolment-executor\.js";/);
  assert.match(worker, /MOODLE_ENROLMENT_WRITE_OPERATIONS = new Map\(\[/);
  assert.match(worker, /func: executeMoodleEnrolmentInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }

  // The whole family sits in one Edit group of its own, and the unenrolment is
  // never a standing grant.
  const actions = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const action = (toolName) => actions.find((entry) => entry.id === `action:moodle:${toolName}`);
  for (const operation of Object.values(operations)) {
    assert.equal(action(operation.toolName).group, ENROLMENT_GROUP, operation.toolName);
  }
  assert.equal(action("moodle_unenrol_participant").availability, "review");
  assert.equal(action("moodle_unenrol_participant").tier, "destructive");
  assert.match(action("moodle_unenrol_participant").reviewReason, /can remove their grades, their submissions and their participation history/);
  assert.match(action("moodle_unenrol_participant").reviewReason, /Morrow cannot undo it/);
  for (const toolName of ["moodle_enrol_participant", "moodle_suspend_participant", "moodle_assign_role", "moodle_remove_role"]) {
    assert.equal(action(toolName).availability, "edit", toolName);
    assert.equal(action(toolName).tier, "standard", toolName);
    assert.equal(action(toolName).verification, "checked", toolName);
  }
  assert.match(action("moodle_suspend_participant").description, /Morrow has no route that reverses it/);
  assert.match(action("moodle_assign_role").description, /It changes no enrolment/);
});

test("each enrolment and role write binds one rostered person, sends one request, and reads the participant record back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-enrolment-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  const writes = [];
  let origin = "";
  let browser;
  let model;

  const ROLES = [
    { id: "5", name: "Student" },
    { id: "4", name: "Non-editing teacher" },
    { id: "3", name: "Teacher" },
  ];
  const initialModel = () => ({
    nextUe: 200,
    // Every one of these carries a name and an email address on purpose: none
    // of them may reach a result.
    participants: [
      {
        userId: "11", fullname: "Ada Lovelace", email: "ada@example.edu", roles: ["5"],
        enrolments: [{ ueId: "101", method: "Manual enrolments", status: "Active", start: "1700000000", end: "0" }],
      },
      {
        userId: "12", fullname: "Grace Hopper", email: "grace@example.edu", roles: ["5", "4"],
        enrolments: [{ ueId: "102", method: "Manual enrolments", status: "Active", start: "1700000000", end: "0" }],
      },
      {
        userId: "13", fullname: "Katherine Johnson", email: "katherine@example.edu", roles: ["5"],
        enrolments: [
          { ueId: "103", method: "Manual enrolments", status: "Active", start: "1700000000", end: "0" },
          { ueId: "104", method: "Self enrolment", status: "Active", start: "1700000000", end: "0" },
        ],
      },
    ],
    // Users Moodle's own manual enrolment page offers as candidates.
    candidates: [{ userId: "21", fullname: "Mary Jackson", email: "mary@example.edu" }],
    // A role the site's own control does not offer this principal.
    unassignableRoleFor: "",
    // Moodle keeps a role an enrolment method granted and protects.
    protectedRoleFor: "",
    duplicateRow: false,
    candidateListTooLarge: false,
    changeOtherDuringWrite: false,
    suspendRefusesForm: false,
  });
  const participantsOf = () => (model.duplicateRow ? [...model.participants, model.participants[0]] : model.participants);
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const roleName = (roleId) => ROLES.find((role) => role.id === roleId)?.name || `Role ${roleId}`;
  const roleOptionsFor = (participant) => {
    const offered = ROLES.filter((role) => !(model.unassignableRoleFor === participant.userId && role.id === "3"));
    return JSON.stringify({
      options: offered.map((role) => ({ key: Number(role.id), value: role.name })),
      attributes: [{ name: "multiple", value: true }],
    });
  };
  const roleCell = (participant) => (
    `<td class="c3"><span class="inplaceeditable inplaceeditable-autocomplete" data-inplaceeditable="1"`
    + ` data-component="core_role" data-itemtype="user_roles" data-itemid="${COURSE_ID}:${participant.userId}"`
    + ` data-value="${escape(JSON.stringify(participant.roles.map((value) => Number(value))))}"`
    + ` data-options="${escape(roleOptionsFor(participant))}" data-type="autocomplete">`
    + `<a href="#" class="quickeditlink">${participant.roles.map(roleName).join(", ")}</a></span></td>`
  );
  const statusCell = (participant) => `<td class="c4">${participant.enrolments.map((enrolment) => (
    `<div class="d-flex" data-fullname="${escape(participant.fullname)}" data-coursename="Foundations of Care"`
    + ` data-enrolinstancename="${escape(enrolment.method)}" data-status="${escape(enrolment.status)}"`
    + ` data-timestart="${enrolment.start}" data-timeend="${enrolment.end}" data-timeenrolled="1699000000">`
    + `<span class="badge">${escape(enrolment.status)}</span>`
    + `<a class="editenrollink" role="button" data-action="editenrolment" rel="${enrolment.ueId}" href="/enrol/editenrolment.php?ifilter=0&amp;ue=${enrolment.ueId}">Edit</a>`
    + `<a class="unenrollink" role="button" data-action="unenrol" rel="${enrolment.ueId}" href="/enrol/unenroluser.php?ifilter=0&amp;ue=${enrolment.ueId}">Unenrol</a>`
    + "</div>"
  )).join("")}</td>`;
  const participantsTable = () => {
    const rows = participantsOf().map((participant) => (
      `<tr><td class="c0"><input class="usercheckbox" name="user${participant.userId}" type="checkbox"></td>`
      + `<td class="c1">${escape(participant.fullname)}</td><td class="c2">${escape(participant.email)}</td>`
      + `${roleCell(participant)}${statusCell(participant)}</tr>`
    )).join("");
    return `<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants"`
      + ` data-table-uniqueid="user-index-participants-${COURSE_ID}" data-table-total-rows="${participantsOf().length}">`
      + `<table><thead><tr><th>Select</th><th>Name</th><th>Email</th><th>Roles</th><th>Status</th></tr></thead>`
      + `<tbody>${rows}</tbody></table></div>`;
  };
  const candidateOptions = () => (model.candidateListTooLarge
    ? `<optgroup label="Too many users (2345) to show"><option disabled>Please search</option></optgroup>`
    : `<optgroup label="Not enrolled users (${model.candidates.length})">${model.candidates.map((candidate) => (
      `<option value="${candidate.userId}">${escape(candidate.fullname)} (${escape(candidate.email)})</option>`
    )).join("")}</optgroup>`);
  const manageForm = () => (
    `<!doctype html><html><body class="path-enrol course-${COURSE_ID}"><h2>Manual enrolments</h2>`
    + `<form id="assignform" method="post" action="/enrol/manual/manage.php?enrolid=${ENROL_ID}&amp;id=${COURSE_ID}"><div>`
    + `<input type="hidden" name="sesskey" value="${SESSKEY}">`
    + `<div class="userselector"><input type="text" name="removeselect_searchtext" value="">`
    + `<select name="removeselect[]" size="20" multiple><optgroup label="Enrolled users (${model.participants.length})">`
    + model.participants.map((participant) => `<option value="${participant.userId}">${escape(participant.fullname)}</option>`).join("")
    + `</optgroup></select></div>`
    + `<input name="add" id="add" type="submit" value="Add">`
    + `<input name="remove" id="remove" type="submit" value="Remove">`
    + `<div class="userselector"><input type="text" name="addselect_searchtext" value="">`
    + `<select name="addselect[]" size="20" multiple>${candidateOptions()}</select></div>`
    + `<select name="roleid"><option value="5" selected>Student</option><option value="3">Teacher</option></select>`
    + `<select name="extendperiod"><option value="0" selected>Unlimited</option></select>`
    + `<select name="extendbase"><option value="4" selected>Today</option></select>`
    + `<input type="hidden" name="timeend[day]" value="1">`
    + `</div></form></body></html>`
  );
  const enrolmentById = (ueId) => {
    for (const participant of model.participants) {
      const enrolment = participant.enrolments.find((entry) => entry.ueId === ueId);
      if (enrolment) return { participant, enrolment };
    }
    return null;
  };
  const editEnrolmentForm = (ueId) => {
    const found = enrolmentById(ueId);
    if (!found) return null;
    const selected = found.enrolment.status === "Suspended" ? "1" : "0";
    return `<!doctype html><html><body class="path-enrol course-${COURSE_ID}">`
      + `<form method="post" action="/enrol/editenrolment.php?ifilter=0&amp;ue=${ueId}"><div>`
      + `<input type="hidden" name="ue" value="${ueId}">`
      + `<input type="hidden" name="ifilter" value="0">`
      + `<input type="hidden" name="sesskey" value="${SESSKEY}">`
      + `<input type="hidden" name="_qf__enrol_user_enrolment_form" value="1">`
      + `<select name="status"><option value="0"${selected === "0" ? " selected" : ""}>Active</option>`
      + `<option value="1"${selected === "1" ? " selected" : ""}>Suspended</option></select>`
      + `<select name="duration"><option value="0" selected>Unlimited</option></select>`
      + `<input type="hidden" name="timestart[day]" value="14">`
      + `<input type="hidden" name="timestart[month]" value="11">`
      + `<input type="submit" name="submitbutton" value="Save changes">`
      + `</div></form></body></html>`;
  };
  const unenrolConfirmation = (ueId) => (
    `<!doctype html><html><body class="path-enrol course-${COURSE_ID}"><div class="confirmation-dialogue">`
    + `<p>Do you really want to unenrol this user?</p>`
    + `<form method="post" action="/enrol/unenroluser.php"><div>`
    + `<input type="submit" value="Continue">`
    + `<input type="hidden" name="ue" value="${ueId}">`
    + `<input type="hidden" name="confirm" value="1">`
    + `<input type="hidden" name="sesskey" value="${SESSKEY}">`
    + `</div></form>`
    + `<form method="get" action="/user/index.php"><div><input type="submit" value="Cancel">`
    + `<input type="hidden" name="id" value="${COURSE_ID}"></div></form>`
    + `</div></body></html>`
  );
  const disturbOthers = () => {
    if (!model.changeOtherDuringWrite) return;
    model.participants[1].roles = ["5"];
    model.changeOtherDuringWrite = false;
  };
  const body = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (request.method === "GET" && target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-${COURSE_ID}"><h1>Foundations of Care</h1>`
        + `<script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: COURSE_ID })} };</script></body>`);
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await body(request))[0];
      assert.equal(target.searchParams.get("sesskey"), SESSKEY);
      assert.equal(target.searchParams.get("info"), call.methodname);
      if (call.methodname === "core_table_get_dynamic_table_content") {
        assert.equal(call.args.uniqueid, `user-index-participants-${COURSE_ID}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ index: 0, error: false, data: { html: participantsTable() } }]));
        return;
      }
      if (call.methodname === "core_update_inplace_editable") {
        writes.push({ route: "role", args: call.args });
        const [courseId, userId] = String(call.args.itemid).split(":");
        assert.equal(courseId, String(COURSE_ID));
        const participant = model.participants.find((entry) => entry.userId === userId);
        const requested = JSON.parse(call.args.value).map((value) => String(value));
        const kept = model.protectedRoleFor === userId
          ? [...new Set([...requested, ...participant.roles.filter((role) => role === "4")])]
          : requested;
        participant.roles = ROLES.filter((role) => kept.includes(role.id)).map((role) => role.id);
        disturbOthers();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          index: 0,
          error: false,
          data: {
            component: "core_role",
            itemtype: "user_roles",
            itemid: call.args.itemid,
            value: JSON.stringify(participant.roles.map((value) => Number(value))),
            displayvalue: participant.roles.map(roleName).join(", "),
            options: roleOptionsFor(participant),
            type: "autocomplete",
          },
        }]));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET" && target.pathname === "/enrol/instances.php") {
      assert.equal(target.searchParams.get("id"), String(COURSE_ID));
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body class="path-enrol course-${COURSE_ID}"><table><tr><td>Manual enrolments</td>`
        + `<td><a href="/enrol/manual/manage.php?enrolid=${ENROL_ID}&amp;id=${COURSE_ID}" title="Enrol users">Enrol users</a>`
        + `<a href="/enrol/editinstance.php?courseid=${COURSE_ID}&amp;id=${ENROL_ID}&amp;type=manual">Edit</a></td></tr>`
        + `<tr><td>Self enrolment</td><td><a href="/enrol/editinstance.php?courseid=${COURSE_ID}&amp;id=9&amp;type=self">Edit</a></td></tr>`
        + `</table></body></html>`);
      return;
    }
    if (target.pathname === "/enrol/manual/manage.php") {
      assert.equal(target.searchParams.get("enrolid"), String(ENROL_ID));
      if (request.method === "POST") {
        const fields = new URLSearchParams(await body(request));
        writes.push({ route: "enrol", fields: [...fields.entries()] });
        assert.equal(fields.get("sesskey"), SESSKEY);
        assert.equal(fields.get("add"), "Add");
        assert.equal(fields.get("remove"), null);
        assert.equal(fields.get("removeselect[]"), null);
        for (const userId of fields.getAll("addselect[]")) {
          const candidate = model.candidates.find((entry) => entry.userId === userId);
          if (!candidate) continue;
          model.candidates = model.candidates.filter((entry) => entry.userId !== userId);
          model.participants.push({
            userId: candidate.userId,
            fullname: candidate.fullname,
            email: candidate.email,
            roles: [fields.get("roleid")],
            enrolments: [{ ueId: String(model.nextUe += 1), method: "Manual enrolments", status: "Active", start: "1700000000", end: "0" }],
          });
        }
        disturbOthers();
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(manageForm());
      return;
    }
    if (target.pathname === "/enrol/editenrolment.php") {
      const ueId = target.searchParams.get("ue") || "";
      if (request.method === "POST") {
        const fields = new URLSearchParams(await body(request));
        writes.push({ route: "suspend", fields: [...fields.entries()] });
        assert.equal(fields.get("sesskey"), SESSKEY);
        const found = enrolmentById(fields.get("ue") || "");
        if (model.suspendRefusesForm) {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(editEnrolmentForm(fields.get("ue") || ""));
          return;
        }
        if (found) found.enrolment.status = fields.get("status") === "1" ? "Suspended" : "Active";
        disturbOthers();
        response.writeHead(302, { location: `/user/index.php?id=${COURSE_ID}` }).end();
        return;
      }
      const form = editEnrolmentForm(ueId);
      if (!form) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(form);
      return;
    }
    if (target.pathname === "/enrol/unenroluser.php") {
      if (request.method === "POST") {
        const fields = new URLSearchParams(await body(request));
        writes.push({ route: "unenrol", fields: [...fields.entries()] });
        assert.equal(fields.get("sesskey"), SESSKEY);
        assert.equal(fields.get("confirm"), "1");
        const found = enrolmentById(fields.get("ue") || "");
        if (found) {
          found.participant.enrolments = found.participant.enrolments.filter((entry) => entry.ueId !== fields.get("ue"));
          if (found.participant.enrolments.length === 0) {
            model.participants = model.participants.filter((entry) => entry.userId !== found.participant.userId);
          }
        }
        disturbOthers();
        response.writeHead(302, { location: `/user/index.php?id=${COURSE_ID}` }).end();
        return;
      }
      const ueId = target.searchParams.get("ue") || "";
      if (!enrolmentById(ueId)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(unenrolConfirmation(ueId));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    model = initialModel();
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=${COURSE_ID}`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: String(COURSE_ID) };
    const execute = (operation, argumentsValue, options = {}) => page.evaluate(
      executeMoodleEnrolmentInPage,
      JSON.stringify({
        mode: "execute",
        operation,
        arguments: argumentsValue,
        binding: options.binding || binding,
        expiresAt: options.expiresAt ?? Date.now() + 60_000,
      }),
    );
    // The digest every one of these writes requires is the digest the person
    // reviewed, produced by the participant read itself.
    const reviewedDigest = async () => {
      const read = await page.evaluate(
        executeMoodleCourseParticipantsInPage,
        JSON.stringify({ operation: PARTICIPANTS, arguments: { course_id: COURSE_ID }, binding, expiresAt: Date.now() + 60_000 }),
      );
      assert.equal(read.ok, true, JSON.stringify(read));
      return read.snapshot_digest;
    };
    const loseNextWriteResponse = () => page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const method = String(parameters[1]?.method || "GET").toUpperCase();
        const target = new URL(String(parameters[0]), globalThis.location.href);
        const isWrite = method === "POST" && (target.pathname.startsWith("/enrol/")
          || target.searchParams.get("info") === "core_update_inplace_editable");
        const response = await nativeFetch(...parameters);
        if (isWrite) {
          globalThis.fetch = nativeFetch;
          throw new TypeError("write response lost after dispatch");
        }
        return response;
      };
    });

    let digest = await reviewedDigest();
    assert.match(digest, /^[a-f0-9]{64}$/);

    // Every refusal below happens before any write leaves the page.
    const refuse = async (operation, argumentsValue, error, options) => {
      const before = writes.length;
      const result = await execute(operation, argumentsValue, options);
      assert.deepEqual([result.ok, result.sent, result.error], [false, false, error], JSON.stringify(result));
      assert.equal(writes.length, before, `${operation.toolName} sent a write while refusing ${error}`);
    };

    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11 }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: "nope" }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.suspend, { course_id: 3, user_id: 11, expected_digest: digest }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: "eleven", expected_digest: digest }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 0, expected_digest: digest }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Student" }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: " Student " }, "moodle_enrolment_arguments_invalid");
    await refuse(operations.unenrol, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_enrolment_arguments_invalid");
    await refuse({ ...operations.suspend, readOnly: true }, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_operation_refused");
    await refuse({ ...operations.suspend, key: "moodle.form.enrol.participant.read.v1" }, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_operation_refused");
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_execution_expired", { expiresAt: Date.now() - 1 });
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_binding_mismatch", { binding: { ...binding, principalId: "9" } });
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: "0".repeat(64) }, "moodle_expected_digest_mismatch");

    // The person must resolve to exactly one row of this course's roster.
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 99, expected_digest: digest }, "moodle_enrolment_participant_not_rostered");
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 99, expected_digest: digest, role_name: "Teacher" }, "moodle_enrolment_participant_not_rostered");
    await refuse(operations.unenrol, { course_id: COURSE_ID, user_id: 99, expected_digest: digest, acknowledge_removes_learner_record: true }, "moodle_enrolment_participant_not_rostered");
    model.duplicateRow = true;
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_enrolment_duplicate_identity");
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Teacher" }, "moodle_enrolment_duplicate_identity");
    model.duplicateRow = false;

    // One meaning per operation: a person who holds more than one enrolment is
    // refused, because Morrow cannot say which record the change would take.
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 13, expected_digest: digest }, "moodle_enrolment_multiple_enrolments");
    await refuse(operations.unenrol, { course_id: COURSE_ID, user_id: 13, expected_digest: digest, acknowledge_removes_learner_record: true }, "moodle_enrolment_multiple_enrolments");

    // The unenrolment states what it takes with the person before it runs.
    await refuse(operations.unenrol, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, acknowledge_removes_learner_record: false }, "moodle_unenrol_acknowledgement_required");

    // Enrolment refusals: someone already in the course, someone Moodle's own
    // candidate list does not offer, and a list that offers nobody at all.
    await refuse(operations.enrol, { course_id: COURSE_ID, user_id: 11, expected_digest: digest }, "moodle_enrolment_already_enrolled");
    await refuse(operations.enrol, { course_id: COURSE_ID, user_id: 99, expected_digest: digest }, "moodle_enrolment_candidate_absent");
    model.candidateListTooLarge = true;
    await refuse(operations.enrol, { course_id: COURSE_ID, user_id: 21, expected_digest: digest }, "moodle_enrolment_candidate_list_unavailable");
    model.candidateListTooLarge = false;

    // Role refusals, all of them before anything is sent.
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Manager" }, "moodle_role_name_unresolved");
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Student" }, "moodle_role_already_assigned");
    await refuse(operations.removeRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Teacher" }, "moodle_role_not_assigned");
    model.unassignableRoleFor = "12";
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 12, expected_digest: await reviewedDigest(), role_name: "Teacher" }, "moodle_role_name_unresolved");
    model.participants[1].roles = ["5", "3"];
    await refuse(operations.assignRole, { course_id: COURSE_ID, user_id: 12, expected_digest: await reviewedDigest(), role_name: "Non-editing teacher" }, "moodle_role_unassignable_role_present");
    model.participants[1].roles = ["5", "4"];
    model.unassignableRoleFor = "";
    digest = await reviewedDigest();

    // One role assignment: one request, and the exact record back.
    const written = (route) => writes.filter((entry) => entry.route === route).length;
    let before = writes.length;
    const assigned = await execute(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Non-editing teacher" });
    assert.equal(assigned.ok, true, JSON.stringify(assigned));
    assert.equal(assigned.sent, true);
    assert.equal(writes.length - before, 1, "a role assignment sends exactly one request");
    assert.equal(assigned.verification.status, "verified");
    assert.equal(assigned.data.schema, "morrow.moodle-enrolment-write.v1");
    assert.equal(assigned.data.action, "moodle_assign_role");
    assert.deepEqual(assigned.data.learner, { user_id: "11" });
    assert.deepEqual(assigned.data.role, { role_id: "4", name: "Non-editing teacher" });
    assert.deepEqual(assigned.data.participant_before.roles, ["Student"]);
    assert.deepEqual(assigned.data.participant_after.roles, ["Student", "Non-editing teacher"]);
    assert.deepEqual(assigned.data.participant_after.enrolments, [{ method: "Manual enrolments", status: "Active", start: "2023-11-14T22:13:20.000Z", end: null }]);
    assert.deepEqual(assigned.data.proof.required_capabilities, ["moodle/course:viewparticipants", "moodle/course:enrolreview", "moodle/role:assign"]);
    assert.equal(assigned.data.proof.dispatch_count, 1);
    assert.deepEqual(JSON.parse(writes.at(-1).args.value).sort(), [4, 5]);
    assert.equal(writes.at(-1).args.itemid, `${COURSE_ID}:11`);
    // The digest the write returns is the digest the next review would read.
    digest = await reviewedDigest();
    assert.equal(assigned.snapshot_digest, digest);

    // The same person, the same route, one role taken away again.
    before = writes.length;
    const removed = await execute(operations.removeRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Non-editing teacher" });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(writes.length - before, 1, "a role removal sends exactly one request");
    assert.deepEqual(removed.data.participant_after.roles, ["Student"]);
    assert.deepEqual(removed.data.participant_after.enrolments, removed.data.participant_before.enrolments);
    digest = await reviewedDigest();

    // Moodle keeps a role an enrolment method granted and protects. The removal
    // is reported as unconfirmed with the role still in place, and the role
    // control is not sent again.
    model.protectedRoleFor = "11";
    model.participants[0].roles = ["5", "4"];
    digest = await reviewedDigest();
    before = writes.length;
    const protectedRemoval = await execute(operations.removeRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Non-editing teacher" });
    assert.deepEqual(
      [protectedRemoval.ok, protectedRemoval.sent, protectedRemoval.outcomeUnknown, protectedRemoval.error],
      [false, true, true, "moodle_role_removal_protected"],
      JSON.stringify(protectedRemoval),
    );
    assert.equal(protectedRemoval.verification.status, "unconfirmed");
    assert.equal(writes.length - before, 1, "a protected role removal is never sent twice");
    model.protectedRoleFor = "";
    model.participants[0].roles = ["5"];
    digest = await reviewedDigest();

    // One suspension: one POST of the native form, and the saved status read
    // back from the same native control.
    before = writes.length;
    const suspended = await execute(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest });
    assert.equal(suspended.ok, true, JSON.stringify(suspended));
    assert.equal(writes.length - before, 1, "a suspension sends exactly one POST");
    assert.equal(written("suspend"), 1);
    assert.equal(suspended.data.action, "moodle_suspend_participant");
    assert.equal(suspended.data.participant_before.enrolments[0].status, "Active");
    assert.deepEqual(suspended.data.participant_after.enrolments, [{ method: "Manual enrolments", status: "Suspended", start: "2023-11-14T22:13:20.000Z", end: null }]);
    assert.deepEqual(suspended.data.participant_after.roles, ["Student"]);
    const suspendFields = new Map(writes.at(-1).fields);
    assert.equal(suspendFields.get("status"), "1");
    assert.equal(suspendFields.get("ue"), "101");
    assert.equal(suspendFields.get("submitbutton"), "Save changes");
    assert.equal(suspendFields.get("timestart[day]"), "14");
    digest = await reviewedDigest();

    // A suspension Moodle refuses saved nothing, and says so instead of
    // reporting an unknown result.
    model.participants[0].enrolments[0].status = "Active";
    model.suspendRefusesForm = true;
    digest = await reviewedDigest();
    before = writes.length;
    const refused = await execute(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest });
    assert.deepEqual(
      [refused.ok, refused.sent, refused.outcomeUnknown, refused.error],
      [false, true, false, "moodle_form_validation_failed"],
      JSON.stringify(refused),
    );
    assert.equal(refused.verification.status, "mismatch");
    assert.equal(writes.length - before, 1, "a refused suspension is never sent twice");
    model.suspendRefusesForm = false;
    await refuse(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: "0".repeat(64) }, "moodle_expected_digest_mismatch");
    digest = await reviewedDigest();

    // One enrolment: one POST of Moodle's own manual enrolment form, with the
    // role that method gives, and the new participant record back.
    before = writes.length;
    const enrolled = await execute(operations.enrol, { course_id: COURSE_ID, user_id: 21, expected_digest: digest });
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    assert.equal(writes.length - before, 1, "an enrolment sends exactly one POST");
    assert.equal(written("enrol"), 1);
    assert.equal(enrolled.data.participant_before, null);
    assert.deepEqual(enrolled.data.participant_after.roles, ["Student"]);
    assert.deepEqual(enrolled.data.participant_after.enrolments.map((entry) => entry.method), ["Manual enrolments"]);
    assert.deepEqual(enrolled.data.enrolment_method_role, { role_id: "5", name: "Student" });
    const enrolFields = writes.at(-1).fields;
    assert.deepEqual(enrolFields.filter(([name]) => name === "addselect[]"), [["addselect[]", "21"]]);
    assert.deepEqual(enrolFields.filter(([name]) => name === "roleid"), [["roleid", "5"]]);
    assert.equal(enrolFields.some(([name]) => name === "remove" || name === "removeselect[]"), false);
    assert.equal(enrolFields.some(([name]) => name === "extendbase"), true, "the native form is carried through unchanged");
    digest = await reviewedDigest();
    assert.equal(enrolled.snapshot_digest, digest);

    // A change that moves someone else is reported as unconfirmed, never as the
    // approved result.
    model.changeOtherDuringWrite = true;
    before = writes.length;
    const disturbed = await execute(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Non-editing teacher" });
    assert.deepEqual(
      [disturbed.ok, disturbed.sent, disturbed.outcomeUnknown, disturbed.error],
      [false, true, true, "moodle_enrolment_other_participants_changed"],
      JSON.stringify(disturbed),
    );
    assert.equal(writes.length - before, 1);
    model.participants[1].roles = ["5", "4"];
    model.participants[0].roles = ["5"];
    digest = await reviewedDigest();

    // A lost response after one dispatch is applied but unconfirmed, on the
    // form route and on the role route, and nothing is sent again.
    before = writes.length;
    await loseNextWriteResponse();
    const lostRole = await execute(operations.assignRole, { course_id: COURSE_ID, user_id: 11, expected_digest: digest, role_name: "Non-editing teacher" });
    assert.deepEqual(
      [lostRole.ok, lostRole.sent, lostRole.outcomeUnknown, lostRole.error],
      [false, true, true, "moodle_enrolment_write_unconfirmed"],
      JSON.stringify(lostRole),
    );
    assert.equal(lostRole.verification.status, "unconfirmed");
    assert.equal(writes.length - before, 1, "a lost role write is never sent twice");
    model.participants[0].roles = ["5"];
    digest = await reviewedDigest();
    before = writes.length;
    await loseNextWriteResponse();
    const lostSuspension = await execute(operations.suspend, { course_id: COURSE_ID, user_id: 11, expected_digest: digest });
    assert.deepEqual(
      [lostSuspension.ok, lostSuspension.sent, lostSuspension.outcomeUnknown, lostSuspension.error],
      [false, true, true, "moodle_enrolment_write_unconfirmed"],
      JSON.stringify(lostSuspension),
    );
    assert.equal(writes.length - before, 1, "a lost suspension is never sent twice");
    model.participants[0].enrolments[0].status = "Active";
    digest = await reviewedDigest();

    // The unenrolment: one POST of Moodle's own confirmation, the person gone
    // from the roster afterwards, and the removal named in full.
    before = writes.length;
    const unenrolled = await execute(operations.unenrol, { course_id: COURSE_ID, user_id: 21, expected_digest: digest, acknowledge_removes_learner_record: true });
    assert.equal(unenrolled.ok, true, JSON.stringify(unenrolled));
    assert.equal(writes.length - before, 1, "an unenrolment sends exactly one POST");
    assert.equal(written("unenrol"), 1);
    assert.equal(unenrolled.data.participant_after, null);
    assert.deepEqual(unenrolled.data.participant_before.enrolments.map((entry) => entry.method), ["Manual enrolments"]);
    assert.deepEqual(unenrolled.data.removed, UNENROL_REMOVALS);
    assert.equal(unenrolled.data.proof.participant_absent_after, true);
    const unenrolFields = new Map(writes.at(-1).fields);
    assert.equal(unenrolFields.get("confirm"), "1");
    assert.equal(unenrolFields.get("ue"), "201");
    assert.equal(model.participants.some((entry) => entry.userId === "21"), false);

    // Nothing any of these results carries names a person.
    // Every route these five writes use was actually driven here.
    assert.deepEqual(new Set(writes.map((entry) => entry.route)), new Set(["role", "enrol", "suspend", "unenrol"]));
    assert.ok(requests.some((entry) => entry.method === "GET" && entry.pathname === "/enrol/instances.php"));

    const everyResult = JSON.stringify([assigned, removed, protectedRemoval, suspended, refused, enrolled, disturbed, lostRole, lostSuspension, unenrolled]);
    for (const identity of ["Ada", "Lovelace", "Grace", "Hopper", "Mary", "Jackson", "@example.edu", "example.edu"]) {
      assert.equal(everyResult.includes(identity), false, `a result carried ${identity}`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
