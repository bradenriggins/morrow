// Moodle proof that removes every object it creates. The entry script supplies a client.
// Tests supply a fake client and never open a live course.
import { writeFileSync } from "node:fs";

const DELETE_TOOLS = ["moodle_delete_activity", "moodle_delete_section", "moodle_delete_group"];

export function moodleProofCourse(env = process.env) {
  const raw = env.MORROW_MOODLE_COURSE;
  if (raw === undefined || String(raw).trim() === "") {
    return { ok: false, reason: "MORROW_MOODLE_COURSE is required. This proof does not default to a shared course." };
  }
  const courseId = Number(raw);
  const sectionRaw = env.MORROW_MOODLE_SECTION;
  const sectionId = sectionRaw === undefined || sectionRaw === "" ? null : Number(sectionRaw);
  if (!Number.isSafeInteger(courseId) || courseId < 1 || (sectionId !== null && (!Number.isSafeInteger(sectionId) || sectionId < 1))) {
    return { ok: false, reason: "Moodle proof course and optional section id must be positive safe integers." };
  }
  return { ok: true, courseId, sectionId };
}

export function cleanupCanBeAttempted(catalog, tools) {
  const names = new Set((catalog?.operations || []).map((operation) => operation.toolName));
  if (DELETE_TOOLS.some((name) => !names.has(name))) return false;
  return typeof tools?.change === "function" && typeof tools?.read === "function";
}

function snapshot(result) {
  return result?.raw?.data?.result?.snapshot_digest || null;
}

function activityList(value) {
  return Array.isArray(value?.data?.activities) ? value.data.activities : [];
}

/**
 * Runs the safe proof. Returns exitCode 0 only when every created id was deleted.
 * A failed delete, or a run that cannot attempt cleanup, returns exitCode 1.
 */
