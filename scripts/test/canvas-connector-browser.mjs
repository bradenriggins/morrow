#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { CanvasConnectorRuntime } from "../../packages/canvas-connector-mcp/dist/runtime.js";
import { LoopbackApprovalServer } from "../../packages/mcp-server/dist/approval-server.js";

const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION = resolve(ROOT, "connector/extension");
const OUTPUT = resolve(ROOT, "output/playwright/canvas-connector");

async function captureThemes(page, name, width = 900) {
  await page.setViewportSize({ width, height: 760 });
  await page.evaluate(async () => {
    await document.fonts.load('13px "Google Sans Flex"');
    await document.fonts.ready;
  });
  assert.equal(await page.locator(".brand img").evaluate((image) => image.complete && image.naturalWidth > 0), true);
  assert.equal(await page.evaluate(() => document.fonts.check('13px "Google Sans Flex"')), true);
  assert.doesNotMatch(await page.locator("body").innerText(), /\b(?:MCP|nonce|digest|dispatch|binding|frozen)\b/i);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.locator("main").screenshot({ path: join(OUTPUT, `${name}-${colorScheme}.png`) });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

async function waitFor(probe, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}

function startCanvas(directory) {
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  let writes = 0;
  let quizItemWrites = 0;
  const requests = [];
  let quizItem = null;
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);
    const json = (status, value, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/courses/42") {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": "canvas_session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax" });
      response.end('<!doctype html><html><head><meta name="csrf-token" content="synthetic-csrf"></head><body><h1>Synthetic Canvas Course</h1></body></html>');
      return;
    }
    if (url.pathname === "/api/v1/users/self/profile") return json(200, { id: "7", name: "Synthetic Instructor" });
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77") return json(200, { id: "77", title: "New Quiz 77", published: true });
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77/items/145" && request.method === "GET") {
      return quizItem ? json(200, quizItem) : json(404, { error: "not_found" });
    }
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77/items" && request.method === "POST") {
      if (request.headers["x-csrf-token"] !== "synthetic-csrf" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session" });
      }
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        return json(415, { error: "new quiz item body must be JSON" });
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.deepEqual(body, {
          item: {
            entry: {
              interaction_data: { word_limit_enabled: true, word_limit: 250 },
              interaction_type_slug: "essay",
              item_body: "<p>Explain the result.</p>",
              scoring_algorithm: "None",
              scoring_data: { value: "" },
              title: "Evidence question",
            },
            entry_type: "Item",
            points_possible: 5,
          },
        });
        quizItemWrites += 1;
        quizItem = { id: "145", ...body.item };
        json(201, quizItem);
      });
      return;
    }
    if (url.pathname === "/api/v1/users/self/favorites/courses") return json(200, [{ id: "42", name: "Synthetic Canvas Course" }]);
    if (url.pathname === "/api/v1/users/self/favorites/courses/42" && request.method === "POST") {
      if (request.headers["x-csrf-token"] !== "synthetic-csrf" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session", csrf: request.headers["x-csrf-token"] || null, hasCookie: String(request.headers.cookie || "").includes("canvas_session=synthetic") });
      }
      writes += 1;
      return json(200, { id: "42", name: "Synthetic Canvas Course" });
    }
    json(404, { error: "not_found", path: url.pathname });
  });
  return { server, writes: () => writes, quizItemWrites: () => quizItemWrites, requests: () => [...requests] };
}

