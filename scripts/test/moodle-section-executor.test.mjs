import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleSectionInPage } from "../../connector/extension/src/moodle-section-executor.js";
import { executeMoodleInPage } from "../../connector/extension/src/moodle-executor.js";
import { categoriesForBinding } from "../../connector/extension/src/edit-policy.js";

const root = new URL("../..", import.meta.url);
const operations = Object.freeze({
  create: { key: "moodle.ajax.core_courseformat_update_course.section_add.v1", toolName: "moodle_create_section", provider: "moodle", readOnly: false },
  remove: { key: "moodle.ajax.core_courseformat_update_course.section_delete.v1", toolName: "moodle_delete_section", provider: "moodle", readOnly: false },
  move: { key: "moodle.ajax.core_courseformat_update_course.section_move_after.v1", toolName: "moodle_move_section", provider: "moodle", readOnly: false },
});
const CONTENTS = { key: "moodle.ajax.core_courseformat_get_state.v1", toolName: "moodle_get_contents", provider: "moodle", readOnly: true };
// The section's own native settings form, which is where its name, its summary
// and its access restrictions are kept.
const SECTION_FORM = Object.freeze({
  read: { key: "moodle.form.course.editsection.read.v1", toolName: "moodle_get_section", provider: "moodle", readOnly: true },
  write: { key: "moodle.form.course.editsection.write.v1", toolName: "moodle_update_section", provider: "moodle", readOnly: false },
});
const SESSKEY = "moodle-private-session";
const STATE_KEY = "state-key-never-crosses-the-bridge";
const SECTION_REMOVALS = [
  "The section, its name and its summary, with every file stored in that summary",
  "Its access restrictions",
  "Its place in the course. Every later section moves up by one",
];
const ACTIVITY_REMOVALS = [
  "The activity and its place in the section",
  "Every file the activity stores, in every one of its file areas",
  "Its grade item, and every grade and feedback stored in that item",
  "Its completion records for every learner",
  "Its calendar events",
  "Its tags, comments and ratings",
  "Its role assignments and permission overrides",
];

