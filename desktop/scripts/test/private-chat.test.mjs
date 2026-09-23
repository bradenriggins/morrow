import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test, { after } from "node:test";
import { clearExtensionGlobals, loadExtensionPage } from "./lib/extension-dom.mjs";
import {
  canvasProtectedRoster,
  protectLocalRequest,
  sourceProtectedRoster,
} from "../../connector/extension/src/protected-request.js";

const root = new URL("../../", import.meta.url);
const NOW = 2_000_000;
const MICHAELA = {
  id: 7,
  name: "Michaela Brook",
  sortable_name: "Brook, Michaela",
  short_name: "Michaela",
  email: "michaela.brook@example.edu",
  login_id: "mbrook",
  sis_user_id: "A1001",
  integration_id: "person-7",
};
const MORGAN = {
  id: 42,
  name: "Morgan Brook",
  sortable_name: "Brook, Morgan",
  short_name: "Morgan",
  email: "morgan.brook@example.edu",
  login_id: "mbrook2",
  sis_user_id: "A1002",
};

function roster(values = [MORGAN, MICHAELA]) {
  return sourceProtectedRoster(values);
}

function protect(text, assertedIdentifiers, fields = {}) {
  return protectLocalRequest({
    sourceBindingId: "canvas:course-89585",
    courseId: "89585",
    text,
    assertedIdentifiers,
    roster: roster(),
    rosterComplete: true,
    rosterFreshAt: NOW,
    now: NOW,
    ...fields,
  }).protectedText;
}

after(clearExtensionGlobals);

test("local protection replaces names and Canvas identifiers with stable course-local labels", () => {
  const protectedText = protect(
    "Review Michaela Brook at michaela.brook@example.edu, login mbrook, SIS A1001, and student #7.",
    ["Michaela Brook", "michaela.brook@example.edu", "mbrook", "A1001", "7"],
  );
  assert.equal(
    protectedText,
    "Review Student A1 at Student A1, login Student A1, SIS Student A1, and student #Student A1.",
  );
  assert.doesNotMatch(protectedText, /Michaela|Brook|example\.edu|mbrook|A1001|\b7\b/iu);

  const reordered = protectLocalRequest({
    sourceBindingId: "canvas:course-89585",
    courseId: "89585",
    text: "Compare Michaela Brook with Morgan Brook.",
    assertedIdentifiers: ["Michaela Brook", "Morgan Brook"],
    roster: roster([MICHAELA, MORGAN]),
    rosterComplete: true,
    rosterFreshAt: NOW,
    now: NOW,
  }).protectedText;
  assert.equal(reordered, "Compare Student A1 with Student A2.");
});

test("local protection keeps label bindings stable when the course roster changes", () => {
  const unused = { id: 99, name: "Taylor North", email: "taylor@example.edu" };
  const first = protectLocalRequest({
    sourceBindingId: "canvas:course-89585", courseId: "89585",
    text: "Review Morgan Brook.", assertedIdentifiers: ["Morgan Brook"],
    roster: roster([MORGAN, unused]), rosterComplete: true, rosterFreshAt: NOW, now: NOW,
  });
  const addedEarlierId = { id: 1, name: "Alex Lane", email: "alex@example.edu" };
  const second = protectLocalRequest({
    sourceBindingId: "canvas:course-89585", courseId: "89585",
    text: "Compare Morgan Brook with Alex Lane.", assertedIdentifiers: ["Morgan Brook", "Alex Lane"],
    roster: sourceProtectedRoster([addedEarlierId, MORGAN, unused]), rosterComplete: true, rosterFreshAt: NOW, now: NOW,
    labelsById: first.labelsById,
  });
  assert.equal(first.protectedText, "Review Student A1.");
  assert.deepEqual(first.labelsById, { 42: "Student A1" });
  assert.equal(second.protectedText, "Compare Student A1 with Student A2.");
  assert.deepEqual(second.labelsById, { 1: "Student A2", 42: "Student A1" });
  const followUp = protectLocalRequest({
    sourceBindingId: "canvas:course-89585", courseId: "89585",
    text: "Explain Student A1's result.", assertedIdentifiers: ["Student A1"],
    roster: sourceProtectedRoster([addedEarlierId, MORGAN, unused]), rosterComplete: true, rosterFreshAt: NOW, now: NOW,
    labelsById: second.labelsById,
  });
  assert.equal(followUp.protectedText, "Explain Student A1's result.");
});

