import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleGroupsLifecycleInPage } from "../../connector/extension/src/moodle-groups-executor.js";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../..", import.meta.url);
const SESSKEY = "moodle-private-session";
const STATE_KEY = "state-key-never-crosses-the-bridge";
const ENROLMENT_KEY = "group-enrolment-key-stays-in-chrome";
const operations = Object.freeze({
  groupings: { key: "moodle.page.group.groupings.read.v1", toolName: "moodle_get_course_groupings", provider: "moodle", readOnly: true },
  createGroup: { key: "moodle.form.group.create.v1", toolName: "moodle_create_group", provider: "moodle", readOnly: false },
  updateGroup: { key: "moodle.form.group.update.v1", toolName: "moodle_update_group", provider: "moodle", readOnly: false },
  deleteGroup: { key: "moodle.form.group.delete.v1", toolName: "moodle_delete_group", provider: "moodle", readOnly: false },
  addMember: { key: "moodle.form.group.member.add.v1", toolName: "moodle_add_group_member", provider: "moodle", readOnly: false },
  removeMember: { key: "moodle.form.group.member.remove.v1", toolName: "moodle_remove_group_member", provider: "moodle", readOnly: false },
  createGrouping: { key: "moodle.form.grouping.create.v1", toolName: "moodle_create_grouping", provider: "moodle", readOnly: false },
  updateGrouping: { key: "moodle.form.grouping.update.v1", toolName: "moodle_update_grouping", provider: "moodle", readOnly: false },
  setGroupingGroups: { key: "moodle.form.grouping.groups.set.v1", toolName: "moodle_set_grouping_groups", provider: "moodle", readOnly: false },
  groupMode: { key: "moodle.ajax.core_courseformat_update_course.cm_groupmode.v1", toolName: "moodle_set_activity_group_mode", provider: "moodle", readOnly: false },
});
const CONTENTS = { key: "moodle.ajax.core_courseformat_get_state.v1", toolName: "moodle_get_contents", provider: "moodle", readOnly: true };

test("the group and grouping operations are cataloged, routed, and gated by their own approval class", () => {
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, operation.readOnly);
    assert.match(entry.description, /Browser-fixture proof only; no signed-in Moodle site has run it\./);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\/public\//);
    if (!operation.readOnly) {
      assert.ok(byTool.get(entry.reviewTool)?.readOnly, `${operation.toolName} needs a read review tool`);
      assert.match(entry.description, /applied but unconfirmed and is never retried/);
    }
  }

  // Every group and grouping route is the same capability at the same context.
  for (const toolName of ["moodle_get_course_groupings", "moodle_create_group", "moodle_update_group", "moodle_delete_group",
    "moodle_add_group_member", "moodle_remove_group_member", "moodle_create_grouping", "moodle_update_grouping", "moodle_set_grouping_groups"]) {
    assert.match(byTool.get(toolName).description, /Requires moodle\/course:managegroups at the course context/, toolName);
  }
  // The activity group mode is not one of them.
  assert.match(byTool.get("moodle_set_activity_group_mode").description, /requires moodle\/course:manageactivities at the course context, not moodle\/course:managegroups/);
  assert.match(byTool.get("moodle_set_activity_group_mode").description, /forced mode overrides what is saved here/);

  const removal = byTool.get("moodle_delete_group");
  assert.equal(removal.destructive, true);
  assert.equal(removal.irreversible, true);
  assert.equal(removal.dataClass, "learner");
  assert.match(removal.description, /Morrow cannot undo it/);
  assert.match(removal.description, /lists every member the deletion removes/);
  assert.match(removal.description, /expected_member_count must be the number/);
  assert.deepEqual(removal.inputSchema.required, ["course_id", "group_id", "expected_group_name", "expected_member_count", "expected_digest"]);

  for (const toolName of ["moodle_add_group_member", "moodle_remove_group_member"]) {
    const entry = byTool.get(toolName);
    assert.equal(entry.dataClass, "learner", toolName);
    assert.equal(entry.family, "learner-data", toolName);
    assert.equal(entry.destructive, undefined, toolName);
    assert.match(entry.description, /stable learner token/, toolName);
    assert.deepEqual(entry.inputSchema.required, ["course_id", "group_id", "expected_group_name", "user_id", "expected_digest"], toolName);
  }
  for (const toolName of ["moodle_create_group", "moodle_update_group", "moodle_create_grouping", "moodle_update_grouping"]) {
    assert.match(byTool.get(toolName).description, /renders itself again and saves nothing, and that is reported as a refusal, not as an unknown outcome/, toolName);
  }
  assert.match(byTool.get("moodle_add_group_member").description, /moodle_group_member_list_bounded/);
  assert.match(byTool.get("moodle_set_grouping_groups").description, /moodle_grouping_groups_two_directions/);
  assert.equal(byTool.get("moodle_get_course_groupings").dataClass, "course");
  assert.match(byTool.get("moodle_update_group").description, /moodle_group_visibility_locked/);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleGroupsLifecycleInPage \} from "\.\/moodle-groups-executor\.js";/);
  assert.match(worker, /MOODLE_GROUPS_LIFECYCLE_OPERATION_KEYS = new Set\(\[/);
  assert.match(worker, /func: executeMoodleGroupsLifecycleInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }

  // A group deletion is never a standing Edit grant; each one is reviewed on its own.
  const actions = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const action = (toolName) => actions.find((entry) => entry.id === `action:moodle:${toolName}`);
  assert.equal(action("moodle_delete_group").availability, "review");
  assert.equal(action("moodle_delete_group").tier, "destructive");
  assert.match(action("moodle_delete_group").reviewReason, /every member the deletion removes from it/);
  assert.match(action("moodle_delete_group").reviewReason, /Morrow cannot undo it/);
  for (const toolName of ["moodle_create_group", "moodle_update_group"]) {
    assert.equal(action(toolName).availability, "edit", toolName);
    assert.equal(action(toolName).group, "Moodle · Group", toolName);
  }
  for (const toolName of ["moodle_add_group_member", "moodle_remove_group_member"]) {
    assert.equal(action(toolName).group, "Moodle · Group Member", toolName);
    assert.match(action(toolName).description, /which learners an activity that separates groups shows to each other/, toolName);
  }
  assert.match(action("moodle_set_activity_group_mode").description, /which learners an activity that separates groups shows to each other/);
  assert.equal(action("moodle_create_grouping").group, "Moodle · Grouping");
});

