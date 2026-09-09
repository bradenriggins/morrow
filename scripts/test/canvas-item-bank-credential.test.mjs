import assert from "node:assert/strict";
import test from "node:test";
import {
  ITEM_BANK_CREDENTIAL_MAX_AGE_MS,
  itemBankApiOriginForFrameUrl,
  itemBankCredentialFromRequest,
  itemBankLaunchUrl,
  itemBankPermissionOrigins,
  usableItemBankCredential,
} from "../../connector/extension/src/item-bank-credential.js";

const NOW = Date.parse("2026-09-08T20:00:00.000Z");
const NONCE = "b28f3aae-8888-4c5b-9a17-458f2e1fe309";
const TOKEN = `Signature ${"launch-bound-secret-".repeat(8)}`;
const LAUNCH_URL = "https://school.instructure.com/courses/42/external_tools/54065";
const LTI_URL = "https://school.quiz-lti-iad-prod.instructure.com/lti/launch";
const API_ORIGIN = "https://school.quiz-api-iad-prod.instructure.com";

const launch = (overrides = {}) => ({
  tabId: 19,
  canvasLocalContextId: "42",
  launchUrl: LAUNCH_URL,
  launchNonce: NONCE,
  launchedAt: NOW - 1_000,
  ...overrides,
});

const request = (overrides = {}) => ({
  method: "GET",
  tabId: 19,
  frameId: 7,
  url: `${API_ORIGIN}/api/banks?course_id=course-context-uuid`,
  documentUrl: LTI_URL,
  initiator: new URL(LTI_URL).origin,
  requestHeaders: [
    { name: "Authorization", value: TOKEN },
    { name: "AuthType", value: "Signature" },
  ],
  ...overrides,
});

test("a normal bound course path derives only the exact Item Banks launch", () => {
  for (const path of ["/courses/42", "/courses/42/quizzes", "/courses/42/pages/week-1", "/courses/42/external_tools/99"]) {
    assert.equal(itemBankLaunchUrl(`https://school.instructure.com${path}`, "https://school.instructure.com", "42"), LAUNCH_URL, path);
  }
  assert.equal(itemBankLaunchUrl("https://school.instructure.com/courses/42", "https://school.instructure.com"), LAUNCH_URL);
  for (const [tabUrl, origin, course] of [
    ["https://other.instructure.com/courses/42", "https://school.instructure.com", "42"],
    ["http://school.instructure.com/courses/42", "http://school.instructure.com", "42"],
    ["https://school.instructure.com/courses/43", "https://school.instructure.com", "42"],
    ["https://school.instructure.com/courses/42", "https://school.instructure.com/path", "42"],
    ["https://school.instructure.com/accounts/42", "https://school.instructure.com", "42"],
  ]) assert.equal(itemBankLaunchUrl(tabUrl, origin, course), "");
});

test("origin discovery accepts one exact same-tenant quiz-lti frame", () => {
  const frames = [
    { frameId: 0, url: LAUNCH_URL },
    { frameId: 7, url: LTI_URL },
  ];
  assert.deepEqual(itemBankPermissionOrigins(frames, "https://school.instructure.com"), [
    "https://school.quiz-lti-iad-prod.instructure.com/*",
    "https://school.quiz-api-iad-prod.instructure.com/*",
  ]);
  assert.equal(itemBankApiOriginForFrameUrl(LTI_URL), API_ORIGIN);
  assert.equal(itemBankApiOriginForFrameUrl(`${API_ORIGIN}/api/banks`), API_ORIGIN);
});

test("origin discovery refuses unsafe, cross-tenant, custom-domain, and ambiguous frames", () => {
  assert.deepEqual(itemBankPermissionOrigins([{ frameId: 7, url: "https://other.quiz-lti-iad-prod.instructure.com/lti/launch" }], "https://school.instructure.com"), []);
  assert.deepEqual(itemBankPermissionOrigins([{ frameId: 7, url: LTI_URL }], "https://canvas.school.edu"), []);
  assert.deepEqual(itemBankPermissionOrigins([
    { frameId: 7, url: LTI_URL },
    { frameId: 8, url: "https://school.quiz-lti-pdx-prod.instructure.com/lti/launch" },
  ], "https://school.instructure.com"), []);
  assert.deepEqual(itemBankPermissionOrigins([{ frameId: 7, url: "https://school.quiz-api-iad-prod.instructure.com/api/banks" }], "https://school.instructure.com"), []);
  assert.deepEqual(itemBankPermissionOrigins([{ frameId: 0, url: LTI_URL }], "https://school.instructure.com"), []);
});

