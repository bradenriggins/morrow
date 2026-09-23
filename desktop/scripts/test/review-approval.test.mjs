import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  parseReviewApprovalPresence,
  reviewApprovalProof,
  reviewPagePath,
  signReviewApproval,
} from "../../connector/extension/src/review-approval.js";

const EXTENSION_ID = "a".repeat(32);
const presence = { origin: "http://127.0.0.1:44300", key: randomBytes(32).toString("base64url") };
const pagePath = "/operations/op%3Areview-1234";
const approvePath = `${pagePath}/approve`;
const nonce = randomBytes(32).toString("base64url");
const sender = { id: EXTENSION_ID, tab: { id: 7 }, frameId: 0, origin: presence.origin, url: `${presence.origin}${pagePath}` };

function serverProof(key, path, value) {
  return createHmac("sha256", Buffer.from(key, "base64url")).update(`morrow.review-approval.v1\n${path}\n${value}`).digest("base64url");
}

test("signs exactly what the review server checks", async () => {
  assert.equal(await reviewApprovalProof(presence.key, approvePath, nonce), serverProof(presence.key, approvePath, nonce));
  const signed = await signReviewApproval({ approvePath, nonce }, sender, presence, EXTENSION_ID);
  assert.deepEqual(signed, { ok: true, presence: serverProof(presence.key, approvePath, nonce) });
});

test("signs only for its own content script in the top frame of a review at the key's origin", async () => {
  const refused = async (overrides, message = { approvePath, nonce }) => {
    const result = await signReviewApproval(message, { ...sender, ...overrides }, presence, EXTENSION_ID);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    return result.code;
  };
  assert.equal(await refused({ id: "b".repeat(32) }), "review_approval_sender_refused");
  assert.equal(await refused({ tab: undefined }), "review_approval_sender_refused");
  assert.equal(await refused({ frameId: 3 }), "review_approval_sender_refused");
  assert.equal(await refused({ origin: "http://127.0.0.1:9999", url: `http://127.0.0.1:9999${pagePath}` }), "review_approval_sender_refused");
  assert.equal(await refused({ url: `${presence.origin}/recent` }), "review_approval_sender_refused");
  assert.equal(await refused({ url: `${presence.origin}${pagePath}?next=1` }), "review_approval_sender_refused");
  assert.equal(await refused({}, { approvePath: "/operations/op%3Aother/approve", nonce }), "review_approval_request_invalid");
  assert.equal(await refused({}, { approvePath, nonce: "short" }), "review_approval_request_invalid");
  const missing = await signReviewApproval({ approvePath, nonce }, sender, null, EXTENSION_ID);
  assert.deepEqual(missing, { ok: false, code: "review_approval_key_missing" });
});

// A person closes a change Morrow could not settle from that change's own page, with the same
// signed click as an approval. The Bridge signs no other action, and no close for a group.
test("signs the close form of the change's own page, and no other action", async () => {
  const closePath = `${pagePath}/close`;
  assert.deepEqual(await signReviewApproval({ approvePath: closePath, nonce }, sender, presence, EXTENSION_ID),
    { ok: true, presence: serverProof(presence.key, closePath, nonce) });
  for (const path of [`${pagePath}/cancel`, `${pagePath}/status`, "/operations/op%3Aother/close"]) {
    assert.equal((await signReviewApproval({ approvePath: path, nonce }, sender, presence, EXTENSION_ID)).code, "review_approval_request_invalid", path);
  }
  const batchPage = "/batches/batch-1234";
  const batchSender = { ...sender, url: `${presence.origin}${batchPage}` };
  assert.equal((await signReviewApproval({ approvePath: `${batchPage}/close`, nonce }, batchSender, presence, EXTENSION_ID)).code, "review_approval_request_invalid");
  assert.equal((await signReviewApproval({ approvePath: `${batchPage}/approve`, nonce }, batchSender, presence, EXTENSION_ID)).ok, true);
});

test("accepts only a loopback review origin and a 32-byte key", () => {
  assert.deepEqual(parseReviewApprovalPresence(presence), presence);
  for (const bad of [
    null,
    { ...presence, origin: "http://localhost:44300" },
    { ...presence, origin: "http://127.0.0.1" },
    { ...presence, key: "x" },
    { ...presence, extra: 1 },
  ]) assert.throws(() => parseReviewApprovalPresence(bad), /ui_state_invalid/);
  assert.equal(reviewPagePath(`${presence.origin}${pagePath}`, presence), pagePath);
  assert.equal(reviewPagePath(`${presence.origin}/batches/batch-1234`, presence), "/batches/batch-1234");
  assert.equal(reviewPagePath(`${presence.origin}/recent`, presence), null);
  assert.equal(reviewPagePath("not a url", presence), null);
});

const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/review-approval-content.js", import.meta.url), "utf8");