test("the section lifecycle operations are cataloged, routed, and gated by their own approval class", () => {
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  const byTool = new Map(catalog.operations.map((entry) => [entry.toolName, entry]));

  for (const operation of Object.values(operations)) {
    const entry = byTool.get(operation.toolName);
    assert.ok(entry, `${operation.toolName} is missing from the Moodle catalog`);
    assert.equal(entry.key, operation.key);
    assert.equal(entry.provider, "moodle");
    assert.equal(entry.readOnly, false);
    assert.equal(entry.reviewTool, "moodle_get_contents");
    assert.match(entry.description, /Browser-fixture proof only; no signed-in Moodle site has run it\./);
    assert.match(entry.description, /Custom sections and Weekly sections courses only/);
    assert.match(entry.description, /a course that holds a section Moodle itself owns/);
    assert.equal(entry.documentation, "https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/stateactions.php");
    assert.equal(entry.inputSchema.properties.expected_digest.pattern, "^[a-f0-9]{64}$");
  }

  const created = byTool.get("moodle_create_section");
  assert.deepEqual(created.inputSchema.required, ["course_id", "expected_digest"]);
  assert.match(created.description, /at the end of one standard Moodle course/);
  assert.match(created.description, /Requires moodle\/course:update at the course context/);
  assert.match(created.description, /moodle_update_section to give it a name of its own and moodle_move_section to put it somewhere else/);

  // The deletion is the one operation here that cannot be undone, and it says
  // both that and what it takes with the section.
  const removal = byTool.get("moodle_delete_section");
  assert.equal(removal.destructive, true);
  assert.equal(removal.irreversible, true);
  assert.deepEqual(removal.inputSchema.required, ["course_id", "section_id", "expected_digest"]);
  assert.match(removal.description, /Morrow cannot undo it/);
  assert.match(removal.description, /with every activity in it/);
  assert.match(removal.description, /Requires moodle\/course:update and moodle\/course:movesections at the course context/);
  assert.match(removal.description, /lists every activity in the section/);
  assert.match(removal.description, /the General section, which Moodle does not delete/);
  assert.match(removal.description, /a section holding a Question bank activity/);

  const moved = byTool.get("moodle_move_section");
  assert.equal(moved.destructive, undefined);
  assert.equal(moved.irreversible, undefined);
  assert.deepEqual(moved.inputSchema.required, ["course_id", "section_id", "position", "expected_digest"]);
  assert.match(moved.description, /Requires moodle\/course:movesections at the course context/);
  assert.match(moved.description, /renumbers every section between its old and its new place/);
  assert.match(moved.inputSchema.properties.position.description, /counting from 1/);
  assert.equal(byTool.get("moodle_create_section").destructive, undefined);

  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleSectionInPage \} from "\.\/moodle-section-executor\.js";/);
  assert.match(worker, /MOODLE_SECTION_OPERATION_KEYS = new Set\(\[/);
  assert.match(worker, /func: executeMoodleSectionInPage/);
  for (const operation of Object.values(operations)) {
    assert.ok(worker.includes(`"${operation.key}"`), `service-worker.js does not route ${operation.key}`);
  }

  // A section deletion is never a standing Edit grant; each one is reviewed on its own.
  const actions = categoriesForBinding({ provider: "moodle" }, catalog.operations);
  const action = (toolName) => actions.find((entry) => entry.id === `action:moodle:${toolName}`);
  assert.equal(action("moodle_delete_section").availability, "review");
  assert.match(action("moodle_delete_section").reviewReason, /removes every activity in it/);
  assert.match(action("moodle_delete_section").reviewReason, /Morrow cannot undo it/);
  assert.equal(action("moodle_delete_section").tier, "destructive");
  assert.equal(action("moodle_delete_section").group, "Moodle · Course lifecycle");
  assert.equal(action("moodle_delete_section").rules, undefined);
  for (const toolName of ["moodle_create_section", "moodle_move_section"]) {
    assert.equal(action(toolName).availability, "edit", toolName);
    assert.equal(action(toolName).group, "Moodle · Section", toolName);
    assert.equal(action(toolName).tier, "standard", toolName);
  }
});