test("local protection covers structured identity fields and more than one learner", () => {
  const input = JSON.stringify({
    student_id: 7,
    student_email: "michaela.brook@example.edu",
    note: "Compare Michaela Brook and Morgan Brook (A1002).",
  });
  const protectedText = protect(input, ["7", "michaela.brook@example.edu", "Michaela Brook", "Morgan Brook", "A1002"]);
  assert.deepEqual(JSON.parse(protectedText), {
    student_id: "Student A1",
    student_email: "Student A1",
    note: "Compare Student A1 and Student A2 (Student A2).",
  });
});

test("local protection preserves an ordinary score that equals a learner ID", () => {
  const protectedText = protect(
    "Michaela Brook scored 42 out of 50; student #7 needs review.",
    ["Michaela Brook"],
  );
  assert.equal(protectedText, "Student A1 scored 42 out of 50; student #Student A1 needs review.");

  const explicitId = protect("Compare student #42 with Michaela Brook.", ["42", "Michaela Brook"]);
  assert.equal(explicitId, "Compare student #Student A2 with Student A1.");
});

test("Canvas roster protection keeps a matching deleted learner and rejects mismatched history", () => {
  const deleted = [{
    course_id: 89585,
    type: "StudentEnrollment",
    enrollment_state: "deleted",
    user_id: 42,
    sis_user_id: "A1002",
    user: MORGAN,
  }];
  const combined = canvasProtectedRoster([MICHAELA], deleted, "89585");
  assert.deepEqual(combined.map((identity) => identity.id), ["7", "42"]);
  assert.throws(
    () => canvasProtectedRoster([MICHAELA], [{ ...deleted[0], course_id: 1 }], "89585"),
    /protected_request_roster_history_mismatch/,
  );
});

test("local protection fails closed for ambiguity, unknown data, stale or incomplete rosters, and existing labels", () => {
  assert.throws(() => protect("Review Brook.", ["Brook"]), /protected_request_identifier_ambiguous/);
  assert.throws(
    () => protect("Review Michaela Brook at stranger@example.edu.", ["Michaela Brook"]),
    /protected_request_identifier_unknown/,
  );
  assert.throws(
    () => protect("Review Michaela Brook.", ["Michaela Brook"], { rosterFreshAt: NOW - 60_001 }),
    /protected_request_roster_stale/,
  );
  assert.throws(
    () => protect("Review Michaela Brook.", ["Michaela Brook"], { rosterComplete: false }),
    /protected_request_roster_incomplete/,
  );
  assert.throws(
    () => protect("Compare Michaela Brook with student  A1.", ["Michaela Brook"]),
    /protected_request_existing_label_refused/,
  );
  assert.throws(
    () => protect("Review Michaela Brook.", ["michaela.brook@example.edu"]),
    /protected_request_assertion_missing/,
  );
});

const COURSE = [
  { id: 98765, name: "Jane Doe", sortable_name: "Doe, Jane", short_name: "Janie D", login_id: "jdoe", email: "jane.doe@school.edu", sis_user_id: "20231234" },
  { id: 55123, name: "José García", sortable_name: "García, José", login_id: "jgarcia", email: "jgarcia@school.edu" },
  { id: 44001, name: "Will Grant", sortable_name: "Grant, Will", login_id: "wgrant" },
  { id: 44002, name: "Mia Chen", sortable_name: "Chen, Mia" },
];

function protectCourse(text, assertedIdentifiers, fields = {}) {
  return protectLocalRequest({
    sourceBindingId: "canvas:course-1", courseId: "1", text, assertedIdentifiers,
    roster: canvasProtectedRoster(COURSE, [], "1"), rosterComplete: true, rosterFreshAt: NOW, now: NOW, ...fields,
  });
}

test("local protection matches a rostered name written without its accents, on both sides", () => {
  const unasserted = protectCourse("Jane Doe and Jose Garcia are failing", ["Jane Doe"]).protectedText;
  assert.doesNotMatch(unasserted, /Jos|Garc/iu);
  assert.match(unasserted, /^Student A\d+ and Student A\d+ are failing$/u);
  const asserted = protectCourse("Please review Jose Garcia.", ["Jose Garcia"]).protectedText;
  assert.match(asserted, /^Please review Student A\d+\.$/u);
  const accented = protectCourse("Please review José García.", ["Jose Garcia"]).protectedText;
  assert.equal(accented, asserted);
});

