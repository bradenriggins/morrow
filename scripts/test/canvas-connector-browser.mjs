#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  let unreadableWriteResponses = 0;
  const requests = [];
  let quizItem = null;
  let pageWrites = 0;
  let pageRevision = 1;
  const lesson = { page_id: "91", url: "lesson", title: "Cell structure", body: '<h2>Cell structure</h2><p>Cells have membranes.</p><img src="/courses/42/files/8" alt="Cell">', published: true, front_page: false, editing_roles: "teachers" };
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
    if (url.pathname === "/api/v1/courses/42") return json(200, { id: "42", name: "Introduction to Human Biology" });
    if (url.pathname === "/api/v1/courses/42/pages/lesson/revisions/latest") return json(200, { revision_id: String(pageRevision), latest: true, url: lesson.url, title: lesson.title, body: lesson.body });
    if (url.pathname === "/api/v1/courses/42/pages/lesson/revisions") return json(200, [pageRevision, pageRevision - 1].filter((id) => id > 0).map((id) => ({ revision_id: String(id), latest: id === pageRevision })));
    if (url.pathname === "/api/v1/courses/42/pages/lesson") {
      if (request.method === "GET") return json(200, lesson);
      if (request.method === "PUT") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.deepEqual([...body.keys()], ["wiki_page[body]"]);
          lesson.body = body.get("wiki_page[body]");
          pageRevision += 1;
          pageWrites += 1;
          json(200, lesson);
        });
        return;
      }
    }
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
    if (url.pathname === "/api/v1/users/self/favorites/courses/43" && request.method === "POST") {
      unreadableWriteResponses += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{unreadable response after apply");
      return;
    }
    if (url.pathname === "/api/v1/users/self/favorites/courses/42" && request.method === "POST") {
      if (request.headers["x-csrf-token"] !== "synthetic-csrf" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session", csrf: request.headers["x-csrf-token"] || null, hasCookie: String(request.headers.cookie || "").includes("canvas_session=synthetic") });
      }
      writes += 1;
      return json(200, { id: "42", name: "Synthetic Canvas Course" });
    }
    json(404, { error: "not_found", path: url.pathname });
  });
  return { server, writes: () => writes, quizItemWrites: () => quizItemWrites, pageWrites: () => pageWrites, lesson: () => ({ ...lesson }), changeLesson: () => { lesson.body += "<p>Another edit.</p>"; pageRevision += 1; }, setLesson: (body) => { lesson.body = body; pageRevision += 1; }, unreadableWriteResponses: () => unreadableWriteResponses, requests: () => [...requests] };
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
  runtimeRevision: "1.0.0-rc.1",
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
    arguments: {
      course_id: "42", assignment_id: "77", item_entry_type: "Item", item_entry_title: "Red blood cell function",
      item_entry_item_body: "<p>A patient has a low red blood cell count. Which essential function is most directly affected?</p>", item_points_possible: 5,
      item_entry_interaction_type_slug: "choice", item_entry_scoring_algorithm: "Equivalence",
      item_entry_interaction_data: { choices: [
        { id: "11111111-1111-4111-8111-111111111111", position: 1, item_body: "<p>Carry <strong>oxygen</strong> from the lungs to the body.</p>" },
        { id: "22222222-2222-4222-8222-222222222222", position: 2, item_body: "<p>Defend the body against infection.</p>" },
        { id: "33333333-3333-4333-8333-333333333333", position: 3, item_body: "<p>Help the blood clot.</p>" },
        { id: "44444444-4444-4444-8444-444444444444", position: 4, item_body: "<p>Produce antibodies.</p>" },
      ] },
      item_entry_scoring_data: { value: "11111111-1111-4111-8111-111111111111" },
      item_entry_feedback_correct: "<p><strong>Yes.</strong> Hemoglobin in red blood cells binds oxygen and carries it to the tissues.</p>",
      item_entry_feedback_incorrect: "<p>Think about <strong>hemoglobin</strong>. White blood cells help fight infection; platelets help with clotting.</p>",
      item_entry_answer_feedback: { "33333333-3333-4333-8333-333333333333": "<p>Platelets perform this function, not red blood cells.</p>" },
    },
    readback: { tool: "canvas_get_quiz_item", expectedDigest: "c".repeat(64) },
  },
};
const approvalStates = new Map();
let finishApproval;
let finishBatchApproval;
let batchState = "planned";
let batchOperationState = "awaiting_approval";
const batchSnapshot = () => ({
  batch: { state: batchState }, expiresAt: approvalSnapshot.approvalExpiresAt,
  children: [
    { operation: { ...approvalSnapshot, state: batchOperationState } },
    { operation: { ...approvalSnapshot, state: batchOperationState, operationId: "op:second-batch-item", plan: { ...approvalSnapshot.plan, tool: "canvas_delete_quiz_item", risk: { approvalClass: "destructive" }, arguments: { course_id: "84", assignment_id: "99", item_id: "19" } } } },
  ],
});
const largeBatchSnapshot = () => ({ batch: { state: "planned" }, expiresAt: approvalSnapshot.approvalExpiresAt,
  children: Array.from({ length: 40 }, (_, index) => ({ operation: { ...approvalSnapshot, operationId: `op:bulk-${index + 1}`, plan: { ...approvalSnapshot.plan, arguments: { ...approvalSnapshot.plan.arguments, item_entry_title: `Blood and circulation — question ${index + 1}` } } } })),
});
const mixedBatchSnapshot = () => ({ batch: { state: "planned" }, expiresAt: approvalSnapshot.approvalExpiresAt, children: [
  { operation: { ...approvalSnapshot, operationId: "op:assignment-preview", plan: { ...approvalSnapshot.plan, tool: "canvas_create_assignment", arguments: { course_id: "42", assignment_name: "Patient education plan", assignment_description: "<h3>Your task</h3><p>Write a clear explanation of <strong>oxygen transport</strong> for a patient.</p><ul><li>Use plain language.</li><li>Include one example.</li></ul>", assignment_due_at: "2026-09-08T17:00:00Z", assignment_points_possible: 0, assignment_published: false } } } },
  { operation: { ...approvalSnapshot, operationId: "op:discussion-preview", plan: { ...approvalSnapshot.plan, tool: "canvas_create_new_discussion_topic_courses", arguments: { course_id: "42", title: "What would you tell the patient?", message: "<p>Explain why a patient with anemia might feel tired.</p><blockquote>Respond to one classmate with a question that deepens the discussion.</blockquote>", require_initial_post: true, published: false } } } },
  { operation: { ...approvalSnapshot, operationId: "op:moodle-preview", plan: { ...approvalSnapshot.plan, tool: "moodle_update_course_summary", arguments: { connection_id: "moodle-test", course_id: 17, summary: "<h3>Welcome to Biology</h3><p>Explore how <em>structure supports function</em>.</p>", expected_digest: "d".repeat(64), expected_connection: "e".repeat(64) } } } },
  { operation: { ...approvalSnapshot, operationId: "op:blackboard-preview", plan: { ...approvalSnapshot.plan, tool: "blackboard_update_content", arguments: { connection_id: "blackboard-test", course_id: "_12_1", content_id: "_34_1", title: "Cell structure", body: "<h3>From cells to systems</h3><p>Start with the cell membrane, then follow oxygen into the tissues.</p>", expected_digest: "d".repeat(64), expected_connection: "e".repeat(64) } } } },
  { operation: { ...batchSnapshot().children[1].operation, state: "awaiting_approval" } },
] });
const operationApproval = new LoopbackApprovalServer({
  operationGet: (id) => ({ ...approvalSnapshot, operationId: id,
    state: approvalStates.get(id) || approvalSnapshot.state,
    ...(id === "op:page-edit" ? { plan: { ...approvalSnapshot.plan, tool: "canvas_update_create_page_courses", arguments: { course_id: "42", url_or_id: "lesson", _morrow: { page_guard: { find_text: "Cells have membranes.", replace_text: "Cells have protective membranes." } } } } } : {}),
    ...(id === "op:short-preview" ? { plan: { ...approvalSnapshot.plan, arguments: { course_id: "42", assignment_id: "77", item_entry_title: "Red blood cell function", item_entry_item_body: "<p>What is the main function of red blood cells?</p>", item_points_possible: 5 } } } : {}),
    ...(id === "op:lesson-preview" ? { plan: { ...approvalSnapshot.plan, tool: "canvas_update_create_page_courses", arguments: { course_id: "42", url_or_id: "lesson", wiki_page_body: '<h2>Blood has a job to do.</h2><p>Every heartbeat moves a living transport system through your body. Its parts work together to deliver oxygen, respond to infection, and limit blood loss.</p><h3>Three parts. Three essential roles.</h3><table><caption>Blood components at a glance</caption><thead><tr><th scope="col">Component</th><th scope="col">Main role</th></tr></thead><tbody><tr><td><strong>Red blood cells</strong></td><td>Carry oxygen to tissues</td></tr><tr><td><strong>White blood cells</strong></td><td>Help defend against infection</td></tr><tr><td><strong>Platelets</strong></td><td>Help form blood clots</td></tr></tbody></table><blockquote><p><strong>Make the connection</strong><br>If red blood cell levels fall, less oxygen may reach the tissues. How might that affect a patient during exercise?</p></blockquote><h3>Before you move on</h3><ol><li>Explain the role of hemoglobin.</li><li>Distinguish oxygen transport from clotting.</li><li>Use those differences to explain one patient symptom.</li></ol>' } } } : {}),
    ...(id === "op:unsafe-preview" ? { plan: { ...approvalSnapshot.plan, arguments: { ...approvalSnapshot.plan.arguments, item_entry_item_body: '<p>Safe lesson content.</p><script>window.previewEscaped=true;fetch("/unexpected-write",{method:"POST"})</script><style>body{display:none}</style><img src="https://invalid.example/track" onerror="window.previewEscaped=true" alt="Illustration"><iframe src="/operations"></iframe><form action="/unexpected-write"><input name="nonce"><button>Injected approval</button></form><a href="javascript:alert(1)">Read more</a><meta http-equiv="refresh" content="0;url=https://invalid.example/"><svg onload="window.previewEscaped=true"><foreignObject><div>Untrusted embedded content</div></foreignObject></svg>' } } } : {}),
    ...(id === "op:expired-ui-test" ? { approvalExpiresAt: new Date(Date.now() - 60_000).toISOString() } : {}),
    ...(id === "op:unnamed-file" ? { plan: { ...approvalSnapshot.plan, tool: "canvas_delete_file", arguments: { id: "88" }, risk: { approvalClass: "destructive" } } } : {}),
  }),
  operationReviewContext: async (id) => ({ targets: id === "op:missing-names"
    ? [{ field: "course_id", label: "Course", name: "" }, { field: "assignment_id", label: "Quiz", name: "" }]
    : id === "op:unnamed-file" ? []
    : ["op:assignment-preview", "op:discussion-preview"].includes(id) ? [{ field: "course_id", label: "Course", name: "Introduction to Human Biology" }]
    : id === "op:moodle-preview" ? [{ field: "connection_id", label: "Connection", name: "Moodle test school" }, { field: "course_id", label: "Course", name: "Biology in Moodle" }]
    : id === "op:blackboard-preview" ? [{ field: "connection_id", label: "Connection", name: "Blackboard test school" }, { field: "course_id", label: "Course", name: "Biology in Blackboard" }, { field: "content_id", label: "Lesson", name: "Cell structure" }]
    : ["op:page-edit", "op:lesson-preview"].includes(id) ? [{ field: "course_id", label: "Course", name: "Introduction to Human Biology" }, { field: "url_or_id", label: "Page", name: "Blood and circulation" }]
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
  approveOperation: (id) => {
    approvalStates.set(id, id === "op:expired-on-submit" ? "cancelled" : "approved");
    return { ...approvalSnapshot, state: approvalStates.get(id) };
  },
  runApprovedOperation: async (id) => {
    approvalStates.set(id, "dispatching");
    await new Promise((resolve) => { finishApproval = resolve; });
    approvalStates.set(id, "verified");
  },
  cancelOperation: (id) => {
    approvalStates.set(id, "cancelled");
    return { ...approvalSnapshot, state: "cancelled" };
  },
  batchApprovalGet: (id) => id === "batch-large-preview" ? largeBatchSnapshot() : id === "batch-mixed-preview" ? mixedBatchSnapshot() : batchSnapshot(),
  batchApprovalStatus: () => ({
    batch: { state: batchState }, totalChildren: 2,
    confirmedChildren: batchState === "completed" ? 2 : 0,
    states: { 0: batchState === "completed" ? "Confirmed in Canvas" : "In progress", 1: batchState === "completed" ? "Confirmed in Canvas" : "In progress" },
  }),
  approveBatch: () => {
    batchOperationState = "approved";
    return batchSnapshot();
  },
  runApprovedBatch: async () => {
    batchState = "running";
    batchOperationState = "dispatching";
    await new Promise((resolve) => { finishBatchApproval = resolve; });
    batchOperationState = "verified";
    batchState = "completed";
  },
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
  await operationApprovalPage.getByRole("button", { name: "Add this question" }).waitFor();
  assert.equal(await operationApprovalPage.locator(".decision details").getAttribute("open"), null);
  assert.equal(await operationApprovalPage.locator(".destination").innerText().then((text) => text.includes("Week 3: Blood and Circulation")), true);
  assert.doesNotMatch(await operationApprovalPage.locator("body").innerText(), /Course ID|Assignment ID|Evidence question/);
  assert.match(await operationApprovalPage.locator(".question-heading").innerText(), /Red blood cell function/);
  assert.equal(await operationApprovalPage.locator(".answer-option").count(), 4);
  assert.equal(await operationApprovalPage.getByText("Marked correct", { exact: true }).count(), 1);
  await operationApprovalPage.getByRole("region", { name: "Question text preview" }).getByText("A patient has a low red blood cell count.", { exact: false }).waitFor();
  await operationApprovalPage.getByText("Feedback students will see", { exact: true }).click();
  await captureThemes(operationApprovalPage, "approval-operation");
  await captureThemes(operationApprovalPage, "approval-operation-narrow", 320);
  await operationApprovalPage.getByRole("button", { name: "Try the question" }).click();
  await operationApprovalPage.getByRole("radio", { name: "Help the blood clot." }).check();
  await operationApprovalPage.getByRole("button", { name: "Check answer" }).click();
  await operationApprovalPage.getByText("This does not match the answer key. You can try again.", { exact: true }).waitFor();
  assert.match(await operationApprovalPage.locator(".practice-result").innerText(), /Platelets perform this function/);
  await operationApprovalPage.getByRole("radio", { name: "Carry oxygen from the lungs to the body." }).check();
  await operationApprovalPage.getByRole("button", { name: "Check answer" }).click();
  await operationApprovalPage.getByText("This matches the answer key.", { exact: true }).waitFor();
  await captureThemes(operationApprovalPage, "approval-try-question");
  await captureThemes(operationApprovalPage, "approval-try-question-narrow", 320);
  assert.equal(approvalStates.size, 0, "trying a question must not approve or execute it");
  await operationApprovalPage.getByRole("button", { name: "Answer key", exact: true }).click();
  await operationApprovalPage.getByRole("button", { name: "Add this question" }).click();
  await operationApprovalPage.getByRole("heading", { name: "Applying your changes" }).waitFor();
  assert.doesNotMatch(await operationApprovalPage.locator("body").innerText(), /Continue/);
  await captureThemes(operationApprovalPage, "approval-running");
  finishApproval();
  await operationApprovalPage.getByRole("heading", { name: "Changes confirmed" }).waitFor();
  await captureThemes(operationApprovalPage, "approval-confirmed");
  await captureThemes(operationApprovalPage, "approval-confirmed-narrow", 320);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/batches/batch-ui-test`);
  await operationApprovalPage.getByRole("heading", { name: "Check these 2 changes" }).waitFor();
  assert.equal(await operationApprovalPage.locator(".change-content").count(), 2);
  assert.equal(await operationApprovalPage.locator(".warning").innerText(), "This removes content. It cannot be undone from this screen.");
  await operationApprovalPage.locator(".change-item > summary").nth(1).click();
  assert.match(await operationApprovalPage.locator(".destination").nth(1).innerText(), /Human Anatomy[\s\S]+Outdated practice question/);
  await captureThemes(operationApprovalPage, "approval-batch");
  await operationApprovalPage.getByRole("button", { name: "Apply all 2 changes" }).click();
  await operationApprovalPage.getByRole("heading", { name: "Applying your changes" }).waitFor();
  await operationApprovalPage.getByText("0 of 2 changes confirmed in Canvas.", { exact: true }).waitFor();
  finishBatchApproval();
  await operationApprovalPage.getByRole("heading", { name: "Changes confirmed" }).waitFor();
  assert.deepEqual(await operationApprovalPage.locator("[data-operation-status]").allTextContents(), ["Confirmed in Canvas", "Confirmed in Canvas"]);
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Stop remaining changes" }).count(), 0);
  await captureThemes(operationApprovalPage, "approval-batch-confirmed");
  await captureThemes(operationApprovalPage, "approval-batch-confirmed-narrow", 320);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/batches/batch-large-preview`);
  assert.equal(await operationApprovalPage.locator(".change-item:visible").count(), 10);
  assert.equal(await operationApprovalPage.locator(".change-item[open]").count(), 0);
  await operationApprovalPage.getByRole("button", { name: "Next", exact: true }).click();
  await operationApprovalPage.getByText("Showing 11–20 of 40 changes", { exact: true }).waitFor();
  await operationApprovalPage.getByLabel("Find a change").fill("question 40");
  assert.equal(await operationApprovalPage.locator(".change-item:visible").count(), 1);
  await operationApprovalPage.getByText("Showing 1 change", { exact: true }).waitFor();
  await operationApprovalPage.locator(".change-item:visible > summary").click();
  await operationApprovalPage.locator(".change-item:visible").getByRole("button", { name: "Try the question" }).click();
  await operationApprovalPage.locator(".change-item:visible").getByRole("radio", { name: "Help the blood clot." }).check();
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Apply all 40 changes" }).count(), 1);
  assert.equal(batchState, "completed", "browsing the next group must not start it");
  await captureThemes(operationApprovalPage, "approval-large-filtered");
  await operationApprovalPage.getByLabel("Find a change").fill("");
  await captureThemes(operationApprovalPage, "approval-large");
  await captureThemes(operationApprovalPage, "approval-large-narrow", 360);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/batches/batch-mixed-preview`);
  assert.match(await operationApprovalPage.locator(".next-step").innerText(), /your learning platforms/);
  assert.equal(await operationApprovalPage.locator(".change-item").count(), 5);
  await operationApprovalPage.locator(".change-item > summary").first().click();
  assert.equal(await operationApprovalPage.getByRole("region", { name: "Assignment instructions preview" }).count(), 1);
  assert.match(await operationApprovalPage.locator(".change-item").first().innerText(), /Points\s+0[\s\S]+Visible to students\s+No/);
  assert.equal(await operationApprovalPage.locator("time[datetime='2026-09-08T17:00:00Z']").count(), 1);
  await captureThemes(operationApprovalPage, "approval-mixed");
  await captureThemes(operationApprovalPage, "approval-mixed-narrow", 360);
  await operationApprovalPage.getByLabel("Find a change").fill("patient");
  assert.match(await operationApprovalPage.locator(".warning").innerText(), /removes content/);
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Apply all 5 changes" }).count(), 1);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Apage-edit`);
  await operationApprovalPage.getByRole("heading", { name: "Change this page text?" }).waitFor();
  assert.match(await operationApprovalPage.locator(".request").innerText(), /Current text[\s\S]*Cells have membranes\.[\s\S]*Replacement[\s\S]*Cells have protective membranes\./);
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Change this text" }).count(), 1);
  assert.doesNotMatch(await operationApprovalPage.locator("body").innerText(), /Course ID|Url or ID|page_guard/);
  await captureThemes(operationApprovalPage, "approval-page-correction");
  await captureThemes(operationApprovalPage, "approval-page-correction-narrow", 360);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Ashort-preview`);
  assert.ok((await operationApprovalPage.getByRole("region", { name: "Question text preview" }).boundingBox()).height < 90, "short text must not sit in a fixed-height box");
  await captureThemes(operationApprovalPage, "approval-short");
  await captureThemes(operationApprovalPage, "approval-short-narrow", 320);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Alesson-preview`);
  await operationApprovalPage.getByRole("table").waitFor();
  await captureThemes(operationApprovalPage, "approval-lesson");
  await captureThemes(operationApprovalPage, "approval-lesson-narrow", 360);
  const unexpectedRequests = [];
  const observeRequest = (request) => { if (/invalid\.example|unexpected-write/.test(request.url())) unexpectedRequests.push(request.url()); };
  operationApprovalPage.on("request", observeRequest);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Aunsafe-preview`);
  const safePreview = operationApprovalPage.getByRole("region", { name: "Question text preview" });
  await safePreview.getByText("Safe lesson content.", { exact: true }).waitFor();
  assert.equal(await safePreview.locator("script, style, iframe, form, input, button, meta, svg, [onerror], [href], [src]").count(), 0);
  assert.equal(await operationApprovalPage.evaluate(() => window.previewEscaped), undefined);
  assert.deepEqual(unexpectedRequests, []);
  assert.equal(approvalStates.has("op:unsafe-preview"), false);
  operationApprovalPage.off("request", observeRequest);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Amissing-names`);
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Add this question" }).count(), 0);
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
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Aunnamed-file`);
  assert.equal(await operationApprovalPage.getByRole("button", { name: "Apply this change" }).count(), 0);
  const fileReviewUrl = operationApprovalPage.url();
  const fileNonce = await operationApprovalPage.locator('input[name="nonce"]').inputValue();
  const refusedFile = await operationApprovalPage.request.post(`${fileReviewUrl}/approve`, { form: { nonce: fileNonce }, headers: { origin: new URL(fileReviewUrl).origin, referer: fileReviewUrl } });
  assert.equal(refusedFile.status(), 409);
  assert.equal(approvalStates.has("op:unnamed-file"), false);
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Aexpired-ui-test`);
  await operationApprovalPage.getByRole("heading", { name: "This review has expired" }).waitFor();
  assert.equal(await operationApprovalPage.locator("button").count(), 0);
  await captureThemes(operationApprovalPage, "approval-expired");
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/op%3Aexpired-on-submit`);
  await operationApprovalPage.getByRole("button", { name: "Add this question" }).click();
  await operationApprovalPage.getByRole("heading", { name: "Request cancelled" }).waitFor();
  assert.equal(await operationApprovalPage.getByRole("heading", { name: "Changes confirmed" }).count(), 0);
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
  assert.equal(binding.courseName, "Introduction to Human Biology");
  process.stderr.write("[browser-test] exact Canvas account bound\n");

  await popup.reload();
  await popup.locator("#account").waitFor();
  assert.equal(await popup.locator("#canvas-value").innerText(), "Course tab open");
  assert.match(await popup.locator("#account-origin").innerText(), /Introduction to Human Biology/);
  assert.doesNotMatch(await popup.locator("#account-origin").innerText(), /Course 42/);
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
  const pageBefore = canvas.lesson();
  const pageRead = await runtime.call("canvas_show_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId } });
  assert.equal(pageRead.result.pageBodySha256, createHash("sha256").update(pageBefore.body).digest("hex"));
  const pageGuard = { page_id: "91", revision_id: "1", body_sha256: pageRead.result.pageBodySha256, fields: { url: "lesson", title: pageBefore.title, published: true, front_page: false, editing_roles: "teachers" }, find_text: "Cells have membranes.", replace_text: "Cells have protective membranes." };
  const pageArgs = { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId, page_guard: pageGuard, outer_grant: { ...grant, effect_receipt_id: "effect:page-edit-test" } } };
  const pageWrite = await runtime.call("canvas_update_create_page_courses", pageArgs);
  assert.equal(pageWrite.ok, true, JSON.stringify(pageWrite));
  assert.equal(pageWrite.result.verification.status, "verified", JSON.stringify(pageWrite));
  assert.equal(pageWrite.result.verification.createdRevisionId, "2");
  assert.deepEqual(canvas.lesson(), { ...pageBefore, body: pageBefore.body.replace(pageGuard.find_text, pageGuard.replace_text) });
  assert.equal(canvas.pageWrites(), 1);
  canvas.changeLesson();
  const stalePage = await runtime.call("canvas_update_create_page_courses", { ...pageArgs, _morrow: { ...pageArgs._morrow, outer_grant: { ...grant, effect_receipt_id: "effect:stale-page-test" } } });
  assert.equal(stalePage.ok, false);
  assert.equal(stalePage.resultState, "not_sent");
  assert.match(JSON.stringify(stalePage), /page_changed/);
  assert.equal(canvas.pageWrites(), 1);
  canvas.setLesson("Remove this.");
  const removalBefore = canvas.lesson();
  const removalRead = await runtime.call("canvas_show_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId } });
  const removalGuard = { page_id: "91", revision_id: "4", body_sha256: removalRead.result.pageBodySha256, fields: { url: "lesson", title: removalBefore.title, published: true, front_page: false, editing_roles: "teachers" }, find_text: "Remove this.", replace_text: "" };
  const removalWrite = await runtime.call("canvas_update_create_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId, page_guard: removalGuard, outer_grant: { ...grant, effect_receipt_id: "effect:page-removal-test" } } });
  assert.equal(removalWrite.ok, true, JSON.stringify(removalWrite));
  assert.equal(removalWrite.result.verification.status, "verified", JSON.stringify(removalWrite));
  assert.equal(canvas.lesson().body, "");
  assert.equal(canvas.pageWrites(), 2);
  canvas.setLesson("<p>Use &times here.</p>");
  const entityBefore = canvas.lesson();
  const entityRead = await runtime.call("canvas_show_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId } });
  const entityGuard = { page_id: "91", revision_id: "6", body_sha256: entityRead.result.pageBodySha256, fields: { url: "lesson", title: entityBefore.title, published: true, front_page: false, editing_roles: "teachers" }, find_text: "times", replace_text: "plus" };
  const entityWrite = await runtime.call("canvas_update_create_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId, page_guard: entityGuard, outer_grant: { ...grant, effect_receipt_id: "effect:page-entity-test" } } });
  assert.equal(entityWrite.ok, false);
  assert.equal(entityWrite.resultState, "not_sent");
  assert.match(JSON.stringify(entityWrite), /page_text_inside_entity/);
  assert.equal(canvas.lesson().body, entityBefore.body);
  assert.equal(canvas.pageWrites(), 2);
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

  const uncertainArgs = {
    id: "43",
    _morrow: { source_binding_id: binding.sourceBindingId, operation_id: "operation:unreadable-write", outer_grant: { ...grant, effect_receipt_id: "effect:unreadable-write" } },
  };
  const uncertain = await runtime.call("canvas_add_course_to_favorites", uncertainArgs);
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.problem?.code, "write_outcome_unknown", JSON.stringify(uncertain));
  assert.equal(uncertain.problem?.recoverable, false);
  assert.equal(canvas.unreadableWriteResponses(), 1);
  assert.equal((await runtime.call("canvas_add_course_to_favorites", uncertainArgs)).ok, false);
  assert.equal(canvas.unreadableWriteResponses(), 1);

  await canvasPage.close();
  await waitFor(() => runtime.bridge.listBindings()[0]?.runtimeVerified === false, "closed Canvas tab still advertised as available");
  await popup.locator("#canvas-value").filter({ hasText: /^Course tab needed$/ }).waitFor();
  await popup.getByRole("button", { name: "Connect Canvas course", exact: true }).waitFor();
  assert.equal((await runtime.call("canvas_get_new_quiz", { course_id: "42", assignment_id: "77", _morrow: { source_binding_id: binding.sourceBindingId } })).resultState, "not_sent");
  await captureThemes(popup, "popup-course-closed", 360);
  canvasPage = await context.newPage();
  await canvasPage.goto(canvasUrl);
  const newTabId = await replacementWorker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, canvasUrl);
  assert.equal((await popup.evaluate(async (tabId) => chrome.runtime.sendMessage({ type: "morrow_connect_canvas", tabId }), newTabId)).ok, true);
  const rebound = await waitFor(() => runtime.bridge.listBindings().find((entry) => entry.runtimeVerified && entry.sourceBindingId !== binding.sourceBindingId), "Canvas tab did not reconnect with fresh authority");
  assert.equal(rebound.sessionGeneration, 2);
  await popup.locator("#canvas-value").filter({ hasText: /^Course tab open$/ }).waitFor();

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