export async function runMoodleSafeProof({
  tools,
  catalog,
  env = process.env,
  outPath = env.MORROW_MOODLE_RECEIPT || "/private/tmp/morrow-moodle-safe-proof.json",
  writeReceipt = (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  log = (line) => process.stdout.write(line),
} = {}) {
  const course = moodleProofCourse(env);
  const created = [];
  const deleted = [];
  if (!course.ok) return { exitCode: 1, reason: course.reason, created, deleted };
  if (!cleanupCanBeAttempted(catalog, tools)) {
    return { exitCode: 1, reason: "Moodle proof refused to run because cleanup cannot be attempted.", created, deleted };
  }

  const COURSE = course.courseId;
  let SECTION = course.sectionId;
  const MARK = env.MORROW_MOODLE_MARK || `MORROWPROOF-${Date.now()}`;
  const byTool = new Map((catalog.operations || []).map((operation) => [operation.toolName, operation]));
  const receipt = { schema: "morrow.moodle-safe-proof.v1", mark: MARK, courseId: COURSE, startedAt: new Date().toISOString(), rows: [] };
  const failures = [];

  function row(tool, kind, verdict, detail = {}) {
    const value = { tool, kind, verdict, at: new Date().toISOString(), ...detail };
    receipt.rows.push(value);
    log(`${verdict.padEnd(7)} ${tool}${detail.reason ? `: ${detail.reason}` : ""}\n`);
    writeReceipt(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return value;
  }

  async function read(name, args, { record = true } = {}) {
    try {
      const answer = await tools.read(name, args);
      if (record) {
        row(name, "read", answer.ok ? "PASS" : "BLOCKED", answer.ok
          ? { providerReadback: true }
          : { reason: answer.code || answer.reason || "provider_refused" });
      }
      return answer;
    } catch (error) {
      if (record) row(name, "read", "FAIL", { reason: String(error).slice(0, 240) });
      return { ok: false, code: "threw" };
    }
  }

  async function write(name, args, verify) {
    let answer = await tools.change(`${MARK}-${name}`, name, args);
    if (["applied_or_unknown", "sent_unchecked"].includes(answer.outcome) && answer.operationId && typeof tools.callTool === "function") {
      const reconciled = await tools.callTool("morrow_operation_reconcile", { operation_id: answer.operationId }, 120_000);
      const result = reconciled?.structuredContent || {};
      if (result.status === "verified" && result.effectState === "verified" && result.verification?.status === "verified") {
        answer = { ...answer, outcome: "verified", reconciledWithoutReplay: true };
      }
    }
    if (answer.outcome !== "verified") {
      row(name, "write", "FAIL", { reason: answer.outcome, state: answer.state || null, attention: answer.attention || [] });
      return false;
    }
    try {
      const evidence = await verify();
      if (!evidence) throw new Error("fresh provider readback did not show the requested state");
      row(name, "write", "PASS", { operationId: answer.operationId || null, providerReadback: true, ...(answer.reconciledWithoutReplay ? { reconciledWithoutReplay: true } : {}) });
      return true;
    } catch (error) {
      row(name, "write", "FAIL", { operationId: answer.operationId || null, reason: String(error).slice(0, 240) });
      return false;
    }
  }

  async function contents({ record = false } = {}) {
    return read("moodle_get_contents", { course_id: COURSE }, { record });
  }

  async function activityByName(name) {
    const answer = await contents();
    return activityList(answer).find((activity) => activity.name === name) || null;
  }

  async function readModule(tool, moduleId, { record = true } = {}) {
    return read(tool, { course_id: COURSE, module_id: Number(moduleId) }, { record });
  }

  function requiredArguments(toolName, values) {
    const operation = byTool.get(toolName);
    const args = {};
    for (const key of operation?.inputSchema?.required || []) {
      if (values[key] === undefined) throw new Error(`${toolName} has no value for ${key}`);
      args[key] = values[key];
    }
    return args;
  }

  function remember(kind, id, extra = {}) {
    if (id == null || !Number.isFinite(Number(id))) return;
    const key = `${kind}:${id}`;
    if (created.some((entry) => `${entry.kind}:${entry.id}` === key)) return;
    created.push({ kind, id: Number(id), ...extra });
  }

  async function createActivity(spec) {
    const form = await read(spec.form, spec.formArgs || { course_id: COURSE, section_id: SECTION });
    if (!form.ok || !snapshot(form)) return row(spec.create, "write", "BLOCKED", { reason: `${spec.form} did not supply a snapshot` });
    const name = `${MARK}-${spec.module}`;
    let args;
    try {
      args = requiredArguments(spec.create, {
        ...form.data,
        course_id: COURSE,
        section_id: SECTION,
        name,
        instructions: `<p>${MARK} safe proof.</p>`,
        content: `<p>${MARK} safe proof.</p>`,
        description: `${MARK} safe proof`,
        external_url: "https://example.com/morrow-proof",
        assessment: { type: "none" },
        due_date: null,
        cutoff_at: null,
        available_from: null,
        available_to: null,
        grading_due_at: null,
        open_at: null,
        close_at: null,
        options: ["Morrow A", "Morrow B"],
        limits: [0, 0],
        first_page_title: `${MARK} first page`,
        expected_digest: snapshot(form),
        ...(spec.values || {}),
      });
    } catch (error) {
      return row(spec.create, "write", "BLOCKED", { reason: String(error.message || error) });
    }
    await write(spec.create, args, async () => Boolean(await activityByName(name)));
    const activity = await activityByName(name);
    if (activity) remember("activity", activity.id, { name });
    if (!activity) return;
    await readModule(spec.read, activity.id);
    if (!spec.update) return;
    const before = await readModule(spec.read, activity.id, { record: false });
    const expected = snapshot(before);
    if (!before.ok || !expected) return row(spec.update, "write", "BLOCKED", { reason: `${spec.read} did not supply a snapshot` });
    const changedValue = spec.updateValue ?? `${name}-updated`;
    const updateArgs = { course_id: COURSE, module_id: Number(activity.id), expected_digest: expected, [spec.updateField]: changedValue };
    await write(spec.update, updateArgs, async () => {
      const after = await readModule(spec.read, activity.id, { record: false });
      return after.ok && (after.data?.[spec.updateField] === changedValue || (spec.updateField === "content" && String(after.data?.content || "").includes(MARK)));
    });
  }

  async function deleteOne(entry) {
    try {
      if (entry.kind === "activity") {
        const state = await contents();
        const digest = snapshot(state);
        if (!state.ok || !digest) throw new Error("cleanup read did not supply a snapshot");
        const ok = await write("moodle_delete_activity", { course_id: COURSE, module_id: Number(entry.id), expected_digest: digest }, async () => {
          const check = await contents();
          return check.ok && Array.isArray(check.data?.activities) && !activityList(check).some((item) => String(item.id) === String(entry.id));
        });
        if (!ok) throw new Error("activity delete was not read back");
      } else if (entry.kind === "section") {
        const state = await contents();
        const digest = snapshot(state);
        if (!state.ok || !digest) throw new Error("cleanup read did not supply a snapshot");
        const ok = await write("moodle_delete_section", { course_id: COURSE, section_id: Number(entry.id), expected_digest: digest }, async () => {
          const check = await contents();
          return check.ok && Array.isArray(check.data?.sections) && !(check.data.sections || []).some((item) => String(item.id) === String(entry.id));
        });
        if (!ok) throw new Error("section delete was not read back");
      } else if (entry.kind === "group") {
        const state = await read("moodle_get_course_groups", { course_id: COURSE }, { record: false });
        const digest = snapshot(state);
        if (!state.ok || !digest) throw new Error("cleanup read did not supply a snapshot");
        const ok = await write("moodle_delete_group", {
          course_id: COURSE,
          group_id: Number(entry.id),
          expected_group_name: entry.name,
          expected_member_count: 0,
          expected_digest: digest,
        }, async () => {
          const check = await read("moodle_get_course_groups", { course_id: COURSE }, { record: false });
          const rows = Array.isArray(check.data) ? check.data : check.data?.groups || [];
          return check.ok && Array.isArray(rows) && !rows.some((item) => String(item.id) === String(entry.id));
        });
        if (!ok) throw new Error("group delete was not read back");
      } else {
        throw new Error(`no delete for ${entry.kind}`);
      }
      deleted.push(entry);
      return true;
    } catch (error) {
      failures.push({ ...entry, error: String(error.message || error) });
      return false;
    }
  }

  let exitCode = 0;
  try {
    await read("moodle_list_my_courses", { limit: 100, offset: 0 });
    await read("moodle_get_course", { course_id: COURSE });
    const initialContents = await contents({ record: true });
    if (SECTION === null) {
      const writableSection = (initialContents.data?.sections || []).find((section) => Number(section.section) > 0 && Number.isSafeInteger(Number(section.id)));
      if (!writableSection) throw new Error("Moodle proof course has no writable section");
      SECTION = Number(writableSection.id);
    }
    await read("moodle_get_course_summary", { course_id: COURSE });
    await read("moodle_get_course_settings", { course_id: COURSE });
    await read("moodle_get_site_inventory", { course_id: COURSE });
    await read("moodle_get_role_definitions", { course_id: COURSE });

    const beforeSection = await contents();
    const beforeIds = new Set((beforeSection.data?.sections || []).map((section) => String(section.id)));
    if (snapshot(beforeSection)) {
      await write("moodle_create_section", { course_id: COURSE, expected_digest: snapshot(beforeSection) }, async () => {
        const after = await contents();
        return (after.data?.sections || []).some((section) => !beforeIds.has(String(section.id)));
      });
    }
    const afterSection = await contents();
    const newSection = (afterSection.data?.sections || []).find((section) => !beforeIds.has(String(section.id)));
    if (newSection) {
      const sectionId = Number(newSection.id);
      remember("section", sectionId);
      const sectionRead = await read("moodle_get_section", { course_id: COURSE, section_id: sectionId });
      if (snapshot(sectionRead)) {
        await write("moodle_update_section", { course_id: COURSE, section_id: sectionId, name: `${MARK}-section`, summary: `<p>${MARK}</p>`, expected_digest: snapshot(sectionRead) }, async () => {
          const check = await read("moodle_get_section", { course_id: COURSE, section_id: sectionId }, { record: false });
          return check.ok && check.data?.name === `${MARK}-section`;
        });
      }
      for (const [tool, visible] of [["moodle_hide_section", false], ["moodle_show_section", true]]) {
        const state = await contents();
        if (!snapshot(state)) continue;
        await write(tool, { course_id: COURSE, section_id: sectionId, expected_digest: snapshot(state) }, async () => {
          const check = await contents();
          const section = (check.data?.sections || []).find((item) => Number(item.id) === sectionId);
          return section && Boolean(section.visible) === visible;
        });
      }
      const state = await contents();
      const movable = (state.data?.sections || []).filter((section) => Number(section.section) > 0);
      if (snapshot(state) && movable.length > 1) {
        await write("moodle_move_section", { course_id: COURSE, section_id: sectionId, position: 1, expected_digest: snapshot(state) }, async () => {
          const check = await contents();
          return Number((check.data?.sections || []).find((item) => Number(item.id) === sectionId)?.section) === 1;
        });
      }
    }

    const specs = [
      { module: "label", form: "moodle_get_label_creation_form", create: "moodle_create_label", read: "moodle_get_label", update: "moodle_update_label", updateField: "content", updateValue: `<p>${MARK} updated label</p>` },
      { module: "page", form: "moodle_get_page_creation_form", create: "moodle_create_page", read: "moodle_get_page", update: "moodle_update_page", updateField: "name" },
      { module: "url", form: "moodle_get_url_creation_form", create: "moodle_create_url", read: "moodle_get_url", update: "moodle_update_url", updateField: "name" },
      { module: "assign", form: "moodle_get_assignment_creation_form", create: "moodle_create_assignment", read: "moodle_get_assignment", update: "moodle_update_assignment", updateField: "name" },
      { module: "quiz", form: "moodle_get_quiz_creation_form", create: "moodle_create_quiz", read: "moodle_get_quiz", update: "moodle_update_quiz", updateField: "name" },
      { module: "forum", form: "moodle_get_forum_creation_form", create: "moodle_create_forum", read: "moodle_get_forum", update: "moodle_update_forum", updateField: "name" },
      { module: "choice", form: "moodle_get_choice_creation_form", create: "moodle_create_choice", read: "moodle_get_choice", update: "moodle_update_choice", updateField: "name" },
      { module: "book", form: "moodle_get_book_creation_form", create: "moodle_create_book", read: "moodle_get_book", update: "moodle_update_book", updateField: "name" },
      { module: "lesson", form: "moodle_get_lesson_creation_form", create: "moodle_create_lesson", read: "moodle_get_lesson", update: "moodle_update_lesson", updateField: "name" },
      { module: "glossary", form: "moodle_get_glossary_creation_form", create: "moodle_create_glossary", read: "moodle_get_glossary", update: "moodle_update_glossary", updateField: "name" },
      { module: "wiki", form: "moodle_get_wiki_creation_form", create: "moodle_create_wiki", read: "moodle_get_wiki", update: "moodle_update_wiki", updateField: "name" },
      { module: "feedback", form: "moodle_get_feedback_creation_form", create: "moodle_create_feedback", read: "moodle_get_feedback", update: "moodle_update_feedback", updateField: "name" },
      { module: "data", form: "moodle_get_database_creation_form", create: "moodle_create_database", read: "moodle_get_database", update: "moodle_update_database", updateField: "name" },
      { module: "workshop", form: "moodle_get_workshop_creation_form", create: "moodle_create_workshop", read: "moodle_get_workshop", update: "moodle_update_workshop", updateField: "name" },
      { module: "bigbluebuttonbn", form: "moodle_get_bigbluebuttonbn_creation_form", create: "moodle_create_bigbluebuttonbn", read: "moodle_get_bigbluebuttonbn", update: "moodle_update_bigbluebuttonbn", updateField: "name", values: { opening_time: { year: 2026, month: 10, day: 1, hour: 9, minute: 0 }, closing_time: { year: 2026, month: 10, day: 1, hour: 10, minute: 0 }, wait_for_moderator: true } },
      { module: "qbank", form: "moodle_get_qbank_activity_creation_form", create: "moodle_create_qbank_activity", read: "moodle_get_qbank_activity" },
      { module: "subsection", form: "moodle_get_contents", formArgs: { course_id: COURSE }, create: "moodle_create_subsection", read: "moodle_get_subsection" },
    ];
    for (const spec of specs) await createActivity(spec);

    const page = created.find((entry) => entry.kind === "activity" && String(entry.name || "").endsWith("-page"));
    const pageActivity = page ? { id: page.id } : null;
    const target = newSection || (await contents()).data?.sections?.find((section) => Number(section.id) !== SECTION);
    if (pageActivity && target) {
      for (const [tool, visible] of [["moodle_hide_activity", false], ["moodle_show_activity", true]]) {
        const state = await contents();
        await write(tool, { course_id: COURSE, module_id: Number(pageActivity.id), expected_digest: snapshot(state) }, async () => {
          const check = await contents();
          return Boolean(activityList(check).find((item) => String(item.id) === String(pageActivity.id))?.visible) === visible;
        });
      }
      let state = await contents();
      await write("moodle_move_activity", { course_id: COURSE, module_id: Number(pageActivity.id), target_section_id: Number(target.id), expected_digest: snapshot(state) }, async () => {
        const check = await contents();
        return String(activityList(check).find((item) => String(item.id) === String(pageActivity.id))?.sectionid) === String(target.id);
      });
      state = await contents();
      await write("moodle_move_activity_to_position", { course_id: COURSE, module_id: Number(pageActivity.id), target_section_id: SECTION, position: 1, expected_digest: snapshot(state) }, async () => {
        const check = await contents();
        return String(activityList(check).find((item) => String(item.id) === String(pageActivity.id))?.sectionid) === String(SECTION);
      });
      state = await contents();
      const beforeActivityIds = new Set(activityList(state).map((item) => String(item.id)));
      const countBefore = activityList(state).length;
      await write("moodle_duplicate_activity", { course_id: COURSE, module_id: Number(pageActivity.id), expected_digest: snapshot(state) }, async () => {
        const check = await contents();
        return activityList(check).length === countBefore + 1;
      });
      const afterDuplicate = await contents();
      for (const item of activityList(afterDuplicate)) {
        if (!beforeActivityIds.has(String(item.id))) remember("activity", item.id, { name: item.name });
      }
    }

    const groups = await read("moodle_get_course_groups", { course_id: COURSE });
    const groupName = `${MARK}-group`;
    if (snapshot(groups)) {
      await write("moodle_create_group", { course_id: COURSE, name: groupName, visibility: 3, participation: true, expected_digest: snapshot(groups) }, async () => {
        const check = await read("moodle_get_course_groups", { course_id: COURSE }, { record: false });
        return (check.data?.groups || check.data || []).some?.((item) => item.name === groupName);
      });
    }
    const groupsAfter = await read("moodle_get_course_groups", { course_id: COURSE }, { record: false });
    const groupRows = Array.isArray(groupsAfter.data) ? groupsAfter.data : groupsAfter.data?.groups || [];
    const group = groupRows.find((item) => item.name === groupName || item.name === `${groupName}-updated`);
    if (group) remember("group", group.id, { name: group.name });
    if (group && snapshot(groupsAfter)) {
      await write("moodle_update_group", { course_id: COURSE, group_id: Number(group.id), expected_group_name: group.name, name: `${groupName}-updated`, expected_digest: snapshot(groupsAfter) }, async () => {
        const check = await read("moodle_get_course_groups", { course_id: COURSE }, { record: false });
        const rows = Array.isArray(check.data) ? check.data : check.data?.groups || [];
        return rows.some((item) => item.name === `${groupName}-updated`);
      });
      const tracked = created.find((entry) => entry.kind === "group" && Number(entry.id) === Number(group.id));
      if (tracked) tracked.name = `${groupName}-updated`;
    }

    if (!byTool.has("moodle_delete_grouping")) {
      row("moodle_create_grouping", "write", "BLOCKED", { reason: "This proof does not create a grouping because cleanup has no delete for it." });
    }

    receipt.completedAt = new Date().toISOString();
  } catch (error) {
    exitCode = 1;
    receipt.error = String(error?.message || error).slice(0, 300);
    log(`FAIL    proof: ${receipt.error}\n`);
  } finally {
    const order = { activity: 0, group: 1, section: 2 };
    const pending = [...created].sort((left, right) => (order[left.kind] ?? 9) - (order[right.kind] ?? 9));
    for (const entry of pending) {
      const ok = await deleteOne(entry);
      if (!ok) exitCode = 1;
    }
    receipt.cleanup = { created: created.map((entry) => ({ kind: entry.kind, id: entry.id })), deleted: deleted.map((entry) => ({ kind: entry.kind, id: entry.id })), failures };
    receipt.summary = receipt.rows.reduce((summary, entry) => {
      summary[entry.verdict] = (summary[entry.verdict] || 0) + 1;
      return summary;
    }, {});
    writeReceipt(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
    log(`${JSON.stringify(receipt.summary)}\n${outPath}\n`);
  }
  return { exitCode, reason: failures.length ? "A created object was not deleted." : undefined, created, deleted, failures };
}
