import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { PROBLEM_CODES, problemCode, problemCopy, problemText } from "../../connector/extension/src/bridge-problem-copy.js";

/**
 * The gate on what a person reads when Morrow Bridge cannot finish a step. Every failure the
 * Morrow Bridge pages receive carries a stable code, and every code must answer what happened, why,
 * and what to do next. A code this file cannot explain is a fallback that still shows the code.
 */
const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");
const worker = read("connector/extension/src/service-worker.js");
const popup = read("connector/extension/popup/popup.js");
const settings = read("connector/extension/settings/settings.js");
const copySource = read("connector/extension/src/bridge-problem-copy.js");

// The vocabulary the browser harness refuses on a Morrow Bridge page
// (scripts/test/canvas-connector-browser.mjs:30). Copy written here is the copy that renders there.
const TECHNICAL_TERMS = /\b(?:MCP|nonce|digest|dispatch|binding|frozen)\b/i;

/**
 * The codes a Morrow Bridge page can be handed. The service worker throws or answers with each of
 * the first group; the popup raises the second group itself; Chrome raises the third as its own
 * runtime text, which problemCode() names before the copy is read.
 */
const WORKER_CODES = [
  "bridge_not_connected", "bridge_version_mismatch", "bridge_request_failed", "connector_catalog_invalid",
  "course_tab_missing", "course_site_access_required", "course_sign_in_required", "blackboard_browser_unsupported",
  "edit_policy_failed", "edit_policy_binding_missing", "edit_policy_binding_stale", "edit_policy_revision_stale",
  "edit_policy_categories_invalid", "edit_policy_expiration_invalid", "edit_policy_sender_refused",
  "course_discovery_sender_refused", "course_discovery_anchor_missing", "course_discovery_anchor_stale",
  "course_discovery_failed", "course_discovery_receipt_missing", "course_discovery_receipt_stale",
  "course_discovery_complete", "course_selection_invalid", "course_selection_unavailable",
  "course_selection_target_refused", "binding_limit_reached",
];
const POPUP_CODES = ["course_tab_missing", "course_permission_denied", "course_permission_prompt_missing"];
const SETTINGS_CODES = ["course_discovery_more_failed", "course_file_access_change_failed", "course_file_access_permission_remove_failed",
  "edit_policy_status_unreadable", "edit_policy_options_unreadable", "edit_policy_save_unconfirmed", "edit_policy_revoke_unconfirmed",
  "edit_policy_category_unavailable", "course_selection_invalid", "course_discovery_receipt_stale"];
const CHROME_RUNTIME_TEXT = [
  "Could not establish connection. Receiving end does not exist.",
  "The message port closed before a response was received.",
  "Extension context invalidated.",
];

// The codes Morrow Bridge returns for one course read or change. bridge-18 names these as the
// states a person must be able to read, so each one is explained here rather than left generic.
const OPERATION_CODES = [
  "bridge_port_in_use", "canvas_binding_required", "course_binding_mismatch", "course_scope_required",
  "edit_policy_stale", "edit_policy_rule_refused", "edit_policy_canvas_content_guard_required",
  "write_outcome_unknown", "bridge_maintenance_unavailable", "canvas_file_storage_access_required",
  "effect_receipt_refused", "item_bank_dependency_review_required", "provider_effect_target_conflict",
];