test("local protection replaces a rostered platform id written after a person word or bare", () => {
  const result = protectCourse("Jane Doe is user 98765 and 55123", ["Jane Doe"]);
  assert.doesNotMatch(result.protectedText, /98765|55123/u);
  assert.match(result.protectedText, /^(Student A\d+) is user \1 and Student A\d+$/u);
  assert.equal(protectCourse("Jane Doe scored 44 in module 44001", ["Jane Doe"]).protectedText.endsWith("in module 44001"), true);
});

// A student number or a numeric login names one student as surely as the platform id does.
const NUMBERED_COURSE = [
  { id: 98765, name: "Jane Doe", sortable_name: "Doe, Jane", login_id: "jdoe", email: "jane.doe@school.edu", sis_user_id: "20231234" },
  { id: 55123, name: "José García", sortable_name: "García, José", login_id: "70011222", email: "jgarcia@school.edu", sis_user_id: "20239876" },
  { id: 44001, name: "Will Grant", sortable_name: "Grant, Will", login_id: "wgrant", integration_id: "30004444" },
];

function protectNumbered(text, assertedIdentifiers) {
  return protectLocalRequest({
    sourceBindingId: "canvas:course-1", courseId: "1", text, assertedIdentifiers,
    roster: canvasProtectedRoster(NUMBERED_COURSE, [], "1"), rosterComplete: true, rosterFreshAt: NOW, now: NOW,
  });
}

