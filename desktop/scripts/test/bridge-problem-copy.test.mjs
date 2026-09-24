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
 *
 * The worker's codes are read from its source: every `new Error("code")` it raises reaches a page
 * as that code through messageCode() unless it is one the worker answers only to the Morrow app.
 * WORKER_ANSWER_CODES holds only the codes the worker answers without raising them that way: the
 * pairing refusals Morrow names, the sender refusals, and the fallbacks for a failure with no code.
 */
const WORKER_THROWN_CODES = [...new Set([...worker.matchAll(/new Error\("([a-z][a-z0-9_]{2,80})"\)/g)].map(([, code]) => code))];
const WORKER_ANSWER_CODES = [
  "bridge_pairing_refused", "bridge_version_mismatch", "bridge_request_failed",
  "edit_policy_failed", "edit_policy_revision_stale", "edit_policy_sender_refused", "course_discovery_sender_refused",
];

/**
 * A failed Private Chat send reaches the drawer as the code privateChatCode() translates it to, read
 * here from the worker's own PRIVATE_CHAT_SEND_CODES table.
 */
const PRIVATE_CHAT_SEND_CODES = (() => {
  const table = worker.match(/^const PRIVATE_CHAT_SEND_CODES = Object\.freeze\(\{\n([\s\S]*?)\n\}\);$/m);
  assert.ok(table, "PRIVATE_CHAT_SEND_CODES is no longer a top-level table in the service worker");
  return Object.fromEntries([...table[1].matchAll(/^\s+([a-z][a-z0-9_]+): "([a-z][a-z0-9_]+)",$/gm)].map(([, from, to]) => [from, to]));
})();

/**
 * The codes the worker answers only to the Morrow app: the result of one Bridge command from the
 * Morrow app, or of one course operation the assistant asked for. None reaches a Morrow Bridge page,
 * so none needs page copy. Each names every worker function that raises it, and the test below holds
 * the worker to that list, so the same code raised on a page's path fails here first.
 */
const MORROW_APP_CODES = {
  canvas_file_content_too_large: ["boundedResponseBytes"],
  canvas_file_content_timeout: ["boundedResponseBytes", "readCanvasCourseFileBytes"],
  canvas_file_content_stream_invalid: ["boundedResponseBytes"],
  canvas_file_transfer_timeout: ["executeCanvasCourseFileTransfer"],
  canvas_hot_spot_transfer_timeout: ["executeCanvasNewQuizHotSpotCreate"],
  canvas_pagination_resume_refused: ["claimCanvasListContinuation", "issueCanvasListContinuation"],
  edit_policy_set_invalid: ["bridgePolicySet"],
  edit_policy_set_stale: ["applyBridgePolicySet", "bridgePolicySet"],
  edit_policy_options_invalid: ["bridgePolicyOptionsGet"],
  edit_policy_options_stale: ["bridgePolicyOptionsGet"],
  ui_state_invalid: ["bridgeUiState"],
  ui_state_stale: ["bridgeUiState"],
};

/** The top-level worker functions that raise `code`, by the declaration each raise sits under. */
function workerFunctionsRaising(code) {
  const lines = worker.split("\n");
  const found = new Set();
  for (const [index, line] of lines.entries()) {
    if (!line.includes(`new Error("${code}")`)) continue;
    let owner = null;
    for (let at = index; at >= 0 && owner === null; at -= 1) {
      const declaration = /^(?:async )?function\*? (\w+)\(/.exec(lines[at]);
      if (declaration) owner = declaration[1];
      else if (at !== index && /^[^\s}]/.test(lines[at])) owner = `top-level line ${at + 1}`;
    }
    found.add(owner ?? "top-level line 1");
  }
  return [...found].sort();
}

/** The chrome.runtime.onMessage listener: every request a Morrow Bridge page sends starts here. */
const PAGE_LISTENER = (() => {
  const start = worker.indexOf("chrome.runtime.onMessage.addListener(");
  assert.ok(start >= 0, "the service worker no longer listens for page requests");
  const end = worker.indexOf("\n});\n", start);
  assert.ok(end > start, "the page request listener does not close at the start of a line");
  return worker.slice(start, end);
})();
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
  "edit_policy_stale", "edit_policy_rule_refused", "edit_policy_page_missing", "edit_policy_canvas_content_guard_required",
  "write_outcome_unknown", "bridge_maintenance_unavailable", "canvas_file_storage_access_required",
  "effect_receipt_refused", "provider_effect_target_conflict",
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