/** A small DOM with one approve form and one cancel form, enough for the content script's submit handler. */
function reviewTab(response) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(child) { child.parentElement = this; this.children.push(child); }
    after(node) { this.parentElement.append(node); }
    get lastElementChild() { return this.children.at(-1); }
    querySelectorAll(selector) {
      const all = [];
      const walk = (node) => node.children.forEach((child) => { all.push(child); walk(child); });
      walk(this);
      if (selector === "button") return all.filter((node) => node.tag === "button");
      if (selector === ".review-approval-problem") return all.filter((node) => String(node.className).includes("review-approval-problem"));
      if (selector === 'input[name="nonce"]') return all.filter((node) => node.tag === "input" && node.name === "nonce");
      return all.filter((node) => node.tag === "input" && (node.name === "presence" || node.dataset.morrowSubmitter));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class HTMLFormElement extends Element {}
  class HTMLButtonElement extends Element {}
  const posted = [];
  HTMLFormElement.prototype.submit = function submit() {
    posted.push(Object.fromEntries(this.children.filter((node) => node.tag === "input").map((node) => [node.name, node.value])));
  };
  const listeners = [];
  const container = new Element("div");
  const form = new HTMLFormElement("form");
  form.setAttribute("action", approvePath);
  const nonceInput = new Element("input");
  nonceInput.name = "nonce";
  nonceInput.value = nonce;
  form.append(nonceInput);
  const approve = new HTMLButtonElement("button");
  const remember = new HTMLButtonElement("button");
  remember.name = "remember";
  remember.value = "1";
  form.append(approve);
  form.append(remember);
  container.append(form);
  const cancel = new HTMLFormElement("form");
  cancel.setAttribute("action", `${pagePath}/cancel`);
  const messages = [];
  const nameRequests = [];
  const context = {
    HTMLFormElement,
    HTMLButtonElement,
    URL,
    location: { href: `${presence.origin}${pagePath}` },
    document: {
      addEventListener: (type, listener) => listeners.push({ type, listener }),
      createElement: (tag) => new Element(tag),
    },
    chrome: { runtime: {
      sendMessage: async (message) => {
        // The script also asks once for the learner names on its page; this review has none.
        if (message?.type === "morrow_review_learner_names") {
          nameRequests.push(message);
          return { ok: true, names: {} };
        }
        messages.push(message);
        return response;
      },
      onMessage: { addListener: () => undefined },
    } },
  };
  context.globalThis = context;
  runInNewContext(CONTENT_SOURCE, context);
  const submit = async (target, { isTrusted, submitter = approve }) => {
    const event = { target, isTrusted, submitter, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
    for (const { type, listener } of listeners) if (type === "submit") listener(event);
    await new Promise((resolve) => setImmediate(resolve));
    return event;
  };
  return { form, cancel, remember, container, posted, messages, nameRequests, submit };
}

test("adds the signature only after a person's own click, and keeps the chosen button", async () => {
  const tab = reviewTab({ ok: true, presence: "signed-value" });
  const event = await tab.submit(tab.form, { isTrusted: true, submitter: tab.remember });
  assert.equal(event.prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(tab.messages)), [{ type: "morrow_review_approval_sign", approvePath, nonce }]);
  assert.deepEqual(JSON.parse(JSON.stringify(tab.posted)), [{ nonce, presence: "signed-value", remember: "1" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(tab.nameRequests)), [{ type: "morrow_review_learner_names" }]);
});

test("never asks the Bridge to sign a submit that a script started", async () => {
  const tab = reviewTab({ ok: true, presence: "signed-value" });
  const event = await tab.submit(tab.form, { isTrusted: false });
  assert.equal(event.prevented, true, "an untrusted submit must not reach the server either");
  assert.deepEqual(tab.messages, []);
  assert.deepEqual(tab.posted, []);
});

test("leaves every other form alone", async () => {
  const tab = reviewTab({ ok: true, presence: "signed-value" });
  const event = await tab.submit(tab.cancel, { isTrusted: true });
  assert.equal(event.prevented, false);
  assert.deepEqual(tab.messages, []);
});

test("signs a person's own click on the close form, and says a failed close closed nothing", async () => {
  const tab = reviewTab({ ok: true, presence: "signed-close" });
  tab.form.setAttribute("action", `${pagePath}/close`);
  await tab.submit(tab.form, { isTrusted: true });
  assert.deepEqual(JSON.parse(JSON.stringify(tab.messages)), [{ type: "morrow_review_approval_sign", approvePath: `${pagePath}/close`, nonce }]);
  assert.deepEqual(JSON.parse(JSON.stringify(tab.posted)), [{ nonce, presence: "signed-close" }]);
  const refused = reviewTab({ ok: false, code: "review_approval_key_missing" });
  refused.form.setAttribute("action", `${pagePath}/close`);
  await refused.submit(refused.form, { isTrusted: true });
  assert.deepEqual(refused.posted, []);
  assert.match(refused.container.querySelector(".review-approval-problem").textContent, /^Morrow Bridge could not confirm this click\..*Nothing was closed\.$/);
  const scripted = reviewTab({ ok: true, presence: "signed-close" });
  scripted.form.setAttribute("action", `${pagePath}/close`);
  await scripted.submit(scripted.form, { isTrusted: false });
  assert.deepEqual(scripted.messages, []);
});

test("says so in the page and sends nothing when the Bridge cannot sign", async () => {
  const tab = reviewTab({ ok: false, code: "review_approval_key_missing" });
  await tab.submit(tab.form, { isTrusted: true });
  assert.deepEqual(tab.posted, []);
  const note = tab.container.querySelector(".review-approval-problem");
  assert.match(note.textContent, /^Morrow Bridge could not confirm this approval\..*Nothing was approved\.$/);
});