test("local protection replaces a rostered student number or numeric login the educator did not list", () => {
  const cases = [
    ["Jane Doe and 98765 both missed the lab.", /^(Student A\d+) and \1 both missed the lab\.$/u],
    ["Jane Doe and 20239876 both missed the lab.", /^Student A\d+ and Student A\d+ both missed the lab\.$/u],
    ["Jane Doe and 70011222 both missed the lab.", /^Student A\d+ and Student A\d+ both missed the lab\.$/u],
    ["Jane Doe's student number is 20231234.", /^(Student A\d+)'s student number is \1\.$/u],
    ["Jane Doe and student 30004444 need more time.", /^Student A\d+ and student Student A\d+ need more time\.$/u],
  ];
  for (const [text, expected] of cases) {
    const result = protectNumbered(text, ["Jane Doe"]);
    assert.match(result.protectedText, expected, text);
    assert.doesNotMatch(result.protectedText, /98765|20239876|70011222|20231234|30004444/u, text);
  }
  const garcia = protectNumbered("Jane Doe and 20239876 both missed the lab.", ["Jane Doe"]);
  const login = protectNumbered("Jane Doe and 70011222 both missed the lab.", ["Jane Doe"]);
  assert.equal(garcia.protectedText, login.protectedText, "a student number and a login of one student get one label");
  // A number written after a course word stays a course number.
  assert.equal(protectNumbered("Jane Doe is in section 20239876.", ["Jane Doe"]).protectedText.endsWith("in section 20239876."), true);
});

test("local protection refuses a number that is an identifier of two different students", () => {
  const shared = [
    { id: 98765, name: "Jane Doe", sortable_name: "Doe, Jane", sis_user_id: "55123" },
    { id: 55123, name: "José García", sortable_name: "García, José" },
  ];
  assert.throws(() => protectLocalRequest({
    sourceBindingId: "canvas:course-1", courseId: "1", text: "Jane Doe and 55123 both missed the lab.", assertedIdentifiers: ["Jane Doe"],
    roster: canvasProtectedRoster(shared, [], "1"), rosterComplete: true, rosterFreshAt: NOW, now: NOW,
  }), /protected_request_identifier_ambiguous/);
});

test("local protection does not turn common words that match a lone name part into labels", () => {
  const ordinary = protectCourse("Jane Doe will get a grant for this", ["Jane Doe"]);
  assert.match(ordinary.protectedText, /^Student A\d+ will get a grant for this$/u);
  assert.deepEqual(ordinary.unmatchedNames, []);
  const fullName = protectCourse("Will Grant needs help, and so does Jane Doe.", ["Will Grant", "Jane Doe"]).protectedText;
  assert.doesNotMatch(fullName, /Will|Grant/u);
  const surname = protectCourse("Ask Grant about Jane Doe.", ["Jane Doe"]).protectedText;
  assert.doesNotMatch(surname, /Grant/u);
});

test("local protection reports name-like words it could not match instead of passing them silently", () => {
  const nickname = protectCourse("Jane Doe (goes by Janey) and Bobby Smith are failing", ["Jane Doe"]);
  assert.deepEqual(nickname.unmatchedNames, ["Janey", "Bobby Smith"]);
  const typo = protectCourse("Jane Doe and Mia Chenn", ["Jane Doe"]);
  assert.deepEqual(typo.unmatchedNames, ["Chenn"]);
  const sentenceStart = protectCourse("Will you check Jane Doe? Grant needs one too.", ["Jane Doe"]);
  assert.deepEqual(sentenceStart.unmatchedNames, ["Will", "Grant"]);
  assert.deepEqual(protectCourse("\"Will you check Jane Doe?\"\nGrant asked.", ["Jane Doe"]).unmatchedNames, ["Will", "Grant"]);
  const plain = protectCourse("On Monday, check Jane Doe in Canvas. The Module 2 quiz is late.", ["Jane Doe"]);
  assert.deepEqual(plain.unmatchedNames, []);
});

test("the tucked-away drawer sends through an active relay and closing it clears local raw fields", async () => {
  const status = {
    catalogDigest: "c".repeat(64),
    bindingLimit: 500,
    siteAnchors: [],
    bindings: [{
      sourceBindingId: "canvas:course-89585",
      provider: "canvas",
      origin: "https://canvas.example.edu",
      siteUrl: "https://canvas.example.edu",
      principalId: "teacher@example.edu",
      courseId: "89585",
      courseName: "Biology",
      runtimeVerified: true,
      editPolicyRevision: 0,
    }],
    privateChat: {
      schema: "morrow.private-chat.status.v1",
      transportAvailable: true,
      clients: [{ id: "assistant-1", name: "Desktop assistant", protocolVersion: "2025-06-18", sampling: true, pushSampling: true }],
    },
  };
  const page = await loadExtensionPage("settings/settings.html", {
    handlers: {
      morrow_edit_policy_status: () => status,
      morrow_private_chat_send: () => ({ status: "sent" }),
      morrow_private_chat_close: () => ({ status: "closed" }),
    },
  });
  assert.equal(page.hidden("#private-chat-drawer"), true);
  const opener = page.query("#private-chat-open");
  const background = page.query("main");
  opener.focus();
  await page.click("#private-chat-open");
  assert.equal(page.hidden("#private-chat-drawer"), false);
  assert.equal(background.hasAttribute("inert"), true);
  assert.equal(opener.getAttribute("aria-expanded"), "true");
  assert.equal(page.document.activeElement, page.query("#private-chat-close"));
  assert.equal(page.query("#private-chat-send").disabled, false);
  assert.match(page.text("#private-chat-status"), /^Ready\./u);
  const backwards = {
    type: "keydown", key: "Tab", shiftKey: true, prevented: false,
    preventDefault() { this.prevented = true; }, stopPropagation() {},
  };
  page.document.dispatchEvent(backwards);
  assert.equal(backwards.prevented, true);
  assert.equal(page.document.activeElement, page.query("#private-chat-send"));
  const forwards = {
    type: "keydown", key: "Tab", shiftKey: false, prevented: false,
    preventDefault() { this.prevented = true; }, stopPropagation() {},
  };
  page.document.dispatchEvent(forwards);
  assert.equal(forwards.prevented, true);
  assert.equal(page.document.activeElement, page.query("#private-chat-close"));
  await page.type("#private-chat-identifiers", "Michaela Brook");
  await page.type("#private-chat-message", "Review Michaela Brook.");
  await page.click("#private-chat-send");
  assert.equal(page.messages("morrow_private_chat_send").length, 1);
  assert.deepEqual(page.messages("morrow_private_chat_send")[0], {
    type: "morrow_private_chat_send",
    sourceBindingId: "canvas:course-89585",
    text: "Review Michaela Brook.",
    assertedIdentifiers: ["Michaela Brook"],
  });
  await page.click("#private-chat-close");
  assert.equal(page.hidden("#private-chat-drawer"), true);
  assert.equal(background.hasAttribute("inert"), false);
  assert.equal(opener.getAttribute("aria-expanded"), "false");
  assert.equal(page.document.activeElement, opener);
  assert.equal(page.query("#private-chat-identifiers").value, "");
  assert.equal(page.query("#private-chat-message").value, "");
  assert.equal(page.text("#private-chat-history"), "No messages in this local conversation.");
  assert.equal(page.messages("morrow_private_chat_close").length, 1);
});

test("the service worker exposes only the authenticated Private chat relay and protects before Bridge result", () => {
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /message\.kind === "private_chat_exchange"\) await handlePrivateChatExchange\(message\)/u);
  assert.match(worker, /const protectedRequest = protectLocalRequest\([\s\S]*const protectedText = protectedRequest\.protectedText[\s\S]*sendResult\(command, true, \{[\s\S]*protectedText/u);
  assert.match(worker, /message\?\.type === "morrow_private_chat_send" \? \(\) => submitPrivateChatMessage/u);
  assert.match(worker, /privateChatClosed[\s\S]*status: "closed"/u);
  assert.doesNotMatch(worker, /chrome\.storage\.local\.(?:set|remove)\([^\n]*privateChat/u);
});

test("the service worker clears only the exact cancelled Private Chat request", () => {
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const start = worker.indexOf("function handleBridgeCancellation(message)");
  const end = worker.indexOf("\nasync function privateChatRoster", start);
  assert.ok(start >= 0 && end > start);
  const pending = {
    requestId: "bridge:request-1234",
    operationId: "private-chat:operation-1234",
    generation: 7,
  };
  const context = {
    state: { generation: 7, privateChat: { pending }, bridgeCommands: new Map() },
    PROTOCOL_VERSION: 1,
    cleared: 0,
    results: [],
    problem(code, message, recoverable) { return { code, message, recoverable }; },
    sendResult(command, ok, result, failure) { context.results.push({ command, ok, result, failure }); },
    clearPrivateChat() {
      context.cleared += 1;
      context.state.privateChat = null;
    },
  };
  vm.runInNewContext(`${worker.slice(start, end)}\nglobalThis.cancel = handleBridgeCancellation;`, context);
  const exact = {
    schema: "morrow.bridge.cancel.v1",
    protocolVersion: 1,
    requestId: pending.requestId,
    operationId: pending.operationId,
    generation: 7,
    cancelledAt: Date.now(),
  };
  context.cancel({ ...exact, requestId: "bridge:different-1234" });
  assert.equal(context.cleared, 0);
  assert.ok(context.state.privateChat);
  context.cancel(exact);
  assert.equal(context.cleared, 1);
  assert.equal(context.state.privateChat, null);
  assert.equal(context.results.at(-1).failure.code, "bridge_request_cancelled");

  const queuedWrite = { ...pending, operationId: "operation:queued-write-1234", kind: "invoke_write" };
  const queued = { command: queuedWrite, cancelled: false, effectPossible: false, resultSent: false };
  context.state.bridgeCommands.set(queuedWrite.requestId, queued);
  context.cancel({ ...exact, operationId: queuedWrite.operationId });
  assert.equal(queued.cancelled, true);
  assert.equal(context.results.at(-1).failure.code, "request_cancelled_before_dispatch");

  const startedWrite = { ...pending, requestId: "bridge:started-1234", operationId: "operation:started-write-1234", kind: "invoke_write" };
  const started = { command: startedWrite, cancelled: false, effectPossible: true, resultSent: false };
  context.state.bridgeCommands.set(startedWrite.requestId, started);
  context.cancel({ ...exact, requestId: startedWrite.requestId, operationId: startedWrite.operationId });
  assert.equal(started.cancelled, true);
  assert.equal(context.results.at(-1).failure.code, "write_outcome_unknown");
});

function privateChatWorker() {
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  const start = worker.indexOf("function privateChatStatus()");
  const end = worker.indexOf("\nfunction editPermissionSummary", start);
  assert.ok(start >= 0 && end > start);
  const sent = [];
  const context = {
    state: { generation: 3, privateChat: null, privateChatClosed: null, courseDataAuthorityGeneration: 1, operations: new Map([
      ["canvas_list_users_in_course_users", { name: "canvas_list_users_in_course_users" }],
      ["canvas_list_enrollments_courses", { name: "canvas_list_enrollments_courses" }],
    ]) },
    sent,
    chrome: { runtime: { sendMessage: async () => undefined } },
    setTimeout, clearTimeout, Date, Promise, Error, Object, Array, Number, String, Set, Map, JSON, RegExp,
    protectLocalRequest, canvasProtectedRoster, sourceProtectedRoster,
    problem(code, message, recoverable) { return { code, message, recoverable }; },
    sendResult(command, ok, result, failure) { sent.push({ command, ok, result, failure }); },
    async courseDataAuthorityCurrent() { return true; },
    async catalog() {},
    async bindingFor(id) {
      return { sourceBindingId: id, provider: "canvas", courseId: "1", runtimeVerified: true };
    },
    async executeOperation(_binding, operation) {
      return operation.name === "canvas_list_users_in_course_users"
        ? { ok: true, truncated: false, data: COURSE }
        : { ok: true, truncated: false, data: [] };
    },
  };
  vm.runInNewContext(`${worker.slice(start, end)}
globalThis.api = { handlePrivateChatExchange, submitPrivateChatMessage, privateChatStatus, clearPrivateChat };`, context);
  let request = 0;
  const command = (args) => ({
    requestId: `bridge:request-${++request}`, operationId: `private-chat:operation-${request}`, generation: 3,
    expiresAt: Date.now() + 60_000,
    arguments: { schema: "morrow.private-chat.exchange.v1", sessionId: "session-12345678", assistantName: "Desktop assistant", ...args },
  });
  return { api: context.api, sent, command };
}

test("Private Chat takes each student's label from the gateway and shows the educator real names", async () => {
  const { api, sent, command } = privateChatWorker();
  await api.handlePrivateChatExchange(command({ action: "listen" }));
  const submitted = api.submitPrivateChatMessage("canvas:course-1", "Extend Jane Doe's due date. Will Grant too.", ["Jane Doe", "Will Grant"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = sent.at(-1);
  assert.equal(request.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(request.result)), {
    schema: "morrow.private-chat.exchange.v1", status: "labels_required", sessionId: "session-12345678",
    sourceBindingId: "canvas:course-1", courseId: "1", learnerIds: ["44001", "98765"],
  });
  await api.handlePrivateChatExchange(command({
    action: "labels", sourceBindingId: "canvas:course-1", courseId: "1",
    labelsById: { 98765: "Student A1", 44001: "Student A3" },
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(await submitted)), { status: "sent" });
  const message = sent.at(-1).result;
  assert.equal(message.status, "message");
  assert.equal(message.protectedText, "Extend Student A1's due date. Student A3 too.");
  // Only ids reach the gateway, to ask for labels; no name leaves the Bridge.
  assert.doesNotMatch(JSON.stringify(sent), /Jane|Doe|Will|Grant|jdoe|school\.edu/u);

  await api.handlePrivateChatExchange(command({
    action: "reply_and_listen", sourceBindingId: "canvas:course-1", courseId: "1",
    assistantReply: "Student A1 now has until Friday; Student A3 still needs one.",
  }));
  const status = JSON.parse(JSON.stringify(api.privateChatStatus()));
  assert.deepEqual(status.messages.map((entry) => entry.text), [
    "Extend Student A1's due date. Student A3 too.",
    "Student A1 now has until Friday; Student A3 still needs one.",
  ]);
  assert.deepEqual(status.messages[1].parts, [
    { name: "Jane Doe", label: "Student A1" }, { text: " now has until Friday; " },
    { name: "Will Grant", label: "Student A3" }, { text: " still needs one." },
  ]);
  api.clearPrivateChat({ answerPending: true });
  assert.equal(api.privateChatStatus().messages.length, 0);
});

// The gateway sends the last reply a session allows as reply_at_limit. The Bridge shows it, ends the
// chat, and takes no further message, so no educator message is left without an answer.
test("Private Chat shows the last reply at the limit, ends the chat, and takes no further message", async () => {
  const { api, sent, command } = privateChatWorker();
  await api.handlePrivateChatExchange(command({ action: "listen" }));
  const submitted = api.submitPrivateChatMessage("canvas:course-1", "Extend Jane Doe's due date.", ["Jane Doe"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await api.handlePrivateChatExchange(command({
    action: "labels", sourceBindingId: "canvas:course-1", courseId: "1", labelsById: { 98765: "Student A1" },
  }));
  await submitted;
  await api.handlePrivateChatExchange(command({
    action: "reply_at_limit", sourceBindingId: "canvas:course-1", courseId: "1",
    assistantReply: "Student A1 now has until Friday.",
  }));
  const ended = sent.at(-1);
  assert.equal(ended.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(ended.result)), { schema: "morrow.private-chat.exchange.v1", status: "closed" });
  const status = JSON.parse(JSON.stringify(api.privateChatStatus()));
  assert.equal(status.ended, true);
  assert.equal(status.transportAvailable, false);
  assert.deepEqual(status.messages.map((entry) => entry.text), ["Extend Student A1's due date.", "Student A1 now has until Friday."]);
  await assert.rejects(api.submitPrivateChatMessage("canvas:course-1", "One more thing for Jane Doe.", ["Jane Doe"]), /private_chat_start_required/u);
  const before = sent.length;
  await api.handlePrivateChatExchange(command({
    action: "reply_and_listen", sourceBindingId: "canvas:course-1", courseId: "1", assistantReply: "Another reply.",
  }));
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).failure.code, "private_chat_scope_changed");
  assert.equal(api.privateChatStatus().messages.length, 2);

  // A new Private Chat the assistant starts replaces the ended one instead of reporting it busy.
  const next = command({ action: "listen" });
  next.arguments.sessionId = "session-87654321";
  await api.handlePrivateChatExchange(next);
  const restarted = JSON.parse(JSON.stringify(api.privateChatStatus()));
  assert.equal(restarted.ended, false);
  assert.equal(restarted.transportAvailable, true);
  assert.deepEqual(restarted.messages, []);
});

test("Private Chat asks the educator to confirm name-like words it could not match before sending", async () => {
  const { api, sent, command } = privateChatWorker();
  await api.handlePrivateChatExchange(command({ action: "listen" }));
  const before = sent.length;
  const review = await api.submitPrivateChatMessage("canvas:course-1", "Compare Mia Chen with Bobby Smith.", ["Mia Chen"]);
  assert.deepEqual(JSON.parse(JSON.stringify(review)), { status: "review", names: ["Bobby Smith"] });
  assert.equal(sent.length, before);
  const submitted = api.submitPrivateChatMessage("canvas:course-1", "Compare Mia Chen with Bobby Smith.", ["Mia Chen"], ["Bobby Smith"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...sent.at(-1).result.learnerIds], ["44002"]);
  await assert.rejects(api.handlePrivateChatExchange(command({
    action: "labels", sourceBindingId: "canvas:course-1", courseId: "1", labelsById: { 44001: "Student A3" },
  })).then(() => submitted), /private_chat_labels_invalid/u);
});

test("the drawer shows the educator real names and asks before sending unmatched names", async () => {
  const status = {
    catalogDigest: "c".repeat(64), bindingLimit: 500, siteAnchors: [],
    bindings: [{
      sourceBindingId: "canvas:course-1", provider: "canvas", origin: "https://canvas.example.edu",
      siteUrl: "https://canvas.example.edu", principalId: "teacher@example.edu", courseId: "1",
      courseName: "Biology", runtimeVerified: true, editPolicyRevision: 0,
    }],
    privateChat: {
      schema: "morrow.private-chat.status.v1", transportAvailable: true,
      clients: [{ id: "assistant-1", name: "Desktop assistant", protocolVersion: "2025-06-18", sampling: true, pushSampling: true }],
      sourceBindingId: "canvas:course-1", courseId: "1",
      messages: [
        { role: "user", text: "Extend Student A1's due date.", parts: [{ text: "Extend " }, { name: "Jane <Doe>", label: "Student A1" }, { text: "'s due date." }] },
        { role: "assistant", text: "Student A1 now has until Friday.", parts: [{ name: "Jane <Doe>", label: "Student A1" }, { text: " now has until Friday." }] },
      ],
    },
  };
  let sends = 0;
  const page = await loadExtensionPage("settings/settings.html", {
    handlers: {
      morrow_edit_policy_status: () => status,
      morrow_private_chat_send: () => (++sends === 1 ? { status: "review", names: ["Bobby Smith"] } : { status: "sent" }),
      morrow_private_chat_close: () => ({ status: "closed" }),
    },
  });
  await page.click("#private-chat-open");
  const history = page.query("#private-chat-history").innerHTML;
  assert.match(history, /Jane &lt;Doe&gt;/u);
  assert.match(history, /title="The assistant sees Student A1"/u);
  assert.doesNotMatch(page.text("#private-chat-history"), /Student A1/u);
  await page.type("#private-chat-identifiers", "Mia Chen");
  await page.type("#private-chat-message", "Compare Mia Chen with Bobby Smith.");
  await page.click("#private-chat-send");
  assert.match(page.text("#private-chat-status"), /Bobby Smith/u);
  assert.equal(page.query("#private-chat-message").value, "Compare Mia Chen with Bobby Smith.");
  assert.equal(page.messages("morrow_private_chat_send")[0].confirmedNames, undefined);
  await page.click("#private-chat-send");
  assert.deepEqual(page.messages("morrow_private_chat_send")[1].confirmedNames, ["Bobby Smith"]);
  assert.equal(page.query("#private-chat-message").value, "");
});

// After a send the chat keeps running while the assistant answers. It is not a chat that needs starting.
test("the drawer says a sent message waits for the assistant's reply, and asks to start a chat only when none exists", async () => {
  const binding = { sourceBindingId: "canvas:course-89585", provider: "canvas", origin: "https://canvas.example.edu", courseId: "89585", courseName: "Biology", runtimeVerified: true, editPolicyRevision: 0 };
  const client = { id: "session-12345678", name: "Claude Desktop", protocolVersion: "2026-07-28", sampling: true, pushSampling: false };
  const sent = {
    schema: "morrow.private-chat.status.v1", transportAvailable: false, waitingForMessage: false, clients: [client],
    messages: [{ role: "user", text: "Review Student A1's missing work.", parts: [{ text: "Review " }, { name: "Michaela Brook", label: "Student A1" }, { text: "'s missing work." }] }],
    sourceBindingId: binding.sourceBindingId, courseId: "89585", code: "private_chat_start_required",
  };
  const none = { schema: "morrow.private-chat.status.v1", transportAvailable: false, waitingForMessage: false, clients: [], messages: [], code: "private_chat_start_required" };
  let privateChat = sent;
  const page = await loadExtensionPage("settings/settings.html", {
    handlers: { morrow_edit_policy_status: () => ({ bindings: [binding], catalogDigest: "c".repeat(64), siteAnchors: [], bindingLimit: 500, privateChat }) },
  });
  await page.click("#private-chat-open");
  assert.equal(page.text("#private-chat-status"), "Sent. Waiting for the assistant's reply. Keep this drawer open.");
  assert.equal(page.query("#private-chat-message").disabled, true);
  privateChat = none;
  await page.click("#refresh");
  await page.waitFor(() => page.text("#private-chat-status") !== "Sent. Waiting for the assistant's reply. Keep this drawer open.", "the drawer kept the waiting line after the chat ended");
  assert.equal(page.text("#private-chat-status"), "Ask the connected assistant to start Morrow Private Chat. Keep this drawer open while you chat.");
  // A chat that reached its message limit keeps its last reply in view and says how to continue.
  privateChat = { ...sent, ended: true, messages: [...sent.messages, { role: "assistant", text: "Student A1 has two missing labs.", parts: [{ name: "Michaela Brook", label: "Student A1" }, { text: " has two missing labs." }] }] };
  await page.click("#refresh");
  await page.waitFor(() => page.text("#private-chat-status").startsWith("This Private Chat"), "the drawer did not show that the chat ended");
  assert.equal(page.text("#private-chat-status"), "This Private Chat reached its message limit. Close this drawer, then ask your assistant to start a new Private Chat.");
  assert.equal(page.query("#private-chat-message").disabled, true);
  assert.match(page.text("#private-chat-history"), /Michaela Brook has two missing labs\./u);
});
