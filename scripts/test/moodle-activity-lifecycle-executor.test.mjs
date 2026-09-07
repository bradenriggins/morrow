import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleActivityLifecycleInPage } from "../../connector/extension/src/moodle-activity-lifecycle-executor.js";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../..", import.meta.url);
const operations = Object.freeze({
  duplicate: { key: "moodle.ajax.core_courseformat_update_course.cm_duplicate.v1", toolName: "moodle_duplicate_activity", provider: "moodle", readOnly: false },
  remove: { key: "moodle.ajax.core_courseformat_update_course.cm_delete.v1", toolName: "moodle_delete_activity", provider: "moodle", readOnly: false },
  move: { key: "moodle.ajax.core_courseformat_update_course.cm_move_to_position.v1", toolName: "moodle_move_activity_to_position", provider: "moodle", readOnly: false },
});
const CONTENTS = { key: "moodle.ajax.core_courseformat_get_state.v1", toolName: "moodle_get_contents", provider: "moodle", readOnly: true };
const SESSKEY = "moodle-private-session";
const COURSE_REMOVALS = [
  "The activity and its place in the section",
  "Every file the activity stores, in every one of its file areas",
  "Its grade item, and every grade and feedback stored in that item",
  "Its completion records for every learner",
  "Its calendar events",
  "Its tags, comments and ratings",
  "Its role assignments and permission overrides",
];

test("the activity lifecycle operations are cataloged, routed, and gated by their own approval class", () => {
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, false);
    assert.equal(entry.reviewTool, "moodle_get_contents");
    assert.match(entry.description, /moodle\/course:manageactivities/);
    assert.match(entry.description, /Custom sections and Weekly sections courses only/);
    assert.match(entry.description, /delegates a subsection/);
    assert.match(entry.description, /Browser-fixture proof only; no signed-in Moodle site has run it\./);
    assert.match(entry.documentation, /^https:\/\/github\.com\/moodle\/moodle\/blob\/v5\.2\.2\/public\/course\/format\/classes\/stateactions\.php/);
    assert.equal(Object.hasOwn(entry.inputSchema.properties, "expected_digest"), true);
  }

  // Deletion is the one operation here that cannot be undone, and it says so.
  const removal = byTool.get("moodle_delete_activity");
  assert.equal(removal.destructive, true);
  assert.equal(removal.irreversible, true);
  assert.match(removal.description, /Morrow cannot undo it/);
  assert.match(removal.description, /Question bank activity/);
  for (const toolName of ["moodle_duplicate_activity", "moodle_move_activity_to_position"]) {
    assert.equal(byTool.get(toolName).destructive, undefined);
    assert.equal(byTool.get(toolName).irreversible, undefined);
  }
  const copy = byTool.get("moodle_duplicate_activity");
  assert.match(copy.description, /every file it stores/);
  assert.match(copy.description, /does not hold learner submissions, attempts, responses, or grades/);
  assert.match(copy.description, /visible to learners as soon as it is created/);
  assert.match(byTool.get("moodle_move_activity_to_position").inputSchema.properties.position.description, /counting from 1/);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleActivityLifecycleInPage \} from "\.\/moodle-activity-lifecycle-executor\.js";/);
  assert.match(worker, /MOODLE_ACTIVITY_LIFECYCLE_OPERATION_KEYS = new Set\(\[/);
  assert.match(worker, /func: executeMoodleActivityLifecycleInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }

  // A deletion is never a standing Edit grant; each one is reviewed on its own.
  const actions = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const action = (toolName) => actions.find((entry) => entry.id === `action:moodle:${toolName}`);
  assert.equal(action("moodle_delete_activity").availability, "review");
  assert.match(action("moodle_delete_activity").reviewReason, /Morrow cannot undo it/);
  assert.equal(action("moodle_delete_activity").tier, "destructive");
  assert.equal(action("moodle_delete_activity").group, "Moodle · Course lifecycle");
  // A review action is published without a rule, so no Edit grant can carry it.
  assert.equal(action("moodle_delete_activity").rules, undefined);
  for (const toolName of ["moodle_duplicate_activity", "moodle_move_activity_to_position"]) {
    assert.equal(action(toolName).availability, "edit", toolName);
    assert.equal(action(toolName).group, "Moodle · Activity", toolName);
    assert.equal(action(toolName).tier, "standard", toolName);
  }
});