test("one group, membership, grouping, or activity group mode changes exactly, against Moodle's own saved state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-groups-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  const bodies = [];
  let origin = "";
  let browser;
  let model;
  let draft = 900_000;

  const initialModel = () => ({
    nextGroupId: 20,
    nextGroupingId: 40,
    frozenGroupControls: false,
    candidateListTooLarge: false,
    renameOtherGroupOnWrite: "",
    refuseNextGroupSave: false,
    driftProtectedOnSave: false,
    idnumberSuffix: "",
    people: { 3: "Course Teacher", 7: "Jane Moodle", 11: "Sam Partner" },
    groups: [
      { id: "8", name: "Team A", visibility: 0, participation: true, members: ["7"] },
      { id: "9", name: "Team B", visibility: 2, participation: false, members: [] },
    ],
    groupings: [
      { id: "5", name: "Project teams", groupIds: ["8"], activities: 1 },
      { id: "6", name: "Reading circles", groupIds: [], activities: 0 },
    ],
    courseGroupMode: 0,
    courseGroupModeForce: 0,
    course: { id: 2, fullname: "Foundations of Care", editmode: true, statekey: STATE_KEY, numsections: 1, sectionlist: [5] },
    section: [{ id: "5", number: 0, title: "General", visible: true, hasrestrictions: false, component: "", cmlist: ["50", "51"] }],
    cm: [
      { id: "50", module: "assign", modname: "Assignment", sectionid: "5", sectionnumber: 0, name: "Evidence log", visible: true, stealth: false, groupmode: 0, hasdelegatedsection: false },
      { id: "51", module: "forum", modname: "Forum", sectionid: "5", sectionnumber: 0, name: "Case notes", visible: true, stealth: false, groupmode: 0, hasdelegatedsection: false },
    ],
  });
  const groupById = (id) => model.groups.find((entry) => entry.id === id);
  const groupingById = (id) => model.groupings.find((entry) => entry.id === id);
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const draftId = () => String(draft += 1);

  const groupForm = (group) => {
    const visibility = group ? group.visibility : 0;
    const participation = group ? group.participation : true;
    const visibilityControl = model.frozenGroupControls
      ? `<span class="form-control-static">Members</span><input type="hidden" name="visibility" value="${visibility}">`
      : `<select name="visibility" id="id_visibility">${[0, 1, 2, 3].map((value) => `<option value="${value}"${value === visibility ? " selected" : ""}>Visibility ${value}</option>`).join("")}</select>`;
    const participationControl = model.frozenGroupControls
      ? `<input type="hidden" name="participation" value="${participation ? 1 : 0}">`
      : `<input type="hidden" name="participation" value="0"><input type="checkbox" name="participation" value="1"${participation ? " checked" : ""}>`;
    const action = group ? `/group/group.php?id=${group.id}` : "/group/group.php?courseid=2";
    return `<!doctype html><html><body class="path-group course-2"><form method="post" action="${action}" id="mform1">
      <input type="hidden" name="sesskey" value="${SESSKEY}">
      <input type="hidden" name="_qf__group_form" value="1">
      <input type="text" name="name" value="${escape(group ? group.name : "")}">
      <input type="text" name="idnumber" value="${group ? `IDN-${group.id}${model.idnumberSuffix}` : ""}">
      <textarea name="description_editor[text]">${group ? "Saved group description" : ""}</textarea>
      <input type="hidden" name="description_editor[format]" value="1">
      <input type="hidden" name="description_editor[itemid]" value="${draftId()}">
      <input type="password" name="enrolmentkey" value="${group ? ENROLMENT_KEY : ""}">
      ${visibilityControl}
      ${participationControl}
      <input type="hidden" name="imagefile" value="${draftId()}">
      <input type="hidden" name="id" value="${group ? group.id : ""}">
      <input type="hidden" name="courseid" value="2">
      <input type="submit" name="submitbutton" value="Save changes">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };
  const groupingForm = (grouping) => {
    const action = grouping ? `/group/grouping.php?id=${grouping.id}` : "/group/grouping.php?courseid=2";
    return `<!doctype html><html><body class="path-group course-2"><form method="post" action="${action}" id="mform1">
      <input type="hidden" name="sesskey" value="${SESSKEY}">
      <input type="hidden" name="_qf__grouping_form" value="1">
      <input type="text" name="name" value="${escape(grouping ? grouping.name : "")}">
      <input type="text" name="idnumber" value="">
      <textarea name="description_editor[text]">${grouping ? "Saved grouping description" : ""}</textarea>
      <input type="hidden" name="description_editor[format]" value="1">
      <input type="hidden" name="description_editor[itemid]" value="${draftId()}">
      <input type="hidden" name="id" value="${grouping ? grouping.id : ""}">
      <input type="hidden" name="courseid" value="2">
      <input type="submit" name="submitbutton" value="Save changes">
      <input type="submit" name="cancel" value="Cancel">
    </form></body></html>`;
  };
  const selector = (name, entries) => {
    const options = entries.length
      ? `<optgroup label="Student (${entries.length})">${entries.map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("")}</optgroup>`
      : `<optgroup label="None"><option disabled="disabled">&nbsp;</option></optgroup>`;
    return `<div class="userselector" id="${name}_wrapper"><select name="${name}[]" id="${name}" multiple="multiple" size="20">${options}</select></div>`;
  };
  const cappedSelector = (name) => `<div class="userselector" id="${name}_wrapper"><select name="${name}[]" id="${name}" multiple="multiple" size="20">`
    + `<optgroup label="Too many users (150) to show"><option disabled="disabled">&nbsp;</option></optgroup>`
    + `<optgroup label="Please use the search"><option disabled="disabled">&nbsp;</option></optgroup></select></div>`;
  const memberForm = (group) => {
    const members = group.members.map((userId) => [userId, model.people[userId]]);
    const candidates = Object.keys(model.people).filter((userId) => !group.members.includes(userId)).map((userId) => [userId, model.people[userId]]);
    return `<!doctype html><html><body class="path-group course-2"><div id="addmembersform">
      <form id="assignform" method="post" action="/group/members.php?group=${group.id}">
      <input type="hidden" name="sesskey" value="${SESSKEY}">
      ${selector("removeselect", members)}
      <input type="text" name="removeselect_searchtext" value="">
      <input class="btn" name="add" id="add" type="submit" value="Add">
      <input class="btn" name="remove" id="remove" type="submit" value="Remove">
      ${model.candidateListTooLarge ? cappedSelector("addselect") : selector("addselect", candidates)}
      <input type="text" name="addselect_searchtext" value="">
      <input type="submit" name="cancel" value="Back to groups">
      </form></div></body></html>`;
  };
  const assignForm = (grouping) => {
    const held = grouping.groupIds.map((groupId) => [`${groupId}.`, groupById(groupId)?.name || groupId]);
    const rest = model.groups.filter((entry) => !grouping.groupIds.includes(entry.id)).map((entry) => [`${entry.id}.`, entry.name]);
    const box = (name, entries) => `<div class="userselector" id="${name}_wrapper"><select name="${name}[]" size="20" id="${name}" multiple="multiple">`
      + (entries.length ? entries.map(([value, label]) => `<option value="${escape(value)}" title="${escape(label)}">${escape(label)}</option>`).join("") : "<option>&nbsp;</option>")
      + "</select></div>";
    return `<!doctype html><html><body class="path-group course-2"><div id="addmembersform">
      <form id="assignform" method="post" action="">
      <input type="hidden" name="sesskey" value="${SESSKEY}">
      ${box("removeselect", held)}
      <input class="btn" name="add" id="add" type="submit" value="Add">
      <input class="btn" name="remove" id="remove" type="submit" value="Remove">
      ${box("addselect", rest)}
      <input type="submit" name="cancel" value="Back to groupings">
      </form></div></body></html>`;
  };
  const groupingsPage = () => {
    const rows = model.groupings.map((grouping) => {
      const names = grouping.groupIds.map((groupId) => groupById(groupId)?.name || groupId).join(", ") || "None";
      return `<tr><td>${escape(grouping.name)}</td><td>${escape(names)}</td><td>${grouping.activities}</td>`
        + `<td><a href="/group/grouping.php?id=${grouping.id}" title="Edit"><i class="icon"></i></a>`
        + `<a href="/group/grouping.php?id=${grouping.id}&amp;delete=1" title="Delete"><i class="icon"></i></a>`
        + `<a href="/group/assign.php?id=${grouping.id}" title="Show groups in grouping"><i class="icon"></i></a></td></tr>`;
    }).join("");
    return `<!doctype html><html><body class="path-group course-2"><select id="tertiary-nav"><option>Groupings</option></select>`
      + `<table class="generaltable table table-hover table-striped"><thead><tr><th>Grouping</th><th>Groups</th><th>Activities</th><th>Edit</th></tr></thead>`
      + `<tbody>${rows}</tbody></table></body></html>`;
  };
  const courseForm = () => `<!doctype html><html><body class="path-course course-2"><form method="post" action="/course/edit.php?id=2">
    <input type="hidden" name="id" value="2">
    <input name="fullname" value="Foundations of Care">
    <select name="groupmode">${[0, 1, 2].map((value) => `<option value="${value}"${value === model.courseGroupMode ? " selected" : ""}>Mode ${value}</option>`).join("")}</select>
    <select name="groupmodeforce">${[0, 1].map((value) => `<option value="${value}"${value === model.courseGroupModeForce ? " selected" : ""}>Force ${value}</option>`).join("")}</select>
    <input type="hidden" name="sesskey" value="${SESSKEY}">
    <input type="submit" name="saveanddisplay" value="Save">
  </form></body></html>`;
  const stateBody = () => JSON.stringify([{
    data: JSON.stringify({
      course: { ...model.course },
      section: model.section.map((entry) => ({ ...entry })),
      cm: model.cm.map((entry) => ({ ...entry })),
    }),
  }]);
  const membersBody = (group) => JSON.stringify(group.members.length
    ? [{ name: "Student", users: group.members.map((userId) => ({ id: Number(userId), name: model.people[userId] })) }]
    : []);

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, reply) => {
    const target = new URL(request.url || "/", origin);
    const record = { method: request.method, pathname: target.pathname, search: target.search, info: target.searchParams.get("info") };
    requests.push(record);
    const html = (body) => { reply.writeHead(200, { "content-type": "text/html" }); reply.end(body); };
    const json = (body) => { reply.writeHead(200, { "content-type": "application/json" }); reply.end(body); };
    const seeOther = (location) => { reply.writeHead(303, { location }); reply.end(); };

    if (request.method === "GET" && target.pathname === "/course/view.php") {
      html(`<!doctype html><body class="path-course course-2"><h1>Foundations of Care</h1><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/edit.php") {
      if (target.searchParams.get("id") !== "2") { reply.writeHead(400).end(); return; }
      html(courseForm());
      return;
    }
    if (target.pathname === "/group/index.php" && request.method === "GET") {
      const group = groupById(target.searchParams.get("group") || "");
      if (!group || target.searchParams.get("id") !== "2" || target.searchParams.get("action") !== "ajax_getmembersingroup") { reply.writeHead(400).end(); return; }
      json(membersBody(group));
      return;
    }
    if (target.pathname === "/group/group.php") {
      const group = target.searchParams.has("id") ? groupById(target.searchParams.get("id")) : null;
      if (request.method === "GET") {
        if (target.searchParams.has("id") && !group) { reply.writeHead(400).end(); return; }
        html(groupForm(group));
        return;
      }
      const body = new URLSearchParams(await readBody(request));
      bodies.push({ pathname: target.pathname, search: target.search, body: body.toString() });
      if (model.refuseNextGroupSave) {
        // Moodle renders the same form again, with its error, and saves nothing.
        model.refuseNextGroupSave = false;
        html(groupForm(group));
        return;
      }
      const participation = (body.getAll("participation").pop() || "0") === "1";
      const visibility = Number(body.get("visibility") || 0);
      if (group) {
        group.name = body.get("name");
        group.visibility = visibility;
        group.participation = participation;
        if (model.renameOtherGroupOnWrite) {
          const other = groupById(model.renameOtherGroupOnWrite);
          if (other) other.name = "Renamed by something else";
        }
        if (model.driftProtectedOnSave) model.idnumberSuffix = "-changed";
        seeOther(`/group/index.php?id=2&group=${group.id}`);
        return;
      }
      const created = { id: String(model.nextGroupId += 1), name: body.get("name"), visibility, participation, members: [] };
      model.groups.push(created);
      seeOther(`/group/index.php?id=2&group=${created.id}`);
      return;
    }
    if (target.pathname === "/group/delete.php" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request));
      bodies.push({ pathname: target.pathname, search: target.search, body: body.toString() });
      if (body.get("sesskey") !== SESSKEY || body.get("confirm") !== "1" || body.get("courseid") !== "2") { reply.writeHead(400).end(); return; }
      const groupId = body.get("groups");
      model.groups = model.groups.filter((entry) => entry.id !== groupId);
      for (const grouping of model.groupings) grouping.groupIds = grouping.groupIds.filter((entry) => entry !== groupId);
      seeOther("/group/index.php?id=2");
      return;
    }
    if (target.pathname === "/group/members.php") {
      const group = groupById(target.searchParams.get("group") || "");
      if (!group) { reply.writeHead(400).end(); return; }
      if (request.method === "GET") { html(memberForm(group)); return; }
      const body = new URLSearchParams(await readBody(request));
      bodies.push({ pathname: target.pathname, search: target.search, body: body.toString() });
      if (body.get("sesskey") !== SESSKEY) { reply.writeHead(400).end(); return; }
      if (body.has("add")) {
        for (const userId of body.getAll("addselect[]")) {
          if (Object.hasOwn(model.people, userId) && !group.members.includes(userId)) group.members.push(userId);
        }
      } else if (body.has("remove")) {
        group.members = group.members.filter((userId) => !body.getAll("removeselect[]").includes(userId));
      }
      html(memberForm(group));
      return;
    }
    if (target.pathname === "/group/groupings.php" && request.method === "GET") {
      if (target.searchParams.get("id") !== "2") { reply.writeHead(400).end(); return; }
      html(groupingsPage());
      return;
    }
    if (target.pathname === "/group/grouping.php") {
      const grouping = target.searchParams.has("id") ? groupingById(target.searchParams.get("id")) : null;
      if (request.method === "GET") {
        if (target.searchParams.has("id") && !grouping) { reply.writeHead(400).end(); return; }
        html(groupingForm(grouping));
        return;
      }
      const body = new URLSearchParams(await readBody(request));
      bodies.push({ pathname: target.pathname, search: target.search, body: body.toString() });
      if (grouping) grouping.name = body.get("name");
      else model.groupings.push({ id: String(model.nextGroupingId += 1), name: body.get("name"), groupIds: [], activities: 0 });
      seeOther("/group/groupings.php?id=2");
      return;
    }
    if (target.pathname === "/group/assign.php") {
      const grouping = groupingById(target.searchParams.get("id") || "");
      if (!grouping) { reply.writeHead(400).end(); return; }
      if (request.method === "GET") { html(assignForm(grouping)); return; }
      const body = new URLSearchParams(await readBody(request));
      bodies.push({ pathname: target.pathname, search: target.search, body: body.toString() });
      if (body.get("sesskey") !== SESSKEY) { reply.writeHead(400).end(); return; }
      const ids = (name) => body.getAll(`${name}[]`).map((value) => value.replace(/\.$/, ""));
      if (body.has("add")) {
        for (const groupId of ids("addselect")) if (groupById(groupId) && !grouping.groupIds.includes(groupId)) grouping.groupIds.push(groupId);
      } else if (body.has("remove")) {
        grouping.groupIds = grouping.groupIds.filter((groupId) => !ids("removeselect").includes(groupId));
      }
      html(assignForm(grouping));
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const call = JSON.parse(await readBody(request))[0];
      record.method_name = call.methodname;
      if (target.searchParams.get("sesskey") !== SESSKEY || target.searchParams.get("info") !== call.methodname) { reply.writeHead(400).end(); return; }
      if (call.methodname === "core_group_get_course_groups") {
        json(JSON.stringify([{ data: JSON.stringify(model.groups.map((entry) => ({
          id: Number(entry.id), courseid: 2, name: entry.name, description: "", descriptionformat: 1,
          idnumber: `IDN-${entry.id}`, visibility: entry.visibility, participation: entry.participation,
        }))) }]));
        return;
      }
      if (call.methodname === "core_courseformat_get_state") { json(stateBody()); return; }
      if (call.methodname === "core_courseformat_update_course") {
        bodies.push({ pathname: target.pathname, search: target.search, body: JSON.stringify(call.args) });
        const activity = model.cm.find((entry) => entry.id === String(call.args.ids[0]));
        if (activity) activity.groupmode = { cm_nogroups: 0, cm_separategroups: 1, cm_visiblegroups: 2 }[call.args.action];
        json(JSON.stringify([{ data: null }]));
        return;
      }
    }
    reply.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    model = initialModel();
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const stable = (value) => {
      if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
      if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
      return JSON.stringify(value === undefined ? null : value);
    };
    const groupDigest = () => createHash("sha256").update(stable({
      course_id: "2",
      groups: model.groups
        .map((group) => ({
          id: group.id, name: group.name, visibility: group.visibility, participation: group.participation,
          membership: group.members.map((userId) => ({ user_id: userId, name: model.people[userId] }))
            .sort((left, right) => Number(left.user_id) - Number(right.user_id)),
        }))
        .sort((left, right) => Number(left.id) - Number(right.id)),
    })).digest("hex");
    const digestWrites = new Set([operations.createGroup.key, operations.updateGroup.key, operations.deleteGroup.key, operations.addMember.key, operations.removeMember.key]);
    const rawRun = (operation, argumentsValue, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleGroupsLifecycleInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }),
    );
    const run = (operation, argumentsValue, expiresAt = Date.now() + 60_000) => rawRun(
      operation,
      digestWrites.has(operation.key) ? { ...argumentsValue, expected_digest: argumentsValue.expected_digest || groupDigest() } : argumentsValue,
      expiresAt,
    );
    const contents = () => page.evaluate(
      executeMoodleInPage,
      JSON.stringify({ mode: "execute", operation: CONTENTS, arguments: { course_id: 2 }, binding, expiresAt: Date.now() + 60_000 }),
    );
    // Every POST that is not one of the two read services is a native write route.
    const writePosts = () => requests.filter((entry) => entry.method === "POST"
      && !(entry.pathname === "/lib/ajax/service.php" && ["core_group_get_course_groups", "core_courseformat_get_state"].includes(entry.info)));
    const countWrites = () => writePosts().length;
    const lastBody = () => new URLSearchParams(bodies[bodies.length - 1].body);
    const noWrite = async (result, before, expected) => {
      assert.deepEqual(
        { ok: result.ok, sent: result.sent, error: result.error },
        { ok: false, sent: false, error: expected },
        JSON.stringify(result),
      );
      assert.equal(result.outcomeUnknown, undefined, JSON.stringify(result));
      assert.equal(countWrites(), before, `${expected} must send nothing`);
    };

    // 1. The grouping read. It sends no POST of its own and carries no identity.
    const beforeRead = countWrites();
    const groupings = await run(operations.groupings, { course_id: 2 });
    assert.equal(groupings.ok, true, JSON.stringify(groupings));
    assert.equal(groupings.sent, false);
    assert.deepEqual(groupings.data.groupings, [
      { grouping_id: "5", name: "Project teams", activity_count: 1, group_ids: ["8"] },
      { grouping_id: "6", name: "Reading circles", activity_count: 0, group_ids: [] },
    ]);
    assert.match(groupings.snapshot_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(groupings.data.proof, {
      method: "native_groupings_page", route: "/group/groupings.php",
      required_capability: "moodle/course:managegroups", scope: "every_grouping_of_the_approved_course",
    });
    assert.equal(countWrites(), beforeRead);
    assert.equal(JSON.stringify(groupings).includes(SESSKEY), false);

    // 2. Strict arguments, before anything is read or sent.
    await noWrite(await run(operations.groupings, { course_id: 2, extra: true }), countWrites(), "moodle_groups_arguments_invalid");
    await noWrite(await run(operations.createGroup, { course_id: 2, name: "Team <b>C</b>" }), countWrites(), "moodle_groups_arguments_invalid");
    await noWrite(await run(operations.createGroup, { course_id: 3, name: "Team C" }), countWrites(), "moodle_groups_arguments_invalid");
    assert.deepEqual(await run(operations.createGroup, { course_id: 2, name: "Team C" }, Date.now() - 1),
      { ok: false, sent: false, error: "moodle_execution_expired" });
    await noWrite(await rawRun(operations.createGroup, {
      course_id: 2, name: "Team C", expected_digest: "0".repeat(64),
    }), countWrites(), "moodle_expected_digest_mismatch");

    // 3. One group is created with one POST of the native form.
    let before = countWrites();
    const created = await run(operations.createGroup, { course_id: 2, name: "Team C", visibility: 1, participation: false });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.verification.status, "verified");
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(created.data.group, {
      group_id: "21", name: "Team C", visibility: 1,
      visibility_meaning: "Members see the group and its other members", participation: false,
    });
    assert.deepEqual(created.data.groups.map((entry) => entry.name), ["Team A", "Team B", "Team C"]);
    const createdBody = lastBody();
    assert.equal(createdBody.get("name"), "Team C");
    assert.equal(createdBody.get("visibility"), "1");
    assert.deepEqual(createdBody.getAll("participation"), ["0", "0"]);
    assert.equal(createdBody.get("courseid"), "2");
    assert.equal(createdBody.get("submitbutton"), "Save changes");
    assert.equal(createdBody.get("_qf__group_form"), "1");
    assert.equal(JSON.stringify(created).includes(SESSKEY), false);

    // 4. A name Moodle already holds is refused before anything is sent.
    await noWrite(await run(operations.createGroup, { course_id: 2, name: "Team A" }), countWrites(), "moodle_group_name_taken");

    // 5. A rename carries every other control through, and the digest of those
    //    controls is unchanged even though Moodle mints new draft ids each load.
    before = countWrites();
    const renamed = await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team A", name: "Team Alpha" });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    assert.equal(countWrites(), before + 1);
    assert.equal(renamed.data.group.name, "Team Alpha");
    assert.match(renamed.proof.protected_settings_digest, /^[a-f0-9]{64}$/);
    const renameBody = lastBody();
    assert.equal(renameBody.get("name"), "Team Alpha");
    assert.equal(renameBody.get("idnumber"), "IDN-8");
    assert.equal(renameBody.get("description_editor[text]"), "Saved group description");
    assert.equal(renameBody.get("enrolmentkey"), ENROLMENT_KEY);
    assert.equal(JSON.stringify(renamed).includes(ENROLMENT_KEY), false);
    assert.equal(groupById("8").name, "Team Alpha");

    // 6. A change somewhere else in the course group list, or in a control this
    //    change did not name, leaves the result applied but unconfirmed.
    model.renameOtherGroupOnWrite = "9";
    before = countWrites();
    const drifted = await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", name: "Team Alpha 2" });
    assert.equal(countWrites(), before + 1);
    assert.deepEqual({ ok: drifted.ok, sent: drifted.sent, outcomeUnknown: drifted.outcomeUnknown, error: drifted.error },
      { ok: false, sent: true, outcomeUnknown: true, error: "moodle_group_write_not_verified" }, JSON.stringify(drifted));
    assert.equal(drifted.verification.status, "unconfirmed");
    model.renameOtherGroupOnWrite = "";
    groupById("9").name = "Team B";
    groupById("8").name = "Team Alpha";

    model.driftProtectedOnSave = true;
    before = countWrites();
    const protectedChanged = await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", name: "Team Alpha 3" });
    assert.equal(countWrites(), before + 1);
    assert.deepEqual({ ok: protectedChanged.ok, sent: protectedChanged.sent, outcomeUnknown: protectedChanged.outcomeUnknown, error: protectedChanged.error },
      { ok: false, sent: true, outcomeUnknown: true, error: "moodle_group_write_not_verified" }, JSON.stringify(protectedChanged));
    assert.equal(protectedChanged.verification.status, "unconfirmed");
    model.driftProtectedOnSave = false;
    model.idnumberSuffix = "";
    groupById("8").name = "Team Alpha";

    // 7. A group this course does not hold is refused before anything is sent.
    await noWrite(await run(operations.updateGroup, { course_id: 2, group_id: 404, expected_group_name: "Team Alpha", name: "Team Zulu" }),
      countWrites(), "moodle_group_absent");

    // 8. A native form that refuses its own input saved nothing, and the result
    //    says that rather than reporting an outcome Morrow does not know.
    model.refuseNextGroupSave = true;
    before = countWrites();
    const refused = await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", name: "Team Refused" });
    assert.equal(countWrites(), before + 1);
    assert.deepEqual({ ok: refused.ok, sent: refused.sent, outcomeUnknown: refused.outcomeUnknown, error: refused.error },
      { ok: false, sent: true, outcomeUnknown: false, error: "moodle_form_validation_failed" }, JSON.stringify(refused));
    assert.equal(refused.verification.status, "mismatch");
    assert.equal(groupById("8").name, "Team Alpha");

    // 9. The reviewed name must be the name the group carries now.
    await noWrite(await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team A", name: "Team Omega" }),
      countWrites(), "moodle_expected_group_name_mismatch");

    // 10. Moodle freezes visibility and participation once a group has a member.
    model.frozenGroupControls = true;
    await noWrite(await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", visibility: 3 }),
      countWrites(), "moodle_group_visibility_locked");
    await noWrite(await run(operations.updateGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", participation: false }),
      countWrites(), "moodle_group_visibility_locked");
    model.frozenGroupControls = false;

    // 11. An identity Moodle does not offer for this exact group is refused.
    await noWrite(await run(operations.addMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 99 }),
      countWrites(), "moodle_group_member_not_available");
    await noWrite(await run(operations.addMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 7 }),
      countWrites(), "moodle_group_member_already_present");
    model.candidateListTooLarge = true;
    await noWrite(await run(operations.addMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 11 }),
      countWrites(), "moodle_group_member_list_bounded");
    model.candidateListTooLarge = false;

    // 12. One member is added with one POST, and the saved membership decides it.
    before = countWrites();
    const added = await run(operations.addMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 11 });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(added.data.member, { user_id: "11", name: "Sam Partner" });
    assert.equal(added.data.member_count, 2);
    assert.equal(added.proof.group_visibility, 0);
    assert.equal(added.proof.group_visibility_meaning, "Visible to everyone in the course");
    const addBody = lastBody();
    assert.deepEqual(addBody.getAll("addselect[]"), ["11"]);
    assert.equal(addBody.get("add"), "1");
    assert.equal(addBody.has("removeselect[]"), false);
    assert.deepEqual(groupById("8").members, ["7", "11"]);

    // 13. One member is removed with one POST.
    before = countWrites();
    const removed = await run(operations.removeMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 11 });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(removed.data.member, { user_id: "11", name: "Sam Partner" });
    assert.deepEqual(lastBody().getAll("removeselect[]"), ["11"]);
    assert.equal(lastBody().get("remove"), "1");
    assert.deepEqual(groupById("8").members, ["7"]);
    await noWrite(await run(operations.removeMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 11 }),
      countWrites(), "moodle_group_member_absent");

    // 14. A lost response after the one dispatch is applied-or-unknown, never retried.
    await page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST"
          && new URL(String(parameters[0]), globalThis.location.href).pathname === "/group/members.php") {
          globalThis.fetch = nativeFetch;
          throw new TypeError("member response lost after dispatch");
        }
        return response;
      };
    });
    before = countWrites();
    const lost = await run(operations.addMember, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", user_id: 11 });
    assert.equal(countWrites(), before + 1, "a lost response must not be retried");
    assert.equal(lost.ok, false);
    assert.equal(lost.sent, true);
    assert.equal(lost.outcomeUnknown, true);
    assert.equal(lost.verification.status, "unconfirmed");
    assert.equal(lost.error, "moodle_groups_write_unconfirmed");
    assert.deepEqual(groupById("8").members, ["7", "11"], "the fixture applied the write the browser could not confirm");
    groupById("8").members = ["7"];

    // 15. A deletion names every member it removes, and the reviewed membership
    //     has to be the membership it takes with it.
    await noWrite(await run(operations.deleteGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", expected_member_count: 0 }),
      countWrites(), "moodle_expected_member_count_mismatch");
    before = countWrites();
    const deleted = await run(operations.deleteGroup, { course_id: 2, group_id: "8", expected_group_name: "Team Alpha", expected_member_count: 1 });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(deleted.data.removed_members, [{ user_id: "7", name: "Jane Moodle" }]);
    assert.equal(deleted.data.deleted_group.name, "Team Alpha");
    assert.equal(deleted.proof.members_removed, 1);
    assert.equal(deleted.proof.learner_records_removed, true);
    assert.ok(deleted.proof.removes.some((line) => /stops being in this group/.test(line)));
    assert.ok(deleted.proof.removes.some((line) => /place in every grouping/.test(line)));
    assert.deepEqual(deleted.data.groups.map((entry) => entry.name), ["Team B", "Team C"]);
    const deleteBody = lastBody();
    assert.equal(deleteBody.get("groups"), "8");
    assert.equal(deleteBody.get("confirm"), "1");
    assert.equal(deleteBody.get("courseid"), "2");
    assert.equal(groupById("8"), undefined);
    assert.deepEqual(groupingById("5").groupIds, []);

    // 16. Groupings are bound by the digest of the reading that was reviewed.
    const groupingDigest = async () => {
      const read = await run(operations.groupings, { course_id: 2 });
      assert.equal(read.ok, true, JSON.stringify(read));
      return read.snapshot_digest;
    };
    await noWrite(await run(operations.createGrouping, { course_id: 2, name: "Lab pairs", expected_digest: "0".repeat(64) }),
      countWrites(), "moodle_expected_digest_mismatch");
    before = countWrites();
    const grouping = await run(operations.createGrouping, { course_id: 2, name: "Lab pairs", expected_digest: await groupingDigest() });
    assert.equal(grouping.ok, true, JSON.stringify(grouping));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(grouping.data.grouping, { grouping_id: "41", name: "Lab pairs", activity_count: 0, group_ids: [] });
    assert.equal(lastBody().get("name"), "Lab pairs");
    await noWrite(await run(operations.createGrouping, { course_id: 2, name: "Lab pairs", expected_digest: await groupingDigest() }),
      countWrites(), "moodle_grouping_name_taken");

    before = countWrites();
    const renamedGrouping = await run(operations.updateGrouping, { course_id: 2, grouping_id: "41", name: "Lab partners", expected_digest: await groupingDigest() });
    assert.equal(renamedGrouping.ok, true, JSON.stringify(renamedGrouping));
    assert.equal(countWrites(), before + 1);
    assert.equal(renamedGrouping.data.grouping.name, "Lab partners");

    // 17. One grouping's group set changes in one native submission.
    await noWrite(await run(operations.setGroupingGroups, { course_id: 2, grouping_id: "41", group_ids: [9, 404], expected_digest: await groupingDigest() }),
      countWrites(), "moodle_group_absent");
    before = countWrites();
    const assigned = await run(operations.setGroupingGroups, { course_id: 2, grouping_id: "41", group_ids: [9], expected_digest: await groupingDigest() });
    assert.equal(assigned.ok, true, JSON.stringify(assigned));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(assigned.data.grouping.group_ids, ["9"]);
    assert.deepEqual(lastBody().getAll("addselect[]"), ["9"]);
    assert.equal(lastBody().get("add"), "1");
    assert.equal(lastBody().has("removeselect[]"), false);
    // One native submission does one direction, so a set that both adds and
    // removes is refused instead of being sent as two changes.
    await noWrite(await run(operations.setGroupingGroups, { course_id: 2, grouping_id: "41", group_ids: [21], expected_digest: await groupingDigest() }),
      countWrites(), "moodle_grouping_groups_two_directions");
    before = countWrites();
    const widened = await run(operations.setGroupingGroups, { course_id: 2, grouping_id: "41", group_ids: [9, 21], expected_digest: await groupingDigest() });
    assert.equal(widened.ok, true, JSON.stringify(widened));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(widened.data.grouping.group_ids, ["9", "21"]);
    assert.deepEqual(lastBody().getAll("addselect[]"), ["21"]);
    before = countWrites();
    const reduced = await run(operations.setGroupingGroups, { course_id: 2, grouping_id: "41", group_ids: [21], expected_digest: await groupingDigest() });
    assert.equal(reduced.ok, true, JSON.stringify(reduced));
    assert.equal(countWrites(), before + 1);
    assert.deepEqual(reduced.data.grouping.group_ids, ["21"]);
    assert.deepEqual(lastBody().getAll("removeselect[]"), ["9"]);
    assert.equal(lastBody().get("remove"), "1");
    await noWrite(await run(operations.setGroupingGroups, { course_id: 2, grouping_id: "41", group_ids: [21], expected_digest: await groupingDigest() }),
      countWrites(), "moodle_grouping_groups_unchanged");
    // Grouping 5 is untouched by every one of those changes.
    assert.deepEqual(groupingById("5").groupIds, []);

    // 18. The activity group mode, against the same course state moodle_get_contents returns.
    const reviewedDigest = async () => {
      const read = await contents();
      assert.equal(read.ok, true, JSON.stringify(read));
      return read.snapshot_digest;
    };
    await noWrite(await run(operations.groupMode, { course_id: 2, module_id: 50, group_mode: 1, expected_digest: "0".repeat(64) }),
      countWrites(), "moodle_expected_digest_mismatch");
    await noWrite(await run(operations.groupMode, { course_id: 2, module_id: 50, group_mode: 0, expected_digest: await reviewedDigest() }),
      countWrites(), "moodle_activity_group_mode_unchanged");
    await noWrite(await run(operations.groupMode, { course_id: 2, module_id: 404, group_mode: 1, expected_digest: await reviewedDigest() }),
      countWrites(), "moodle_activity_absent");
    before = countWrites();
    const separate = await run(operations.groupMode, { course_id: 2, module_id: 50, group_mode: 1, expected_digest: await reviewedDigest() });
    assert.equal(separate.ok, true, JSON.stringify(separate));
    assert.equal(countWrites(), before + 1);
    assert.equal(separate.data.group_mode, 1);
    assert.equal(separate.data.group_mode_meaning, "Separate groups");
    assert.equal(separate.data.course_forces_group_mode, false);
    assert.equal(separate.data.effective_group_mode, 1);
    assert.equal(separate.proof.saved_value_in_effect, true);
    assert.equal(separate.proof.required_capability, "moodle/course:manageactivities");
    assert.deepEqual(JSON.parse(bodies[bodies.length - 1].body), {
      action: "cm_separategroups", courseid: 2, ids: [50], targetsectionid: null, targetcmid: null,
    });
    assert.equal(model.cm.find((entry) => entry.id === "50").groupmode, 1);
    assert.equal(model.cm.find((entry) => entry.id === "51").groupmode, 0);

    // A course that forces its own mode overrides the saved activity value, and
    // the result says so instead of claiming the change reached learners.
    model.courseGroupMode = 0;
    model.courseGroupModeForce = 1;
    before = countWrites();
    const forced = await run(operations.groupMode, { course_id: 2, module_id: 51, group_mode: 2, expected_digest: await reviewedDigest() });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(countWrites(), before + 1);
    assert.equal(forced.data.group_mode, 2);
    assert.equal(forced.data.course_forces_group_mode, true);
    assert.equal(forced.data.effective_group_mode, 0);
    assert.equal(forced.data.effective_group_mode_meaning, "No groups");
    assert.equal(forced.proof.saved_value_in_effect, false);

    // 19. Nothing in this workflow opens an activity or a module page.
    assert.equal(requests.some((entry) => /^\/mod\//.test(entry.pathname)), false);
    assert.equal(requests.filter((entry) => entry.pathname === "/course/view.php").length, 1);
    assert.equal(requests.some((entry) => entry.method === "POST" && entry.pathname === "/course/edit.php"), false);
    assert.equal(bodies.every((entry) => !entry.body.includes(STATE_KEY)), true);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
