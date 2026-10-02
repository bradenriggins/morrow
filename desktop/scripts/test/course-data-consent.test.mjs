import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COURSE_DATA_CONSENT_KEY,
  COURSE_DATA_CONSENT_VALUE,
  hasCourseDataConsent,
} from "../../connector/extension/src/course-data-consent.js";

const worker = readFileSync(new URL("../../connector/extension/src/service-worker.js", import.meta.url), "utf8");

test("only the current explicit course-data agreement is accepted", () => {
  assert.equal(COURSE_DATA_CONSENT_KEY, "morrowCourseDataConsent");
  assert.equal(hasCourseDataConsent(COURSE_DATA_CONSENT_VALUE), true);
  for (const value of [undefined, null, false, true, "morrow.course-data-consent.v0", {}, []]) {
    assert.equal(hasCourseDataConsent(value), false, JSON.stringify(value));
  }
});

test("the Bridge cannot read bindings, pair, or open its socket before agreement", () => {
  for (const [signature, consentCheck] of [
    ["async function canvasTabChanged(tabId)", /if \(!await courseDataConsentAccepted\(\)\) return;/],
    ["async function connectBridge()", /if \(!await courseDataAuthorityCurrent\(authorityGeneration\)\) return;/],
    ["async function requestPairing()", /await requireCourseDataAuthority\(authorityGeneration\);/],
  ]) {
    const start = worker.indexOf(signature);
    assert.notEqual(start, -1, signature);
    const body = worker.slice(start, start + 240);
    assert.match(body, consentCheck, signature);
  }
  assert.match(worker, /async function status\(\) \{\s*const authorityGeneration = state\.courseDataAuthorityGeneration;\s*if \(!await courseDataAuthorityCurrent\(authorityGeneration\)\) return \{ consentRequired: true \};/);
  assert.match(worker, /Promise\.resolve\(consentExempt \? undefined : requireCourseDataConsent\(\)\)\.then\(run\)/);
});

test("agreement is recorded only by the named product action", () => {
  assert.match(worker, /async function acceptCourseDataConsent\(\) \{\s*await chrome\.storage\.local\.set\(\{ \[COURSE_DATA_CONSENT_KEY\]: COURSE_DATA_CONSENT_VALUE \}\);\s*await connectBridge\(\);/);
  assert.match(worker, /message\?\.type === "morrow_course_data_consent_accept" \? acceptCourseDataConsent/);
});

test("consent is withdrawn only by the settings page, disconnecting first", () => {
  assert.match(worker, /async function withdrawCourseDataConsent\(\) \{\s*await disconnectConnector\(\);\s*await chrome\.storage\.local\.remove\(COURSE_DATA_CONSENT_KEY\);\s*return \{ withdrawn: true \};\s*\}/);
  assert.match(worker, /message\?\.type === "morrow_course_data_consent_withdraw" \? \(settingsSender\(sender\) \? withdrawCourseDataConsent : \(\) => \{ throw new Error\("bridge_consent_sender_refused"\); \}\)/);
  assert.match(worker, /message\?\.type === "morrow_course_data_consent_withdraw"\s*\|\| message\?\.type === "morrow_status"/);
});

test("consent withdrawal closes and erases Private Chat before detaching the Bridge socket", () => {
  const start = worker.indexOf("chrome.storage.onChanged.addListener((changes, areaName) => {");
  const end = worker.indexOf("\nchrome.runtime.onStartup.addListener", start);
  assert.ok(start >= 0 && end > start);
  const listener = worker.slice(start, end);
  const invalidate = listener.indexOf("invalidateCourseDataAuthority();");
  const clear = listener.indexOf("clearPrivateChat({ answerPending: true });");
  const detach = listener.indexOf("state.socket = null;");
  const close = listener.indexOf('socket?.close(1000, "course_data_consent_removed");');
  assert.ok(invalidate >= 0 && invalidate < clear && clear < detach && detach < close);
});
