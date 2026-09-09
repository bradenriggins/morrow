import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("the tucked-away drawer sends through an active relay and closing it clears local raw fields", async () => {
  const status = {
    catalogDigest: "c".repeat(64),
    bindingLimit: 500,
    editDurations: [{ value: 3_600_000, label: "1 hour" }],
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
  await page.click("#private-chat-open");
  assert.equal(page.hidden("#private-chat-drawer"), false);
  assert.equal(page.query("#private-chat-send").disabled, false);
  assert.match(page.text("#private-chat-status"), /^Ready\./u);
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
