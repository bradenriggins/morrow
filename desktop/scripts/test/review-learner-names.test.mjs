import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { launchTestChromium } from "./lib/chromium-launch.mjs";
import {
  clearReviewLearnerNames,
  handleReviewLearnerNamesMessage,
  parseReviewLearnerNames,
  reviewLearnerNamesFor,
  storeReviewLearnerNames,
} from "../../connector/extension/src/review-approval.js";

/**
 * The review server shows learners by label only, because any local program can read it. The
 * runtime sends the label-to-name map to Morrow Bridge over the paired connection. The Bridge
 * keeps it in session storage and gives it only to its own content script in the review tab for
 * that exact review, which shows "Name (Student A1)" in the page text and nowhere else.
 */

const EXTENSION_ID = "a".repeat(32);
const presence = { origin: "http://127.0.0.1:44300", key: "k".repeat(43) };
const entry = { path: "/operations/op:review-1234", names: { "Student A1": "Jane Doe", "Student A2": "<b>Ana</b> Rivera" } };
const sender = { id: EXTENSION_ID, tab: { id: 7 }, frameId: 0, origin: presence.origin, url: `${presence.origin}/operations/op%3Areview-1234` };

test("accepts only an exact, bounded label-to-name map for a review path", () => {
  assert.deepEqual(parseReviewLearnerNames([entry]), [entry]);
  assert.deepEqual(parseReviewLearnerNames(undefined), []);
  for (const bad of [
    entry,
    [{ ...entry, extra: 1 }],
    [{ ...entry, path: "/recent" }],
    [{ ...entry, path: "/operations/op%3Areview-1234" }],
    [{ ...entry, names: {} }],
    [{ ...entry, names: { "Student B1": "Jane Doe" } }],
    [{ ...entry, names: { "Student A1": "" } }],
    [{ ...entry, names: { "Student A1": "x".repeat(121) } }],
    [entry, entry],
    Array.from({ length: 21 }, (_, index) => ({ ...entry, path: `/operations/op:review-${1000 + index}` })),
  ]) assert.throws(() => parseReviewLearnerNames(bad), /ui_state_invalid/, JSON.stringify(bad).slice(0, 80));
});

test("gives a review's names only to its own content script in the top frame of that review", () => {
  assert.deepEqual(reviewLearnerNamesFor(sender, [entry], presence, EXTENSION_ID), { ok: true, names: entry.names });
  const other = { path: "/operations/op:other-1234", names: { "Student A1": "Someone Else" } };
  assert.deepEqual(reviewLearnerNamesFor(sender, [other], presence, EXTENSION_ID), { ok: true, names: {} });
  for (const overrides of [
    { id: "b".repeat(32) },
    { tab: undefined },
    { frameId: 2 },
    { origin: "http://127.0.0.1:9999", url: "http://127.0.0.1:9999/operations/op%3Areview-1234" },
    { url: `${presence.origin}/recent` },
    { url: `${presence.origin}/operations/op%3Areview-1234?x=1` },
  ]) {
    assert.deepEqual(reviewLearnerNamesFor({ ...sender, ...overrides }, [entry], presence, EXTENSION_ID), { ok: false, names: {} }, JSON.stringify(overrides));
  }
  assert.deepEqual(reviewLearnerNamesFor(sender, [entry], null, EXTENSION_ID), { ok: false, names: {} });
});

function fakeChrome(tabs = []) {
  const session = new Map();
  const sent = [];
  const injected = [];
  globalThis.chrome = {
    runtime: { id: EXTENSION_ID },
    storage: { session: {
      get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (values) => { for (const [key, value] of Object.entries(values)) session.set(key, value); },
      remove: async (key) => { session.delete(key); },
    } },
    tabs: {
      query: async () => tabs,
      sendMessage: async (tabId, message) => { sent.push({ tabId, message }); },
    },
    scripting: { executeScript: async (details) => { injected.push(details.target.tabId); } },
  };
  return { session, sent, injected };
}