test("one section is added, removed, or placed exactly, against the complete course state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-section-"));
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
  const section = (values) => ({ visible: true, hasrestrictions: false, component: "", ...values });
  const initialModel = () => ({
    format: "topics",
    formatFrozen: false,
    courseFormReadable: true,
    formatAfterUpdate: "",
    formUnreadableAfterUpdate: false,
    deleteInstead: "",
    renameDuringUpdate: "",
    delegated: false,
    nextId: 20,
    // The section Moodle marks as the current one, by section number.
    marker: 1,
    course: { id: 2, fullname: "Foundations of Care", editmode: true, statekey: STATE_KEY },
    // In course order. Every derived field is rebuilt from that order.
    section: [
      section({ id: "5", rawtitle: "", cmlist: ["50"] }),
      section({ id: "6", rawtitle: "Week 1: Foundations", cmlist: ["51", "52"] }),
      section({ id: "7", rawtitle: "", cmlist: ["53", "56"] }),
      section({ id: "8", rawtitle: "Week 4: Assessment", cmlist: ["54"] }),
      section({ id: "9", rawtitle: "", cmlist: ["55"] }),
      section({ id: "10", rawtitle: "Week 6: Wrap up", cmlist: [] }),
    ],
    cm: [
      activity({ id: "50", module: "page", sectionid: "5", name: "Welcome" }),
      activity({ id: "51", module: "page", sectionid: "6", name: "Reading notes" }),
      activity({ id: "52", module: "assign", sectionid: "6", name: "Evidence log" }),
      activity({ id: "53", module: "quiz", sectionid: "7", name: "Week 3 check" }),
      activity({ id: "54", module: "customcert", sectionid: "8", name: "Course certificate" }),
      activity({ id: "55", module: "qbank", sectionid: "9", name: "Shared question bank" }),
      activity({ id: "56", module: "page", sectionid: "7", name: "Case study" }),
    ],
  });

  // Moodle builds a section's shown title, its current flag, its link and the
  // course's highlighted name from the section's place in the course, so this
  // fixture rebuilds all four whenever the order changes.
  const renumber = () => {
    model.section.forEach((entry, index) => {
      entry.number = index;
      entry.title = entry.rawtitle || (index === 0 ? "General" : `Topic ${index}`);
      entry.current = index === model.marker;
      entry.sectionurl = `/course/view.php?id=2#section-${index}`;
      for (const cm of model.cm) if (cm.sectionid === entry.id) cm.sectionnumber = index;
    });
    if (model.delegated) model.section[model.section.length - 1].component = "mod_subsection";
    model.course.numsections = model.section.length - 1;
    model.course.sectionlist = model.section.map((entry) => Number(entry.id));
    model.course.highlighted = model.section.find((entry) => entry.current)?.title || "";
  };
  const stateBody = () => {
    renumber();
    return JSON.stringify([{
      data: JSON.stringify({
        course: { ...model.course },
        section: model.section.map((entry) => ({ ...entry })),
        cm: model.cm.map((entry) => ({ ...entry })),
      }),
    }]);
  };
  const applyUpdate = (args) => {
    if (args.action === "section_add") {
      model.section.push(section({ id: String(model.nextId += 1), rawtitle: "", cmlist: [] }));
      return;
    }
    if (args.action === "section_delete") {
      const targetId = String(model.deleteInstead || args.ids[0]);
      const removed = model.section.find((entry) => entry.id === targetId);
      if (!removed || removed.number === 0) return;
      model.cm = model.cm.filter((entry) => entry.sectionid !== targetId);
      model.section = model.section.filter((entry) => entry.id !== targetId);
      return;
    }
    const targetId = String(model.deleteInstead || args.ids[0]);
    const moved = model.section.find((entry) => entry.id === targetId);
    const remaining = model.section.filter((entry) => entry.id !== targetId);
    const at = remaining.findIndex((entry) => entry.id === String(args.targetsectionid));
    if (!moved || at < 0) return;
    model.section = [...remaining.slice(0, at + 1), moved, ...remaining.slice(at + 1)];
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
        if (model.renameDuringUpdate) {
          const renamed = model.section.find((entry) => entry.id === model.renameDuringUpdate);
          renamed.rawtitle = "Renamed by something else";
        }
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
      executeMoodleSectionInPage,
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
    const order = (result) => result.data.sections.map((entry) => entry.id);
    const titles = (result) => result.data.sections.map((entry) => entry.title);
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
    const place = (values) => ({ course_id: 2, section_id: 7, position: 1, expected_digest: digest, ...values });

    await refuse(operations.move, place({ position: 0 }), "moodle_section_arguments_invalid");
    await refuse(operations.move, place({ position: "2" }), "moodle_section_arguments_invalid");
    await refuse(operations.move, { course_id: 2, section_id: 7, expected_digest: digest }, "moodle_section_arguments_invalid");
    await refuse(operations.move, place({ course_id: 3 }), "moodle_section_arguments_invalid");
    await refuse(operations.remove, { course_id: 2, section_id: 7, position: 1, expected_digest: digest }, "moodle_section_arguments_invalid");
    await refuse(operations.create, { course_id: 2, section_id: 7, expected_digest: digest }, "moodle_section_arguments_invalid");
    await refuse(operations.remove, { course_id: 2, section_id: 7, expected_digest: "0".repeat(64) }, "moodle_expected_digest_mismatch");
    await refuse(operations.create, { course_id: 2, expected_digest: digest }, "moodle_execution_expired", Date.now() - 1);
    await refuse({ ...operations.create, readOnly: true }, { course_id: 2, expected_digest: digest }, "moodle_operation_refused");

    // The General section is not deleted or moved, and a section this course
    // does not hold is not a target.
    await refuse(operations.remove, { course_id: 2, section_id: 5, expected_digest: digest }, "moodle_section_general_refused");
    await refuse(operations.move, place({ section_id: 5 }), "moodle_section_general_refused");
    await refuse(operations.remove, { course_id: 2, section_id: 99, expected_digest: digest }, "moodle_section_precondition_refused");
    await refuse(operations.move, place({ section_id: 99 }), "moodle_section_precondition_refused");

    // A place that is not a place in the course order, and a place that leaves
    // the order as it is, are both refused before anything is sent.
    await refuse(operations.move, place({ section_id: 7, position: 6 }), "moodle_section_position_out_of_range");
    await refuse(operations.move, place({ section_id: 7, position: 2 }), "moodle_section_position_unchanged");

    // A section holding a module type whose removed records Morrow cannot name,
    // and a section holding a Question bank, are refused before the first action.
    await refuse(operations.remove, { course_id: 2, section_id: 8, expected_digest: digest }, "moodle_delete_section_records_not_enumerated");
    await refuse(operations.remove, { course_id: 2, section_id: 9, expected_digest: digest }, "moodle_delete_section_question_bank_refused");

    // A course that holds a section Moodle itself owns is refused for all three
    // operations, because renumbering it would move a subtree Morrow has not read.
    model.delegated = true;
    const delegatedDigest = await reviewedDigest();
    for (const [operation, argumentsValue] of [
      [operations.create, { course_id: 2, expected_digest: delegatedDigest }],
      [operations.remove, { course_id: 2, section_id: 7, expected_digest: delegatedDigest }],
      [operations.move, { course_id: 2, section_id: 7, position: 1, expected_digest: delegatedDigest }],
    ]) {
      await refuse(operation, argumentsValue, "moodle_section_delegated_refused");
    }
    model = initialModel();

    // A course format this contract does not cover, and a course settings form
    // that cannot be read, both stop before the course state is read.
    model.format = "tiles";
    await refuse(operations.create, { course_id: 2, expected_digest: digest }, "moodle_section_course_format_unverified");
    model.format = "topics";
    model.courseFormReadable = false;
    await refuse(operations.create, { course_id: 2, expected_digest: digest }, "moodle_section_course_format_unverified");
    model.courseFormReadable = true;

    // One dispatch adds one empty section at the end, and nothing already in
    // the course changes place.
    updates.length = 0;
    const added = await execute(operations.create, { course_id: 2, expected_digest: await reviewedDigest() });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual(added.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(updates, [{ action: "section_add", courseid: 2, ids: [], targetsectionid: null, targetcmid: null }]);
    assert.deepEqual(added.section, { section_id: 21, name: "Topic 6", number: 6 });
    assert.deepEqual(order(added), ["5", "6", "7", "8", "9", "10", "21"]);
    assert.deepEqual(added.data.sections.at(-1).cmlist, []);
    assert.equal(added.data.sections.at(-1).visible, true);
    assert.equal(added.data.course.numsections, 6);
    assert.equal(added.snapshot_digest, await reviewedDigest());
    assert.deepEqual(added.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "section_id", label: "New section", name: "Topic 6" },
    ]);
    assert.deepEqual(added.proof, {
      method: "native_course_state_action",
      action: "section_add",
      route: "/lib/ajax/service.php",
      required_capability: "moodle/course:update",
      scope: "one_section_in_the_approved_course",
      reversible_by_morrow: false,
    });
    // Neither the session key nor the state key crosses the bridge.
    assert.equal(JSON.stringify(added).includes(SESSKEY), false);
    assert.equal(JSON.stringify(added).includes(STATE_KEY), false);
    assert.equal(JSON.stringify(added).includes("statekey"), false);

    // One dispatch places the section exactly. Moodle is told the section the
    // moved one must follow, and the complete course state comes back with that
    // order, the sections between renumbered, and nothing else changed.
    model = initialModel();
    updates.length = 0;
    const placed = await execute(operations.move, { course_id: 2, section_id: 6, position: 3, expected_digest: await reviewedDigest() });
    assert.equal(placed.ok, true, JSON.stringify(placed));
    assert.deepEqual(updates, [{ action: "section_move_after", courseid: 2, ids: [6], targetsectionid: 8, targetcmid: null }]);
    assert.deepEqual(order(placed), ["5", "7", "8", "6", "9", "10"]);
    assert.deepEqual(placed.data.sections.map((entry) => entry.number), [0, 1, 2, 3, 4, 5]);
    // The one section with a name of its own keeps it; the unnamed sections
    // carry the title Moodle builds from their new place.
    assert.deepEqual(titles(placed), ["General", "Topic 1", "Week 4: Assessment", "Week 1: Foundations", "Topic 4", "Week 6: Wrap up"]);
    assert.deepEqual(placed.data.activities.filter((entry) => entry.sectionid === "6").map((entry) => entry.sectionnumber), [3, 3]);
    assert.deepEqual(placed.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "section_id", label: "Section", name: "Week 1: Foundations" },
      { field: "position", label: "After section", name: "Week 4: Assessment" },
    ]);
    assert.deepEqual(placed.proof, {
      method: "native_course_state_action",
      action: "section_move_after",
      route: "/lib/ajax/service.php",
      required_capability: "moodle/course:movesections",
      scope: "one_section_in_the_approved_course",
      reversible_by_morrow: false,
      sections_renumbered: 3,
    });
    assert.equal(placed.snapshot_digest, await reviewedDigest());

    // The first place after the General section is the one place that names it
    // as the section to follow.
    model = initialModel();
    updates.length = 0;
    const first = await execute(operations.move, { course_id: 2, section_id: 8, position: 1, expected_digest: await reviewedDigest() });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(updates, [{ action: "section_move_after", courseid: 2, ids: [8], targetsectionid: 5, targetcmid: null }]);
    assert.deepEqual(order(first), ["5", "8", "6", "7", "9", "10"]);

    // The last place in the course order is the last section it can follow.
    model = initialModel();
    updates.length = 0;
    const last = await execute(operations.move, { course_id: 2, section_id: 6, position: 5, expected_digest: await reviewedDigest() });
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.deepEqual(updates, [{ action: "section_move_after", courseid: 2, ids: [6], targetsectionid: 10, targetcmid: null }]);
    assert.deepEqual(order(last), ["5", "7", "8", "9", "10", "6"]);

    // One deletion, with every activity it removes named in the result.
    model = initialModel();
    updates.length = 0;
    const removed = await execute(operations.remove, { course_id: 2, section_id: 7, expected_digest: await reviewedDigest() });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.deepEqual(removed.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.deepEqual(updates, [{ action: "section_delete", courseid: 2, ids: [7], targetsectionid: null, targetcmid: null }]);
    assert.deepEqual(order(removed), ["5", "6", "8", "9", "10"]);
    assert.deepEqual(removed.data.activities.map((entry) => entry.id), ["50", "51", "52", "54", "55"]);
    assert.deepEqual(titles(removed), ["General", "Week 1: Foundations", "Week 4: Assessment", "Topic 3", "Week 6: Wrap up"]);
    assert.deepEqual(removed.proof.removes, SECTION_REMOVALS);
    assert.deepEqual(removed.proof.activity_removals, ACTIVITY_REMOVALS);
    assert.deepEqual(removed.proof.activities_removed, [
      {
        module_id: 53,
        name: "Week 3 check",
        module: "quiz",
        removes: [
          "Every learner attempt and the responses in it",
          "Quiz grades and the grade history",
          "User and group overrides",
          "The Quiz's own question slots. The questions themselves stay in their Question bank",
        ],
      },
      { module_id: 56, name: "Case study", module: "page", removes: [] },
    ]);
    assert.equal(removed.proof.learner_records_removed, true);
    assert.equal(removed.proof.reversible_by_morrow, false);
    assert.equal(removed.proof.required_capability, "moodle/course:update with moodle/course:movesections");
    assert.deepEqual(removed.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "section_id", label: "Section", name: "Topic 2" },
    ]);

    // A section with no activities in it removes no learner record, and says so.
    model = initialModel();
    updates.length = 0;
    const emptied = await execute(operations.remove, { course_id: 2, section_id: 10, expected_digest: await reviewedDigest() });
    assert.equal(emptied.ok, true, JSON.stringify(emptied));
    assert.deepEqual(emptied.proof.activities_removed, []);
    assert.equal(emptied.proof.learner_records_removed, false);
    assert.equal(emptied.proof.sections_renumbered, 0);
    assert.deepEqual(order(emptied), ["5", "6", "7", "8", "9"]);

    // A saved state that is not the approved one is applied_or_unknown, and the
    // result carries the state Moodle actually holds.
    model = initialModel();
    model.deleteInstead = "10";
    updates.length = 0;
    const drifted = await execute(operations.remove, { course_id: 2, section_id: 7, expected_digest: await reviewedDigest() });
    assert.deepEqual([drifted.ok, drifted.sent, drifted.outcomeUnknown, drifted.error], [false, true, true, "moodle_section_write_not_verified"]);
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_section_write_not_verified" });
    assert.equal(updates.length, 1);
    assert.deepEqual(order(drifted), ["5", "6", "7", "8", "9"]);

    // A name given to another section while the approved change was applied is
    // not the approved state either. Morrow does not require the title Moodle
    // builds from a place, and it does require every stored name.
    model = initialModel();
    model.renameDuringUpdate = "9";
    updates.length = 0;
    const alsoChanged = await execute(operations.move, { course_id: 2, section_id: 6, position: 3, expected_digest: await reviewedDigest() });
    assert.deepEqual([alsoChanged.ok, alsoChanged.sent, alsoChanged.outcomeUnknown, alsoChanged.error], [false, true, true, "moodle_section_write_not_verified"]);
    assert.equal(updates.length, 1);
    assert.deepEqual(order(alsoChanged), ["5", "7", "8", "6", "9", "10"]);

    // A lost response after one dispatch is applied_or_unknown, and nothing is
    // sent a second time.
    model = initialModel();
    updates.length = 0;
    const lostDigest = await reviewedDigest();
    await loseNextUpdateResponse();
    const lost = await execute(operations.remove, { course_id: 2, section_id: 7, expected_digest: lostDigest });
    assert.deepEqual(lost, {
      ok: false,
      sent: true,
      outcomeUnknown: true,
      verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_section_write_unconfirmed" },
      error: "moodle_section_write_unconfirmed",
    });
    assert.equal(updates.length, 1);
    assert.equal(model.section.some((entry) => entry.id === "7"), false);

    // A course format that changes under the action, and a course settings form
    // that stops answering after it, are both unconfirmed rather than verified.
    model = initialModel();
    model.formatAfterUpdate = "weeks";
    updates.length = 0;
    const changedFormat = await execute(operations.create, { course_id: 2, expected_digest: await reviewedDigest() });
    assert.deepEqual([changedFormat.ok, changedFormat.sent, changedFormat.outcomeUnknown, changedFormat.error], [false, true, true, "moodle_section_readback_unconfirmed"]);
    assert.equal(updates.length, 1);

    model = initialModel();
    model.formUnreadableAfterUpdate = true;
    updates.length = 0;
    const unreadable = await execute(operations.create, { course_id: 2, expected_digest: await reviewedDigest() });
    assert.deepEqual([unreadable.ok, unreadable.sent, unreadable.outcomeUnknown, unreadable.error], [false, true, true, "moodle_section_readback_unconfirmed"]);
    assert.equal(updates.length, 1);
    model.courseFormReadable = true;

    // A frozen course format control is read the same way as the select.
    model = initialModel();
    model.formatFrozen = true;
    updates.length = 0;
    const frozen = await execute(operations.move, { course_id: 2, section_id: 6, position: 2, expected_digest: await reviewedDigest() });
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    assert.deepEqual(order(frozen), ["5", "7", "6", "8", "9", "10"]);
    assert.equal(updates.length, 1);

    // A replay of an approved change against the state it already produced is
    // refused, because the reviewed digest no longer describes the course.
    const replay = await execute(operations.move, { course_id: 2, section_id: 6, position: 2, expected_digest: frozen.snapshot_digest });
    assert.deepEqual([replay.ok, replay.sent, replay.error], [false, false, "moodle_section_position_unchanged"]);
    const staleReplay = await execute(operations.remove, { course_id: 2, section_id: 7, expected_digest: lostDigest });
    assert.deepEqual([staleReplay.ok, staleReplay.sent, staleReplay.error], [false, false, "moodle_expected_digest_mismatch"]);
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