/** Every .js and .ts file under the Morrow Bridge extension and the workspace package sources. */
function sourceFiles(directory, files = []) {
  for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, files);
    else if (/\.(?:js|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const MORROW_SOURCE = [
  ...sourceFiles("connector/extension"),
  ...readdirSync(new URL("packages", root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return sourceFiles(`packages/${entry.name}/src`);
      } catch {
        return [];
      }
    }),
].filter((path) => path !== "connector/extension/src/bridge-problem-copy.js")
  .map((path) => ({ path, text: read(path) }));

test("every explained code names what happened, why, and one next action", () => {
  assert.ok(PROBLEM_CODES.length > 0);
  for (const code of PROBLEM_CODES) {
    const copy = problemCopy(code);
    assert.equal(copy.code, code);
    assert.equal(copy.known, true, code);
    for (const [part, value] of Object.entries({ title: copy.title, detail: copy.detail, action: copy.action })) {
      assert.equal(typeof value, "string", `${code}.${part}`);
      assert.ok(value.trim().length >= 12, `${code}.${part} is too short to state anything: ${JSON.stringify(value)}`);
      assert.doesNotMatch(value, TECHNICAL_TERMS, `${code}.${part} uses a word the Morrow Bridge pages refuse`);
      assert.doesNotMatch(value, /preview/i, `${code}.${part}`);
    }
    assert.doesNotMatch(copy.title, /[.!?]$/, `${code}.title reads as a heading, so it carries no end punctuation`);
    assert.match(copy.action, /[.!?]$/, `${code}.action`);
    assert.notEqual(copy.detail, copy.action, code);
    assert.ok(problemText(code).includes(copy.action), code);
  }
});

test("each code reads as its own state rather than one repeated sentence", () => {
  const titles = PROBLEM_CODES.map((code) => problemCopy(code).title);
  assert.equal(new Set(titles).size, titles.length, "two codes share one title, so one of them names no state of its own");
  const actions = PROBLEM_CODES.map((code) => problemCopy(code).action);
  const repeated = actions.filter((action, index) => actions.indexOf(action) !== index);
  assert.deepEqual(repeated, [], "two codes offer the same next action");
});

test("every code bridge-18 names is explained", () => {
  for (const code of [...WORKER_CODES, ...POPUP_CODES, ...SETTINGS_CODES, ...OPERATION_CODES]) {
    assert.ok(PROBLEM_CODES.includes(code), `${code} has no copy, so a person would read the unknown-state fallback`);
  }
});

// A code with no explanation is honest only while it is genuinely unknown, and copy for a code
// nothing raises is a state no person can reach. Both directions are checked here.
test("every explained code is one Morrow actually raises", () => {
  const chromeRuntimeNamed = CHROME_RUNTIME_TEXT.map((text) => problemCode(text));
  for (const code of PROBLEM_CODES) {
    if (chromeRuntimeNamed.includes(code)) {
      assert.ok(copySource.includes(`: "${code}"`), `${code} must be named from the Chrome runtime text it explains`);
      continue;
    }
    const raisedIn = MORROW_SOURCE.filter((file) => file.text.includes(`"${code}"`));
    assert.ok(raisedIn.length > 0, `${code} is explained here but raised nowhere in Morrow`);
  }
});

test("every code a Morrow Bridge page can receive still exists where it is raised", () => {
  for (const code of WORKER_CODES) assert.ok(worker.includes(`"${code}"`), `${code} is no longer raised in the service worker`);
  for (const code of POPUP_CODES) {
    assert.ok(popup.includes(`"${code}"`) || worker.includes(`"${code}"`), `${code} is no longer raised in the popup`);
  }
  for (const code of SETTINGS_CODES) assert.ok(settings.includes(`"${code}"`), `${code} is no longer raised in Plan and Edit settings`);
});

test("the failure Chrome itself raises is named rather than left as Chrome's own text", () => {
  assert.equal(problemCode(new Error(CHROME_RUNTIME_TEXT[0])), "bridge_extension_unreachable");
  assert.equal(problemCode(new Error(CHROME_RUNTIME_TEXT[1])), "bridge_extension_unreachable");
  assert.equal(problemCode(new Error(CHROME_RUNTIME_TEXT[2])), "bridge_extension_reloaded");
  assert.match(problemText("bridge_extension_unreachable"), /Chrome extensions page/);
  assert.match(problemText("bridge_extension_reloaded"), /Reload this page/);
});

test("a cause is read as its code, whatever carried it", () => {
  assert.equal(problemCode(new Error("course_permission_denied")), "course_permission_denied");
  assert.equal(problemCode("course_permission_denied"), "course_permission_denied");
  assert.equal(problemCode({ code: "write_outcome_unknown", message: "ignored" }), "write_outcome_unknown");
  assert.equal(problemCode(new Error("Morrow could not complete this request.")), "bridge_request_failed");
  assert.equal(problemCode(new Error("toString")), "bridge_request_failed");
  assert.equal(problemCode(new Error("")), "bridge_request_failed");
  assert.equal(problemCode(null), "bridge_request_failed");
  assert.equal(problemCode(undefined), "bridge_request_failed");
});

test("an unknown code still shows the code, so a support conversation can start from it", () => {
  const copy = problemCopy("something_new_from_a_later_release");
  assert.equal(copy.known, false);
  assert.equal(copy.code, "something_new_from_a_later_release");
  assert.ok(copy.detail.includes("something_new_from_a_later_release"));
  assert.ok(problemText("something_new_from_a_later_release").includes("something_new_from_a_later_release"));
  for (const value of [copy.title, copy.detail, copy.action]) assert.ok(value.trim().length >= 12);
  // The fallback is for a state Morrow cannot name, so no explained code may read as one.
  for (const code of PROBLEM_CODES) assert.notEqual(problemCopy(code).title === copy.title && problemCopy(code).detail === copy.detail, true, code);
  const empty = problemCopy("");
  assert.equal(empty.known, false);
  assert.ok(empty.detail.includes("no state name"));
});

test("one code reads as one line for the single region each page shows a problem in", () => {
  const line = problemText("bridge_not_connected");
  assert.equal(line, "Morrow is not running on this computer. Morrow Bridge asked the Morrow app on this computer to start a connection, and nothing answered. Open the Morrow app, then select Connect Morrow again.");
  assert.doesNotMatch(line, /\s\s|\n/);
});

// The three pages read their words from this file rather than from a map of their own.
test("the popup, the setup guide and Plan and Edit settings render these codes", () => {
  const guide = read("connector/extension/onboarding/onboarding.js");
  for (const [name, source] of [["popup", popup], ["setup guide", guide], ["settings", settings]]) {
    assert.match(source, /bridge-problem-copy\.js/, `the ${name} does not read its problem copy from one place`);
    assert.match(source, /problemText\(/, `the ${name} does not render problem copy`);
    assert.match(source, /response\?\.code \|\| response\?\.error/, `the ${name} drops the code the service worker answers with`);
  }
});