test("the first exact authenticated bank list request yields one launch-bound credential", () => {
  const credential = itemBankCredentialFromRequest(request(), launch(), NOW);
  assert.deepEqual(credential, {
    tabId: 19,
    frameId: 7,
    apiOrigin: API_ORIGIN,
    token: TOKEN,
    authType: "Signature",
    contextUuid: "course-context-uuid",
    canvasLocalContextId: "42",
    launchUrl: LAUNCH_URL,
    launchNonce: NONCE,
    launchedAt: NOW - 1_000,
    capturedAt: NOW,
  });
  assert.equal(Object.isFrozen(credential), true);
});

test("credential capture rejects every request outside the pending launch", () => {
  const cases = [
    ["no pending launch", request(), null],
    ["wrong method", request({ method: "POST" }), launch()],
    ["wrong tab", request({ tabId: 20 }), launch()],
    ["top frame", request({ frameId: 0 }), launch()],
    ["wrong path", request({ url: `${API_ORIGIN}/api/banks/91?course_id=course-context-uuid` }), launch()],
    ["wrong API host", request({ url: "https://other.quiz-api-iad-prod.instructure.com/api/banks?course_id=course-context-uuid" }), launch()],
    ["wrong frame host", request({ documentUrl: "https://other.quiz-lti-iad-prod.instructure.com/lti/launch" }), launch()],
    ["missing context UUID", request({ url: `${API_ORIGIN}/api/banks` }), launch()],
    ["duplicate context UUID", request({ url: `${API_ORIGIN}/api/banks?course_id=a&course_id=b` }), launch()],
    ["missing Authorization", request({ requestHeaders: [{ name: "AuthType", value: "Signature" }] }), launch()],
    ["duplicate Authorization", request({ requestHeaders: [{ name: "Authorization", value: TOKEN }, { name: "authorization", value: TOKEN }, { name: "AuthType", value: "Signature" }] }), launch()],
    ["wrong AuthType", request({ requestHeaders: [{ name: "Authorization", value: TOKEN }, { name: "AuthType", value: "Bearer" }] }), launch()],
    ["stale launch", request(), launch({ launchedAt: NOW - 45_001 })],
    ["future launch", request(), launch({ launchedAt: NOW + 1 })],
    ["wrong tool", request(), launch({ launchUrl: "https://school.instructure.com/courses/42/external_tools/9" })],
    ["wrong numeric context", request(), launch({ canvasLocalContextId: "43" })],
    ["invalid nonce", request(), launch({ launchNonce: "nonce" })],
  ];
  for (const [label, details, pending] of cases) {
    assert.equal(itemBankCredentialFromRequest(details, pending, NOW), null, label);
  }
});

test("credential use requires an exact fresh tab, frame, host, course, launch, and nonce match", () => {
  const credential = itemBankCredentialFromRequest(request(), launch(), NOW);
  const expected = {
    tabId: 19,
    frameId: 7,
    apiOrigin: API_ORIGIN,
    canvasLocalContextId: "42",
    launchUrl: LAUNCH_URL,
    launchNonce: NONCE,
    launchedAt: NOW - 1_000,
  };
  assert.equal(usableItemBankCredential(credential, expected, NOW), credential);
  for (const [label, changed] of [
    ["tab", { tabId: 20 }],
    ["frame", { frameId: 8 }],
    ["host", { apiOrigin: "https://other.quiz-api-iad-prod.instructure.com" }],
    ["course", { canvasLocalContextId: "43" }],
    ["launch", { launchUrl: "https://school.instructure.com/courses/42/external_tools/9" }],
    ["nonce", { launchNonce: "a28f3aae-8888-4c5b-9a17-458f2e1fe309" }],
    ["time", { launchedAt: NOW - 2_000 }],
  ]) assert.equal(usableItemBankCredential(credential, { ...expected, ...changed }, NOW), null, label);
  assert.equal(usableItemBankCredential(credential, expected, NOW + ITEM_BANK_CREDENTIAL_MAX_AGE_MS + 1), null, "stale credential");
});