// A section's access restrictions live in one control of the same native form
// moodle_update_section writes: the `availabilityconditionsjson` textarea of
// course/editsection_form.php. Morrow does not write restrictions, so the value
// the section already holds must go back exactly as it came, a restriction that
// changed since the review must stop the write before it is sent, and one that
// changed under the write must leave the result unverified.
// https://github.com/moodle/moodle/blob/v5.2.2/public/course/editsection_form.php
test("a section name and summary change carries the section's access restrictions through unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-section-form-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const RESTRICTIONS = JSON.stringify({ op: "&", c: [{ type: "date", d: ">=", t: 1767225600 }, { type: "group", id: 4 }], showc: [true, false] });
  const OTHER_RESTRICTIONS = JSON.stringify({ op: "&", c: [{ type: "date", d: ">=", t: 1767225600 }], showc: [true] });
  const requests = [];
  const posts = [];
  let origin = "";
  let browser;
  let model;

  const initialModel = () => ({
    name: "Week 3",
    summary: "<p>Evidence week.</p>",
    availability: RESTRICTIONS,
    // The number of the section-form request after which something else changes
    // the section's restrictions, and the restrictions the save itself stores.
    changeAfterRequest: 0,
    changeOnSave: "",
    reads: 0,
  });
  const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const sectionForm = () => `<!doctype html><html><body class="path-course course-2"><form method="post" action="/course/editsection.php?id=7">`
    + `<input type="hidden" name="id" value="7">`
    + `<input type="hidden" name="course" value="2">`
    + `<input type="hidden" name="returnurl" value="/course/view.php?id=2">`
    + `<input type="hidden" name="sesskey" value="${SESSKEY}">`
    + `<input type="hidden" name="_qf__editsection_form" value="1">`
    + `<input type="text" name="name" value="${escape(model.name)}">`
    + `<textarea name="summary_editor[text]">${escape(model.summary)}</textarea>`
    + `<input type="hidden" name="summary_editor[format]" value="1">`
    + `<input type="hidden" name="summary_editor[itemid]" value="912">`
    + `<textarea name="availabilityconditionsjson">${escape(model.availability)}</textarea>`
    + `<input type="submit" name="submitbutton" value="Save changes">`
    + `<input type="submit" name="cancel" value="Cancel">`
    + `</form></body></html>`;

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    if (request.method === "GET" && target.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-2"><h1>Foundations of Care</h1><script>var M = { cfg: ${JSON.stringify({ wwwroot: origin, sesskey: SESSKEY, userId: 3, courseId: 2 })} };</script></body>`);
      return;
    }
    if (request.method === "GET" && target.pathname === "/course/editsection.php") {
      if (target.searchParams.get("id") !== "7") {
        response.writeHead(404).end();
        return;
      }
      const body = sectionForm();
      model.reads += 1;
      if (model.changeAfterRequest && model.reads === model.changeAfterRequest) model.availability = OTHER_RESTRICTIONS;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(body);
      return;
    }
    if (request.method === "POST" && target.pathname === "/repository/draftfiles_ajax.php") {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ filecount: 0, list: [], tree: { children: [] } }));
      return;
    }
    if (request.method === "POST" && target.pathname === "/course/editsection.php") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const values = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      posts.push(values);
      model.name = String(values.get("name") ?? "");
      model.summary = String(values.get("summary_editor[text]") ?? "");
      // Moodle stores the restrictions the form carried back to it.
      model.availability = model.changeOnSave || String(values.get("availabilityconditionsjson") ?? "");
      response.writeHead(303, { location: "/course/view.php?id=2" }).end();
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
    await page.goto(`${origin}/course/view.php?id=2`);
    const binding = { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" };
    const call = (operation, argumentsValue) => page.evaluate(
      executeMoodleInPage,
      JSON.stringify({ mode: "execute", operation, arguments: argumentsValue, binding, expiresAt: Date.now() + 60_000 }),
    );
    const review = () => call(SECTION_FORM.read, { course_id: 2, section_id: 7 });
    const rename = (expectedDigest, name = "Week 3: Evidence") => call(SECTION_FORM.write, { course_id: 2, section_id: 7, name, expected_digest: expectedDigest });

    // What the person reviews is the section's name and summary. The section's
    // restrictions are not part of it, so Morrow neither reports nor changes them.
    const reviewed = await review();
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    assert.deepEqual(reviewed.data, { course_id: 2, section_id: 7, name: "Week 3", summary: "<p>Evidence week.</p>", summary_format: 1 });

    // One POST renames the section and carries its restrictions back exactly as
    // they came, so the section keeps them.
    const saved = await rename(reviewed.snapshot_digest);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(saved.verification, { schema: "morrow.browser-verification.v1", status: "verified" });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].get("availabilityconditionsjson"), RESTRICTIONS);
    assert.equal(posts[0].get("name"), "Week 3: Evidence");
    assert.equal(posts[0].get("summary_editor[text]"), "<p>Evidence week.</p>");
    assert.equal(posts[0].get("submitbutton"), "Save changes");
    assert.deepEqual(posts[0].getAll("cancel"), []);
    assert.equal(model.availability, RESTRICTIONS);
    assert.deepEqual(saved.data, { course_id: 2, section_id: 7, name: "Week 3: Evidence", summary: "<p>Evidence week.</p>", summary_format: 1 });
    assert.deepEqual(saved.targets, [
      { field: "course_id", label: "Course", name: "Foundations of Care" },
      { field: "section_id", label: "Section", name: "Week 3: Evidence" },
    ]);

    // A restriction added between the review and the change makes the reviewed
    // digest no longer describe the section, so nothing is sent.
    model = initialModel();
    posts.length = 0;
    model.changeAfterRequest = 1;
    const stale = await review();
    assert.equal(stale.ok, true, JSON.stringify(stale));
    const refusedStale = await rename(stale.snapshot_digest);
    assert.deepEqual([refusedStale.ok, refusedStale.sent, refusedStale.error], [false, false, "moodle_expected_digest_mismatch"]);
    assert.equal(posts.length, 0);

    // A restriction changed between the form Morrow prepared and the moment it
    // would send stops the change at the pre-send check, with nothing sent.
    model = initialModel();
    posts.length = 0;
    const prepared = await review();
    model.changeAfterRequest = 2;
    const refusedChanged = await rename(prepared.snapshot_digest);
    assert.deepEqual([refusedChanged.ok, refusedChanged.sent, refusedChanged.error], [false, false, "moodle_form_changed"]);
    assert.equal(posts.length, 0);

    // A restriction changed by something else while the change was applied is a
    // saved section that is not the approved one, so the result is not verified.
    model = initialModel();
    posts.length = 0;
    const beforeDrift = await review();
    model.changeOnSave = OTHER_RESTRICTIONS;
    const drifted = await rename(beforeDrift.snapshot_digest);
    assert.deepEqual([drifted.ok, drifted.sent, drifted.error], [false, true, "moodle_write_not_verified"]);
    assert.deepEqual(drifted.verification, { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_readback_mismatch" });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].get("availabilityconditionsjson"), RESTRICTIONS);
    assert.equal(model.availability, OTHER_RESTRICTIONS);

    // Only the section's own native form, its draft-file check, and the course
    // page Moodle redirects to are opened.
    assert.deepEqual([...new Set(requests.filter((entry) => entry.pathname !== "/favicon.ico").map((entry) => `${entry.method} ${entry.pathname}`))].sort(), [
      "GET /course/editsection.php",
      "GET /course/view.php",
      "POST /course/editsection.php",
      "POST /repository/draftfiles_ajax.php",
    ]);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
