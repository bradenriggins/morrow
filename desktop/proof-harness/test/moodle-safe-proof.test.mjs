import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { cleanupCanBeAttempted, runMoodleSafeProof } from "../lib/moodle-safe-proof.mjs";

const catalog = JSON.parse(readFileSync(new URL("../../connector/extension/generated/moodle-browser-catalog.json", import.meta.url), "utf8"));

function fakeTools({ failDeletes = false } = {}) {
  const calls = [];
  const world = {
    sections: [{ id: 10, section: 1, visible: true, name: "Topic" }],
    activities: [],
    groups: [],
    next: 100,
  };
  const digest = "a".repeat(64);
  const snap = (data) => ({ ok: true, data, raw: { data: { result: { snapshot_digest: digest } } } });
  const tools = {
    async read(name, args) {
      calls.push({ kind: "read", name, args });
      if (name === "moodle_get_contents") return snap({ sections: world.sections, activities: world.activities });
      if (name === "moodle_get_course_groups") return snap({ groups: world.groups });
      if (name === "moodle_get_course_groupings") return snap({ groupings: [] });
      if (name === "moodle_get_section") return snap(world.sections.find((section) => Number(section.id) === Number(args.section_id)) || {});
      if (String(name).startsWith("moodle_get_") && args?.module_id != null) {
        return snap(world.activities.find((activity) => Number(activity.id) === Number(args.module_id)) || {});
      }
      return snap({});
    },
    async change(_label, name, args) {
      calls.push({ kind: "change", name, args });
      if (String(name).startsWith("moodle_delete_")) {
        if (failDeletes) return { outcome: "failed" };
        if (name === "moodle_delete_activity") world.activities = world.activities.filter((activity) => String(activity.id) !== String(args.module_id));
        if (name === "moodle_delete_section") world.sections = world.sections.filter((section) => String(section.id) !== String(args.section_id));
        if (name === "moodle_delete_group") world.groups = world.groups.filter((group) => String(group.id) !== String(args.group_id));
        return { outcome: "verified" };
      }
      if (name === "moodle_create_section") {
        const id = world.next++;
        world.sections.push({ id, section: world.sections.length, visible: true, name: "New section" });
        return { outcome: "verified" };
      }
      if (name === "moodle_create_group") {
        const id = world.next++;
        world.groups.push({ id, name: args.name });
        return { outcome: "verified" };
      }
      if (name === "moodle_create_grouping") {
        return { outcome: "verified" };
      }
      if (String(name).startsWith("moodle_create_")) {
        const id = world.next++;
        world.activities.push({ id, name: args.name, sectionid: args.section_id, visible: true, content: args.content || "" });
        return { outcome: "verified" };
      }
      if (name === "moodle_duplicate_activity") {
        const source = world.activities.find((activity) => String(activity.id) === String(args.module_id));
        const id = world.next++;
        world.activities.push({ ...(source || {}), id, name: `${source?.name || "copy"} copy` });
        return { outcome: "verified" };
      }
      if (name === "moodle_update_section") {
        const section = world.sections.find((item) => Number(item.id) === Number(args.section_id));
        if (section && args.name) section.name = args.name;
        return { outcome: "verified" };
      }
      if (name === "moodle_update_group") {
        const group = world.groups.find((item) => Number(item.id) === Number(args.group_id));
        if (group && args.name) group.name = args.name;
        return { outcome: "verified" };
      }
      if (String(name).startsWith("moodle_update_")) {
        const activity = world.activities.find((item) => Number(item.id) === Number(args.module_id));
        if (activity && args.name) activity.name = args.name;
        if (activity && args.content) activity.content = args.content;
        return { outcome: "verified" };
      }
      if (name === "moodle_hide_section" || name === "moodle_show_section") {
        const section = world.sections.find((item) => Number(item.id) === Number(args.section_id));
        if (section) section.visible = name === "moodle_show_section";
        return { outcome: "verified" };
      }
      if (name === "moodle_move_section") {
        const section = world.sections.find((item) => Number(item.id) === Number(args.section_id));
        if (section) section.section = args.position;
        return { outcome: "verified" };
      }
      if (name === "moodle_hide_activity" || name === "moodle_show_activity") {
        const activity = world.activities.find((item) => Number(item.id) === Number(args.module_id));
        if (activity) activity.visible = name === "moodle_show_activity";
        return { outcome: "verified" };
      }
      if (name === "moodle_move_activity" || name === "moodle_move_activity_to_position") {
        const activity = world.activities.find((item) => Number(item.id) === Number(args.module_id));
        if (activity && args.target_section_id) activity.sectionid = args.target_section_id;
        return { outcome: "verified" };
      }
      return { outcome: "verified" };
    },
    async callTool() { return { structuredContent: {} }; },
  };
  return { tools, calls, world };
}

function env(course = "2") {
  return { MORROW_MOODLE_COURSE: course, MORROW_MOODLE_MARK: "MORROWPROOF-TEST" };
}

test("cleanup deletes every created id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-proof-"));
  const outPath = join(directory, "receipt.json");
  const { tools, calls } = fakeTools();
  const result = await runMoodleSafeProof({
    tools,
    catalog,
    env: env(),
    outPath,
    log() {},
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.ok(result.created.length > 0);
  const deletedIds = calls.filter((call) => call.kind === "change" && String(call.name).startsWith("moodle_delete_"))
    .map((call) => String(call.args.module_id ?? call.args.section_id ?? call.args.group_id));
  for (const created of result.created) {
    assert.equal(deletedIds.includes(String(created.id)), true, `${created.kind} ${created.id} was not deleted`);
  }
  assert.equal(calls.some((call) => call.name === "moodle_create_grouping"), false);
});

test("a failed delete exits non-zero", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-proof-fail-"));
  const { tools, calls } = fakeTools({ failDeletes: true });
  const result = await runMoodleSafeProof({
    tools,
    catalog,
    env: env(),
    outPath: join(directory, "receipt.json"),
    log() {},
  });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.created.length > 0);
  const deleteCalls = calls.filter((call) => call.kind === "change" && String(call.name).startsWith("moodle_delete_"));
  assert.ok(deleteCalls.length > 0);
  for (const created of result.created) {
    assert.equal(deleteCalls.some((call) => String(call.args.module_id ?? call.args.section_id ?? call.args.group_id) === String(created.id)), true);
  }
});

test("the proof refuses a shared default and a run that cannot clean up", async () => {
  const { tools, calls } = fakeTools();
  const missingCourse = await runMoodleSafeProof({ tools, catalog, env: {}, log() {} });
  assert.equal(missingCourse.exitCode, 1);
  assert.equal(calls.filter((call) => call.kind === "change").length, 0);
  assert.equal(cleanupCanBeAttempted({ operations: [] }, tools), false);
  const noCleanup = await runMoodleSafeProof({
    tools,
    catalog: { operations: [] },
    env: env("4"),
    log() {},
  });
  assert.equal(noCleanup.exitCode, 1);
  assert.match(noCleanup.reason, /cleanup cannot be attempted/);
  assert.equal(calls.filter((call) => call.kind === "change").length, 0);
});