test("keeps the map in session storage, tells the review tab, and forgets it when cleared", async () => {
  const fake = fakeChrome([{ id: 7, url: sender.url }, { id: 8, url: "https://example.com/" }]);
  try {
    fake.session.set("morrowReviewApprovalPresence", presence);
    await storeReviewLearnerNames([entry]);
    assert.deepEqual([...fake.session.values()].at(-1), [entry]);
    assert.deepEqual(fake.injected, [7]);
    assert.deepEqual(fake.sent, [{ tabId: 7, message: { type: "morrow_review_learner_names_changed" } }]);
    const answer = await new Promise((resolve) => {
      assert.equal(handleReviewLearnerNamesMessage({ type: "morrow_review_learner_names" }, sender, resolve), true);
    });
    assert.deepEqual(answer, { ok: true, names: entry.names });
    await clearReviewLearnerNames();
    assert.equal([...fake.session.keys()].includes("morrowReviewLearnerNames"), false);
    assert.equal(fake.sent.length, 2);
    const cleared = await new Promise((resolve) => handleReviewLearnerNamesMessage({ type: "morrow_review_learner_names" }, sender, resolve));
    assert.deepEqual(cleared, { ok: true, names: {} });
    assert.equal(handleReviewLearnerNamesMessage({ type: "something_else" }, sender, () => undefined), false);
  } finally {
    delete globalThis.chrome;
  }
});

const CONTENT_SOURCE = readFileSync(new URL("../../connector/extension/src/review-approval-content.js", import.meta.url), "utf8");

test("the review tab shows each name beside its label in page text only, and removes it when the map ends", async () => {
  const browser = await launchTestChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`<main>
      <h1>Extension for Student A1</h1>
      <p id="both">Student A1 and Student A2, not Student A3.</p>
      <form method="post" action="/operations/op%3Areview-1234/approve"><input type="hidden" name="nonce" value="n"><input name="note" value="Student A1"><textarea name="t">Student A1</textarea><button>Apply</button></form>
      <details><summary>Technical details</summary><pre>{"student_ids":["Student A1"]}</pre></details>
      <div id="work-status"></div>
    </main>`);
    await page.evaluate(() => {
      window.__names = { "Student A1": "Jane Doe", "Student A2": "<b>Ana</b> Rivera" };
      window.__listeners = [];
      window.__asked = 0;
      window.chrome = { runtime: {
        sendMessage: async (message) => {
          if (message?.type !== "morrow_review_learner_names") return null;
          window.__asked += 1;
          return { ok: true, names: window.__names };
        },
        onMessage: { addListener: (listener) => window.__listeners.push(listener) },
      } };
    });
    await page.addScriptTag({ content: CONTENT_SOURCE });
    await page.waitForFunction(() => document.querySelector("h1").textContent === "Extension for Jane Doe (Student A1)");
    assert.equal(await page.textContent("#both"), "Jane Doe (Student A1) and <b>Ana</b> Rivera (Student A2), not Student A3.");
    assert.equal(await page.locator("#both b").count(), 0, "a name is text, never markup");
    assert.equal(await page.textContent("pre"), '{"student_ids":["Student A1"]}');
    assert.equal(await page.inputValue('input[name="note"]'), "Student A1");
    assert.equal(await page.inputValue("textarea"), "Student A1");
    // The status poll replaces part of the page; the new text gets names too.
    await page.evaluate(() => { document.querySelector("#work-status").innerHTML = "<p>Saved for Student A1.</p>"; });
    await page.waitForFunction(() => document.querySelector("#work-status p").textContent === "Saved for Jane Doe (Student A1).");
    // The Bridge forgets the map (review ended, or disconnected): the page goes back to labels.
    await page.evaluate(() => {
      window.__names = {};
      for (const listener of window.__listeners) listener({ type: "morrow_review_learner_names_changed" }, {}, () => undefined);
    });
    await page.waitForFunction(() => document.querySelector("h1").textContent === "Extension for Student A1");
    assert.equal(await page.textContent("#both"), "Student A1 and Student A2, not Student A3.");
    assert.equal(await page.textContent("#work-status p"), "Saved for Student A1.");
  } finally {
    await browser.close();
  }
});