test("one activity is copied, removed, or placed exactly, against the complete course state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-activity-lifecycle-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const requests = [];
  const updates = [];
  let origin = "";
  let browser;
  let model;

  const activity = (values) => ({
    visible: true, stealth: false, hasdelegatedsection: false, uservisible: true, accessvisible: true,
    hascmrestrictions: false, allowstealth: true, indent: 0, ...values,
  });
  const initialModel = () => ({
    format: "topics",
    formatFrozen: false,
    courseFormReadable: true,
    formatAfterUpdate: "",
    formUnreadableAfterUpdate: false,
    deleteInstead: "",
    copyVisible: null,
    renameDuringUpdate: "",
    nextId: 90,
    course: { id: 2, fullname: "Foundations of Care", statekey: "state-key-never-crosses-the-bridge" },
    section: [
      { id: "7", number: 4, title: "Week 4: Evidence", visible: true, hasrestrictions: false, component: "", cmlist: ["51", "52", "53", "56"] },
      { id: "8", number: 5, title: "Week 5: Synthesis", visible: true, hasrestrictions: false, component: null, cmlist: ["54", "57", "58"] },
      { id: "9", number: 6, title: "Week 6: Not yet released", visible: false, hasrestrictions: false, component: "", cmlist: [] },
      { id: "10", number: 7, title: "Delegated subsection", visible: true, hasrestrictions: false, component: "mod_subsection", cmlist: ["55"] },
    ],
    cm: [
      activity({ id: "51", module: "page", sectionid: "7", sectionnumber: 4, name: "Reading notes" }),
      activity({ id: "52", module: "assign", sectionid: "7", sectionnumber: 4, name: "Evidence log" }),
      activity({ id: "53", module: "quiz", sectionid: "7", sectionnumber: 4, name: "Week 4 check" }),
      activity({ id: "54", module: "url", sectionid: "8", sectionnumber: 5, name: "Further reading" }),
      activity({ id: "55", module: "page", sectionid: "10", sectionnumber: 7, name: "Inside the subsection" }),
      activity({ id: "56", module: "subsection", sectionid: "7", sectionnumber: 4, name: "Delegated subsection", hasdelegatedsection: true }),
      activity({ id: "57", module: "customcert", sectionid: "8", sectionnumber: 5, name: "Course certificate" }),
      activity({ id: "58", module: "qbank", sectionid: "8", sectionnumber: 5, name: "Shared question bank" }),
    ],
  });
  const stateBody = () => JSON.stringify([{
    data: JSON.stringify({
      course: model.course,
      section: model.section.map((entry) => ({ ...entry })),
      cm: model.cm.map((entry) => ({ ...entry })),
    }),
  }]);
  const sectionOf = (cm) => model.section.find((entry) => entry.id === cm.sectionid);
  const applyUpdate = (args) => {
    const cm = model.cm.find((entry) => entry.id === String(args.ids[0]));
    if (!cm) return;
    if (args.action === "cm_move") {
      const destination = model.section.find((entry) => entry.id === String(args.targetsectionid));
      const source = sectionOf(cm);
      source.cmlist = source.cmlist.filter((entry) => entry !== cm.id);
      const before = args.targetcmid === null ? -1 : destination.cmlist.indexOf(String(args.targetcmid));
      if (before < 0) destination.cmlist.push(cm.id);
      else destination.cmlist.splice(before, 0, cm.id);
      cm.sectionid = destination.id;
      cm.sectionnumber = destination.number;
      return;
    }
    if (args.action === "cm_duplicate") {
      const source = sectionOf(cm);
      const copy = { ...cm, id: String(model.nextId += 1), name: `${cm.name} (copy)` };
      if (model.copyVisible !== null) copy.visible = model.copyVisible;
      model.cm.push(copy);
      source.cmlist.splice(source.cmlist.indexOf(cm.id) + 1, 0, copy.id);
      return;
    }
    // Moodle takes the activity out of the course state at once.
    const removed = model.deleteInstead ? model.cm.find((entry) => entry.id === model.deleteInstead) : cm;
    const source = sectionOf(removed);
    source.cmlist = source.cmlist.filter((entry) => entry !== removed.id);
    model.cm = model.cm.filter((entry) => entry.id !== removed.id);
  };
  const courseForm = () => {
    const format = model.formatFrozen
      ? `<input type="hidden" name="format" value="${model.format}">`
      : `<select name="format" id="id_format">${["topics", "weeks", "singleactivity", "tiles"].map((entry) => `<option value="${entry}"${entry === model.format ? " selected" : ""}>${entry}</option>`).join("")}</select>`;
    return `<!doctype html><html><body class="path-course course-2"><form method="post" action="/course/edit.php"><input type="hidden" name="id" value="2"><input name="fullname" value="Foundations of Care">${format}<input type="hidden" name="visible" value="1"><input type="hidden" name="sesskey" value="${SESSKEY}"><input type="submit" name="saveanddisplay" value="Save"></form></body></html>`;
  };

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (request.method === "GET" && target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><h1>Foundations of Care</h1><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/edit.php") {
      if (!model.courseFormReadable || target.searchParams.get("id") !== "2") {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(courseForm());
      return;
    }
    if (request.method === "POST" && target.pathname === "/lib/ajax/service.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"))[0];
      assert.equal(target.searchParams.get("sesskey"), SESSKEY);
      assert.equal(target.searchParams.get("info"), call.methodname);
      if (call.methodname === "core_courseformat_get_state") {
        assert.equal(call.args.courseid, 2);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(stateBody());
        return;
      }
      if (call.methodname === "core_courseformat_update_course") {
        updates.push(call.args);
        applyUpdate(call.args);
        if (model.renameDuringUpdate) model.cm.find((entry) => entry.id === model.renameDuringUpdate).name = "Renamed by something else";
        if (model.formatAfterUpdate) model.format = model.formatAfterUpdate;
        if (model.formUnreadableAfterUpdate) model.courseFormReadable = false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ data: null }]));
        return;
      }
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
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const execute = (operation, argumentsValue, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleActivityLifecycleInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt }),
    );
    // The digest every one of these writes requires is the digest the person
    // reviewed, produced by the catalog read itself.
    const reviewed = () => page.evaluate(
      executeMoodleInPage,
      JSON.stringify({ mode: "execute", operation: CONTENTS, arguments: { course_id: 2 }, binding, expiresAt: Date.now() + 60_000 }),
    );
    const reviewedDigest = async () => {
      const read = await reviewed();
      assert.equal(read.ok, true, JSON.stringify(read));
      return read.snapshot_digest;
    };
    const cmlist = (result, sectionId) => result.data.sections.find((entry) => entry.id === sectionId).cmlist;
    const loseNextUpdateResponse = () => page.evaluate(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (...parameters) => {
        const response = await nativeFetch(...parameters);
        const target = new URL(String(parameters[0]), globalThis.location.href);
        if (String(parameters[1]?.method || "GET").toUpperCase() === "POST" && target.searchParams.get("info") === "core_courseformat_update_course") {
          globalThis.fetch = nativeFetch;
          throw new TypeError("update response lost after dispatch");
        }
        return response;
      };
    });

    const digest = await reviewedDigest();
    assert.match(digest, /^[a-f0-9]{64}$/);

    // Every refusal below happens before any native action is sent.
    const refuse = async (operation, argumentsValue, error, expiresAt) => {
      const before = updates.length;
      const result = await execute(operation, argumentsValue, expiresAt);
      assert.deepEqual([result.ok, result.sent, result.error], [false, false, error], JSON.stringify(result));
      assert.equal(updates.length, before, `${operation.toolName} sent a native action while refusing ${error}`);
    };
    const move = (values) => ({ course_id: 2, module_id: 51, target_section_id: 7, position: 1, expected_digest: digest, ...values });

    await refuse(operations.move, move({ position: 0 }), "moodle_activity_lifecycle_arguments_invalid");
    await refuse(operations.move, move({ position: "2" }), "moodle_activity_lifecycle_arguments_invalid");
    await refuse(operations.move, { course_id: 2, module_id: 51, target_section_id: 7, expected_digest: digest }, "moodle_activity_lifecycle_arguments_invalid");
    await refuse(operations.move, move({ course_id: 3 }), "moodle_activity_lifecycle_arguments_invalid");
    await refuse(operations.remove, { course_id: 2, module_id: 51, position: 1, expected_digest: digest }, "moodle_activity_lifecycle_arguments_invalid");
    await refuse(operations.remove, { course_id: 2, module_id: 51, expected_digest: "0".repeat(64) }, "moodle_expected_digest_mismatch");
    await refuse(operations.duplicate, { course_id: 2, module_id: 51, expected_digest: digest }, "moodle_execution_expired", Date.now() - 1);

    // An activity that delegates a subsection, and an activity inside a section
    // Moodle owns, are refused for all three operations.
    for (const [operation, argumentsValue] of [
      [operations.remove, { course_id: 2, module_id: 56, expected_digest: digest }],
      [operations.duplicate, { course_id: 2, module_id: 56, expected_digest: digest }],
      [operations.move, move({ module_id: 56, target_section_id: 8, position: 1 })],
      [operations.remove, { course_id: 2, module_id: 55, expected_digest: digest }],
      [operations.duplicate, { course_id: 2, module_id: 55, expected_digest: digest }],
      [operations.move, move({ module_id: 55, target_section_id: 8, position: 1 })],
    ]) {
      await refuse(operation, argumentsValue, "moodle_activity_lifecycle_delegated_refused");
    }

    // A module type whose removed records Morrow cannot name, and a Question
    // bank activity, are refused before the first native action.
    await refuse(operations.remove, { course_id: 2, module_id: 57, expected_digest: digest }, "moodle_delete_activity_records_not_enumerated");
    await refuse(operations.remove, { course_id: 2, module_id: 58, expected_digest: digest }, "moodle_delete_activity_question_bank_refused");
    // The same module types can still be copied and placed.
    await refuse(operations.move, move({ module_id: 57, target_section_id: 9, position: 1 }), "moodle_activity_lifecycle_precondition_refused");

    await refuse(operations.move, move({ module_id: 999 }), "moodle_activity_lifecycle_precondition_refused");
    await refuse(operations.move, move({ target_section_id: 999 }), "moodle_activity_lifecycle_precondition_refused");
    await refuse(operations.move, move({ target_section_id: 10, position: 1 }), "moodle_activity_lifecycle_precondition_refused");
    await refuse(operations.move, move({ position: 5 }), "moodle_activity_position_out_of_range");
    await refuse(operations.move, move({ position: 1 }), "moodle_activity_position_unchanged");
    await refuse(operations.move, move({ module_id: 53, position: 3 }), "moodle_activity_position_unchanged");

    // A course format this contract does not cover, and a course settings form
    // that cannot be read, both stop before the course state is read.
    model.format = "tiles";
    await refuse(operations.remove, { course_id: 2, module_id: 51, expected_digest: digest }, "moodle_activity_lifecycle_course_format_unverified");
    model.format = "topics";
    model.courseFormReadable = false;
    await refuse(operations.remove, { course_id: 2, module_id: 51, expected_digest: digest }, "moodle_activity_lifecycle_course_format_unverified");
    model.courseFormReadable = true;

    // One dispatch places the activity exactly, and the complete course state
    // comes back with that order and nothing else changed.
    const placed = await execute(operations.move, move({ module_id: 51, target_section_id: 7, position: 3 }));
    assert.equal(placed.ok, true, JSON.stringify(placed));
    assert.deepEqual(placed.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(cmlist(placed, "7"), ["52", "53", "51", "56"]);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { action: "cm_move", courseid: 2, ids: [51], targetsectionid: 7, targetcmid: 56 });
    assert.equal(placed.snapshot_digest, await reviewedDigest());
    assert.deepEqual(placed.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "module_id", label: "Activity", name: "Reading notes" },
      { field: "target_section_id", label: "Destination section", name: "Week 4: Evidence" },
    ]);
    assert.deepEqual(placed.proof, {
      method: "native_course_state_action",
      action: "cm_move",
      route: "/lib/ajax/service.php",
      required_capability: "moodle/course:manageactivities",
      scope: "one_activity_in_the_approved_course",
      reversible_by_morrow: false,
    });
    assert.equal(JSON.stringify(placed).includes(SESSKEY), false);
    assert.equal(JSON.stringify(placed).includes("statekey"), false);

    // The last place in a section is the one native move with no target activity.
    model = initialModel();
    updates.length = 0;
    const last = await execute(operations.move, move({ module_id: 51, target_section_id: 8, position: 4, expected_digest: await reviewedDigest() }));
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.deepEqual(cmlist(last, "8"), ["54", "57", "58", "51"]);
    assert.deepEqual(cmlist(last, "7"), ["52", "53", "56"]);
    assert.equal(last.data.activities.find((entry) => entry.id === "51").sectionnumber, 5);
    assert.deepEqual(updates, [{ action: "cm_move", courseid: 2, ids: [51], targetsectionid: 8, targetcmid: null }]);

    // A place between two activities of another section names that exact activity.
    model = initialModel();
    updates.length = 0;
    const between = await execute(operations.move, move({ module_id: 51, target_section_id: 8, position: 2, expected_digest: await reviewedDigest() }));
    assert.equal(between.ok, true, JSON.stringify(between));
    assert.deepEqual(cmlist(between, "8"), ["54", "51", "57", "58"]);
    assert.deepEqual(updates, [{ action: "cm_move", courseid: 2, ids: [51], targetsectionid: 8, targetcmid: 57 }]);

    // One copy, in the same section, immediately after the original.
    model = initialModel();
    updates.length = 0;
    const copied = await execute(operations.duplicate, { course_id: 2, module_id: 52, expected_digest: await reviewedDigest() });
    assert.equal(copied.ok, true, JSON.stringify(copied));
    assert.deepEqual(copied.copy, { module_id: 91, name: "Evidence log (copy)" });
    assert.deepEqual(cmlist(copied, "7"), ["51", "52", "91", "53", "56"]);
    const madeCopy = copied.data.activities.find((entry) => entry.id === "91");
    assert.deepEqual([madeCopy.module, madeCopy.sectionid, madeCopy.visible, madeCopy.name], ["assign", "7", true, "Evidence log (copy)"]);
    assert.deepEqual(updates, [{ action: "cm_duplicate", courseid: 2, ids: [52], targetsectionid: null, targetcmid: null }]);
    assert.deepEqual(copied.proof, {
      method: "native_course_state_action",
      action: "cm_duplicate",
      route: "/lib/ajax/service.php",
      required_capability: "moodle/course:manageactivities with moodle/backup:backuptargetimport and moodle/restore:restoretargetimport",
      scope: "one_activity_in_the_approved_course",
      reversible_by_morrow: false,
      copies: [
        "The activity's settings and content",
        "Every file the activity stores, in every one of its file areas",
        "Its access restrictions and completion settings",
      ],
      learner_work_copied: false,
    });

    // A copy that does not carry the original's visibility is not the approved
    // change, so the result is applied_or_unknown.
    model = initialModel();
    model.copyVisible = false;
    updates.length = 0;
    const wrongCopy = await execute(operations.duplicate, { course_id: 2, module_id: 52, expected_digest: await reviewedDigest() });
    assert.deepEqual([wrongCopy.ok, wrongCopy.sent, wrongCopy.outcomeUnknown, wrongCopy.error], [false, true, true, "moodle_activity_lifecycle_write_not_verified"]);
    assert.deepEqual(wrongCopy.verification, { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_activity_lifecycle_write_not_verified" });
    assert.equal(updates.length, 1);
    assert.equal(wrongCopy.data.activities.find((entry) => entry.id === "91").visible, false);

    // One deletion, with the exact list of what it removed in the result.
    model = initialModel();
    updates.length = 0;
    const removed = await execute(operations.remove, { course_id: 2, module_id: 52, expected_digest: await reviewedDigest() });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.deepEqual(removed.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(cmlist(removed, "7"), ["51", "53", "56"]);
    assert.equal(removed.data.activities.some((entry) => entry.id === "52"), false);
    assert.equal(removed.data.activities.length, 7);
    assert.deepEqual(updates, [{ action: "cm_delete", courseid: 2, ids: [52], targetsectionid: null, targetcmid: null }]);
    assert.deepEqual(removed.proof.removes, [
      ...COURSE_REMOVALS,
      "Every learner submission and every submitted file",
      "Every grade, feedback comment and feedback file",
      "Extensions, marking workflow states and marking allocations",
      "User and group overrides",
    ]);
    assert.equal(removed.proof.learner_records_removed, true);
    assert.equal(removed.proof.reversible_by_morrow, false);
    assert.deepEqual(removed.targets.map((entry) => entry.name), ["Foundations of Care", "Evidence log", "Week 4: Evidence"]);

    // Each module type states its own removed records.
    model = initialModel();
    updates.length = 0;
    const removedQuiz = await execute(operations.remove, { course_id: 2, module_id: 53, expected_digest: await reviewedDigest() });
    assert.equal(removedQuiz.ok, true, JSON.stringify(removedQuiz));
    assert.deepEqual(removedQuiz.proof.removes.slice(COURSE_REMOVALS.length), [
      "Every learner attempt and the responses in it",
      "Quiz grades and the grade history",
      "User and group overrides",
      "The Quiz's own question slots. The questions themselves stay in their Question bank",
    ]);

    // A saved state that is not the approved one is applied_or_unknown, and the
    // result carries the state Moodle actually holds.
    model = initialModel();
    model.deleteInstead = "51";
    updates.length = 0;
    const drifted = await execute(operations.remove, { course_id: 2, module_id: 52, expected_digest: await reviewedDigest() });
    assert.deepEqual([drifted.ok, drifted.sent, drifted.outcomeUnknown, drifted.error], [false, true, true, "moodle_activity_lifecycle_write_not_verified"]);
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_activity_lifecycle_write_not_verified" });
    assert.equal(updates.length, 1);
    assert.deepEqual(cmlist(drifted, "7"), ["52", "53", "56"]);

    // A change to any other part of the course, made while the approved change
    // was applied, is not the approved state either.
    model = initialModel();
    model.renameDuringUpdate = "54";
    updates.length = 0;
    const alsoChanged = await execute(operations.move, move({ module_id: 51, target_section_id: 7, position: 3, expected_digest: await reviewedDigest() }));
    assert.deepEqual([alsoChanged.ok, alsoChanged.sent, alsoChanged.outcomeUnknown, alsoChanged.error], [false, true, true, "moodle_activity_lifecycle_write_not_verified"]);
    assert.equal(updates.length, 1);
    assert.deepEqual(cmlist(alsoChanged, "7"), ["52", "53", "51", "56"]);
    assert.equal(alsoChanged.data.activities.find((entry) => entry.id === "54").name, "Renamed by something else");

    // A lost response after one dispatch is applied_or_unknown, and nothing is
    // sent a second time.
    model = initialModel();
    updates.length = 0;
    const lostDigest = await reviewedDigest();
    await loseNextUpdateResponse();
    const lost = await execute(operations.remove, { course_id: 2, module_id: 52, expected_digest: lostDigest });
    assert.deepEqual(lost, {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_activity_lifecycle_write_unconfirmed" },
      error: "moodle_activity_lifecycle_write_unconfirmed",
    });
    assert.equal(updates.length, 1);
    assert.equal(model.cm.some((entry) => entry.id === "52"), false);

    // A course format that changes under the action, and a course settings form
    // that stops answering after it, are both unconfirmed rather than verified.
    model = initialModel();
    model.formatAfterUpdate = "weeks";
    updates.length = 0;
    const changedFormat = await execute(operations.remove, { course_id: 2, module_id: 52, expected_digest: await reviewedDigest() });
    assert.deepEqual([changedFormat.ok, changedFormat.sent, changedFormat.outcomeUnknown, changedFormat.error], [false, true, true, "moodle_activity_lifecycle_readback_unconfirmed"]);
    assert.equal(updates.length, 1);

    model = initialModel();
    model.formUnreadableAfterUpdate = true;
    updates.length = 0;
    const unreadable = await execute(operations.remove, { course_id: 2, module_id: 52, expected_digest: await reviewedDigest() });
    assert.deepEqual([unreadable.ok, unreadable.sent, unreadable.outcomeUnknown, unreadable.error], [false, true, true, "moodle_activity_lifecycle_readback_unconfirmed"]);
    assert.equal(updates.length, 1);
    model.courseFormReadable = true;

    // A frozen course format control is read the same way as the select.
    model = initialModel();
    model.formatFrozen = true;
    updates.length = 0;
    const frozen = await execute(operations.move, move({ module_id: 51, target_section_id: 7, position: 2, expected_digest: await reviewedDigest() }));
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    assert.deepEqual(cmlist(frozen, "7"), ["52", "51", "53", "56"]);
    assert.equal(updates.length, 1);

    // A replay of an approved change against the state it already produced is
    // refused, because the reviewed digest no longer describes the course.
    const replay = await execute(operations.move, move({ module_id: 51, target_section_id: 7, position: 2, expected_digest: frozen.snapshot_digest }));
    assert.deepEqual([replay.ok, replay.sent, replay.error], [false, false, "moodle_activity_position_unchanged"]);
    assert.equal(updates.length, 1);

    // No activity view, module settings form, or other native route is opened
    // by any of these operations.
    assert.deepEqual(requests.filter((entry) => /\/mod\//.test(entry.pathname)), []);
    assert.deepEqual(requests.filter((entry) => entry.pathname === "/course/modedit.php"), []);
    assert.deepEqual(requests.filter((entry) => entry.method === "POST" && entry.pathname !== "/lib/ajax/service.php"), []);
    // The browser's own favicon request for the fixture page is not a route
    // this executor opens.
    assert.deepEqual([...new Set(requests.filter((entry) => entry.pathname !== "/favicon.ico").map((entry) => `${entry.method} ${entry.pathname}`))].sort(), [
      "GET /course/edit.php",
      "GET /course/view.php",
      "POST /lib/ajax/service.php",
    ]);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