// Every next step a code names is a control that exists. The course list has no "Find courses"
// button, no course checkboxes, and a mixed Canvas and Moodle selection is allowed.
test("no code names a control or a cause the Morrow Bridge pages do not have", () => {
  const retired = /Find (?:available )?courses|find available courses|Select one or more|Select the courses you want|different platforms|Reconnect Canvas or Moodle from|Connect Canvas|Connect Moodle|Connect selected courses/i;
  for (const code of PROBLEM_CODES) assert.doesNotMatch(problemText(code), retired, code);
});

// Edit is not timed: it stays on until the educator turns it off, so no copy gives it a length.
test("no code describes Edit access as having a length or an end time", () => {
  const timedEdit = /\bEdit (?:access )?(?:lengths?|durations?|time limits?|expir\w*|timers?)\b/i;
  for (const code of PROBLEM_CODES) assert.doesNotMatch(problemText(code), timedEdit, code);
  assert.match(problemCopy("edit_policy_status_unreadable").detail, /connected courses and their Edit access/);
});

// Morrow Bridge reconnects by itself with a saved connection once it is reloaded, and the popup
// shows no Connect Morrow button while one is saved.
test("a version mismatch sends the educator to the popup after the reload, not to Connect Morrow", () => {
  assert.doesNotMatch(problemText("bridge_version_mismatch"), /Connect Morrow/);
  assert.match(problemText("bridge_version_mismatch"), /Reload Morrow Bridge on the Chrome extensions page, then open the Morrow Bridge popup/);
});

test("each code reads as its own state rather than one repeated sentence", () => {
  const titles = PROBLEM_CODES.map((code) => problemCopy(code).title);
  assert.equal(new Set(titles).size, titles.length, "two codes share one title, so one of them names no state of its own");
  const actions = PROBLEM_CODES.map((code) => problemCopy(code).action);
  const repeated = actions.filter((action, index) => actions.indexOf(action) !== index);
  assert.deepEqual(repeated, [], "two codes offer the same next action");
});

test("every code bridge-18 names is explained", () => {
  for (const code of [...WORKER_ANSWER_CODES, ...POPUP_CODES, ...SETTINGS_CODES, ...OPERATION_CODES]) {
    assert.ok(PROBLEM_CODES.includes(code), `${code} has no copy, so a person would read the unknown-state fallback`);
  }
});

// messageCode() hands the popup and the setup guide any code the worker raises, so a raise the copy
// does not explain shows the educator the unknown-state fallback with an internal state name.
test("every code the service worker raises is explained, or is one it answers only to the Morrow app", () => {
  assert.ok(WORKER_THROWN_CODES.includes("bridge_not_connected"), "the worker's raised codes were not read from its source");
  const unexplained = WORKER_THROWN_CODES.filter((code) => {
    if (Object.hasOwn(MORROW_APP_CODES, code)) return false;
    const shown = Object.hasOwn(PRIVATE_CHAT_SEND_CODES, code) ? PRIVATE_CHAT_SEND_CODES[code] : code;
    return !PROBLEM_CODES.includes(shown);
  });
  assert.deepEqual(unexplained, [], "these codes reach a Morrow Bridge page as the unknown-state fallback");
  for (const [from, to] of Object.entries(PRIVATE_CHAT_SEND_CODES)) {
    assert.ok(PROBLEM_CODES.includes(to), `Private Chat translates ${from} to ${to}, which has no copy`);
  }
});

test("a code the worker answers only to the Morrow app is raised only where that list says", () => {
  for (const [code, functions] of Object.entries(MORROW_APP_CODES)) {
    assert.ok(WORKER_THROWN_CODES.includes(code), `${code} is no longer raised in the service worker, so it leaves this list`);
    assert.ok(!PROBLEM_CODES.includes(code), `${code} has page copy, so it is no longer one the worker answers only to the Morrow app`);
    assert.deepEqual(workerFunctionsRaising(code), [...functions].sort(), `${code} is raised somewhere a page request may reach`);
    for (const name of functions) {
      assert.doesNotMatch(PAGE_LISTENER, new RegExp(`\\b${name}\\b`), `${name} runs straight from a page request, so ${code} can reach a page`);
    }
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
  for (const code of WORKER_ANSWER_CODES) assert.ok(worker.includes(`"${code}"`), `${code} is no longer raised in the service worker`);
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