const temporary = mkdtempSync(join(tmpdir(), "morrow-connector-browser-"));
const extensionCopy = join(temporary, "extension");
cpSync(EXTENSION, extensionCopy, { recursive: true });
const manifestPath = join(extensionCopy, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions.push("https://127.0.0.1/*");
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
mkdirSync(OUTPUT, { recursive: true });

const canvas = startCanvas(temporary);
await new Promise((resolveListen) => canvas.server.listen(0, "127.0.0.1", resolveListen));
const address = canvas.server.address();
if (!address || typeof address === "string") throw new Error("synthetic Canvas port unavailable");
const canvasUrl = `https://127.0.0.1:${address.port}/courses/42`;
await new Promise((resolveRequest, rejectRequest) => {
  httpsGet(canvasUrl, { rejectUnauthorized: false }, (response) => {
    response.resume();
    response.once("end", resolveRequest);
  }).once("error", rejectRequest);
});

const connectorConfig = {
  statePath: join(temporary, "connector.json"),
  catalogPath: resolve(ROOT, "artifacts/canvas-api/canvas-api-catalog.json"),
  token: "browser-test-connector-secret-".repeat(3),
  port: 32147,
  runtimeRevision: "1.0.0-rc.0",
  allowedExtensionIds: [],
  approveExtensionId: async () => undefined,
};
let runtime = await CanvasConnectorRuntime.start(connectorConfig);

const approvalSnapshot = {
  schema: "morrow.operation.v1",
  operationId: "op:approval-ui-browser-test",
  state: "awaiting_approval",
  approvalExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  planDigest: "a".repeat(64),
  plan: {
    schema: "morrow.plan.v1",
    tool: "canvas_create_quiz_item",
    source: "canvas-session",
    changedFields: ["item_entry_title", "item_entry_item_body", "item_points_possible"],
    targetSet: { count: 1, digest: "b".repeat(64) },
    risk: { approvalClass: "standard" },
    arguments: { course_id: "42", assignment_id: "77", item_entry_title: "Red blood cell function", item_entry_item_body: "<p>What is the main function of red blood cells?</p>", item_points_possible: 5 },
    readback: { tool: "canvas_get_quiz_item", expectedDigest: "c".repeat(64) },
  },
};
const operationApproval = new LoopbackApprovalServer({
  operationGet: (id) => ({ ...approvalSnapshot, operationId: id,
    ...(id === "op:expired-ui-test" ? { approvalExpiresAt: new Date(Date.now() - 60_000).toISOString() } : {}),
  }),
  operationReviewContext: async (id) => ({ targets: id === "op:missing-names"
    ? [{ field: "course_id", label: "Course", name: "" }, { field: "assignment_id", label: "Quiz", name: "" }]
    : id === "op:second-batch-item" ? [
      { field: "course_id", label: "Course", name: "Human Anatomy", url: "https://canvas.example.edu/courses/84" },
      { field: "assignment_id", label: "Quiz", name: "Week 2: Bones and Muscles", url: "https://canvas.example.edu/courses/84/assignments/99" },
      { field: "item_id", label: "Question", name: "Outdated practice question" },
    ] : [
      { field: "course_id", label: "Course", name: "Introduction to Human Biology", url: "https://canvas.example.edu/courses/42" },
      { field: "assignment_id", label: "Quiz", name: "Week 3: Blood and Circulation", url: "https://canvas.example.edu/courses/42/assignments/77" },
    ],
  }),
  operationList: () => ({ schema: "morrow.operations.v1", operations: [approvalSnapshot] }),
  approveOperation: (id) => ({ ...approvalSnapshot, state: id === "op:expired-on-submit" ? "cancelled" : "approved" }),
  cancelOperation: () => ({ ...approvalSnapshot, state: "cancelled" }),
  batchApprovalGet: () => ({
    batch: { state: "planned" }, expiresAt: approvalSnapshot.approvalExpiresAt,
    children: [
      { operation: approvalSnapshot },
      { operation: { ...approvalSnapshot, operationId: "op:second-batch-item", plan: { ...approvalSnapshot.plan, tool: "canvas_delete_quiz_item", risk: { approvalClass: "destructive" }, arguments: { course_id: "84", assignment_id: "99", item_id: "19" } } } },
    ],
  }),
  setApprovalBaseUrl: () => undefined,
});
const operationApprovalBaseUrl = await operationApproval.start();

const profile = join(temporary, "chrome-profile");
const launchBrowser = () => chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: chromium.executablePath(),
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${extensionCopy}`,
    `--load-extension=${extensionCopy}`,
    "--allow-insecure-localhost",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let context;
try {
  process.stderr.write("[browser-test] starting temporary Chrome for Testing\n");
  context = await launchBrowser();

  const operationApprovalPage = context.pages()[0] || await context.newPage();
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/${encodeURIComponent(approvalSnapshot.operationId)}`);
  await operationApprovalPage.getByRole("heading", { name: "Add this quiz question?" }).waitFor();
  await operationApprovalPage.getByRole("link", { name: "Introduction to Human Biology", exact: false }).waitFor();
  await operationApprovalPage.getByRole("button", { name: "Approve question" }).waitFor();
  assert.equal(await operationApprovalPage.locator("details").getAttribute("open"), null);
  assert.equal(await operationApprovalPage.locator(".destination").innerText().then((text) => text.includes("Week 3: Blood and Circulation")), true);
  assert.doesNotMatch(await operationApprovalPage.locator("body").innerText(), /Course ID|Assignment ID|Evidence question/);
  assert.match(await operationApprovalPage.locator(".request").innerText(), /Red blood cell function/);
  assert.equal(await operationApprovalPage.locator("iframe.text-preview").getAttribute("sandbox"), "");
  await operationApprovalPage.frameLocator("iframe.text-preview").getByText("What is the main function of red blood cells?").waitFor();
  await captureThemes(operationApprovalPage, "approval-operation");
  await captureThemes(operationApprovalPage, "approval-operation-narrow", 320);
  await operationApprovalPage.getByRole("button", { name: "Approve question" }).click();
  await operationApprovalPage.getByRole("heading", { name: 'Return to your chat and say “Continue.”' }).waitFor();
  await captureThemes(operationApprovalPage, "approval-recorded");
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/batches/batch-ui-test`);
  await operationApprovalPage.getByRole("heading", { name: "Check these 2 changes" }).waitFor();
  assert.equal(await operationApprovalPage.locator(".request").count(), 2);
  assert.equal(await operationApprovalPage.locator(".warning").innerText(), "This removes content. It cannot be undone from this screen.");
  assert.match(await operationApprovalPage.locator(".destination").nth(1).innerText(), /Human Anatomy[\s\S]+Outdated practice question/);
  await captureThemes(operationApprovalPage, "approval-batch");
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Amissing-names`);
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Approve question" }).count(), 0);
  assert.match(await operationApprovalPage.locator("body").innerText(), /could not identify the course or activity/);
  assert.doesNotMatch(await operationApprovalPage.locator("body").innerText(), /Course ID|Assignment ID/);
  await captureThemes(operationApprovalPage, "approval-missing-names");
  const blockedReviewUrl = operationApprovalPage.url();
  const blockedNonce = await operationApprovalPage.locator('input[name="nonce"]').inputValue();
  const blockedApproval = await operationApprovalPage.request.post(`${blockedReviewUrl}/approve`, {
    form: { nonce: blockedNonce },
    headers: { origin: new URL(blockedReviewUrl).origin, referer: blockedReviewUrl },
  });
  assert.equal(blockedApproval.status(), 409);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Aexpired-ui-test`);
  await operationApprovalPage.getByRole("heading", { name: "This review has expired" }).waitFor();
  assert.equal(await operationApprovalPage.locator("button").count(), 0);
  await captureThemes(operationApprovalPage, "approval-expired");
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Aexpired-on-submit`);
  await operationApprovalPage.getByRole("button", { name: "Approve question" }).click();
  await operationApprovalPage.getByRole("heading", { name: "Request cancelled" }).waitFor();
  assert.equal(await operationApprovalPage.getByRole("heading", { name: 'Return to your chat and say “Continue.”' }).count(), 0);
  process.stderr.write("[browser-test] operation approval UI ready\n");

  const worker = await waitFor(
    () => context.serviceWorkers().find((candidate) => candidate.url() === `chrome-extension://${EXTENSION_ID}/src/service-worker.js`),
    "connector service worker did not start",
  );
  assert.equal(new URL(worker.url()).hostname, EXTENSION_ID);
  process.stderr.write("[browser-test] connector service worker ready\n");

  let canvasPage = context.pages()[0] || await context.newPage();
  await canvasPage.goto(canvasUrl, { waitUntil: "domcontentloaded" });
  await canvasPage.locator("h1", { hasText: "Synthetic Canvas Course" }).waitFor();
  process.stderr.write("[browser-test] synthetic signed-in Canvas ready\n");

  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);
  await popup.getByRole("button", { name: "Connect Morrow", exact: true }).waitFor();
  await captureThemes(popup, "popup-unpaired", 360);
  const approvalPromise = context.waitForEvent("page");
  await popup.getByRole("button", { name: "Connect Morrow", exact: true }).click();
  const approval = await approvalPromise;
  await approval.waitForURL(/^http:\/\/127\.0\.0\.1:32147\/morrow-bridge\/v1\/pair\/[0-9a-f-]+$/);
  await approval.getByText("Your Canvas password and sign-in details stay in Chrome", { exact: false }).waitFor();
  await captureThemes(approval, "pairing");
  process.stderr.write("[browser-test] pairing review ready\n");
  const pairingApprovedAt = performance.now();
  await approval.getByRole("button", { name: "Allow connection", exact: true }).click();
  await approval.getByText(/approved/i).waitFor();
  await captureThemes(approval, "pairing-approved");
  await popup.bringToFront();
  await popup.locator("#status-value").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 5_000 });
  assert.equal(await popup.locator("#canvas-value").innerText(), "Not connected");
  assert.equal(runtime.bridge.health().connected, true);
  const pairingReadyMs = Math.round(performance.now() - pairingApprovedAt);
  process.stderr.write(`[browser-test] pairing ready without restart in ${pairingReadyMs}ms\n`);

  await context.close();
  context = await launchBrowser();
  const replacementWorker = await waitFor(
    () => context.serviceWorkers().find((candidate) => candidate.url() === `chrome-extension://${EXTENSION_ID}/src/service-worker.js`),
    "connector service worker did not restart",
  );
  await waitFor(() => runtime.bridge.health().connected, "connector did not authenticate after extension restart");
  process.stderr.write("[browser-test] pairing survived extension restart\n");

  canvasPage = context.pages()[0] || await context.newPage();
  await canvasPage.goto(canvasUrl, { waitUntil: "domcontentloaded" });
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);

  const canvasTabId = await replacementWorker.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
  }, canvasUrl);
  assert.equal(Number.isInteger(canvasTabId), true);
  const connected = await popup.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ type: "morrow_connect_canvas", tabId });
  }, canvasTabId);
  assert.equal(connected?.ok, true, connected?.error);
  const binding = await waitFor(() => runtime.bridge.listBindings()[0], "Canvas account did not bind to the connector");
  assert.match(binding.sourceBindingId, /^canvas:[0-9a-f]{20}:g1$/);
  assert.equal(binding.origin, new URL(canvasUrl).origin);
  assert.equal(binding.courseId, "42");
  process.stderr.write("[browser-test] exact Canvas account bound\n");

  await popup.reload();
  await popup.locator("#account").waitFor();
  assert.equal(await popup.locator("#canvas-value").innerText(), "Saved connection");
  assert.equal(await popup.locator("#account-last-checked").getAttribute("datetime").then((value) => Number.isFinite(Date.parse(value))), true);
  assert.equal(await popup.locator("#primary").isHidden(), true);
  await captureThemes(popup, "popup-paired", 360);
  await popup.getByText("How to connect", { exact: true }).click();
  await captureThemes(popup, "popup-help", 360);
  await popup.getByText("How to connect", { exact: true }).click();

  await replacementWorker.evaluate(() => {
    globalThis.savedScriptExecutor = chrome.scripting.executeScript;
    globalThis.itemBankCalls = [];
    chrome.scripting.executeScript = async (details) => {
      if (details.func?.name !== "executeItemBankInPage") return globalThis.savedScriptExecutor(details);
      globalThis.itemBankCalls.push(details.args[0].contextOnly === true ? "probe" : "write");
      return [1, 2].map((frameId) => ({ frameId, result: { matched: true, ok: true, sent: false } }));
    };
  });
  try {
    const ambiguous = await runtime.call("canvas_item_bank_create_bank", {
      title: "Must not be created",
      _morrow: {
        source_binding_id: binding.sourceBindingId,
        operation_id: "operation:ambiguous-bank-test",
        outer_grant: {
          plan_digest: "a".repeat(64), approval_grant_digest: "b".repeat(64),
          effect_receipt_id: "effect:ambiguous-bank-test", dispatch_attempt: 1,
          gateway_process_id: "gateway:browser-test",
        },
      },
    });
    assert.equal(ambiguous.ok, false);
    assert.match(JSON.stringify(ambiguous), /item_bank_context_ambiguous/);
    assert.deepEqual(await replacementWorker.evaluate(() => globalThis.itemBankCalls), ["probe"]);
  } finally {
    await replacementWorker.evaluate(() => {
      chrome.scripting.executeScript = globalThis.savedScriptExecutor;
      delete globalThis.savedScriptExecutor;
      delete globalThis.itemBankCalls;
    });
  }

  const read = await runtime.call("canvas_get_new_quiz", {
    course_id: "42",
    assignment_id: "77",
    _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(read.ok, true);
  assert.match(JSON.stringify(read), /New Quiz 77/);

  const quizItemWrite = await runtime.call("canvas_create_quiz_item", {
    course_id: "42",
    assignment_id: "77",
    item_entry_type: "Item",
    item_entry_title: "Evidence question",
    item_entry_item_body: "<p>Explain the result.</p>",
    item_entry_interaction_type_slug: "essay",
    item_entry_interaction_data: { word_limit_enabled: true, word_limit: 250 },
    item_entry_scoring_algorithm: "None",
    item_entry_scoring_data: { value: "" },
    item_points_possible: 5,
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: "operation:new-quiz-item-browser-test",
      outer_grant: {
        plan_digest: "c".repeat(64),
        approval_grant_digest: "d".repeat(64),
        effect_receipt_id: "effect:new-quiz-item-browser-test",
        dispatch_attempt: 1,
        gateway_process_id: "gateway:browser-test",
      },
    },
  });
  assert.equal(quizItemWrite.ok, true, JSON.stringify(quizItemWrite));
  assert.equal(quizItemWrite.result?.verification?.status, "verified", JSON.stringify(quizItemWrite));
  assert.equal(canvas.quizItemWrites(), 1);

  const grant = {
    plan_digest: "a".repeat(64),
    approval_grant_digest: "b".repeat(64),
    effect_receipt_id: "effect:browser-test",
    dispatch_attempt: 1,
    gateway_process_id: "gateway:browser-test",
  };
  const write = await runtime.call("canvas_add_course_to_favorites", {
    id: "42",
    _morrow: { source_binding_id: binding.sourceBindingId, operation_id: "operation:browser-test", outer_grant: grant },
  });
  assert.equal(write.ok, true, JSON.stringify({ write, requests: canvas.requests() }));
  assert.equal(write.result?.verification?.status, "verified", JSON.stringify(write));
  assert.equal(canvas.writes(), 1);
  const replay = await runtime.call("canvas_add_course_to_favorites", {
    id: "42",
    _morrow: { source_binding_id: binding.sourceBindingId, operation_id: "operation:browser-test-replay", outer_grant: grant },
  });
  assert.equal(replay.ok, false);
  assert.equal(canvas.writes(), 1);
  assert.deepEqual(canvas.requests().filter((request) => request === "POST /api/v1/users/self/favorites/courses/42"), ["POST /api/v1/users/self/favorites/courses/42"]);

  await runtime.close();
  runtime = await CanvasConnectorRuntime.start({ ...connectorConfig, token: "replacement-bridge-secret-".repeat(3) });
  await waitFor(async () => {
    const stored = await replacementWorker.evaluate(() => chrome.storage.local.get(["token", "bindings"]));
    return !stored.token && !(stored.bindings || []).length;
  }, "rejected pairing did not clear stale authority", 10_000);
  await popup.bringToFront();
  await popup.getByRole("button", { name: "Connect Morrow", exact: true }).waitFor();
  await captureThemes(popup, "popup-reconnect", 360);
  const replacementApprovalPromise = context.waitForEvent("page");
  await popup.getByRole("button", { name: "Connect Morrow", exact: true }).click();
  const replacementApproval = await replacementApprovalPromise;
  await replacementApproval.getByRole("button", { name: "Allow connection", exact: true }).click();
  await popup.bringToFront();
  await popup.locator("#status-value").filter({ hasText: /^Connected$/ }).waitFor({ timeout: 5_000 });
  await popup.getByRole("button", { name: "Disconnect Morrow", exact: true }).click();
  await popup.locator("#status-value").filter({ hasText: /^Not connected$/ }).waitFor();
  await waitFor(() => !runtime.bridge.health().connected, "connector did not disconnect");
  const revoked = await replacementWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get(["token", "bindings"]);
    return { token: stored.token || null, bindingCount: Array.isArray(stored.bindings) ? stored.bindings.length : 0 };
  });
  assert.deepEqual(revoked, { token: null, bindingCount: 0 });

  process.stdout.write(`${JSON.stringify({ ok: true, pairingReadyMs, ambiguousItemBankFramesRefused: true, stalePairingRecovered: true, extensionId: EXTENSION_ID, binding: binding.sourceBindingId, newQuiz: "New Quiz 77", newQuizItemWrites: canvas.quizItemWrites(), writes: canvas.writes(), replayRefused: true, disconnectClearedPairing: true, screenshots: ["popup-paired-light", "popup-paired-dark", "pairing-light", "pairing-dark", "approval-operation-light", "approval-operation-dark", "approval-operation-narrow-light", "approval-operation-narrow-dark"].map((name) => join(OUTPUT, `${name}.png`)) })}\n`);
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolveClose) => canvas.server.close(resolveClose));
  await operationApproval.close();
  await runtime.close();
  rmSync(temporary, { recursive: true, force: true });
}
