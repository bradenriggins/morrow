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
import { canvasOperationAdmission, canvasReadbackAssessment } from "../../connector/extension/generated/canvas-operation-admission.js";
import { CanvasConnectorRuntime } from "../../packages/canvas-connector-mcp/dist/runtime.js";
import { LoopbackApprovalServer } from "../../packages/mcp-server/dist/approval-server.js";
import { docxWithMixedAltText, encryptedPdf, taggedPdf } from "../../packages/mcp-server/test/fixtures/canvas-files/index.mjs";

const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION = resolve(ROOT, "connector/extension");
const OUTPUT = resolve(ROOT, "output/playwright/canvas-connector");
const LONG_COURSE_NAME = "Synthetic Course 501: Advanced Human Biology: Molecular Foundations, Clinical Connections, and Evidence-Based Practice";
const FILE_TEXT = "\uFEFFbounded Canvas file bytes";
const FILE_TRANSFER_BYTES = Buffer.from("reviewed Canvas course file bytes\n", "utf8");
/**
 * Course documents for the structural signal route, served from the synthetic
 * storage host by path. Their bytes are the same hand-built fixtures that
 * scripts/test/canvas-file-signals.test.mjs reads.
 */
const SIGNAL_DOCUMENTS = Object.freeze([
  Object.freeze({
    id: "504", path: "/stored-syllabus.pdf", contentType: "application/pdf",
    displayName: "Week one syllabus.pdf", filename: "week-one-syllabus.pdf", bytes: taggedPdf(),
  }),
  Object.freeze({
    id: "505", path: "/stored-handout.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    displayName: "Week one handout.docx", filename: "week-one-handout.docx", bytes: docxWithMixedAltText(),
  }),
  Object.freeze({
    id: "506", path: "/stored-locked.pdf", contentType: "application/pdf",
    displayName: "Locked reading.pdf", filename: "locked-reading.pdf", bytes: encryptedPdf(),
  }),
]);

async function captureThemes(page, name, width = 900, { allowTechnicalTerms = false } = {}) {
  await page.setViewportSize({ width, height: 760 });
  const mark = page.locator(".brand img, .brand-wordmark img").first();
  assert.equal(await mark.evaluate((image) => image.complete && image.naturalWidth > 0), true);
  if (!allowTechnicalTerms) assert.doesNotMatch(await page.locator("body").innerText(), /\b(?:MCP|nonce|digest|dispatch|binding|frozen)\b/i);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.locator("main").screenshot({ path: join(OUTPUT, `${name}-${colorScheme}.png`) });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

async function captureSetupGuide(page, name) {
  for (const width of [320, 390, 1280]) {
    await captureThemes(page, `${name}-${width}`, width, { allowTechnicalTerms: true });
    const headingsFit = await page.locator("h1, h2").evaluateAll((headings) => headings
      .filter((heading) => getComputedStyle(heading).display !== "none")
      .every((heading) => {
        const style = getComputedStyle(heading);
        const lineHeight = Number.parseFloat(style.lineHeight);
        return heading.scrollWidth <= heading.clientWidth && heading.getBoundingClientRect().height <= lineHeight * 1.2;
      }));
    assert.equal(headingsFit, true, `setup guide headings must fit at ${width}px`);
  }
}

// The settings page mirrors every notice into one polite `#announcement` region
// for screen readers (connector/extension/settings/settings.js), so a notice's
// text is in the page twice. `#notice` comes first in the document, so the
// settings notice assertions below take the first match and still read the
// visible notice.
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

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function protectedStateDigest(value, field) {
  const protectedFields = { ...value };
  delete protectedFields[field];
  delete protectedFields.updated_at;
  return createHash("sha256").update(stable(protectedFields)).digest("hex");
}

/** The whole fresh Classic Quiz question minus updated_at and minus the one field this repair edits. */
function classicQuestionProtectedDigest(question, answer) {
  const state = structuredClone(question);
  delete state.updated_at;
  if (!answer) delete state.question_text;
  else delete state.answers.find((candidate) => candidate.id === answer.id)[answer.field];
  return createHash("sha256").update(stable(state)).digest("hex");
}

function newQuizItemProtectedStateDigest(value, remove = (entry) => { delete entry.item_body; }) {
  const protectedFields = structuredClone(value);
  delete protectedFields.updated_at;
  delete protectedFields.entry.updated_at;
  remove(protectedFields.entry);
  return createHash("sha256").update(stable(protectedFields)).digest("hex");
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startCanvas(directory) {
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  let quizItemWrites = 0;
  const requests = [];
  let quizItem = null;
  let pageWrites = 0;
  let pageRevision = 1;
  let principalId = "7";
  let heldPageWrites = 0;
  const pendingPageWrites = [];
  let externalFileDownloadUrl = "";
  // Course documents the structural signal route reads, keyed by Canvas file id.
  const documentFiles = new Map();
  let externalFileUploadUrl = "";
  const transferredFiles = new Map();
  let transferConfirmationAuthenticated = false;
  const lesson = { page_id: "91", url: "lesson", title: "Cell structure", body: '<h2>Cell structure</h2><p>Cells have membranes.</p><img src="/courses/42/files/8" alt="Cell"><img src="/courses/42/files/9?value=a>b&part=opaque">', published: true, front_page: false, editing_roles: "teachers", publish_at: null };
  const assignment = { id: "88", course_id: "42", name: "Cell transport reflection", description: '<p>Explain active transport.</p><img src="/courses/42/files/10">', due_at: "2026-09-08T17:00:00Z", unlock_at: null, lock_at: null, points_possible: 10, published: true, submission_types: ["online_text_entry"] };
  let assignmentWrites = 0;
  let bulkAssignmentDateWrites = 0;
  let bulkAssignmentDates = [{ id: "188", course_id: "42", all_dates: [{ base: true, due_at: "2026-10-01T17:00:00Z", unlock_at: null, lock_at: null }] }];
  let enrollmentReactivationWrites = 0;
  const enrollment = { id: "51", course_id: "42", user_id: "99", enrollment_state: "inactive" };
  const discussion = { id: "89", course_id: "42", title: "Cell transport discussion", message: '<p>Discuss one transport process.</p><img src="/courses/42/files/11">', discussion_type: "threaded", published: true, delayed_post_at: null, lock_at: null };
  let discussionWrites = 0;
  const classicQuiz = { id: "77", course_id: "42", title: "Cell structure check", description: '<p>Review the diagram.</p><img src="/courses/42/files/16">', quiz_type: "assignment", assignment_group_id: "9", points_possible: 25, published: true, show_correct_answers: true, time_limit: 20, due_at: "2026-09-10T17:00:00Z" };
  let classicQuizWrites = 0;
  // Canvas returns the whole Classic Quiz question, and rebuilds it from the
  // whole request, so this fixture holds every field the guarded repair has to
  // read back and resend. 302 sits in a question group and 303 is a question
  // type the repair does not support.
  let classicQuizQuestion = {
    id: "301", quiz_id: "77", quiz_group_id: null, assessment_question_id: "9001", position: 1,
    question_name: "Cell structure", question_type: "multiple_choice_question",
    question_text: '<p>Which part controls the cell?</p><img src="/courses/42/files/17">',
    points_possible: 2, correct_comments: "Correct.", incorrect_comments: "Review the diagram.", neutral_comments: "",
    correct_comments_html: "<p>Correct.</p>", incorrect_comments_html: "<p>Review the diagram.</p>", neutral_comments_html: "",
    answers: [
      { id: "6656", answer_text: '<p>Nucleus</p><img src="/courses/42/files/18">', answer_weight: 100, answer_comments: "Correct." },
      { id: "6657", answer_text: "<p>Cell wall</p>", answer_weight: 0, answer_comments: "Review the diagram." },
    ],
  };
  const groupedQuizQuestion = { ...structuredClone(classicQuizQuestion), id: "302", quiz_group_id: "5501" };
  const unsupportedQuizQuestion = { ...structuredClone(classicQuizQuestion), id: "303", question_type: "matching_question" };
  let classicQuizQuestionWrites = 0;
  let sectionWrites = 0;
  // 302 is the selected course's own section, 401 belongs to another course, 305 is removed
  // outright, 306 is removed from the course while its own route still answers, and 307 keeps its
  // saved name whatever the change asked for.
  const sections = new Map([
    ["302", { id: "302", course_id: "42", name: "Section B", start_at: null, end_at: null }],
    ["305", { id: "305", course_id: "42", name: "Section E", start_at: null, end_at: null }],
    ["306", { id: "306", course_id: "42", name: "Section F", start_at: null, end_at: null }],
    ["307", { id: "307", course_id: "42", name: "Section G", start_at: null, end_at: null }],
    ["401", { id: "401", course_id: "43", name: "Anatomy section", start_at: null, end_at: null }],
  ]);
  const courseSections = new Set(["302", "305", "306", "307"]);
  let groupPageWrites = 0;
  // 88 is the selected course's own group, 91 belongs to another course, 92 is a group a person made
  // for themselves outside any course, and 93 reads as this course's group while the course's own
  // listing of its groups does not name it.
  const groups = new Map([
    ["88", { id: "88", course_id: "42", context_type: "Course", name: "Lab team 1" }],
    ["91", { id: "91", course_id: "43", context_type: "Course", name: "Anatomy team" }],
    ["92", { id: "92", course_id: null, context_type: "User", name: "Study buddies" }],
    ["93", { id: "93", course_id: "42", context_type: "Course", name: "Retired lab team" }],
  ]);
  const courseGroups = new Set(["88"]);
  const groupPages = new Map([
    ["88/week-one", { url: "week-one", title: "Week one", body: "<p>Plan</p>", published: true }],
    ["91/week-one", { url: "week-one", title: "Week one", body: "<p>Other course plan</p>", published: true }],
    ["92/week-one", { url: "week-one", title: "Week one", body: "<p>Personal plan</p>", published: true }],
    ["93/week-one", { url: "week-one", title: "Week one", body: "<p>Retired plan</p>", published: true }],
  ]);
  let courseFileWrites = 0;
  let createdFolderId = 0;
  // 601 is the selected course's own file, 602 is removed outright, 701 belongs to another course,
  // 702 hangs from the Canvas account, and 703 reads as this course's file while the course's own
  // list of files does not name it. Every file carries the signed link Canvas returns with it.
  const courseFile = (id, overrides) => ({
    id, context_type: "Course", context_id: "42", folder_id: "84",
    display_name: "Syllabus.pdf", filename: "syllabus.pdf", "content-type": "application/pdf",
    size: 20480, updated_at: "2026-09-06T12:00:00Z",
    url: `https://127.0.0.1/files/${id}/download?verifier=synthetic-course-file-verifier`,
    ...overrides,
  });
  const files = new Map([
    ["601", courseFile("601")],
    ["602", courseFile("602", { display_name: "Old handout.pdf" })],
    ["701", courseFile("701", { context_id: "43", folder_id: "86" })],
    ["702", courseFile("702", { context_type: "Account", context_id: "5" })],
    ["703", courseFile("703", { display_name: "Retired handout.pdf" })],
  ]);
  const courseFiles = new Set(["601", "602"]);
  // 84 holds the course files, 85 is where a file moves to, and 86 belongs to the other course.
  const folders = new Map([
    ["84", { id: "84", context_type: "Course", context_id: "42", name: "Week 1", parent_folder_id: "80", updated_at: "2026-09-06T12:00:00Z" }],
    ["85", { id: "85", context_type: "Course", context_id: "42", name: "Handouts", parent_folder_id: "80", updated_at: "2026-09-06T12:00:00Z" }],
    ["86", { id: "86", context_type: "Course", context_id: "43", name: "Anatomy handouts", parent_folder_id: "83", updated_at: "2026-09-06T12:00:00Z" }],
  ]);
  const courseFolders = new Set(["84", "85"]);
  let calendarEventWrites = 0;
  let createdCalendarEventId = 0;
  // 501 is on the selected course's calendar, 502 is removed outright, 503 is removed from the
  // course calendar while its own route still answers, and 601 is on another course's calendar.
  const calendarEvent = (id, overrides) => ({
    id, context_code: "course_42", context_name: "Introduction to Human Biology", title: "Lab review",
    start_at: "2026-09-10T16:00:00Z", end_at: "2026-09-10T17:00:00Z",
    description: "<p>Bring the worksheet.</p>", location_name: "Room 2", workflow_state: "active",
    ...overrides,
  });
  const calendarEvents = new Map([
    ["501", calendarEvent("501")],
    ["502", calendarEvent("502", { title: "Old study session" })],
    ["503", calendarEvent("503", { title: "Cancelled review" })],
    ["601", calendarEvent("601", { context_code: "course_43", title: "Anatomy lab" })],
  ]);
  const courseCalendarEvents = new Set(["501", "502", "503"]);
  let appointmentGroupWrites = 0;
  // 701 serves the selected course alone; 702 serves it together with another course, which is the
  // one Morrow refuses outright.
  const appointmentGroups = new Map([
    ["701", { id: "701", context_codes: ["course_42"], sub_context_codes: [], title: "Office hours", location_name: "Room 2", workflow_state: "active" }],
    ["702", { id: "702", context_codes: ["course_42", "course_43"], sub_context_codes: [], title: "Shared office hours", location_name: "Room 3", workflow_state: "active" }],
  ]);
  const courses = Array.from({ length: 501 }, (_, index) => ({ id: String(index + 1), name: `Synthetic Course ${index + 1}` }));
  courses[41] = { id: "42", name: "Introduction to Human Biology" };
  courses[42] = { id: "43", name: "Synthetic Human Anatomy" };
  courses[500] = { id: "501", name: LONG_COURSE_NAME };
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);
    const json = (status, value, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    const coursePage = url.pathname.match(/^(?:\/canvas)?\/courses\/([1-9][0-9]*)(?:\/(?:pages|assignments|quizzes)\/[^/]+)?$/);
    if (coursePage || url.pathname === "/calendar") {
      response.writeHead(200, { "content-type": "text/html", "set-cookie": ["canvas_session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax", "_csrf_token=synthetic%2Bcsrf%2F%3D; Path=/; Secure; SameSite=Lax"] });
      response.end(`<!doctype html><html><head></head><body><h1>${coursePage ? `Synthetic Canvas Course ${coursePage[1]}` : "Synthetic Canvas calendar"}</h1></body></html>`);
      return;
    }
    if (url.pathname === "/api/v1/users/self/profile") return json(200, { id: principalId, name: "Synthetic Instructor" });
    if (url.pathname === "/api/v1/courses/42/folders/81" && request.method === "GET") return json(200, { id: "81" });
    if (url.pathname === "/api/v1/courses/43/folders/82" && request.method === "GET") return json(200, { id: "82" });
    if (["/api/v1/folders/81/files", "/api/v1/folders/82/files"].includes(url.pathname) && request.method === "POST") {
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session" });
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        assert.deepEqual([...body.keys()], ["name", "size", "content_type", "on_duplicate"]);
        assert.equal(body.get("name"), "reviewed-material.txt");
        assert.equal(body.get("size"), String(FILE_TRANSFER_BYTES.byteLength));
        assert.equal(body.get("content_type"), "text/plain");
        assert.equal(body.get("on_duplicate"), "rename");
        assert.ok(externalFileUploadUrl, "transfer upload URL was not configured");
        const courseFile = url.pathname === "/api/v1/folders/81/files"
          ? { key: "morrow-reviewed-file-42", courseId: "42", folderId: "81" }
          : { key: "morrow-reviewed-file-43", courseId: "43", folderId: "82" };
        json(200, { upload_url: externalFileUploadUrl, upload_params: { key: courseFile.key, policy: "synthetic-policy" } });
      });
      return;
    }
    if (url.pathname === "/api/v1/files/502" && request.method === "GET") {
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session" });
      }
      transferConfirmationAuthenticated = true;
      transferredFiles.set("502", { id: "502", courseId: "42", folderId: "81" });
      return json(200, { id: "502" }, { "access-control-allow-origin": "*" });
    }
    if (url.pathname === "/api/v1/files/503" && request.method === "GET") {
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session" });
      }
      transferConfirmationAuthenticated = true;
      transferredFiles.set("503", { id: "503", courseId: "43", folderId: "82" });
      return json(200, { id: "503" }, { "access-control-allow-origin": "*" });
    }
    if (url.pathname === "/api/v1/courses/42/files/502" && request.method === "GET") {
      if (!transferredFiles.has("502")) return json(404, { error: "not_found" });
      return json(200, {
        id: "502", folder_id: "81", display_name: "reviewed-material.txt", filename: "reviewed-material.txt",
        "content-type": "text/plain", size: FILE_TRANSFER_BYTES.byteLength,
        url: `https://${request.headers.host}/files/502/download?verifier=synthetic-transfer-verifier`,
      });
    }
    if (url.pathname === "/api/v1/courses/43/files/503" && request.method === "GET") {
      if (!transferredFiles.has("503")) return json(404, { error: "not_found" });
      return json(200, {
        id: "503", folder_id: "82", display_name: "reviewed-material.txt", filename: "reviewed-material.txt",
        "content-type": "text/plain", size: FILE_TRANSFER_BYTES.byteLength,
        url: `https://${request.headers.host}/files/503/download?verifier=synthetic-transfer-verifier-43`,
      });
    }
    if (url.pathname === "/files/502/download" && request.method === "GET") {
      if (!externalFileDownloadUrl) return json(503, { error: "file_storage_not_configured" });
      response.writeHead(302, { Location: externalFileDownloadUrl });
      response.end();
      return;
    }
    if (url.pathname === "/files/503/download" && request.method === "GET") {
      if (!externalFileDownloadUrl) return json(503, { error: "file_storage_not_configured" });
      response.writeHead(302, { Location: externalFileDownloadUrl });
      response.end();
      return;
    }
    if (url.pathname === "/api/v1/courses/42/files/501" && request.method === "GET") {
      return json(200, {
        id: "501", display_name: "Cross-origin storage text.txt", filename: "cross-origin-storage-text.txt",
        "content-type": "text/plain", size: Buffer.byteLength(FILE_TEXT), updated_at: "2026-09-06T12:00:00Z",
        url: `https://${request.headers.host}/files/501/download?download=1&download_frd=1&verifier=synthetic-file-verifier`,
      });
    }
    if (url.pathname === "/files/501/download" && request.method === "GET") {
      if (!externalFileDownloadUrl) return json(503, { error: "file_storage_not_configured" });
      response.writeHead(302, { Location: externalFileDownloadUrl });
      response.end();
      return;
    }
    const documentMetadata = /^\/api\/v1\/courses\/42\/files\/(\d+)$/.exec(url.pathname);
    if (documentMetadata && request.method === "GET" && documentFiles.has(documentMetadata[1])) {
      const document = documentFiles.get(documentMetadata[1]);
      return json(200, {
        id: document.id, display_name: document.displayName, filename: document.filename,
        "content-type": document.contentType, size: document.bytes.byteLength, updated_at: "2026-09-06T12:00:00Z",
        url: `https://${request.headers.host}/files/${document.id}/download?download=1&download_frd=1&verifier=synthetic-file-verifier`,
      });
    }
    const documentDownload = /^\/files\/(\d+)\/download$/.exec(url.pathname);
    if (documentDownload && request.method === "GET" && documentFiles.has(documentDownload[1])) {
      response.writeHead(302, { Location: documentFiles.get(documentDownload[1]).downloadUrl });
      response.end();
      return;
    }
    if (url.pathname === "/api/v1/courses/42/sections" && request.method === "GET") {
      return json(200, [...courseSections].map((id) => ({ ...sections.get(id) })));
    }
    if (url.pathname === "/api/v1/courses/42/groups" && request.method === "GET") {
      return json(200, [...courseGroups].map((id) => ({ ...groups.get(id) })));
    }
    const groupMatch = url.pathname.match(/^\/api\/v1\/groups\/([1-9][0-9]*)$/);
    if (groupMatch && request.method === "GET") {
      const group = groups.get(groupMatch[1]);
      return group ? json(200, group) : json(404, { error: "not_found" });
    }
    const groupPageMatch = url.pathname.match(/^\/api\/v1\/groups\/([1-9][0-9]*)\/pages\/([^/]+)$/);
    if (groupPageMatch) {
      const key = `${groupPageMatch[1]}/${decodeURIComponent(groupPageMatch[2])}`;
      const page = groupPages.get(key);
      if (request.method === "GET") return page ? json(200, page) : json(404, { error: "not_found" });
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      if (!page) return json(404, { error: "not_found" });
      if (request.method === "PUT") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.deepEqual([...body.keys()], ["wiki_page[body]"]);
          groupPageWrites += 1;
          page.body = body.get("wiki_page[body]");
          json(200, page);
        });
        return;
      }
    }
    if (url.pathname === "/api/v1/courses/42/files" && request.method === "GET") {
      return json(200, [...courseFiles].map((id) => ({ ...files.get(id) })));
    }
    if (url.pathname === "/api/v1/courses/42/folders" && request.method === "GET") {
      return json(200, [...courseFolders].map((id) => ({ ...folders.get(id) })));
    }
    const fileMatch = url.pathname.match(/^\/api\/v1\/files\/(6[0-9]{2}|7[0-9]{2})$/);
    if (fileMatch) {
      const file = files.get(fileMatch[1]);
      if (request.method === "GET") return file ? json(200, file) : json(404, { error: "not_found" });
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      if (!file) return json(404, { error: "not_found" });
      if (request.method === "DELETE") {
        courseFileWrites += 1;
        courseFiles.delete(file.id);
        files.delete(file.id);
        return json(200, file);
      }
      if (request.method === "PUT") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          // Canvas keeps the new name as the file's display name and the destination as the folder
          // it is in, and it never rewrites the bytes for either change.
          assert.equal([...body.keys()].every((key) => ["name", "parent_folder_id", "on_duplicate"].includes(key)), true);
          assert.equal(body.get("on_duplicate"), "rename");
          courseFileWrites += 1;
          if (body.has("name")) file.display_name = body.get("name");
          if (body.has("parent_folder_id")) file.folder_id = body.get("parent_folder_id");
          file.updated_at = "2026-09-06T12:30:00Z";
          json(200, file);
        });
        return;
      }
    }
    const folderMatch = url.pathname.match(/^\/api\/v1\/folders\/([1-9][0-9]*)$/);
    if (folderMatch && request.method === "GET") {
      const folder = folders.get(folderMatch[1]);
      return folder ? json(200, folder) : json(404, { error: "not_found" });
    }
    const folderChildMatch = url.pathname.match(/^\/api\/v1\/folders\/([1-9][0-9]*)\/folders$/);
    if (folderChildMatch && request.method === "POST") {
      const parent = folders.get(folderChildMatch[1]);
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      if (!parent) return json(404, { error: "not_found" });
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        assert.deepEqual([...body.keys()], ["name"]);
        createdFolderId += 1;
        const created = {
          id: String(94 + createdFolderId), context_type: parent.context_type, context_id: parent.context_id,
          name: body.get("name"), parent_folder_id: parent.id, updated_at: "2026-09-06T12:30:00Z",
        };
        folders.set(created.id, created);
        if (courseFolders.has(parent.id)) courseFolders.add(created.id);
        json(200, created);
      });
      return;
    }
    // Canvas answers a calendar listing for the calendars the request names. Morrow asks for the
    // selected course's own calendar and for the whole of it; a request that names neither gets the
    // signed-in person's calendars, which is not that course's own listing.
    if (url.pathname === "/api/v1/calendar_events" && request.method === "GET") {
      const named = url.searchParams.getAll("context_codes");
      const wholeCalendar = url.searchParams.get("all_events") === "true";
      if (named.length === 1 && named[0] === "course_42" && wholeCalendar) {
        return json(200, [...courseCalendarEvents].map((id) => ({ ...calendarEvents.get(id) })));
      }
      return json(200, [...calendarEvents.values()].map((entry) => ({ ...entry })));
    }
    if (url.pathname === "/api/v1/calendar_events" && request.method === "POST") {
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        assert.equal(body.get("calendar_event[context_code]"), "course_42");
        assert.equal([...body.keys()].every((key) => key.startsWith("calendar_event[")), true);
        calendarEventWrites += 1;
        createdCalendarEventId += 1;
        const created = calendarEvent(String(504 + createdCalendarEventId), {
          context_code: body.get("calendar_event[context_code]"),
          title: body.get("calendar_event[title]"),
          start_at: body.get("calendar_event[start_at]"),
          end_at: body.get("calendar_event[end_at]"),
          description: body.get("calendar_event[description]") ?? "",
          location_name: body.get("calendar_event[location_name]") ?? "",
        });
        calendarEvents.set(created.id, created);
        courseCalendarEvents.add(created.id);
        json(200, created);
      });
      return;
    }
    const calendarEventMatch = url.pathname.match(/^\/api\/v1\/calendar_events\/([1-9][0-9]*)$/);
    if (calendarEventMatch) {
      const event = calendarEvents.get(calendarEventMatch[1]);
      if (request.method === "GET") return event ? json(200, event) : json(404, { error: "not_found" });
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      if (!event) return json(404, { error: "not_found" });
      if (request.method === "DELETE") {
        calendarEventWrites += 1;
        courseCalendarEvents.delete(event.id);
        // 503 keeps answering on its own route as a cancelled event, so its removal is proved from
        // the course calendar instead of from a 404.
        if (event.id === "503") event.workflow_state = "deleted";
        else calendarEvents.delete(event.id);
        return json(200, event);
      }
      if (request.method === "PUT") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.equal([...body.keys()].every((key) => key.startsWith("calendar_event[")), true);
          calendarEventWrites += 1;
          for (const [field, wire] of [["title", "title"], ["start_at", "start_at"], ["end_at", "end_at"],
            ["description", "description"], ["location_name", "location_name"], ["context_code", "context_code"]]) {
            if (body.has(`calendar_event[${wire}]`)) event[field] = body.get(`calendar_event[${wire}]`);
          }
          json(200, event);
        });
        return;
      }
    }
    const appointmentGroupMatch = url.pathname.match(/^\/api\/v1\/appointment_groups\/([1-9][0-9]*)$/);
    if (appointmentGroupMatch) {
      const group = appointmentGroups.get(appointmentGroupMatch[1]);
      if (request.method === "GET") return group ? json(200, group) : json(404, { error: "not_found" });
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      if (!group) return json(404, { error: "not_found" });
      if (request.method === "PUT") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.deepEqual(body.getAll("appointment_group[context_codes]"), ["course_42"]);
          appointmentGroupWrites += 1;
          if (body.has("appointment_group[title]")) group.title = body.get("appointment_group[title]");
          if (body.has("appointment_group[location_name]")) group.location_name = body.get("appointment_group[location_name]");
          json(200, group);
        });
        return;
      }
    }
    const sectionMatch = url.pathname.match(/^\/api\/v1\/sections\/([1-9][0-9]*)$/);
    if (sectionMatch) {
      const section = sections.get(sectionMatch[1]);
      if (request.method === "GET") return section ? json(200, section) : json(404, { error: "not_found" });
      if (!String(request.headers.cookie || "").includes("canvas_session=synthetic") || request.headers["x-csrf-token"] !== "synthetic+csrf/=") {
        return json(403, { error: "missing browser session" });
      }
      if (!section) return json(404, { error: "not_found" });
      if (request.method === "DELETE") {
        sectionWrites += 1;
        courseSections.delete(section.id);
        if (section.id !== "306") sections.delete(section.id);
        return json(200, section);
      }
      if (request.method === "PUT") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.deepEqual([...body.keys()], ["course_section[name]"]);
          sectionWrites += 1;
          if (section.id !== "307") section.name = body.get("course_section[name]");
          json(200, section);
        });
        return;
      }
    }
    if (url.pathname === "/api/v1/courses") {
      const page = Number(url.searchParams.get("page"));
      assert.equal(Number.isSafeInteger(page) && page >= 1, true);
      const start = (page - 1) * 100;
      const nextPage = start + 100 < courses.length ? page + 1 : null;
      return json(200, courses.slice(start, start + 100), nextPage === null ? {} : {
        Link: `<https://${request.headers.host}/api/v1/courses?enrollment_state=active&per_page=100&page=${nextPage}>; rel="next"`,
      });
    }
    const courseMatch = url.pathname.match(/^\/api\/v1\/courses\/([1-9][0-9]*)$/);
    if (courseMatch) {
      const course = courses.find((entry) => entry.id === courseMatch[1]);
      return course ? json(200, course) : json(404, { error: "not_found" });
    }
    if (url.pathname === "/api/v1/courses/42/assignments/bulk_update" && request.method === "PUT") {
      if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")
        || !String(request.headers["content-type"] || "").startsWith("application/json")) {
        return json(403, { error: "missing browser session or JSON body" });
      }
      bodyJson(request).then((body) => {
        assert.deepEqual(body, [{ id: "188", all_dates: [{ base: true, due_at: "2026-10-02T17:00:00Z", unlock_at: null }] }]);
        bulkAssignmentDates = body.map((entry) => ({ ...entry, course_id: "42" }));
        bulkAssignmentDateWrites += 1;
        json(200, { id: "981", workflow_state: "queued" });
      });
      return;
    }
    if (url.pathname === "/api/v1/progress/981" && request.method === "GET") return json(200, { id: "981", workflow_state: "completed" });
    if (url.pathname === "/api/v1/courses/42/assignments" && request.method === "GET") {
      const assignmentIds = url.searchParams.getAll("assignment_ids");
      if (!assignmentIds.length) return json(200, [assignment]);
      assert.deepEqual(assignmentIds, ["188"]);
      assert.deepEqual(url.searchParams.getAll("include"), ["all_dates"]);
      return json(200, bulkAssignmentDates);
    }
    if (url.pathname === "/api/v1/courses/42/enrollments/51/reactivate" && request.method === "PUT") {
      if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session" });
      }
      enrollment.enrollment_state = "active";
      enrollmentReactivationWrites += 1;
      return json(200, enrollment);
    }
    if (url.pathname === "/api/v1/courses/42/enrollments" && request.method === "GET") {
      assert.equal(url.searchParams.get("user_id"), "99");
      assert.deepEqual(url.searchParams.getAll("state"), ["active"]);
      return json(200, [enrollment]);
    }
    // Three single-record pages of one Canvas list, with the Link header Canvas
    // sends for numeric pagination, so a bounded read has to resume to finish.
    if (url.pathname === "/api/v1/courses/42/pages" && request.method === "GET") {
      const listPage = Number(url.searchParams.get("page") || 1);
      const nextLink = `<https://${request.headers.host}/api/v1/courses/42/pages?per_page=1&page=${listPage + 1}>; rel="next"`;
      const lastLink = `<https://${request.headers.host}/api/v1/courses/42/pages?per_page=1&page=3>; rel="last"`;
      return json(200, [{ page_id: String(listPage * 11), url: `listed-page-${listPage}`, title: `Listed page ${listPage}` }],
        listPage < 3 ? { Link: `${nextLink},${lastLink}` } : {});
    }
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
          const finish = () => {
            lesson.body = body.get("wiki_page[body]");
            pageRevision += 1;
            pageWrites += 1;
            json(200, lesson);
          };
          if (heldPageWrites > 0) {
            heldPageWrites -= 1;
            pendingPageWrites.push(finish);
          } else finish();
        });
        return;
      }
    }
    if (url.pathname === "/api/v1/courses/42/assignments/88") {
      if (request.method === "GET") return json(200, assignment);
      if (request.method === "PUT") {
        if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
          return json(403, { error: "missing browser session" });
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          const keys = [...body.keys()];
          assert.ok(keys.length === 1 && ["assignment[due_at]", "assignment[description]"].includes(keys[0]));
          if (keys[0] === "assignment[due_at]") assignment.due_at = body.get("assignment[due_at]");
          else assignment.description = body.get("assignment[description]");
          assignmentWrites += 1;
          json(200, assignment);
        });
        return;
      }
    }
    if (url.pathname === "/api/v1/courses/42/discussion_topics/89") {
      if (request.method === "GET") return json(200, discussion);
      if (request.method === "PUT") {
        if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
          return json(403, { error: "missing browser session" });
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.deepEqual([...body.keys()], ["message"]);
          discussion.message = body.get("message");
          discussionWrites += 1;
          json(200, discussion);
        });
        return;
      }
    }
    if (url.pathname === "/api/v1/courses/42/quizzes/77") {
      if (request.method === "GET") return json(200, classicQuiz);
      if (request.method === "PUT") {
        if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
          return json(403, { error: "missing browser session" });
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          assert.deepEqual([...body.keys()], ["quiz[description]"]);
          classicQuiz.description = body.get("quiz[description]");
          classicQuizWrites += 1;
          json(200, classicQuiz);
        });
        return;
      }
    }
    if (/^\/api\/v1\/courses\/42\/quizzes\/77\/questions\/(?:301|302|303)$/.test(url.pathname)) {
      const questionId = url.pathname.split("/").pop();
      const record = questionId === "302" ? groupedQuizQuestion : questionId === "303" ? unsupportedQuizQuestion : classicQuizQuestion;
      if (request.method === "GET") return json(200, structuredClone(record));
      if (request.method === "PUT") {
        if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
          return json(403, { error: "missing browser session" });
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          // Canvas rebuilds a Classic Quiz question from the whole request
          // through AssessmentQuestion.parse_question, so this fixture rebuilds
          // it the same way: a field the request leaves out comes back as its
          // default, never as the value Canvas already held.
          const field = (name) => body.has(`question[${name}]`) ? body.get(`question[${name}]`) : "";
          const answers = [];
          for (let index = 0; body.has(`question[answers][${index}][id]`); index += 1) {
            const answer = { id: body.get(`question[answers][${index}][id]`), answer_text: body.get(`question[answers][${index}][answer_text]`) ?? "", answer_weight: Number(body.get(`question[answers][${index}][answer_weight]`)) };
            for (const name of ["answer_comments", "answer_html", "text_after_answers"]) {
              if (body.has(`question[answers][${index}][${name}]`)) answer[name] = body.get(`question[answers][${index}][${name}]`);
            }
            answers.push(answer);
          }
          const comments = { correct: field("correct_comments"), incorrect: field("incorrect_comments"), neutral: field("neutral_comments") };
          classicQuizQuestion = {
            id: "301", quiz_id: "77", quiz_group_id: null, assessment_question_id: "9001",
            position: Number(field("position")),
            question_name: field("question_name"),
            question_type: field("question_type"),
            question_text: field("question_text"),
            points_possible: Number(field("points_possible")),
            correct_comments: comments.correct, incorrect_comments: comments.incorrect, neutral_comments: comments.neutral,
            correct_comments_html: comments.correct ? `<p>${comments.correct}</p>` : "",
            incorrect_comments_html: comments.incorrect ? `<p>${comments.incorrect}</p>` : "",
            neutral_comments_html: comments.neutral ? `<p>${comments.neutral}</p>` : "",
            answers,
          };
          classicQuizQuestionWrites += 1;
          json(200, structuredClone(classicQuizQuestion));
        });
        return;
      }
    }
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77") return json(200, { id: "77", title: "New Quiz 77", published: true });
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77/items/145" && request.method === "GET") {
      return quizItem ? json(200, quizItem) : json(404, { error: "not_found" });
    }
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77/items/145" && request.method === "PATCH") {
      if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
        return json(403, { error: "missing browser session" });
      }
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        return json(415, { error: "new quiz item body must be JSON" });
      }
      bodyJson(request).then((body) => {
        if (!quizItem || Object.keys(body).length !== 1 || !body.item || typeof body.item !== "object"
          || Object.keys(body.item).length !== 1 || !body.item.entry || typeof body.item.entry !== "object") {
          json(400, { error: "unexpected new quiz item update" });
          return;
        }
        const entry = body.item.entry;
        if (Object.keys(entry).length !== 1) {
          json(400, { error: "unexpected new quiz item update" });
          return;
        }
        if (typeof entry.item_body === "string") quizItem = { ...quizItem, entry: { ...quizItem.entry, item_body: entry.item_body } };
        else if (entry.interaction_data && typeof entry.interaction_data === "object" && !Array.isArray(entry.interaction_data)
          && Array.isArray(entry.interaction_data.choices) && entry.interaction_data.choices.length === 2
          && entry.interaction_data.choices.every((choice) => choice && typeof choice === "object" && typeof choice.id === "string" && typeof choice.item_body === "string")) {
          quizItem = { ...quizItem, entry: { ...quizItem.entry, interaction_data: entry.interaction_data } };
        } else if (entry.answer_feedback && typeof entry.answer_feedback === "object" && !Array.isArray(entry.answer_feedback)
          && Object.keys(entry.answer_feedback).length === 1 && typeof Object.values(entry.answer_feedback)[0] === "string") {
          quizItem = { ...quizItem, entry: { ...quizItem.entry, answer_feedback: entry.answer_feedback } };
        } else if (entry.feedback && typeof entry.feedback === "object" && !Array.isArray(entry.feedback)
          && Object.keys(entry.feedback).length === 1 && typeof entry.feedback.correct === "string") {
          quizItem = { ...quizItem, entry: { ...quizItem.entry, feedback: { ...quizItem.entry.feedback, correct: entry.feedback.correct } } };
        } else {
          json(400, { error: "unexpected new quiz item update" });
          return;
        }
        quizItemWrites += 1;
        json(200, quizItem);
      });
      return;
    }
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77/items" && request.method === "GET") {
      return json(200, quizItem ? [{ id: "145", position: 1, entry_type: quizItem.entry_type }] : []);
    }
    if (url.pathname === "/api/quiz/v1/courses/42/quizzes/77/items" && request.method === "POST") {
      if (request.headers["x-csrf-token"] !== "synthetic+csrf/=" || !String(request.headers.cookie || "").includes("canvas_session=synthetic")) {
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
              interaction_data: {
                rce: true,
                essay: null,
                word_count: true,
                file_upload: false,
                spell_check: true,
                word_limit_enabled: true,
                word_limit_min: "0",
                word_limit_max: "250",
              },
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
        quizItem = { id: "145", ...body.item, status: "mutable", entry_editable: true };
        json(201, quizItem);
      });
      return;
    }
    json(404, { error: "not_found", path: url.pathname });
  });
  return {
    server,
    quizItemWrites: () => quizItemWrites,
    quizItem: () => structuredClone(quizItem),
    setQuizItem: (value) => { quizItem = structuredClone(value); },
    assignment: () => ({ ...assignment, submission_types: [...assignment.submission_types] }),
    assignmentWrites: () => assignmentWrites,
    bulkAssignmentDateWrites: () => bulkAssignmentDateWrites,
    bulkAssignmentDates: () => structuredClone(bulkAssignmentDates),
    enrollmentReactivationWrites: () => enrollmentReactivationWrites,
    enrollment: () => ({ ...enrollment }),
    discussion: () => ({ ...discussion }),
    discussionWrites: () => discussionWrites,
    classicQuiz: () => ({ ...classicQuiz }),
    classicQuizWrites: () => classicQuizWrites,
    classicQuizQuestion: () => structuredClone(classicQuizQuestion),
    classicQuizQuestionWrites: () => classicQuizQuestionWrites,
    changeClassicQuizQuestionPoints: () => { classicQuizQuestion = { ...classicQuizQuestion, points_possible: 5 }; },
    changeClassicQuizSettings: () => { classicQuiz.show_correct_answers = false; },
    pageWrites: () => pageWrites,
    pendingPageWrites: () => pendingPageWrites.length,
    holdOnePageWrite: () => { heldPageWrites += 1; },
    releaseOnePageWrite: () => pendingPageWrites.shift()?.(),
    lesson: () => ({ ...lesson }),
    changeLesson: () => { lesson.body += "<p>Another edit.</p>"; pageRevision += 1; },
    setLesson: (body) => { lesson.body = body; pageRevision += 1; },
    changeAssignment: () => { assignment.description += "<p>Another edit.</p>"; },
    changeDiscussion: () => { discussion.message += "<p>Another edit.</p>"; },
    setPrincipalId: (value) => { principalId = String(value); },
    setExternalFileDownloadUrl: (value) => { externalFileDownloadUrl = String(value); },
    addDocumentFile: (value) => { documentFiles.set(value.id, value); },
    setExternalFileUploadUrl: (value) => { externalFileUploadUrl = String(value); },
    recordTransferredFile: () => { transferredFiles.set("502", { id: "502", courseId: "42", folderId: "81" }); },
    transferredFile: () => transferredFiles.has("502") ? { id: "502" } : null,
    transferredFiles: () => [...transferredFiles.values()].map(({ id, courseId, folderId }) => ({ id, courseId, folderId })),
    transferConfirmationAuthenticated: () => transferConfirmationAuthenticated,
    courseFileWrites: () => courseFileWrites,
    file: (id) => files.has(id) ? { ...files.get(id) } : null,
    courseFileIds: () => [...courseFiles],
    folder: (id) => folders.has(id) ? { ...folders.get(id) } : null,
    sectionWrites: () => sectionWrites,
    section: (id) => sections.has(id) ? { ...sections.get(id) } : null,
    courseSectionIds: () => [...courseSections],
    calendarEventWrites: () => calendarEventWrites,
    calendarEvent: (id) => calendarEvents.has(id) ? { ...calendarEvents.get(id) } : null,
    courseCalendarEventIds: () => [...courseCalendarEvents],
    appointmentGroupWrites: () => appointmentGroupWrites,
    appointmentGroup: (id) => appointmentGroups.has(id) ? { ...appointmentGroups.get(id) } : null,
    groupPageWrites: () => groupPageWrites,
    groupPage: (groupId) => {
      const page = groupPages.get(`${groupId}/week-one`);
      return page ? { ...page } : null;
    },
    requests: () => [...requests],
    tls: { key: readFileSync(key), cert: readFileSync(certificate) },
  };
}

function startExternalFileStore(tls) {
  const requests = [];
  const uploadConfirmationUrls = new Map();
  let transferred = false;
  let heldUploads = 0;
  const pendingUploads = [];
  const server = createHttpsServer(tls, (request, response) => {
    const url = new URL(request.url || "/", "https://localhost");
    requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie || "" });
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/upload/signed") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        assert.ok(body.includes(FILE_TRANSFER_BYTES), "the staged material bytes did not reach the trusted upload URL");
        const key = body.includes(Buffer.from("morrow-reviewed-file-43")) ? "morrow-reviewed-file-43" : "morrow-reviewed-file-42";
        const uploadConfirmationUrl = uploadConfirmationUrls.get(key);
        assert.ok(uploadConfirmationUrl, "transfer confirmation URL was not configured");
        const finish = () => {
          transferred = true;
          response.writeHead(302, { location: uploadConfirmationUrl });
          response.end();
        };
        if (heldUploads > 0) {
          heldUploads -= 1;
          pendingUploads.push(finish);
        } else finish();
      });
      return;
    }
    const document = SIGNAL_DOCUMENTS.find((entry) => entry.path === url.pathname);
    if (document) {
      response.writeHead(200, { "content-type": document.contentType, "content-length": String(document.bytes.byteLength) });
      response.end(document.bytes);
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "content-length": String(transferred ? FILE_TRANSFER_BYTES.byteLength : Buffer.byteLength(FILE_TEXT)) });
    response.end(transferred ? FILE_TRANSFER_BYTES : FILE_TEXT);
  });
  return {
    server,
    requests: () => [...requests],
    setUploadConfirmationUrl: (value, key = "morrow-reviewed-file-42") => { uploadConfirmationUrls.set(key, String(value)); },
    transferred: () => transferred,
    holdOneUpload: () => { heldUploads += 1; },
    pendingUploads: () => pendingUploads.length,
    releaseOneUpload: () => pendingUploads.shift()?.(),
  };
}

const temporary = mkdtempSync(join(tmpdir(), "morrow-connector-browser-"));
const extensionCopy = join(temporary, "extension");
cpSync(EXTENSION, extensionCopy, { recursive: true });
const manifestPath = join(extensionCopy, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// The package test keeps the release manifest at loopback-only. This isolated fixture
// grants its synthetic storage host so the permitted read can reach the test server.
manifest.host_permissions.push("https://127.0.0.1/*", "https://localhost:*/*");
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
mkdirSync(OUTPUT, { recursive: true });

const canvas = startCanvas(temporary);
await new Promise((resolveListen) => canvas.server.listen(0, "127.0.0.1", resolveListen));
const externalFileStore = startExternalFileStore(canvas.tls);
await new Promise((resolveListen) => externalFileStore.server.listen(0, "127.0.0.1", resolveListen));
const address = canvas.server.address();
if (!address || typeof address === "string") throw new Error("synthetic Canvas port unavailable");
const externalFileAddress = externalFileStore.server.address();
if (!externalFileAddress || typeof externalFileAddress === "string") throw new Error("synthetic file store port unavailable");
const canvasUrl = `https://127.0.0.1:${address.port}/courses/42`;
const subpathCanvasUrl = `https://127.0.0.1:${address.port}/canvas/courses/42`;
const assignmentCanvasUrl = `https://127.0.0.1:${address.port}/courses/42/assignments/88`;
const unavailableCourseUrl = `https://127.0.0.1:${address.port}/courses/999/assignments/88`;
const nonCourseCanvasUrl = `https://127.0.0.1:${address.port}/calendar`;
canvas.setExternalFileDownloadUrl(`https://localhost:${externalFileAddress.port}/stored-file.txt?signature=opaque`);
for (const document of SIGNAL_DOCUMENTS) {
  canvas.addDocumentFile({ ...document, downloadUrl: `https://localhost:${externalFileAddress.port}${document.path}?signature=opaque` });
}
// Canvas issues a signed upload URL that carries its signature in the query
// string, so the fixture URL carries one too: the upload observer registers this
// exact URL as its Chrome match pattern.
const externalFileUploadUrl = `https://localhost:${externalFileAddress.port}/upload/signed?signature=opaque`;
canvas.setExternalFileUploadUrl(externalFileUploadUrl);
externalFileStore.setUploadConfirmationUrl(`https://127.0.0.1:${address.port}/api/v1/files/502`);
externalFileStore.setUploadConfirmationUrl(`https://127.0.0.1:${address.port}/api/v1/files/503`, "morrow-reviewed-file-43");
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
  port: 0,
  runtimeRevision: "1.0.0-rc.2",
  allowedExtensionIds: [],
  approveExtensionId: async () => undefined,
};
let runtime = await CanvasConnectorRuntime.start(connectorConfig);
connectorConfig.port = runtime.bridge.health().port;
const testWorkerPath = join(extensionCopy, "src/service-worker.js");
writeFileSync(testWorkerPath, readFileSync(testWorkerPath, "utf8").replace("const PORT = 32147;", `const PORT = ${connectorConfig.port};`));

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
  children: Array.from({ length: 40 }, (_, index) => ({ operation: { ...approvalSnapshot, operationId: `op:bulk-${index + 1}`, plan: { ...approvalSnapshot.plan, arguments: { ...approvalSnapshot.plan.arguments, item_entry_title: `Blood and circulation: question ${index + 1}` } } } })),
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
    ...(id === "op:page-edit" ? { plan: { ...approvalSnapshot.plan, tool: "canvas_update_create_page_courses", arguments: { course_id: "42", url_or_id: "lesson", _morrow: { page_guard: { kind: "text", find_text: "Cells have membranes.", replace_text: "Cells have protective membranes." } } } } } : {}),
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
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let context;
try {
  process.stderr.write("[browser-test] starting temporary Chrome for Testing\n");
  context = await launchBrowser();

  const operationApprovalPage = await context.newPage();
  await operationApprovalPage.goto(`${operationApprovalBaseUrl}/operations/${encodeURIComponent(approvalSnapshot.operationId)}`);
  await operationApprovalPage.getByRole("heading", { name: "Add question?" }).waitFor();
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
  await operationApprovalPage.getByRole("heading", { name: "Review 2 changes" }).waitFor();
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
  await operationApprovalPage.getByRole("heading", { name: "Edit Page text?" }).waitFor();
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
  assert.match(await operationApprovalPage.locator("body").innerText(), /could not identify the course or a selected item/);
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
  await operationApprovalPage.getByRole("heading", { name: "Review expired" }).waitFor();
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

  const firstInstallSetupGuide = await waitFor(
    () => context.pages().find((page) => page.url() === `chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`) || null,
    "first install did not open Morrow setup",
  );
  await firstInstallSetupGuide.getByRole("heading", { name: "Morrow setup", exact: true }).waitFor();
  await firstInstallSetupGuide.getByRole("heading", { name: "What Morrow Bridge can read", exact: true }).waitFor();
  await firstInstallSetupGuide.getByText("Morrow Bridge will not connect to Morrow or read course data before you agree.", { exact: false }).waitFor();
  assert.equal(await firstInstallSetupGuide.locator("#setup-content").isHidden(), true);
  await captureSetupGuide(firstInstallSetupGuide, "setup-guide-course-data-consent");
  await firstInstallSetupGuide.getByRole("button", { name: "Agree and continue", exact: true }).click();
  await firstInstallSetupGuide.getByText("No assistant has approved this connection yet", { exact: true }).waitFor();
  await firstInstallSetupGuide.getByText("Morrow version is checked when Morrow Bridge connects", { exact: true }).waitFor();
  await firstInstallSetupGuide.getByText("No first read is completed yet", { exact: true }).waitFor();
  await firstInstallSetupGuide.getByRole("heading", { name: "Open Morrow", exact: true }).waitFor();
  assert.equal(await firstInstallSetupGuide.getByRole("button", { name: "Guide me", exact: true }).getAttribute("aria-pressed"), "true");
  assert.doesNotMatch(await firstInstallSetupGuide.locator("main").textContent(), /(?:Terminal|command|Developer Mode|unpacked|\/path\/to|CLI)/i);
  await captureSetupGuide(firstInstallSetupGuide, "setup-guide-first-install");
  await firstInstallSetupGuide.getByRole("button", { name: "Setup overview", exact: true }).click();
  await firstInstallSetupGuide.getByRole("heading", { name: "Three setup stages", exact: true }).waitFor();
  for (const step of ["Choose your assistant in Morrow", "Finish Morrow Bridge setup", "Open and connect your course"]) {
    await firstInstallSetupGuide.locator(".setup-steps strong", { hasText: step }).waitFor();
  }
  assert.doesNotMatch(await firstInstallSetupGuide.locator("main").textContent(), /(?:Terminal|command|Developer Mode|unpacked|\/path\/to|CLI)/i);
  await captureSetupGuide(firstInstallSetupGuide, "setup-guide-all-steps");
  await firstInstallSetupGuide.getByRole("button", { name: "Guide me", exact: true }).click();
  await firstInstallSetupGuide.close();
  process.stderr.write("[browser-test] first-install setup guide is guidance-only and fits 320, 390, and 1280px\n");

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
  await approval.waitForURL((url) => url.origin === `http://127.0.0.1:${connectorConfig.port}` && /^\/morrow-bridge\/v1\/pair\/[0-9a-f-]+$/.test(url.pathname));
  await approval.getByText("Your learning-platform password and sign-in details stay in Chrome", { exact: false }).waitFor();
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

  const subpathCanvasPage = await context.newPage();
  await subpathCanvasPage.goto(subpathCanvasUrl, { waitUntil: "domcontentloaded" });
  const subpathCanvasTabId = await replacementWorker.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
  }, subpathCanvasUrl);
  assert.equal(Number.isInteger(subpathCanvasTabId), true);
  const subpathProbe = await replacementWorker.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    return await chrome.tabs.sendMessage(tabId, { type: "morrow_canvas_probe" }, { frameId: 0 });
  }, subpathCanvasTabId);
  assert.deepEqual(subpathProbe, {
    ok: true,
    profile: {
      id: "7", name: "Synthetic Instructor", origin: new URL(canvasUrl).origin,
      courseId: "42", courseName: "Introduction to Human Biology",
    },
  });
  await subpathCanvasPage.close();

  const offCoursePage = await context.newPage();
  await offCoursePage.goto(unavailableCourseUrl, { waitUntil: "domcontentloaded" });
  const offCourseTabId = await replacementWorker.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
  }, unavailableCourseUrl);
  assert.equal(Number.isInteger(offCourseTabId), true);
  const beforeOffCourseConnect = canvas.requests().length;
  const offCourseConnect = await popup.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ type: "morrow_connect_course", tabId });
  }, offCourseTabId);
  assert.equal(offCourseConnect?.ok, false);
  assert.ok(canvas.requests().slice(beforeOffCourseConnect).includes("GET /api/v1/courses/999"));
  await offCoursePage.close();

  const nonCoursePage = await context.newPage();
  await nonCoursePage.goto(nonCourseCanvasUrl, { waitUntil: "domcontentloaded" });
  const nonCourseTabId = await replacementWorker.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
  }, nonCourseCanvasUrl);
  assert.equal(Number.isInteger(nonCourseTabId), true);
  const beforeNonCourseConnect = canvas.requests().length;
  const nonCourseConnect = await popup.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ type: "morrow_connect_course", tabId });
  }, nonCourseTabId);
  assert.equal(nonCourseConnect?.ok, false);
  assert.equal(canvas.requests().slice(beforeNonCourseConnect).some((request) => request.includes("/api/")), false);
  await nonCoursePage.close();

  const wrongAuthPage = await context.newPage();
  await wrongAuthPage.goto(assignmentCanvasUrl, { waitUntil: "domcontentloaded" });
  const wrongAuthTabId = await replacementWorker.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
  }, assignmentCanvasUrl);
  assert.equal(Number.isInteger(wrongAuthTabId), true);
  canvas.setPrincipalId("not-a-canvas-id");
  const beforeWrongAuthConnect = canvas.requests().length;
  const wrongAuthConnect = await popup.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ type: "morrow_connect_course", tabId });
  }, wrongAuthTabId);
  assert.equal(wrongAuthConnect?.ok, false);
  const wrongAuthRequests = canvas.requests().slice(beforeWrongAuthConnect);
  assert.ok(wrongAuthRequests.includes("GET /api/v1/users/self/profile"));
  assert.equal(wrongAuthRequests.includes("GET /api/v1/courses/42"), false);
  canvas.setPrincipalId("7");
  await wrongAuthPage.close();

  await canvasPage.goto(assignmentCanvasUrl, { waitUntil: "domcontentloaded" });
  assert.match(await canvasPage.evaluate(() => document.cookie), /_csrf_token=synthetic%2Bcsrf%2F%3D/);
  const canvasTabId = await replacementWorker.evaluate(async (expectedUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
  }, assignmentCanvasUrl);
  assert.equal(Number.isInteger(canvasTabId), true);
  const detectedCanvas = await popup.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ type: "morrow_detect_course_platform", tabId });
  }, canvasTabId);
  assert.deepEqual(detectedCanvas, { ok: true, result: { provider: "canvas" } });
  process.stderr.write("[browser-test] Morrow Bridge identifies the active Canvas course before it offers the platform action\n");
  const beforeNestedCourseConnect = canvas.requests().length;
  const connected = await popup.evaluate(async (tabId) => {
    return await chrome.runtime.sendMessage({ type: "morrow_connect_course", tabId });
  }, canvasTabId);
  assert.equal(connected?.ok, true, connected?.error);
  const nestedCourseRequests = canvas.requests().slice(beforeNestedCourseConnect);
  assert.ok(nestedCourseRequests.includes("GET /api/v1/users/self/profile"));
  assert.ok(nestedCourseRequests.includes("GET /api/v1/courses/42"));
  const signedFile = await canvasPage.evaluate(async () => await fetch("/api/v1/courses/42/files/501", { credentials: "include" }).then(async (response) => await response.json()));
  assert.equal(signedFile.id, "501");
  const signedFileUrl = new URL(signedFile.url);
  assert.equal(signedFileUrl.origin, new URL(canvasUrl).origin);
  assert.equal(signedFileUrl.pathname, "/files/501/download");
  assert.equal(signedFileUrl.searchParams.getAll("verifier").length, 1);
  assert.deepEqual(externalFileStore.requests(), []);
  process.stderr.write("[browser-test] synthetic Canvas file metadata exposes one canonical, unconsumed download URL\n");
  assert.equal(runtime.bridge.listBindings().length, 0);
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${EXTENSION_ID}/settings/settings.html`);
  await settings.getByRole("heading", { name: "Plan and Edit" }).waitFor();
  await settings.getByText("No connected courses are available.", { exact: false }).first().waitFor();
  const nativeFileStorageAccess = await settings.evaluate(async () => ({
    browserPermission: await chrome.permissions.contains({ origins: ["https://*/*"] }),
    enabled: (await chrome.storage.local.get("courseFileStorageAccessEnabled")).courseFileStorageAccessEnabled === true,
  }));
  assert.deepEqual(nativeFileStorageAccess, { browserPermission: false, enabled: false });
  await settings.evaluate(async () => {
    await chrome.storage.local.set({ courseFileStorageAccessEnabled: true });
  });
  await settings.getByRole("button", { name: "Refresh connected courses" }).click();
  await waitFor(async () => (await settings.evaluate(async () => (await chrome.storage.local.get("courseFileStorageAccessEnabled")).courseFileStorageAccessEnabled)) === false, "externally removed Chrome file permission left course file reading enabled");
  await settings.getByText(/^Off\. (?:Chrome permission was removed, so Morrow keeps course file access off|Morrow cannot access course file content)\.$/).first().waitFor();
  process.stderr.write("[browser-test] course file access fails closed when the persisted opt-in outlives Chrome permission\n");
  await settings.evaluate(async () => {
    await document.fonts.load('13px "Manrope"');
    await document.fonts.ready;
  });
  assert.equal(await settings.evaluate(() => document.fonts.check('13px "Manrope"')), true);
  await captureThemes(settings, "bridge-settings-empty", 900);
  await captureThemes(settings, "bridge-settings-empty-narrow", 320);
  await settings.setViewportSize({ width: 900, height: 760 });
  await settings.getByRole("button", { name: "Find available courses" }).click();
  await waitFor(async () => {
    const text = await settings.locator("body").innerText();
    if (/Morrow could not read available courses|course_discovery_failed/.test(text)) throw new Error(text);
    return text.includes("Page 1 shows 100 available courses");
  }, "initial Canvas discovery did not list its first 100 courses");
  await settings.locator("#course-filter").fill("Introduction to Human Biology");
  await settings.getByRole("checkbox", { name: "Select Introduction to Human Biology to connect" }).check();
  await settings.locator("#course-filter").fill("Synthetic Human Anatomy");
  await settings.getByRole("checkbox", { name: "Select Synthetic Human Anatomy to connect" }).check();
  await settings.locator("#course-filter").fill("");
  await settings.getByRole("button", { name: "Connect 2 selected courses in Plan" }).click();
  await settings.getByText(/2 courses connected in Plan/).first().waitFor();
  for (const pageNumber of [2, 3, 4, 5, 6]) {
    await settings.getByRole("button", { name: "Load more available courses" }).click();
    await settings.locator("#discovery-progress-text").getByText(new RegExp(`Page ${pageNumber} shows`)).waitFor();
  }
  const retainedDiscovery = await settings.evaluate(async () => {
    const saved = await chrome.storage.session.get("courseDiscoveries");
    const receipts = Object.values(saved.courseDiscoveries || {});
    return {
      receiptCount: receipts.length,
      pageNumber: receipts[0]?.pageNumber,
      courseCount: receipts[0]?.courses?.length,
    };
  });
  assert.deepEqual(retainedDiscovery, { receiptCount: 1, pageNumber: 6, courseCount: 1 });
  await settings.locator("#course-filter").fill("Evidence-Based Practice");
  await settings.getByRole("checkbox", { name: `Select ${LONG_COURSE_NAME} to connect` }).check();
  await settings.locator("#course-filter").fill("");
  await settings.getByRole("button", { name: "Connect 1 selected course in Plan" }).click();
  await settings.getByText(/1 course connected in Plan/).first().waitFor();
  await settings.getByRole("button", { name: "View connected courses" }).click();
  const bindings = await waitFor(() => runtime.bridge.listBindings().length === 3 ? runtime.bridge.listBindings() : null, "selected Canvas courses did not bind to the shared site anchor");
  const binding = bindings.find((entry) => entry.courseId === "42");
  const binding43 = bindings.find((entry) => entry.courseId === "43");
  const binding501 = bindings.find((entry) => entry.courseId === "501");
  assert.match(binding.sourceBindingId, /^canvas:[0-9a-f]{20}:g1:c42$/);
  assert.match(binding43.sourceBindingId, /^canvas:[0-9a-f]{20}:g1:c43$/);
  assert.match(binding501.sourceBindingId, /^canvas:[0-9a-f]{20}:g1:c501$/);
  const waitForPublishedEditPermission = (matches, message) => waitFor(async () => {
    const permission = (await runtime.editOptions(binding.sourceBindingId)).editPermission;
    if (!permission || !matches(permission)) return null;
    const published = runtime.bindings().find((entry) => entry.sourceBindingId === binding.sourceBindingId)?.editPermission;
    return published?.scopeDigest === permission.scopeDigest && published?.revision === permission.revision ? permission : null;
  }, message);
  assert.equal(binding.origin, new URL(canvasUrl).origin);
  assert.equal(binding.courseName, "Introduction to Human Biology");
  assert.equal(binding43.courseName, "Synthetic Human Anatomy");
  assert.equal(binding501.courseName, LONG_COURSE_NAME);
  assert.equal(binding501.editPermission, undefined);
  assert.equal(canvas.requests().includes("GET /courses/43"), false);
  assert.equal(canvas.requests().includes("GET /courses/501"), false);
  assert.equal(binding.editOptionsAvailable, true);
  assert.equal(Object.hasOwn(binding, "options"), false);
  assert.equal(Object.hasOwn(binding, "rules"), false);
  const fullEditOptions = await runtime.editOptions(binding.sourceBindingId);
  const canvasCatalog = JSON.parse(readFileSync(join(EXTENSION, "generated/canvas-api-catalog.json"), "utf8"));
  const canvasWriteOperations = canvasCatalog.operations.filter((operation) => operation.readOnly === false);
  // Only an irreversible, destructive admitted write stays review-only: never
  // a standing permission, approved change by change instead. Deleting a New
  // Quiz takes every item in it with it and Canvas does not restore it;
  // archiving an Item Bank and deleting one of its entries or a quiz's use of
  // one reach every quiz, in every course, that draws from the bank, which
  // Canvas gives no complete list of. Every other admitted write, destructive
  // or not, is an ordinary standing Edit grant, including the general New
  // Quiz question update (its id-preserving guard lives in
  // new-quiz-item-guard.js, not in what is grantable) and creating a New Quiz
  // or any non-destructive Item Bank write.
  const reviewOnlyAdmittedCanvasWrites = new Set([
    "canvas_delete_new_quiz", "canvas_item_bank_archive_bank", "canvas_item_bank_delete_entry", "canvas_item_bank_delete_quiz_bank_entry",
  ]);
  const expectedCanvasEditActions = canvasWriteOperations
    .filter((operation) => canvasOperationAdmission(operation).write.state === "admitted"
      && !reviewOnlyAdmittedCanvasWrites.has(operation.toolName))
    .map((operation) => `action:canvas:${operation.toolName}`)
    .sort();
  const publishedCanvasEditActions = fullEditOptions.options
    .filter((option) => option.availability === "edit" && option.id.startsWith("action:canvas:"))
    .map((option) => option.id)
    .sort();
  assert.deepEqual(publishedCanvasEditActions, expectedCanvasEditActions);
  assert.ok(fullEditOptions.options.length > 500, "all edit options must remain available through the on-demand response");
  const expectedDestructiveActions = canvasWriteOperations
    .filter((operation) => operation.risk === "destructive")
    .map((operation) => `action:canvas:${operation.toolName}`)
    .sort();
  const publishedDestructiveActions = fullEditOptions.options
    .filter((option) => option.tier === "destructive")
    .map((option) => option.id)
    .sort();
  assert.deepEqual(publishedDestructiveActions, expectedDestructiveActions);
  assert.equal(fullEditOptions.options.some((option) => option.tier === "destructive" && option.group !== "Canvas actions that remove content"), false);
  assert.equal(fullEditOptions.options.some((option) => option.tier !== "destructive" && option.group === "Canvas actions that remove content"), false);
  const broadAssignmentAction = fullEditOptions.options.find((option) => option.id === "action:canvas:canvas_edit_assignment");
  assert.equal(broadAssignmentAction.availability, "edit");
  assert.equal(broadAssignmentAction.requiresFieldSelection, true);
  assert.match(broadAssignmentAction.description, /Morrow does not grant all of them at once/);
  assert.equal(fullEditOptions.options.some((option) => option.requiresFieldSelection === true && option.availability !== "edit"), false);
  assert.deepEqual(
    fullEditOptions.options.filter((option) => option.destructive === true).map((option) => option.id).sort(),
    publishedDestructiveActions,
  );
  const expectedUncheckedActions = canvasWriteOperations
    .filter((operation) => canvasOperationAdmission(operation).write.state === "admitted"
      && canvasReadbackAssessment(canvasCatalog.operations, operation).state !== "structurally_exact")
    .map((operation) => `action:canvas:${operation.toolName}`)
    .sort();
  const publishedUncheckedActions = fullEditOptions.options
    .filter((option) => option.id.startsWith("action:canvas:") && option.verification === "unchecked")
    .map((option) => option.id)
    .sort();
  assert.ok(expectedUncheckedActions.length > 0 && expectedUncheckedActions.length < publishedCanvasEditActions.length);
  assert.deepEqual(publishedUncheckedActions, expectedUncheckedActions);
  assert.equal(fullEditOptions.options.some((option) => option.availability === "edit" && option.verification === undefined), false);
  assert.equal(fullEditOptions.options.some((option) => option.verification === "unchecked" && !option.verificationReason), false);
  assert.equal(fullEditOptions.options.some((option) => option.availability === "review" && option.verification !== undefined), false);
  const deleteEntryAction = fullEditOptions.options.find((option) => option.id === "action:canvas:canvas_delete_entry_courses");
  assert.equal(deleteEntryAction.destructive, true);
  assert.equal(deleteEntryAction.verification, "unchecked");
  assert.match(deleteEntryAction.verificationReason, /Morrow reports the saved result as unconfirmed\.$/);
  assert.equal(fullEditOptions.options.find((option) => option.id === "canvas_page_content").verification, "checked");
  process.stderr.write("[browser-test] published Edit actions equal the admitted Canvas writes, name every destructive action, mark every action Morrow cannot check, and refuse a blanket field grant\n");
  process.stderr.write("[browser-test] one Canvas site anchor selected three exact courses, including course 501 after paged discovery\n");

  await popup.bringToFront();
  const reopenedSetupPromise = context.waitForEvent("page");
  await popup.getByRole("button", { name: "Open setup guide", exact: true }).click();
  const reopenedSetupGuide = await reopenedSetupPromise;
  await reopenedSetupGuide.waitForURL(`chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`);
  await reopenedSetupGuide.getByRole("heading", { name: "One step left", exact: true }).waitFor();
  await reopenedSetupGuide.getByText("An assistant approved this connection in Morrow. Morrow Bridge sees the connection, not the assistant itself.", { exact: true }).waitFor();
  await reopenedSetupGuide.getByText("Morrow Bridge is connected to Morrow", { exact: true }).waitFor();
  await reopenedSetupGuide.getByText("Morrow matches this Morrow Bridge version and its list of course actions", { exact: true }).waitFor();
  await reopenedSetupGuide.getByText("3 selected courses are ready", { exact: true }).waitFor();
  await reopenedSetupGuide.getByText("No first read is completed yet", { exact: true }).waitFor();
  await reopenedSetupGuide.getByRole("heading", { name: "Try a first read", exact: true }).waitFor();
  await captureSetupGuide(reopenedSetupGuide, "setup-guide-course-ready");
  await reopenedSetupGuide.close();
  process.stderr.write("[browser-test] setup guide reopens from Bridge, reports all five checks live, and holds Ready to use until a course read happens\n");

  const fileReadBeforeOptIn = await runtime.call("canvas_read_course_file_text", {
    course_id: "42", file_id: "501", _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(fileReadBeforeOptIn.ok, false, JSON.stringify(fileReadBeforeOptIn));
  assert.match(JSON.stringify(fileReadBeforeOptIn), /canvas_file_storage_access_required/);
  await replacementWorker.evaluate(async () => {
    await chrome.storage.local.set({ courseFileStorageAccessEnabled: true });
  });
  const fileReadWithoutChromePermission = await runtime.call("canvas_read_course_file_text", {
    course_id: "42", file_id: "501", _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(fileReadWithoutChromePermission.ok, false, JSON.stringify(fileReadWithoutChromePermission));
  assert.match(JSON.stringify(fileReadWithoutChromePermission), /canvas_file_storage_access_required/);
  await settings.evaluate(() => {
    chrome.permissions.contains = async () => true;
  });
  await replacementWorker.evaluate(async () => {
    chrome.permissions.contains = async () => true;
    await chrome.storage.local.set({ courseFileStorageAccessEnabled: true });
  });
  await waitFor(async () => (await settings.evaluate(async () => (await chrome.storage.local.get("courseFileStorageAccessEnabled")).courseFileStorageAccessEnabled)) === true, "test Chrome permission grant did not keep the user opt-in");
  const externalRequestsBeforeRead = externalFileStore.requests().length;
  const fileRead = await runtime.call("canvas_read_course_file_text", {
    course_id: "42", file_id: "501", _morrow: { source_binding_id: binding.sourceBindingId },
  });
  const expectedFileDigest = createHash("sha256").update(FILE_TEXT).digest("hex");
  assert.equal(fileRead.ok, true, JSON.stringify(fileRead));
  assert.deepEqual(fileRead.result, {
    schema: "morrow.canvas-course-file-text.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      id: "501", display_name: "Cross-origin storage text.txt", filename: "cross-origin-storage-text.txt",
      size: Buffer.byteLength(FILE_TEXT), content_type: "text/plain", updated_at: "2026-09-06T12:00:00Z", modified_at: null,
      content: FILE_TEXT, content_sha256: expectedFileDigest, content_byte_length: Buffer.byteLength(FILE_TEXT),
    },
    snapshot_digest: expectedFileDigest,
    provider: "canvas",
  });
  assert.equal(JSON.stringify(fileRead).includes("synthetic-file-verifier"), false);
  assert.deepEqual(externalFileStore.requests().slice(externalRequestsBeforeRead), [{ method: "GET", path: "/stored-file.txt", cookie: "" }]);
  process.stderr.write("[browser-test] confirmed Canvas text file read uses the two-part Chrome permission and strips storage cookies\n");

  const externalRequestsBeforeSignals = externalFileStore.requests().length;
  const readSignals = async (fileId) => await runtime.call("canvas_read_course_file_signals", {
    course_id: "42", file_id: fileId, _morrow: { source_binding_id: binding.sourceBindingId },
  });
  const [pdfDocument, docxDocument, encryptedDocument] = SIGNAL_DOCUMENTS;
  const pdfSignalRead = await readSignals(pdfDocument.id);
  const pdfDigest = createHash("sha256").update(pdfDocument.bytes).digest("hex");
  assert.equal(pdfSignalRead.ok, true, JSON.stringify(pdfSignalRead));
  assert.deepEqual(pdfSignalRead.result, {
    schema: "morrow.canvas-course-file-signals.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      id: "504", display_name: "Week one syllabus.pdf", filename: "week-one-syllabus.pdf",
      size: pdfDocument.bytes.byteLength, content_type: "application/pdf", updated_at: "2026-09-06T12:00:00Z", modified_at: null,
      content_sha256: pdfDigest, content_byte_length: pdfDocument.bytes.byteLength,
      file_signals: {
        format: "pdf", pdf_version: "1.7", page_count: 1, encryption: "absent", marked_content_flag: "present",
        structure_tree_root: "present", document_language: "present", document_language_value_length: 5,
        text_showing_operators: "present", pages_with_text_showing_operators: 1, object_streams_inflated: 0,
        interpretation: "Structural signals only. They do not establish document accessibility, tagging quality, reading order, or WCAG conformance.",
      },
    },
    snapshot_digest: pdfDigest,
    provider: "canvas",
  });
  const docxSignalRead = await readSignals(docxDocument.id);
  assert.equal(docxSignalRead.ok, true, JSON.stringify(docxSignalRead));
  assert.deepEqual(docxSignalRead.result.data.file_signals, {
    format: "docx", core_properties: "present", document_part: "present",
    drawing_alt_text: { status: "observed", total: 3, with_description: 2, without_description: 1 },
    heading_styles: { status: "observed", defined_levels: [1, 2] },
    interpretation: "Structural signals only. They do not establish document accessibility, tagging quality, reading order, or WCAG conformance.",
  });
  const encryptedSignalRead = await readSignals(encryptedDocument.id);
  assert.equal(encryptedSignalRead.ok, false, JSON.stringify(encryptedSignalRead));
  assert.match(JSON.stringify(encryptedSignalRead), /canvas_file_pdf_encrypted/);
  const textAsSignals = await readSignals("501");
  assert.equal(textAsSignals.ok, false, JSON.stringify(textAsSignals));
  assert.match(JSON.stringify(textAsSignals), /canvas_file_content_type_unsupported/);
  // No document byte, no document word, and no signed storage URL may appear in
  // an assistant-bound result.
  const signalPayload = JSON.stringify([pdfSignalRead, docxSignalRead, encryptedSignalRead]);
  for (const secret of ["Week one reading", "A labelled plant cell", "A chart of weekly readings", "Saved document title", "%PDF", "synthetic-file-verifier"]) {
    assert.equal(signalPayload.includes(secret), false, `signal result leaked ${secret}`);
  }
  assert.deepEqual(externalFileStore.requests().slice(externalRequestsBeforeSignals), [
    { method: "GET", path: pdfDocument.path, cookie: "" },
    { method: "GET", path: docxDocument.path, cookie: "" },
    { method: "GET", path: encryptedDocument.path, cookie: "" },
  ]);
  process.stderr.write("[browser-test] Canvas document reads return structural signals only, refuse an encrypted PDF, and send no storage cookies\n");

  const transferAttachment = {
    schema: "morrow.private-file-attachment.v1",
    handle: "file:reviewed-canvas-material",
    manifest: {
      filename: "reviewed-material.txt",
      size_bytes: FILE_TRANSFER_BYTES.byteLength,
      sha256: createHash("sha256").update(FILE_TRANSFER_BYTES).digest("hex"),
    },
    bytes_base64: FILE_TRANSFER_BYTES.toString("base64"),
    content_type: "text/plain",
  };
  const externalRequestsBeforeTransfer = externalFileStore.requests().length;
  const transferred = await runtime.call("canvas_transfer_course_file", {
    course_id: 42,
    folder_id: 81,
    filename: transferAttachment.manifest.filename,
    size_bytes: transferAttachment.manifest.size_bytes,
    sha256: transferAttachment.manifest.sha256,
    content_type: transferAttachment.content_type,
    privateAttachment: transferAttachment,
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: "operation:canvas-file-transfer-browser",
      outer_grant: {
        plan_digest: "e".repeat(64),
        approval_grant_digest: "f".repeat(64),
        effect_receipt_id: "effect:canvas-file-transfer-browser",
        dispatch_attempt: 1,
        gateway_process_id: "gateway:browser-test",
        authorization: { kind: "review" },
      },
    },
  });
  assert.equal(transferred.ok, true, JSON.stringify(transferred));
  assert.equal(transferred.result?.ok, true, JSON.stringify(transferred));
  assert.equal(transferred.result?.verification?.status, "verified", JSON.stringify(transferred));
  assert.equal(JSON.stringify(transferred).includes(transferAttachment.bytes_base64), false);
  assert.equal(JSON.stringify(transferred).includes(FILE_TRANSFER_BYTES.toString("utf8")), false);
  assert.deepEqual(canvas.transferredFile(), { id: "502" });
  assert.equal(canvas.transferConfirmationAuthenticated(), true);
  assert.equal(externalFileStore.transferred(), true);
  assert.deepEqual(externalFileStore.requests().slice(externalRequestsBeforeTransfer), [
    { method: "POST", path: "/upload/signed", cookie: "" },
    { method: "GET", path: "/stored-file.txt", cookie: "" },
  ]);
  process.stderr.write("[browser-test] reviewed Canvas file transfer uses the exact private route, saves one file, and verifies its bytes without exposing them\n");

  // The upload observer must be offered the one Canvas-issued upload request and
  // nothing else. This case records every request filter the observer registers,
  // mirrors each filter with a probe listener, and holds the upload open while a
  // POST goes to the Canvas host. A separate control listener, registered for the
  // Canvas URL alone, proves the foreign request reached this service worker's
  // webRequest at all, so the probe's silence is evidence and not a dead listener.
  // The query string keeps this URL out of the service worker's own routine
  // Canvas profile reads, so the control listener counts this POST alone.
  const foreignPostUrl = `https://127.0.0.1:${address.port}/api/v1/users/self/profile?observer-scope=1`;
  await replacementWorker.evaluate((controlUrl) => {
    self.observerFilters = [];
    self.observerProbeUrls = [];
    self.observerProbes = [];
    const addBeforeRequest = chrome.webRequest.onBeforeRequest.addListener.bind(chrome.webRequest.onBeforeRequest);
    self.restoreObserverProbe = () => {
      chrome.webRequest.onBeforeRequest.addListener = addBeforeRequest;
      for (const probe of self.observerProbes) chrome.webRequest.onBeforeRequest.removeListener(probe);
      chrome.webRequest.onBeforeRequest.removeListener(self.observerControl);
    };
    self.observerControlUrls = [];
    self.observerControl = (details) => { self.observerControlUrls.push(details.url); };
    chrome.webRequest.onBeforeRequest.addListener = (callback, filter, ...rest) => {
      self.observerFilters.push(filter?.urls);
      const probe = (details) => { self.observerProbeUrls.push(details.url); };
      self.observerProbes.push(probe);
      addBeforeRequest(probe, filter, ...rest);
      return addBeforeRequest(callback, filter, ...rest);
    };
    addBeforeRequest(self.observerControl, { urls: [controlUrl] });
  }, foreignPostUrl);
  externalFileStore.holdOneUpload();
  const narrowedTransfer = runtime.call("canvas_transfer_course_file", {
    course_id: 42, folder_id: 81, filename: transferAttachment.manifest.filename,
    size_bytes: transferAttachment.manifest.size_bytes, sha256: transferAttachment.manifest.sha256,
    content_type: transferAttachment.content_type, privateAttachment: transferAttachment,
    _morrow: {
      source_binding_id: binding.sourceBindingId, operation_id: "operation:canvas-file-transfer-observer-scope",
      outer_grant: {
        plan_digest: "5".repeat(64), approval_grant_digest: "6".repeat(64),
        effect_receipt_id: "effect:canvas-file-transfer-observer-scope", dispatch_attempt: 1,
        gateway_process_id: "gateway:browser-test", authorization: { kind: "review" },
      },
    },
  });
  let observerScope;
  try {
    await waitFor(() => externalFileStore.pendingUploads() === 1, "held Canvas upload did not reach the signed endpoint", 15_000);
    const foreignStatus = await replacementWorker.evaluate(async (url) => {
      const response = await fetch(url, { method: "POST", credentials: "omit", cache: "no-store" });
      await response.text();
      return response.status;
    }, foreignPostUrl);
    assert.equal(foreignStatus, 200, "the concurrent POST to the Canvas host did not complete");
    observerScope = await waitFor(
      async () => {
        const state = await replacementWorker.evaluate(() => ({
          filters: self.observerFilters, probed: self.observerProbeUrls, controlled: self.observerControlUrls,
        }));
        return state.controlled.length ? state : null;
      },
      "the concurrent POST to the Canvas host never reached this extension's webRequest",
      15_000,
    );
  } finally {
    externalFileStore.releaseOneUpload();
  }
  const narrowedResult = await narrowedTransfer;
  await replacementWorker.evaluate(() => { self.restoreObserverProbe(); });
  assert.equal(narrowedResult.ok, true, JSON.stringify(narrowedResult));
  assert.equal(narrowedResult.result?.verification?.status, "verified", JSON.stringify(narrowedResult));
  assert.deepEqual(observerScope.filters, [[externalFileUploadUrl]], JSON.stringify(observerScope.filters));
  assert.deepEqual(observerScope.probed, [externalFileUploadUrl], JSON.stringify(observerScope.probed));
  assert.deepEqual(observerScope.controlled, [foreignPostUrl], JSON.stringify(observerScope.controlled));
  process.stderr.write("[browser-test] the reviewed upload observer is offered the exact signed upload URL only, and a concurrent POST to another HTTPS host produces no observer event\n");

  const externalRequestsBeforeParallelTransfer = externalFileStore.requests().length;
  externalFileStore.holdOneUpload();
  const parallelCalls = [
    runtime.call("canvas_transfer_course_file", {
      course_id: 42, folder_id: 81, filename: transferAttachment.manifest.filename,
      size_bytes: transferAttachment.manifest.size_bytes, sha256: transferAttachment.manifest.sha256,
      content_type: transferAttachment.content_type, privateAttachment: transferAttachment,
      _morrow: {
        source_binding_id: binding.sourceBindingId, operation_id: "operation:canvas-file-transfer-parallel-42",
        outer_grant: {
          plan_digest: "1".repeat(64), approval_grant_digest: "2".repeat(64),
          effect_receipt_id: "effect:canvas-file-transfer-parallel-42", dispatch_attempt: 1,
          gateway_process_id: "gateway:browser-test", authorization: { kind: "review" },
        },
      },
    }),
    runtime.call("canvas_transfer_course_file", {
      course_id: 43, folder_id: 82, filename: transferAttachment.manifest.filename,
      size_bytes: transferAttachment.manifest.size_bytes, sha256: transferAttachment.manifest.sha256,
      content_type: transferAttachment.content_type, privateAttachment: transferAttachment,
      _morrow: {
        source_binding_id: binding43.sourceBindingId, operation_id: "operation:canvas-file-transfer-parallel-43",
        outer_grant: {
          plan_digest: "3".repeat(64), approval_grant_digest: "4".repeat(64),
          effect_receipt_id: "effect:canvas-file-transfer-parallel-43", dispatch_attempt: 1,
          gateway_process_id: "gateway:browser-test", authorization: { kind: "review" },
        },
      },
    }),
  ];
  const observedParallelResults = [];
  for (const call of parallelCalls) {
    void call.then((result) => { observedParallelResults.push(result); }, () => { observedParallelResults.push(null); });
  }
  try {
    await waitFor(() => externalFileStore.pendingUploads() === 1, "parallel Canvas upload did not reach the held signed endpoint", 5_000);
    await waitFor(() => observedParallelResults.some((result) => result?.ok === false), "parallel Canvas upload did not refuse the colliding signed URL", 5_000);
  } finally {
    externalFileStore.releaseOneUpload();
  }
  const parallelTransfers = await Promise.all(parallelCalls);
  assert.equal(parallelTransfers.filter((result) => result.ok).length, 1, JSON.stringify(parallelTransfers));
  assert.equal(parallelTransfers.filter((result) => !result.ok).length, 1, JSON.stringify(parallelTransfers));
  const parallelStorageRequests = externalFileStore.requests().slice(externalRequestsBeforeParallelTransfer);
  assert.equal(parallelStorageRequests.filter((request) => request.method === "POST" && request.path === "/upload/signed").length, 1, JSON.stringify(parallelStorageRequests));
  assert.equal(parallelStorageRequests.filter((request) => request.method === "GET" && request.path === "/stored-file.txt" && request.cookie === "").length, 1, JSON.stringify(parallelStorageRequests));
  process.stderr.write("[browser-test] parallel Canvas uploads with one signed URL refuse one dispatch rather than cross-bind a confirmation redirect\n");

  await captureThemes(settings, "bridge-settings-plan", 900);
  await captureThemes(settings, "bridge-settings-plan-narrow", 320);
  await settings.setViewportSize({ width: 900, height: 760 });

  const selectedCourseControl = settings.getByRole("checkbox", { name: "Select Introduction to Human Biology" });
  await selectedCourseControl.focus();
  await settings.keyboard.press("Space");
  await waitFor(async () => await selectedCourseControl.isChecked(), "Space did not select the focused course");
  await waitFor(async () => await selectedCourseControl.evaluate((input) => input === document.activeElement), "course focus did not survive its selected-state render");
  await settings.getByRole("radio", { name: /^Edit/ }).check();
  await settings.getByRole("checkbox", { name: "Correct Canvas Page text" }).check();
  assert.equal(await settings.locator("#edit-duration").inputValue(), String(60 * 60 * 1_000));

  await settings.locator("#action-filter").fill("Remove course from favorites");
  const uncheckableRow = settings.locator('label[for="category-action:canvas:canvas_remove_course_from_favorites"]');
  await uncheckableRow.waitFor();
  assert.deepEqual(await uncheckableRow.locator(".action-flag").allInnerTexts(), ["Removes content", "Saved result not checked"]);
  assert.match(await uncheckableRow.innerText(), /Morrow cannot check this change after it is saved: .+\. Morrow reports the saved result as unconfirmed\./);
  const checkedOnlyFilter = settings.getByRole("checkbox", { name: "Only actions Morrow can check" });
  await checkedOnlyFilter.check();
  await waitFor(async () => await uncheckableRow.count() === 0, "the checked-only filter still listed an action Morrow cannot check");
  await checkedOnlyFilter.uncheck();
  await uncheckableRow.waitFor();
  await uncheckableRow.locator("input[type=checkbox]").check();
  await settings.locator("#save-edit").click();
  const saveConfirmation = settings.locator("#save-confirmation");
  await saveConfirmation.waitFor();
  const saveConfirmationText = await saveConfirmation.innerText();
  assert.match(saveConfirmationText, /1 selected action removes course content: Remove course from favorites\./);
  assert.match(saveConfirmationText, /Morrow cannot check the saved result for 1 selected action: Remove course from favorites\. Morrow reports those results as unconfirmed\./);
  assert.equal(await settings.locator("#save-edit").isDisabled(), true);
  assert.equal(Boolean((await runtime.editOptions(binding.sourceBindingId)).editPermission), false, "Edit access was saved before the second confirmation");
  await captureThemes(settings, "bridge-settings-unchecked-action", 900);
  await settings.setViewportSize({ width: 900, height: 760 });
  await settings.getByRole("button", { name: "Keep reviewing" }).click();
  await waitFor(async () => await saveConfirmation.isHidden(), "the second confirmation stayed open after Keep reviewing");
  await uncheckableRow.locator("input[type=checkbox]").uncheck();
  await settings.locator("#action-filter").fill("");
  await waitFor(async () => await settings.locator("#save-edit").isDisabled() === false, "Save Edit access stayed disabled after the flagged action was cleared");
  process.stderr.write("[browser-test] Settings marks the actions Morrow cannot check, filters them out on request, and refuses to save one without a second confirmation\n");

  await captureThemes(settings, "bridge-settings-edit", 900);
  await captureThemes(settings, "bridge-settings-edit-narrow", 320);
  await settings.setViewportSize({ width: 900, height: 760 });
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const editPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_page_content",
    "saved Edit permission was not published",
  );
  assert.deepEqual(editPermission.enabledCategories, ["canvas_page_content"]);
  assert.deepEqual(editPermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses", toolName: "canvas_update_create_page_courses", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "page_text" }]);
  const originalPolicy = await settings.evaluate(async (sourceBindingId) => {
    const stored = await chrome.storage.local.get("editPolicies");
    return stored.editPolicies?.[sourceBindingId] || null;
  }, binding.sourceBindingId);
  assert.ok(originalPolicy, "saved Edit permission was not persisted for stale-state rendering");
  await settings.evaluate(async ({ sourceBindingId, permission }) => {
    const stored = await chrome.storage.local.get("editPolicies");
    await chrome.storage.local.set({
      editPolicies: { ...stored.editPolicies, [sourceBindingId]: { ...permission, expiresAt: Date.now() - 1_000 } },
    });
  }, { sourceBindingId: binding.sourceBindingId, permission: originalPolicy });
  await settings.getByRole("button", { name: "Refresh connected courses" }).click();
  await settings.getByText("This temporary Edit access has ended.", { exact: false }).first().waitFor();
  assert.equal(await settings.getByRole("radio", { name: "Plan" }).isChecked(), true);
  await settings.getByText("returned to Plan because temporary Edit access ended.", { exact: false }).first().waitFor();
  await captureThemes(settings, "bridge-settings-expired", 900);
  await captureThemes(settings, "bridge-settings-expired-narrow", 320);
  await settings.evaluate(async ({ sourceBindingId, permission }) => {
    const stored = await chrome.storage.local.get("editPolicies");
    await chrome.storage.local.set({ editPolicies: { ...stored.editPolicies, [sourceBindingId]: permission } });
  }, { sourceBindingId: binding.sourceBindingId, permission: originalPolicy });
  await settings.setViewportSize({ width: 900, height: 760 });
  await settings.getByRole("button", { name: "Refresh connected courses" }).click();
  await settings.getByText("Edit: 1 type", { exact: true }).first().waitFor();
  const refusedSettingsMessage = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: "morrow_edit_policy_status" }));
  assert.deepEqual(refusedSettingsMessage, { ok: false, code: "edit_policy_sender_refused", error: "edit_policy_sender_refused" });

  const unscoped = await runtime.call("canvas_item_bank_create_bank", {
    title: "Must not be created",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: "operation:unscoped-bank-test",
      outer_grant: {
        plan_digest: "a".repeat(64), approval_grant_digest: "b".repeat(64),
        effect_receipt_id: "effect:unscoped-bank-test", dispatch_attempt: 1,
        gateway_process_id: "gateway:browser-test",
      },
    },
  });
  assert.equal(unscoped.ok, false);
  assert.equal(unscoped.resultState, "not_sent");
  // Item Bank writes are course_path-scoped by course_id (operation-admission.ts
  // classifies every item_bank service operation this way), so an absent
  // course_id takes the same held-open branch as a course_id that names a
  // different course: one course_binding_course_mismatch rule, not two.
  assert.match(JSON.stringify(unscoped), /course_binding_course_mismatch/);

  const directCourseRead = await runtime.call("canvas_get_single_course_courses", {
    id: "42",
    _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(directCourseRead.ok, true, JSON.stringify(directCourseRead));
  assert.equal(directCourseRead.result?.data?.id, "42");

  // The setup guide's fifth check is a course read that actually returned, so it can only complete
  // after one has. Reads have now returned for course 42, and the recorded proof names that course.
  const readSetupGuide = await context.newPage();
  await readSetupGuide.goto(`chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`);
  await readSetupGuide.getByRole("heading", { name: "Ready to use", exact: true }).waitFor();
  await readSetupGuide.getByText("First read completed in Introduction to Human Biology", { exact: true }).waitFor();
  assert.equal(await readSetupGuide.locator("#readiness-detail").innerText(),
    "3 selected courses are ready in this Chrome session. Morrow completed a first read in Introduction to Human Biology.");
  const recordedRead = await replacementWorker.evaluate(async () => (await chrome.storage.local.get("firstCourseRead")).firstCourseRead);
  assert.equal(recordedRead.courseId, "42");
  assert.equal(recordedRead.courseName, "Introduction to Human Biology");
  assert.equal(recordedRead.provider, "canvas");
  assert.ok(Number.isInteger(recordedRead.at) && recordedRead.at > 0, JSON.stringify(recordedRead));
  await captureSetupGuide(readSetupGuide, "setup-guide-ready");
  await readSetupGuide.close();
  process.stderr.write("[browser-test] the setup guide reports Ready to use only after a course read returned, and names the course it read\n");

  // Every command used to probe the connected course site tab for itself: one content-script
  // injection and one page round trip each, so a batch of reads against one course site paid that
  // cost per read and one navigation in that tab failed all of them. The worker now keeps one
  // short-lived match per course site and shares one in-flight probe. This counts the probes the
  // worker actually sends to the page, not the reads it answers. Eight is MAX_READ_BATCH_CONCURRENCY
  // in packages/batch-engine/src/index.ts, the most reads program work sends at one course site.
  const countAnchorProbes = async () => await replacementWorker.evaluate(() => {
    if (!globalThis.morrowAnchorProbeCounter) {
      const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
      globalThis.morrowAnchorProbes = 0;
      globalThis.morrowAnchorProbeCounter = true;
      chrome.tabs.sendMessage = (tabId, message, options) => {
        if (message?.type === "morrow_canvas_probe") globalThis.morrowAnchorProbes += 1;
        return sendMessage(tabId, message, options);
      };
    }
    return globalThis.morrowAnchorProbes;
  });
  // Longer than ANCHOR_VERIFICATION_TTL_MS in connector/extension/src/service-worker.js, so this
  // burst starts with nothing kept and has to send a real probe of its own.
  const probesBeforeBurst = await countAnchorProbes();
  await delay(2_500);
  const burstReads = await Promise.all(Array.from({ length: 8 }, () => runtime.call("canvas_get_single_course_courses", {
    id: "42",
    _morrow: { source_binding_id: binding.sourceBindingId },
  })));
  assert.equal(burstReads.filter((entry) => entry.ok === true).length, 8, JSON.stringify(burstReads));
  assert.equal(burstReads.every((entry) => entry.result?.data?.id === "42"), true, JSON.stringify(burstReads));
  const burstProbes = await countAnchorProbes() - probesBeforeBurst;
  assert.ok(burstProbes >= 1, "the concurrent read burst must start from an expired course-site match");
  assert.ok(burstProbes <= 2, `8 concurrent reads against one course site must share their probe, and sent ${burstProbes}`);
  process.stderr.write(`[browser-test] 8 concurrent reads against one connected course site shared ${burstProbes} course-site probe(s)\n`);

  const cappedList = await runtime.call("canvas_list_pages_courses", {
    course_id: "42",
    morrow_max_pages: 1,
    _morrow: { source_binding_id: binding.sourceBindingId, list_resume: {} },
  });
  assert.equal(cappedList.ok, true, JSON.stringify(cappedList));
  assert.equal(cappedList.result.truncated, true);
  assert.equal(cappedList.result.morrow_unread_pages, 2);
  assert.match(cappedList.result.morrow_next_page, /^[A-Za-z0-9_-]{8,}$/);
  assert.deepEqual(cappedList.result.data.map((entry) => entry.url), ["listed-page-1"]);
  const resumedList = await runtime.call("canvas_list_pages_courses", {
    course_id: "42",
    morrow_max_pages: 5,
    _morrow: { source_binding_id: binding.sourceBindingId, list_resume: { next_page: cappedList.result.morrow_next_page } },
  });
  assert.equal(resumedList.ok, true, JSON.stringify(resumedList));
  assert.equal(resumedList.result.truncated, false);
  assert.equal(resumedList.result.morrow_pages_read, 3);
  assert.deepEqual(resumedList.result.data.map((entry) => entry.url), ["listed-page-2", "listed-page-3"]);
  const foreignResume = await runtime.call("canvas_list_pages_courses", {
    course_id: "42",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      list_resume: {
        next_page: Buffer.from(JSON.stringify({ v: 1, p: 1, u: "https://attacker.example.com/api/v1/courses/42/pages?page=2" }), "utf8").toString("base64url"),
      },
    },
  });
  assert.equal(foreignResume.ok, false, JSON.stringify(foreignResume));
  assert.match(JSON.stringify(foreignResume), /canvas_pagination_resume_refused/);
  console.log("[browser-test] a capped Canvas list resumes to its last page through one opaque token and refuses a foreign-origin token");
  const semanticCourseMismatch = await runtime.call("canvas_get_course_nickname", {
    course_id: "43",
    _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(semanticCourseMismatch.ok, false);
  assert.equal(semanticCourseMismatch.resultState, "not_sent");
  assert.match(JSON.stringify(semanticCourseMismatch), /course_binding(?:_course)?_mismatch/);
  const syntheticCourseScope = await runtime.call("canvas_clear_course_nicknames", {
    course_id: "42",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: "operation:synthetic-course-scope",
      outer_grant: {
        plan_digest: "a".repeat(64), approval_grant_digest: "b".repeat(64),
        effect_receipt_id: "effect:synthetic-course-scope", dispatch_attempt: 1,
        gateway_process_id: "gateway:browser-test",
      },
    },
  });
  assert.equal(syntheticCourseScope.ok, false);
  assert.equal(syntheticCourseScope.resultState, "not_sent");
  assert.match(JSON.stringify(syntheticCourseScope), /course_scope_required/);

  const read = await runtime.call("canvas_get_new_quiz", {
    course_id: "42",
    assignment_id: "77",
    _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(read.ok, true);
  assert.match(JSON.stringify(read), /New Quiz 77/);

  const privateAttachmentMarker = "cHJpdmF0ZS1maWxlLWJ5dGVz";
  const canvasPrivateAttachmentRefusal = await replacementWorker.evaluate(async ({ tabId, marker }) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    return await chrome.tabs.sendMessage(tabId, {
      type: "morrow_canvas_execute",
      privateAttachment: { bytes_base64: marker },
    }, { frameId: 0 });
  }, { tabId: canvasTabId, marker: privateAttachmentMarker });
  assert.deepEqual(canvasPrivateAttachmentRefusal, { ok: false, sent: false, error: "canvas_private_attachment_refused" });
  assert.equal(JSON.stringify(canvasPrivateAttachmentRefusal).includes(privateAttachmentMarker), false);

  const quizItemWrite = await runtime.call("canvas_create_quiz_item", {
    course_id: "42",
    assignment_id: "77",
    item_entry_type: "Item",
    item_entry_title: "Evidence question",
    item_entry_item_body: "<p>Explain the result.</p>",
    item_entry_interaction_type_slug: "essay",
    item_entry_interaction_data: {
      rce: true,
      essay: null,
      word_count: true,
      file_upload: false,
      spell_check: true,
      word_limit_enabled: true,
      word_limit_min: "0",
      word_limit_max: "250",
    },
    item_entry_scoring_algorithm: "None",
    item_entry_scoring_data: { value: "" },
    item_points_possible: 5,
    morrow_new_quiz_item_lifecycle_guard: {
      kind: "create",
      before_items_sha256: createHash("sha256").update(stable([])).digest("hex"),
      payload_sha256: createHash("sha256").update(stable({
        entry: {
          interaction_data: {
            rce: true,
            essay: null,
            word_count: true,
            file_upload: false,
            spell_check: true,
            word_limit_enabled: true,
            word_limit_min: "0",
            word_limit_max: "250",
          },
          interaction_type_slug: "essay",
          item_body: "<p>Explain the result.</p>",
          scoring_algorithm: "None",
          scoring_data: { value: "" },
          title: "Evidence question",
        },
        entry_type: "Item",
        points_possible: 5,
      })).digest("hex"),
    },
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
  // A Canvas section route names an object, not a course. Morrow reads the section in the bound tab
  // immediately before it sends the change, requires that reading to name the selected course, and
  // keeps it with the result.
  const sectionOperation = canvasCatalog.operations.find((entry) => entry.toolName === "canvas_edit_section");
  const sectionCall = (toolName, argumentsValue, name) => runtime.call(toolName, {
    ...argumentsValue,
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: `operation:${name}`,
      outer_grant: { ...grant, effect_receipt_id: `effect:${name}` },
    },
  });
  const sectionWrite = await sectionCall("canvas_edit_section", { id: "302", course_section_name: "Section B evening" }, "section-edit");
  assert.equal(sectionWrite.ok, true, JSON.stringify(sectionWrite));
  assert.equal(sectionWrite.result.verification.status, "verified", JSON.stringify(sectionWrite));
  assert.equal(sectionWrite.result.verification.readTool, "canvas_get_section_information_sections");
  assert.equal(canvas.sectionWrites(), 1);
  assert.equal(canvas.section("302").name, "Section B evening");
  const sectionResolution = sectionWrite.result.semanticResolution;
  assert.equal(sectionResolution.objectId, "302");
  assert.equal(sectionResolution.courseId, "42");
  assert.equal(sectionResolution.resolverTool, "canvas_get_section_information_sections");
  assert.match(sectionResolution.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.ok(Date.now() - Date.parse(sectionResolution.resolvedAt) < 60_000, "the frozen reading is not current");

  const otherCourseSection = await sectionCall("canvas_edit_section", { id: "401", course_section_name: "Must stay unchanged" }, "section-other-course");
  assert.equal(otherCourseSection.ok, false, JSON.stringify(otherCourseSection));
  assert.equal(otherCourseSection.resultState, "not_sent");
  assert.match(JSON.stringify(otherCourseSection), /canvas_semantic_target_course_mismatch/);
  assert.equal(canvas.sectionWrites(), 1);
  assert.equal(canvas.section("401").name, "Anatomy section");

  const staleSectionResolution = await replacementWorker.evaluate(async ({ tabId, operation, resolution }) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    return await chrome.tabs.sendMessage(tabId, {
      type: "morrow_canvas_execute",
      operation: { ...operation, morrowSemanticResolution: resolution },
      arguments: { id: "302", course_section_name: "Must stay unchanged" },
      principalId: "7",
      expiresAt: Date.now() + 60_000,
      courseId: "42",
    }, { frameId: 0 });
  }, {
    tabId: canvasTabId,
    operation: { ...sectionOperation, morrowCourseTarget: canvasOperationAdmission(sectionOperation).courseTarget },
    resolution: {
      objectId: "302",
      courseId: "42",
      resolverTool: "canvas_get_section_information_sections",
      resolvedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      snapshotDigest: "c".repeat(64),
    },
  });
  assert.deepEqual(staleSectionResolution, { ok: false, sent: false, error: "canvas_semantic_target_resolution_stale" });
  assert.equal(canvas.sectionWrites(), 1);
  assert.equal(canvas.section("302").name, "Section B evening");

  const unchangedSection = await sectionCall("canvas_edit_section", { id: "307", course_section_name: "Section G evening" }, "section-unchanged");
  assert.equal(unchangedSection.ok, true, JSON.stringify(unchangedSection));
  assert.equal(unchangedSection.result.verification.status, "mismatch", JSON.stringify(unchangedSection));
  assert.equal(unchangedSection.result.verification.evidence, "requested_field_mismatch:course_section_name");
  assert.equal(canvas.section("307").name, "Section G");
  assert.equal(canvas.sectionWrites(), 2);

  const deletedSection = await sectionCall("canvas_delete_section", { id: "305" }, "section-delete");
  assert.equal(deletedSection.ok, true, JSON.stringify(deletedSection));
  assert.equal(deletedSection.result.verification.status, "verified", JSON.stringify(deletedSection));
  assert.equal(deletedSection.result.verification.evidence, "fresh_readback_absent");
  assert.equal(canvas.section("305"), null);

  // A section that still answers on its own route is proved gone from the selected course's own
  // listing, read to its last page.
  const removedFromCourse = await sectionCall("canvas_delete_section", { id: "306" }, "section-delete-listed");
  assert.equal(removedFromCourse.ok, true, JSON.stringify(removedFromCourse));
  assert.equal(removedFromCourse.result.verification.status, "verified", JSON.stringify(removedFromCourse));
  assert.equal(removedFromCourse.result.verification.evidence, "fresh_collection_omits_target");
  assert.equal(removedFromCourse.result.verification.readTool, "canvas_list_course_sections");
  assert.deepEqual(canvas.courseSectionIds(), ["302", "307"]);
  assert.equal(canvas.sectionWrites(), 4);
  process.stderr.write("[browser-test] a course section is changed only after one current reading proves the selected course owns it, and each change is read back\n");

  // A Canvas group route names a group, and Canvas can attach a group to another course or let a
  // person make one outside every course. Morrow reads the group in the bound tab, requires the
  // selected course's own complete list of groups to name it, and only then sends the one change.
  const groupCall = sectionCall;
  const groupPageWrite = await groupCall(
    "canvas_update_create_page_groups",
    { group_id: "88", url_or_id: "week-one", wiki_page_body: "<p>Week one plan, revised.</p>" },
    "group-page",
  );
  assert.equal(groupPageWrite.ok, true, JSON.stringify(groupPageWrite));
  assert.equal(groupPageWrite.result.verification.status, "verified", JSON.stringify(groupPageWrite));
  // The change is read back through the group page's own route, not through the group reading.
  assert.equal(groupPageWrite.result.verification.readTool, "canvas_show_page_groups");
  assert.equal(canvas.groupPageWrites(), 1);
  assert.equal(canvas.groupPage("88").body, "<p>Week one plan, revised.</p>");
  const groupResolution = groupPageWrite.result.semanticResolution;
  assert.equal(groupResolution.objectId, "88");
  assert.equal(groupResolution.courseId, "42");
  assert.equal(groupResolution.resolverTool, "canvas_get_single_group");
  assert.match(groupResolution.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.ok(Date.now() - Date.parse(groupResolution.resolvedAt) < 60_000, "the frozen group reading is not current");

  // A group in another course, a group a person made for themselves, and a group this course does
  // not list as its own are all refused before anything is sent.
  for (const [groupId, saved, name] of [
    ["91", "<p>Other course plan</p>", "group-other-course"],
    ["92", "<p>Personal plan</p>", "group-user-context"],
    ["93", "<p>Retired plan</p>", "group-not-listed-by-course"],
  ]) {
    const refused = await groupCall(
      "canvas_update_create_page_groups",
      { group_id: groupId, url_or_id: "week-one", wiki_page_body: "<p>Must stay unchanged.</p>" },
      name,
    );
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.resultState, "not_sent", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /canvas_semantic_target_course_mismatch/);
    assert.equal(canvas.groupPage(groupId).body, saved, groupId);
  }
  assert.equal(canvas.groupPageWrites(), 1);
  assert.equal(canvas.requests().some((entry) => entry === "PUT /api/v1/groups/93/pages/week-one"), false);

  // Who is in a group stays with the person who can decide it. This one is held before dispatch and
  // carries the same sentence Morrow shows anywhere the hold appears.
  const groupMembership = await groupCall("canvas_create_membership", { group_id: "88", user_id: "99" }, "group-membership");
  assert.equal(groupMembership.ok, false, JSON.stringify(groupMembership));
  assert.match(JSON.stringify(groupMembership), /Morrow does not change a student's own record/);
  assert.equal(canvas.requests().some((entry) => entry === "POST /api/v1/groups/88/memberships"), false);
  process.stderr.write("[browser-test] a group's own page is changed only after one current reading and the course's own list of groups prove the selected course owns that group\n");

  // A Canvas file route names a file, and Canvas can hang a file from another course, from the
  // account, or from one person. Morrow reads the file in the bound tab, requires the selected
  // course's own complete list of files to name it, freezes the saved version, and only then sends
  // the one change.
  const fileCall = sectionCall;
  const renamedFile = await fileCall(
    "canvas_update_file",
    { id: "601", name: "Syllabus 2026.pdf", on_duplicate: "rename" },
    "course-file-rename",
  );
  assert.equal(renamedFile.ok, true, JSON.stringify(renamedFile));
  assert.equal(renamedFile.result.verification.status, "verified", JSON.stringify(renamedFile));
  assert.equal(renamedFile.result.verification.readTool, "canvas_get_file_files");
  assert.equal(canvas.courseFileWrites(), 1);
  assert.equal(canvas.file("601").display_name, "Syllabus 2026.pdf");
  const fileResolution = renamedFile.result.semanticResolution;
  assert.equal(fileResolution.objectId, "601");
  assert.equal(fileResolution.courseId, "42");
  assert.equal(fileResolution.resolverTool, "canvas_get_file_files");
  assert.deepEqual(fileResolution.objectVersion, {
    id: "601", updated_at: "2026-09-06T12:00:00Z", size: 20480, "content-type": "application/pdf",
  });
  // A Canvas file link is a signed way in to the bytes, so no result and no frozen record carries one.
  assert.equal(JSON.stringify(renamedFile).includes("synthetic-course-file-verifier"), false);

  // A move lands only in a folder the selected course's own complete list of folders names.
  const movedFile = await fileCall(
    "canvas_update_file",
    { id: "601", parent_folder_id: "85", on_duplicate: "rename" },
    "course-file-move",
  );
  assert.equal(movedFile.ok, true, JSON.stringify(movedFile));
  assert.equal(movedFile.result.verification.status, "verified", JSON.stringify(movedFile));
  assert.equal(canvas.file("601").folder_id, "85");
  assert.equal(canvas.courseFileWrites(), 2);

  const outOfCourseMove = await fileCall(
    "canvas_update_file",
    { id: "601", parent_folder_id: "86", on_duplicate: "rename" },
    "course-file-move-other-course",
  );
  assert.equal(outOfCourseMove.ok, false, JSON.stringify(outOfCourseMove));
  assert.equal(outOfCourseMove.resultState, "not_sent");
  assert.match(JSON.stringify(outOfCourseMove), /canvas_semantic_target_course_mismatch/);
  assert.equal(canvas.file("601").folder_id, "85");
  assert.equal(canvas.courseFileWrites(), 2);

  // Canvas removes a file that already has the new name unless it is told to keep both.
  const overwritingRename = await fileCall(
    "canvas_update_file",
    { id: "601", name: "Old handout.pdf", on_duplicate: "overwrite" },
    "course-file-overwrite",
  );
  assert.equal(overwritingRename.ok, false, JSON.stringify(overwritingRename));
  assert.equal(overwritingRename.resultState, "not_sent");
  assert.match(JSON.stringify(overwritingRename), /canvas_semantic_target_input_refused/);
  assert.equal(canvas.file("601").display_name, "Syllabus 2026.pdf");
  assert.equal(canvas.courseFileWrites(), 2);

  // A file in another course, a file the account owns, and a file this course does not list as its
  // own are all refused before anything is sent.
  for (const [fileId, saved, name] of [
    ["701", "Syllabus.pdf", "course-file-other-course"],
    ["702", "Syllabus.pdf", "course-file-account-context"],
    ["703", "Retired handout.pdf", "course-file-not-listed-by-course"],
  ]) {
    const refused = await fileCall("canvas_update_file", { id: fileId, name: "Must stay unchanged.pdf", on_duplicate: "rename" }, name);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.resultState, "not_sent", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /canvas_semantic_target_course_mismatch/);
    assert.equal(canvas.file(fileId).display_name, saved, fileId);
  }
  assert.equal(canvas.courseFileWrites(), 2);
  assert.equal(canvas.requests().some((entry) => entry === "PUT /api/v1/files/703"), false);

  const removedFile = await fileCall("canvas_delete_file", { id: "602" }, "course-file-delete");
  assert.equal(removedFile.ok, true, JSON.stringify(removedFile));
  assert.equal(removedFile.result.verification.status, "verified", JSON.stringify(removedFile));
  assert.equal(removedFile.result.verification.evidence, "fresh_readback_absent");
  assert.equal(canvas.file("602"), null);
  assert.deepEqual(canvas.courseFileIds(), ["601"]);

  const newFolder = await fileCall("canvas_create_folder_folders", { folder_id: "84", name: "Week 3" }, "course-folder-create");
  assert.equal(newFolder.ok, true, JSON.stringify(newFolder));
  assert.equal(newFolder.result.verification.status, "verified", JSON.stringify(newFolder));
  // The new folder is read back through its own route, where it names the proved parent again.
  assert.equal(newFolder.result.verification.readTool, "canvas_get_folder_folders");
  assert.equal(newFolder.result.semanticResolution.objectId, "84");
  assert.equal(canvas.folder("95").parent_folder_id, "84");
  assert.equal(canvas.folder("95").name, "Week 3");

  const outOfCourseFolder = await fileCall("canvas_create_folder_folders", { folder_id: "86", name: "Must not exist" }, "course-folder-other-course");
  assert.equal(outOfCourseFolder.ok, false, JSON.stringify(outOfCourseFolder));
  assert.equal(outOfCourseFolder.resultState, "not_sent");
  assert.match(JSON.stringify(outOfCourseFolder), /canvas_semantic_target_course_mismatch/);
  assert.equal(canvas.requests().some((entry) => entry === "POST /api/v1/folders/86/folders"), false);

  // Copying reaches a second object that the reading of the first one does not prove, so both copy
  // routes stay held and carry the sentence Morrow shows wherever that hold appears.
  for (const [toolName, argumentsValue] of [
    ["canvas_copy_file", { dest_folder_id: "84", source_file_id: "601" }],
    ["canvas_copy_folder", { dest_folder_id: "84", source_folder_id: "85" }],
  ]) {
    const held = await fileCall(toolName, argumentsValue, `${toolName}-held`);
    assert.equal(held.ok, false, JSON.stringify(held));
    assert.match(JSON.stringify(held), /Canvas can attach this group, file, folder, calendar item or outcome to any course/);
    assert.equal(canvas.requests().some((entry) => entry.startsWith("POST /api/v1/folders/84/copy")), false);
  }
  process.stderr.write("[browser-test] a course file is renamed, moved and removed, and a folder added, only after one current reading and the course's own listings prove the selected course owns the object\n");

  // A Canvas calendar event belongs to whatever calendar its context code names. A new event is put
  // on the selected course's calendar by that code and read back from its own route, and a change to
  // an existing event is sent only after a reading proves it is already on that calendar.
  const calendarCall = sectionCall;
  const newEvent = await calendarCall("canvas_create_calendar_event", {
    calendar_event_context_code: "course_42",
    calendar_event_title: "Lab review",
    calendar_event_start_at: "2026-09-10T16:00:00Z",
    calendar_event_end_at: "2026-09-10T17:00:00Z",
    calendar_event_description: "<p>Bring the worksheet.</p>",
    calendar_event_location_name: "Room 2",
  }, "calendar-event-create");
  assert.equal(newEvent.ok, true, JSON.stringify(newEvent));
  assert.equal(newEvent.result.verification.status, "verified", JSON.stringify(newEvent));
  assert.equal(newEvent.result.verification.readTool, "canvas_get_single_calendar_event_or_assignment");
  assert.equal(canvas.calendarEventWrites(), 1);
  assert.equal(canvas.calendarEvent("505").title, "Lab review");
  assert.equal(canvas.calendarEvent("505").context_code, "course_42");

  // Another course's calendar is refused before anything is sent, and so is a repeat rule: Morrow
  // sends one event and reads that one event back. The calendar a new event names is the course it
  // lands in, so a request that names another course fails the binding check the MCP layer already
  // makes for every course-scoped change.
  for (const [argumentsValue, code, name] of [
    [{ calendar_event_context_code: "course_43", calendar_event_title: "Must not exist" }, /course_binding_course_mismatch/, "calendar-event-other-course"],
    [{ calendar_event_context_code: "course_42", calendar_event_title: "Must not exist", calendar_event_rrule: "FREQ=WEEKLY;COUNT=5" }, /canvas_semantic_target_input_refused/, "calendar-event-series"],
    [{ calendar_event_context_code: "course_42", calendar_event_title: "Must not exist", calendar_event_duplicate_count: 3 }, /canvas_semantic_target_input_refused/, "calendar-event-duplicate"],
  ]) {
    const refused = await calendarCall("canvas_create_calendar_event", argumentsValue, name);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.resultState, "not_sent", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), code);
  }
  assert.equal(canvas.calendarEventWrites(), 1);

  const changedEvent = await calendarCall("canvas_update_calendar_event", {
    id: "501",
    calendar_event_title: "Lab review, revised",
    calendar_event_start_at: "2026-09-11T16:00:00Z",
    calendar_event_end_at: "2026-09-11T17:00:00Z",
    calendar_event_location_name: "Room 4",
  }, "calendar-event-update");
  assert.equal(changedEvent.ok, true, JSON.stringify(changedEvent));
  assert.equal(changedEvent.result.verification.status, "verified", JSON.stringify(changedEvent));
  assert.equal(canvas.calendarEvent("501").title, "Lab review, revised");
  assert.equal(canvas.calendarEvent("501").location_name, "Room 4");
  const eventResolution = changedEvent.result.semanticResolution;
  assert.equal(eventResolution.objectId, "501");
  assert.equal(eventResolution.courseId, "42");
  assert.equal(eventResolution.resolverTool, "canvas_get_single_calendar_event_or_assignment");
  assert.match(eventResolution.snapshotDigest, /^[0-9a-f]{64}$/);

  // An event on another course's calendar, and a change that would move this one to another
  // calendar, are both refused before anything is sent.
  for (const [argumentsValue, name] of [
    [{ id: "601", calendar_event_title: "Must stay unchanged" }, "calendar-event-update-other-course"],
    [{ id: "501", calendar_event_context_code: "course_43" }, "calendar-event-move-out"],
  ]) {
    const refused = await calendarCall("canvas_update_calendar_event", argumentsValue, name);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.resultState, "not_sent", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /canvas_semantic_target_course_mismatch/);
  }
  assert.equal(canvas.calendarEvent("601").title, "Anatomy lab");
  assert.equal(canvas.calendarEvent("501").context_code, "course_42");
  assert.equal(canvas.calendarEventWrites(), 2);

  const removedEvent = await calendarCall("canvas_delete_calendar_event", { id: "502" }, "calendar-event-delete");
  assert.equal(removedEvent.ok, true, JSON.stringify(removedEvent));
  assert.equal(removedEvent.result.verification.status, "verified", JSON.stringify(removedEvent));
  assert.equal(removedEvent.result.verification.evidence, "fresh_readback_absent");
  assert.equal(canvas.calendarEvent("502"), null);

  // An event that still answers on its own route is proved gone from the selected course's whole
  // calendar, asked for by that calendar's context code and read to its last page.
  const cancelledEvent = await calendarCall("canvas_delete_calendar_event", { id: "503" }, "calendar-event-delete-listed");
  assert.equal(cancelledEvent.ok, true, JSON.stringify(cancelledEvent));
  assert.equal(cancelledEvent.result.verification.status, "verified", JSON.stringify(cancelledEvent));
  assert.equal(cancelledEvent.result.verification.evidence, "fresh_collection_omits_target");
  assert.equal(cancelledEvent.result.verification.readTool, "canvas_list_calendar_events");
  assert.deepEqual(canvas.courseCalendarEventIds(), ["501", "505"]);
  assert.equal(canvas.calendarEventWrites(), 4);

  // An appointment group is a sign-up sheet, and one sheet can serve several courses at once.
  const changedAppointmentGroup = await calendarCall("canvas_update_appointment_group", {
    id: "701",
    appointment_group_context_codes: ["course_42"],
    appointment_group_title: "Office hours, revised",
  }, "appointment-group-update");
  assert.equal(changedAppointmentGroup.ok, true, JSON.stringify(changedAppointmentGroup));
  assert.equal(changedAppointmentGroup.result.verification.status, "verified", JSON.stringify(changedAppointmentGroup));
  assert.equal(changedAppointmentGroup.result.verification.readTool, "canvas_get_single_appointment_group");
  assert.equal(canvas.appointmentGroup("701").title, "Office hours, revised");
  assert.equal(canvas.appointmentGroupWrites(), 1);

  // A group that serves this course and another one is refused outright, whether the request names
  // the second course or the saved group does.
  for (const [argumentsValue, name] of [
    [{ id: "702", appointment_group_context_codes: ["course_42"], appointment_group_title: "Must stay unchanged" }, "appointment-group-saved-multi-context"],
    [{ id: "701", appointment_group_context_codes: ["course_42", "course_43"], appointment_group_title: "Must stay unchanged" }, "appointment-group-named-multi-context"],
  ]) {
    const refused = await calendarCall("canvas_update_appointment_group", argumentsValue, name);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.resultState, "not_sent", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /multi_context_object_not_supported/);
  }
  assert.equal(canvas.appointmentGroup("702").title, "Shared office hours");
  assert.equal(canvas.appointmentGroup("701").title, "Office hours, revised");
  assert.equal(canvas.appointmentGroupWrites(), 1);

  // Booking a time slot and cancelling a whole sign-up sheet stay with the person who can decide
  // them, and each carries the sentence Morrow shows wherever that hold appears.
  for (const [toolName, argumentsValue] of [
    ["canvas_reserve_time_slot", { id: "501" }],
    ["canvas_delete_appointment_group", { id: "701" }],
  ]) {
    const held = await calendarCall(toolName, argumentsValue, `${toolName}-held`);
    assert.equal(held.ok, false, JSON.stringify(held));
    assert.match(JSON.stringify(held), /Morrow does not change a student's own record/);
  }
  assert.equal(canvas.requests().some((entry) => entry === "POST /api/v1/calendar_events/501/reservations"), false);
  assert.equal(canvas.requests().some((entry) => entry === "DELETE /api/v1/appointment_groups/701"), false);
  process.stderr.write("[browser-test] a course calendar event is added, changed and removed on the selected course's own calendar, and an appointment group that serves more than one course is refused before dispatch\n");

  const bulkDateWrite = await runtime.call("canvas_bulk_update_assignment_dates", {
    course_id: "42",
    assignment_dates: [{ id: "188", all_dates: [{ base: true, due_at: "2026-10-02T17:00:00Z", unlock_at: null }] }],
    _morrow: { source_binding_id: binding.sourceBindingId, outer_grant: { ...grant, effect_receipt_id: "effect:bulk-assignment-dates-browser-test" } },
  });
  assert.equal(bulkDateWrite.ok, true, JSON.stringify(bulkDateWrite));
  assert.equal(bulkDateWrite.result.verification.status, "verified", JSON.stringify(bulkDateWrite));
  assert.equal(canvas.bulkAssignmentDateWrites(), 1);
  assert.deepEqual(canvas.bulkAssignmentDates(), [{ id: "188", course_id: "42", all_dates: [{ base: true, due_at: "2026-10-02T17:00:00Z", unlock_at: null }] }]);
  const bulkRequestsBeforeInvalid = canvas.requests().filter((entry) => entry === "PUT /api/v1/courses/42/assignments/bulk_update").length;
  const invalidBulkDateWrite = await runtime.call("canvas_bulk_update_assignment_dates", {
    course_id: "42",
    assignment_dates: [{ id: "188", all_dates: [{ base: true }] }],
    _morrow: { source_binding_id: binding.sourceBindingId, outer_grant: { ...grant, effect_receipt_id: "effect:invalid-bulk-assignment-dates-browser-test" } },
  });
  assert.equal(invalidBulkDateWrite.ok, false, JSON.stringify(invalidBulkDateWrite));
  assert.match(JSON.stringify(invalidBulkDateWrite), /canvas_bulk_assignment_dates_invalid/);
  assert.equal(canvas.bulkAssignmentDateWrites(), 1);
  assert.equal(canvas.requests().filter((entry) => entry === "PUT /api/v1/courses/42/assignments/bulk_update").length, bulkRequestsBeforeInvalid);
  const reactivatedEnrollment = await runtime.call("canvas_re_activate_enrollment", {
    course_id: "42",
    id: "51",
    _morrow: { source_binding_id: binding.sourceBindingId, outer_grant: { ...grant, effect_receipt_id: "effect:reactivate-enrollment-browser-test" } },
  });
  assert.equal(reactivatedEnrollment.ok, true, JSON.stringify(reactivatedEnrollment));
  assert.equal(reactivatedEnrollment.result.verification.status, "verified", JSON.stringify(reactivatedEnrollment));
  assert.equal(canvas.enrollmentReactivationWrites(), 1);
  assert.deepEqual(canvas.enrollment(), { id: "51", course_id: "42", user_id: "99", enrollment_state: "active" });
  process.stderr.write("[browser-test] Canvas bulk AssignmentDate and enrollment reactivation changes verify exact Progress, course, subject, and postcondition evidence\n");
  const wrongCourse = await runtime.call("canvas_show_page_courses", {
    course_id: "43",
    url_or_id: "lesson",
    _morrow: { source_binding_id: binding.sourceBindingId },
  });
  assert.equal(wrongCourse.ok, false);
  assert.equal(wrongCourse.resultState, "not_sent");
  assert.match(JSON.stringify(wrongCourse), /course_binding(?:_course)?_mismatch/);
  assert.equal(canvas.requests().includes("GET /api/v1/courses/43/pages/lesson"), false);

  const pageBefore = canvas.lesson();
  const pageRead = await runtime.call("canvas_show_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId } });
  assert.equal(pageRead.result.pageBodySha256, createHash("sha256").update(pageBefore.body).digest("hex"));
  const pageGuard = { kind: "page_text", course_id: "42", page_id: "91", revision_id: "1", body_sha256: pageRead.result.pageBodySha256, fields: { url: "lesson", title: pageBefore.title, published: true, front_page: false, editing_roles: "teachers", publish_at: null }, find_text: "Cells have membranes.", replace_text: "Cells have protective membranes." };
  const editAuthorization = { kind: "edit_scope", policy_digest: editPermission.scopeDigest, policy_revision: editPermission.revision };
  const pageArgs = { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId, canvas_content_guard: pageGuard, outer_grant: { ...grant, effect_receipt_id: "effect:page-edit-test", authorization: editAuthorization } } };
  canvas.holdOnePageWrite();
  const pageWritePromise = runtime.call("canvas_update_create_page_courses", pageArgs);
  await waitFor(() => canvas.pendingPageWrites() === 1, "first Page correction was not held at the provider");
  const revokedQueuedWrite = runtime.call("canvas_update_create_page_courses", {
    ...pageArgs,
    _morrow: {
      ...pageArgs._morrow,
      outer_grant: { ...grant, effect_receipt_id: "effect:page-edit-revoked", authorization: editAuthorization },
    },
  });
  await delay(100);
  await settings.getByRole("button", { name: "Return 1 selected course to Plan" }).click();
  await settings.getByText(/1 course returned to Plan/).first().waitFor();
  await captureThemes(settings, "bridge-settings-returned-plan", 900);
  await captureThemes(settings, "bridge-settings-returned-plan-narrow", 320);
  await settings.setViewportSize({ width: 900, height: 760 });
  canvas.releaseOnePageWrite();
  const pageWrite = await pageWritePromise;
  assert.equal(pageWrite.ok, true, JSON.stringify(pageWrite));
  assert.equal(pageWrite.result.verification.status, "verified", JSON.stringify(pageWrite));
  assert.equal(pageWrite.result.verification.createdRevisionId, "2");
  assert.deepEqual(canvas.lesson(), { ...pageBefore, body: pageBefore.body.replace(pageGuard.find_text, pageGuard.replace_text) });
  assert.equal(canvas.pageWrites(), 1);
  const queuedResult = await revokedQueuedWrite;
  assert.equal(queuedResult.ok, false);
  assert.match(JSON.stringify(queuedResult), /edit_policy_stale/);
  assert.equal(canvas.pageWrites(), 1);

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const textCategory = settings.getByRole("checkbox", { name: "Correct Canvas Page text" });
  if (await textCategory.isChecked()) await textCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas Page image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const altPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_page_image_alt",
    "saved image alternative-text Edit permission was not published",
  );
  assert.deepEqual(altPermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses", toolName: "canvas_update_create_page_courses", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "page_image_alt" }]);
  const altBefore = canvas.lesson();
  const imageSource = "/courses/42/files/9?value=a>b&part=opaque";
  const rawImage = `<img src="${imageSource}">`;
  const imageStart = altBefore.body.indexOf(rawImage);
  assert.ok(imageStart >= 0);
  const altGuard = {
    kind: "page_image_alt", course_id: "42", page_id: "91", revision_id: "2",
    body_sha256: createHash("sha256").update(altBefore.body).digest("hex"),
    fields: { url: "lesson", title: altBefore.title, published: true, front_page: false, editing_roles: "teachers", publish_at: null },
    image_index: 2, image_start: imageStart, image_end: imageStart + rawImage.length - 1,
    image_tag_sha256: createHash("sha256").update(rawImage).digest("hex"),
    image_src_sha256: createHash("sha256").update(imageSource).digest("hex"),
    alt_text: "Cell membrane diagram", decorative: false,
  };
  const altWrite = await runtime.call("canvas_update_create_page_courses", {
    course_id: "42", url_or_id: "lesson",
    _morrow: {
      source_binding_id: binding.sourceBindingId, canvas_content_guard: altGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:page-image-alt-test", authorization: { kind: "edit_scope", policy_digest: altPermission.scopeDigest, policy_revision: altPermission.revision } },
    },
  });
  assert.equal(altWrite.ok, true, JSON.stringify(altWrite));
  assert.equal(altWrite.result.verification.status, "verified", JSON.stringify(altWrite));
  assert.match(altWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.deepEqual(canvas.lesson(), { ...altBefore, body: altBefore.body.replace(rawImage, '<img src="/courses/42/files/9?value=a>b&part=opaque" alt="Cell membrane diagram">') });
  assert.equal(canvas.pageWrites(), 2);

  // The learner-render checks run in the sandboxed Bridge page, which loads
  // nothing and reaches no network. This fixture Page carries one instance of
  // every signal the record reports, so the record below is the real sandbox
  // answer for a real read, not a stub.
  const renderFixtureBody = [
    "<h2>Blood and circulation</h2>",
    '<p><a href="/courses/42/pages/one">Read more</a> then <a href="/courses/42/pages/two">read MORE</a>.</p>',
    '<p><a href="/courses/42/files/12" aria-label="Lab safety checklist">PDF</a> <button type="button"></button></p>',
    '<p><button type="button" tabindex="2">Second stop</button><button type="button" tabindex="1">First stop</button></p>',
    "<table><caption>Blood components</caption>",
    '<tr><th scope="col" id="component">Component</th><th>Role</th></tr>',
    '<tr><td headers="component">Red blood cells</td><td headers="absent-id">Carry oxygen</td></tr></table>',
    '<p><math alttext="x squared"><mi>x</mi></math></p>',
    '<p><img class="equation_image" src="/equation_images/y" alt="y equals mx plus b"></p>',
    '<p><video controls><track kind="captions" src="/captions.vtt"><track src="/subtitles.vtt"></video></p>',
    '<div style="background-color:#ffffff"><p style="color:#767676">Low contrast note</p>',
    '<p style="color:var(--brand)">Theme colour note</p></div>',
  ].join("");
  canvas.setLesson(renderFixtureBody);
  const renderRead = await runtime.call("canvas_show_page_courses", { course_id: "42", url_or_id: "lesson", _morrow: { source_binding_id: binding.sourceBindingId } });
  assert.equal(renderRead.ok, true, JSON.stringify(renderRead));
  const render = renderRead.result.renderCheck;
  assert.ok(render, "the Bridge sandbox returned no render record for the fixture Page");
  assert.equal(render.schema, "morrow.canvas-render-check.v1");
  assert.equal(render.status, "observed");
  assert.equal(render.evidence_class, "saved_source_render_signal_live_unverified");
  assert.equal(render.field, "body");
  assert.equal(render.source_character_count, renderFixtureBody.length);
  assert.equal(render.truncated, false);
  assert.ok(render.element_count > 20, JSON.stringify(render.element_count));
  assert.equal(render.focus_order.focusable_count, 7);
  assert.equal(render.focus_order.positive_tabindex_count, 2);
  assert.deepEqual(render.focus_order.reordered_by_positive_tabindex.map((entry) => [entry.dom_position, entry.tabindex, entry.tab_position]), [
    [6, 1, 1], [5, 2, 2], [1, null, 3], [2, null, 4], [3, null, 5], [4, null, 6],
  ]);
  assert.equal(render.focus_order.rendered_focus_order, "not_determinable_without_course_theme");
  assert.deepEqual(render.accessible_names.entries.map((entry) => [entry.element_kind, entry.name_source]), [
    ["link", "text_content"], ["link", "text_content"], ["link", "aria_label"],
    ["button", "none"], ["button", "text_content"], ["button", "text_content"],
  ]);
  assert.equal(render.accessible_names.without_accessible_name_count, 1);
  assert.deepEqual(render.accessible_names.precedence, ["aria-labelledby", "aria-label", "text content", "title"]);
  assert.deepEqual(render.duplicate_link_text.groups.map((group) => group.distinct_destination_count), [2]);
  assert.equal(render.tables.tables_count, 1);
  const renderTable = render.tables.tables[0];
  assert.deepEqual([renderTable.header_cell_count, renderTable.header_cells_with_scope, renderTable.header_cells_without_scope], [2, 1, 1]);
  assert.deepEqual([renderTable.cells_with_headers_attribute, renderTable.unresolved_headers_references, renderTable.association], [2, 1, "scope_and_headers_ids"]);
  assert.deepEqual(render.equations.mathml_elements.map((entry) => entry.alttext_declared), [true]);
  assert.deepEqual(render.equations.equation_images.map((entry) => [entry.signal, entry.alt_text_declared]), [["equation_image_class", true]]);
  assert.deepEqual(render.media_players.players.map((entry) => [entry.tag, entry.controls_declared, entry.track_kinds.join(",")]), [["video", true, "captions,subtitles"]]);
  assert.equal(render.media_players.embedded_frames_count, 0);
  assert.equal(render.media_players.player_controls, "not_determinable_without_course_theme");
  assert.deepEqual(render.contrast.evaluated.map((entry) => entry.contrast_ratio), [4.54]);
  assert.deepEqual(render.contrast.not_determinable_without_course_theme.map((entry) => entry.reason), [
    "foreground_colour_not_declared_inline", "foreground_colour_not_resolvable_from_saved_source",
  ]);
  assert.equal(render.contrast.text_size, "not_determinable_without_course_theme");
  assert.deepEqual(render.not_determinable_without_course_theme.map((entry) => entry.check), [
    "colour_contrast", "text_size_threshold", "focus_visibility", "rendered_focus_order",
    "media_player_controls", "equation_rendering", "table_reading_order", "assistive_technology_output",
  ]);
  assert.match(render.interpretation, /live-unverified/);
  // The record leaves the course text and every destination behind.
  const renderSerialized = JSON.stringify(render);
  for (const secret of ["Blood and circulation", "Read more", "Lab safety checklist", "Red blood cells", "/courses/42/pages/one", "/equation_images/y", "captions.vtt"]) {
    assert.equal(renderSerialized.includes(secret), false, secret);
  }
  process.stderr.write("[browser-test] sandboxed learner-render checks return one bounded signal record with no course text\n");

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const pageAltCategory = settings.getByRole("checkbox", { name: "Add Canvas Page image alternative text" });
  if (await pageAltCategory.isChecked()) await pageAltCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas Assignment image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const assignmentAltPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_assignment_image_alt",
    "saved Assignment image alternative-text Edit permission was not published",
  );
  assert.deepEqual(assignmentAltPermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment", toolName: "canvas_edit_assignment", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "assignment_image_alt" }]);
  const assignmentBefore = canvas.assignment();
  const assignmentImageSource = "/courses/42/files/10";
  const assignmentRawImage = `<img src="${assignmentImageSource}">`;
  const assignmentImageStart = assignmentBefore.description.indexOf(assignmentRawImage);
  assert.ok(assignmentImageStart >= 0);
  const assignmentAltGuard = {
    kind: "assignment_image_alt", course_id: "42", assignment_id: "88",
    body_sha256: createHash("sha256").update(assignmentBefore.description).digest("hex"),
    protected_state_sha256: protectedStateDigest(assignmentBefore, "description"),
    image_index: 1, image_start: assignmentImageStart, image_end: assignmentImageStart + assignmentRawImage.length - 1,
    image_tag_sha256: createHash("sha256").update(assignmentRawImage).digest("hex"),
    image_src_sha256: createHash("sha256").update(assignmentImageSource).digest("hex"),
    alt_text: "Cell transport diagram", decorative: false,
  };
  const assignmentAltArgs = {
    course_id: "42", id: "88",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: assignmentAltGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:assignment-image-alt-test", authorization: { kind: "edit_scope", policy_digest: assignmentAltPermission.scopeDigest, policy_revision: assignmentAltPermission.revision } },
    },
  };
  const assignmentAltWrite = await runtime.call("canvas_edit_assignment", assignmentAltArgs);
  assert.equal(assignmentAltWrite.ok, true, JSON.stringify(assignmentAltWrite));
  assert.equal(assignmentAltWrite.result.verification.status, "verified", JSON.stringify(assignmentAltWrite));
  assert.match(assignmentAltWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.deepEqual(canvas.assignment(), { ...assignmentBefore, description: assignmentBefore.description.replace(assignmentRawImage, '<img src="/courses/42/files/10" alt="Cell transport diagram">') });
  assert.equal(canvas.assignmentWrites(), 1);
  canvas.changeAssignment();
  const staleAssignment = await runtime.call("canvas_edit_assignment", {
    ...assignmentAltArgs,
    _morrow: { ...assignmentAltArgs._morrow, outer_grant: { ...grant, effect_receipt_id: "effect:assignment-image-alt-stale", authorization: { kind: "edit_scope", policy_digest: assignmentAltPermission.scopeDigest, policy_revision: assignmentAltPermission.revision } } },
  });
  assert.equal(staleAssignment.ok, false, JSON.stringify(staleAssignment));
  assert.match(JSON.stringify(staleAssignment), /canvas_content_changed/);
  assert.equal(canvas.assignmentWrites(), 1);

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const assignmentAltCategory = settings.getByRole("checkbox", { name: "Add Canvas Assignment image alternative text" });
  if (await assignmentAltCategory.isChecked()) await assignmentAltCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas Discussion image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const discussionAltPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_discussion_image_alt",
    "saved Discussion image alternative-text Edit permission was not published",
  );
  assert.deepEqual(discussionAltPermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/discussion_topics/{topic_id}#update_topic_courses", toolName: "canvas_update_topic_courses", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "discussion_image_alt" }]);
  const discussionBefore = canvas.discussion();
  const discussionImageSource = "/courses/42/files/11";
  const discussionRawImage = `<img src="${discussionImageSource}">`;
  const discussionImageStart = discussionBefore.message.indexOf(discussionRawImage);
  assert.ok(discussionImageStart >= 0);
  const discussionAltGuard = {
    kind: "discussion_image_alt", course_id: "42", topic_id: "89",
    body_sha256: createHash("sha256").update(discussionBefore.message).digest("hex"),
    protected_state_sha256: protectedStateDigest(discussionBefore, "message"),
    image_index: 1, image_start: discussionImageStart, image_end: discussionImageStart + discussionRawImage.length - 1,
    image_tag_sha256: createHash("sha256").update(discussionRawImage).digest("hex"),
    image_src_sha256: createHash("sha256").update(discussionImageSource).digest("hex"),
    alt_text: "Diffusion diagram", decorative: false,
  };
  const discussionAltArgs = {
    course_id: "42", topic_id: "89",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: discussionAltGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:discussion-image-alt-test", authorization: { kind: "edit_scope", policy_digest: discussionAltPermission.scopeDigest, policy_revision: discussionAltPermission.revision } },
    },
  };
  const discussionAltWrite = await runtime.call("canvas_update_topic_courses", discussionAltArgs);
  assert.equal(discussionAltWrite.ok, true, JSON.stringify(discussionAltWrite));
  assert.equal(discussionAltWrite.result.verification.status, "verified", JSON.stringify(discussionAltWrite));
  assert.match(discussionAltWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.deepEqual(canvas.discussion(), { ...discussionBefore, message: discussionBefore.message.replace(discussionRawImage, '<img src="/courses/42/files/11" alt="Diffusion diagram">') });
  assert.equal(canvas.discussionWrites(), 1);
  const replayDiscussion = await runtime.call("canvas_update_topic_courses", discussionAltArgs);
  assert.equal(replayDiscussion.ok, false, JSON.stringify(replayDiscussion));
  assert.equal(replayDiscussion.resultState, "unknown", JSON.stringify(replayDiscussion));
  assert.match(JSON.stringify(replayDiscussion), /bridge_outcome_unknown/);
  assert.equal(canvas.discussionWrites(), 1);
  const staleDiscussion = await runtime.call("canvas_update_topic_courses", {
    ...discussionAltArgs,
    _morrow: { ...discussionAltArgs._morrow, outer_grant: { ...grant, effect_receipt_id: "effect:discussion-image-alt-stale", authorization: { kind: "edit_scope", policy_digest: discussionAltPermission.scopeDigest, policy_revision: discussionAltPermission.revision } } },
  });
  assert.equal(staleDiscussion.ok, false, JSON.stringify(staleDiscussion));
  assert.match(JSON.stringify(staleDiscussion), /canvas_content_changed/);
  assert.equal(canvas.discussionWrites(), 1);

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const discussionAltCategory = settings.getByRole("checkbox", { name: "Add Canvas Discussion image alternative text" });
  if (await discussionAltCategory.isChecked()) await discussionAltCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas Classic Quiz description image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const classicQuizDescriptionPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_classic_quiz_description_image_alt",
    "saved Classic Quiz description image alternative-text Edit permission was not published",
  );
  assert.deepEqual(classicQuizDescriptionPermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz", toolName: "canvas_edit_quiz", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "classic_quiz_description_image_alt" }]);
  const classicQuizBefore = canvas.classicQuiz();
  const classicQuizImageSource = "/courses/42/files/16";
  const classicQuizRawImage = `<img src="${classicQuizImageSource}">`;
  const classicQuizImageStart = classicQuizBefore.description.indexOf(classicQuizRawImage);
  assert.ok(classicQuizImageStart >= 0);
  const classicQuizAltGuard = {
    kind: "classic_quiz_description_image_alt", course_id: "42", quiz_id: "77",
    body_sha256: createHash("sha256").update(classicQuizBefore.description).digest("hex"),
    protected_state_sha256: protectedStateDigest(classicQuizBefore, "description"),
    image_index: 1, image_start: classicQuizImageStart, image_end: classicQuizImageStart + classicQuizRawImage.length - 1,
    image_tag_sha256: createHash("sha256").update(classicQuizRawImage).digest("hex"),
    image_src_sha256: createHash("sha256").update(classicQuizImageSource).digest("hex"),
    alt_text: "Cell structure diagram", decorative: false,
  };
  const classicQuizAltArgs = {
    course_id: "42", id: "77",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: classicQuizAltGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:classic-quiz-description-image-alt-test", authorization: { kind: "edit_scope", policy_digest: classicQuizDescriptionPermission.scopeDigest, policy_revision: classicQuizDescriptionPermission.revision } },
    },
  };
  const classicQuizAltWrite = await runtime.call("canvas_edit_quiz", classicQuizAltArgs);
  assert.equal(classicQuizAltWrite.ok, true, JSON.stringify(classicQuizAltWrite));
  assert.equal(classicQuizAltWrite.result.verification.status, "verified", JSON.stringify(classicQuizAltWrite));
  assert.match(classicQuizAltWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.deepEqual(canvas.classicQuiz(), { ...classicQuizBefore, description: classicQuizBefore.description.replace(classicQuizRawImage, '<img src="/courses/42/files/16" alt="Cell structure diagram">') });
  assert.equal(canvas.classicQuizWrites(), 1);
  canvas.changeClassicQuizSettings();
  const staleClassicQuiz = await runtime.call("canvas_edit_quiz", {
    ...classicQuizAltArgs,
    _morrow: { ...classicQuizAltArgs._morrow, outer_grant: { ...grant, effect_receipt_id: "effect:classic-quiz-description-image-alt-stale", authorization: { kind: "edit_scope", policy_digest: classicQuizDescriptionPermission.scopeDigest, policy_revision: classicQuizDescriptionPermission.revision } } },
  });
  assert.equal(staleClassicQuiz.ok, false, JSON.stringify(staleClassicQuiz));
  assert.match(JSON.stringify(staleClassicQuiz), /canvas_content_changed/);
  assert.equal(canvas.classicQuizWrites(), 1);

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const classicQuizDescriptionAltCategory = settings.getByRole("checkbox", { name: "Add Canvas Classic Quiz description image alternative text" });
  if (await classicQuizDescriptionAltCategory.isChecked()) await classicQuizDescriptionAltCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas Classic Quiz question image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const classicQuestionPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_classic_quiz_question_image_alt",
    "saved Classic Quiz question image alternative-text Edit permission was not published",
  );
  assert.deepEqual(classicQuestionPermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question", toolName: "canvas_update_existing_quiz_question", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "classic_quiz_question_image_alt" }]);
  const classicQuestionGuard = (record, image, alt, { questionId = "301", answer } = {}) => {
    const body = answer ? record.answers.find((entry) => entry.id === answer.id)[answer.field] : record.question_text;
    const raw = `<img src="${image}">`;
    const start = body.indexOf(raw);
    assert.ok(start >= 0, `the fixture question has no missing-alt image at ${image}`);
    return {
      kind: "classic_quiz_question_image_alt", course_id: "42", quiz_id: "77", question_id: questionId,
      ...(answer ? { answer_id: answer.id, answer_field: answer.field } : {}),
      body_sha256: createHash("sha256").update(body).digest("hex"),
      protected_state_sha256: classicQuestionProtectedDigest(record, answer),
      image_index: 1, image_start: start, image_end: start + raw.length - 1,
      image_tag_sha256: createHash("sha256").update(raw).digest("hex"),
      image_src_sha256: createHash("sha256").update(image).digest("hex"),
      alt_text: alt, decorative: false,
    };
  };
  const classicQuestionArgs = (guard, receipt) => ({
    course_id: "42", quiz_id: "77", id: guard.question_id,
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: guard,
      outer_grant: { ...grant, effect_receipt_id: receipt, authorization: { kind: "edit_scope", policy_digest: classicQuestionPermission.scopeDigest, policy_revision: classicQuestionPermission.revision } },
    },
  });
  const classicQuestionBefore = canvas.classicQuizQuestion();
  const questionTextGuard = classicQuestionGuard(classicQuestionBefore, "/courses/42/files/17", "Labelled plant cell diagram");
  const questionTextWrite = await runtime.call("canvas_update_existing_quiz_question", classicQuestionArgs(questionTextGuard, "effect:classic-quiz-question-text-image-alt"));
  assert.equal(questionTextWrite.ok, true, JSON.stringify(questionTextWrite));
  assert.equal(questionTextWrite.result.verification.status, "verified", JSON.stringify(questionTextWrite));
  assert.match(questionTextWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  // The whole saved question, not a digest of it: every other field, every
  // answer, its weights and its comments are unchanged by the rebuild.
  assert.deepEqual(canvas.classicQuizQuestion(), {
    ...classicQuestionBefore,
    question_text: classicQuestionBefore.question_text.replace('<img src="/courses/42/files/17">', '<img src="/courses/42/files/17" alt="Labelled plant cell diagram">'),
  });
  assert.equal(canvas.classicQuizQuestionWrites(), 1);

  const answerBefore = canvas.classicQuizQuestion();
  const answerGuard = classicQuestionGuard(answerBefore, "/courses/42/files/18", "Cell nucleus diagram", { answer: { id: "6656", field: "answer_text" } });
  const answerWrite = await runtime.call("canvas_update_existing_quiz_question", classicQuestionArgs(answerGuard, "effect:classic-quiz-answer-image-alt"));
  assert.equal(answerWrite.ok, true, JSON.stringify(answerWrite));
  assert.equal(answerWrite.result.verification.status, "verified", JSON.stringify(answerWrite));
  assert.match(answerWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.deepEqual(canvas.classicQuizQuestion(), {
    ...answerBefore,
    answers: answerBefore.answers.map((answer) => answer.id === "6656"
      ? { ...answer, answer_text: answer.answer_text.replace('<img src="/courses/42/files/18">', '<img src="/courses/42/files/18" alt="Cell nucleus diagram">') }
      : answer),
  });
  assert.equal(canvas.classicQuizQuestionWrites(), 2);

  const groupedQuestionWrite = await runtime.call("canvas_update_existing_quiz_question", classicQuestionArgs(classicQuestionGuard(classicQuestionBefore, "/courses/42/files/17", "Labelled plant cell diagram", { questionId: "302" }), "effect:classic-quiz-question-group-linked"));
  assert.equal(groupedQuestionWrite.ok, false, JSON.stringify(groupedQuestionWrite));
  assert.match(JSON.stringify(groupedQuestionWrite), /classic_quiz_question_group_linked/);
  assert.equal(canvas.classicQuizQuestionWrites(), 2);

  const unsupportedQuestionWrite = await runtime.call("canvas_update_existing_quiz_question", classicQuestionArgs(classicQuestionGuard(classicQuestionBefore, "/courses/42/files/17", "Labelled plant cell diagram", { questionId: "303" }), "effect:classic-quiz-question-type-unsupported"));
  assert.equal(unsupportedQuestionWrite.ok, false, JSON.stringify(unsupportedQuestionWrite));
  assert.match(JSON.stringify(unsupportedQuestionWrite), /classic_quiz_question_type_unsupported/);
  assert.equal(canvas.classicQuizQuestionWrites(), 2);

  canvas.changeClassicQuizQuestionPoints();
  const staleQuestionWrite = await runtime.call("canvas_update_existing_quiz_question", classicQuestionArgs(answerGuard, "effect:classic-quiz-question-stale"));
  assert.equal(staleQuestionWrite.ok, false, JSON.stringify(staleQuestionWrite));
  assert.match(JSON.stringify(staleQuestionWrite), /canvas_content_changed/);
  assert.equal(canvas.classicQuizQuestionWrites(), 2);
  process.stderr.write("[browser-test] a Classic Quiz question image repair rebuilds the whole question, keeps every other field, and refuses a grouped, unsupported, or changed question\n");

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const classicQuizAltCategory = settings.getByRole("checkbox", { name: "Add Canvas Classic Quiz question image alternative text" });
  if (await classicQuizAltCategory.isChecked()) await classicQuizAltCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas New Quiz item image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const newQuizItemAltPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_new_quiz_item_image_alt",
    "saved New Quiz item image alternative-text Edit permission was not published",
  );
  assert.deepEqual(newQuizItemAltPermission.rules, [{ operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_item_image_alt" }]);
  const newQuizItemBefore = canvas.quizItem();
  assert.ok(newQuizItemBefore?.entry?.item_body);
  const newQuizImageSource = "/courses/42/files/12";
  const newQuizRawImage = `<img src="${newQuizImageSource}">`;
  canvas.setQuizItem({ ...newQuizItemBefore, entry: { ...newQuizItemBefore.entry, item_body: `${newQuizItemBefore.entry.item_body}${newQuizRawImage}` } });
  const newQuizItemWithImage = canvas.quizItem();
  const newQuizImageStart = newQuizItemWithImage.entry.item_body.indexOf(newQuizRawImage);
  assert.ok(newQuizImageStart >= 0);
  const newQuizItemAltGuard = {
    kind: "new_quiz_item_image_alt", course_id: "42", assignment_id: "77", item_id: "145",
    body_sha256: createHash("sha256").update(newQuizItemWithImage.entry.item_body).digest("hex"),
    protected_state_sha256: newQuizItemProtectedStateDigest(newQuizItemWithImage),
    image_index: 1, image_start: newQuizImageStart, image_end: newQuizImageStart + newQuizRawImage.length - 1,
    image_tag_sha256: createHash("sha256").update(newQuizRawImage).digest("hex"),
    image_src_sha256: createHash("sha256").update(newQuizImageSource).digest("hex"),
    alt_text: "Cell membrane diagram", decorative: false,
  };
  const newQuizItemAltArgs = {
    course_id: "42", assignment_id: "77", item_id: "145",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: newQuizItemAltGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:new-quiz-item-image-alt-test", authorization: { kind: "edit_scope", policy_digest: newQuizItemAltPermission.scopeDigest, policy_revision: newQuizItemAltPermission.revision } },
    },
  };
  const newQuizItemAltWrite = await runtime.call("canvas_update_quiz_item", newQuizItemAltArgs);
  assert.equal(newQuizItemAltWrite.ok, true, JSON.stringify(newQuizItemAltWrite));
  assert.equal(newQuizItemAltWrite.result.verification.status, "verified", JSON.stringify(newQuizItemAltWrite));
  assert.match(newQuizItemAltWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.deepEqual(canvas.quizItem(), { ...newQuizItemWithImage, entry: { ...newQuizItemWithImage.entry, item_body: newQuizItemWithImage.entry.item_body.replace(newQuizRawImage, '<img src="/courses/42/files/12" alt="Cell membrane diagram">') } });
  assert.equal(canvas.quizItemWrites(), 2);
  canvas.setQuizItem({ ...canvas.quizItem(), entry: { ...canvas.quizItem().entry, scoring_data: { value: "unexpected" } } });
  const staleNewQuizItem = await runtime.call("canvas_update_quiz_item", {
    ...newQuizItemAltArgs,
    _morrow: { ...newQuizItemAltArgs._morrow, outer_grant: { ...grant, effect_receipt_id: "effect:new-quiz-item-image-alt-stale", authorization: { kind: "edit_scope", policy_digest: newQuizItemAltPermission.scopeDigest, policy_revision: newQuizItemAltPermission.revision } } },
  });
  assert.equal(staleNewQuizItem.ok, false, JSON.stringify(staleNewQuizItem));
  assert.match(JSON.stringify(staleNewQuizItem), /canvas_content_changed/);
  assert.equal(canvas.quizItemWrites(), 2);

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const newQuizItemAltCategory = settings.getByRole("checkbox", { name: "Add Canvas New Quiz item image alternative text" });
  if (await newQuizItemAltCategory.isChecked()) await newQuizItemAltCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Add Canvas New Quiz choice and feedback image alternative text" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const newQuizNestedPermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_new_quiz_nested_image_alt",
    "saved New Quiz nested alternative-text Edit permission was not published",
  );
  await waitFor(() => runtime.bindings().find((entry) => entry.sourceBindingId === binding.sourceBindingId)?.editPermission?.scopeDigest === newQuizNestedPermission.scopeDigest,
    "saved New Quiz nested alternative-text Edit permission did not reach the connected binding");
  assert.deepEqual(newQuizNestedPermission.rules, [
    { operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_answer_feedback_image_alt" },
    { operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_choice_image_alt" },
    { operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: [], requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_feedback_image_alt" },
  ]);
  const nestedChoiceImage = '<p>Cell membrane</p><img src="/courses/42/files/13">';
  const nestedAnswerFeedbackImage = '<p>Review the membrane.</p><img src="/courses/42/files/14">';
  const nestedQuestionFeedbackImage = '<p>Correct response.</p><img src="/courses/42/files/15">';
  const nestedChoiceA = "11111111-1111-4111-8111-111111111111";
  const nestedChoiceB = "22222222-2222-4222-8222-222222222222";
  const nestedItem = {
    ...canvas.quizItem(),
    entry: {
      ...canvas.quizItem().entry,
      interaction_type_slug: "choice",
      interaction_data: {
        choices: [
          { id: nestedChoiceA, position: 1, item_body: nestedChoiceImage },
          { id: nestedChoiceB, position: 2, item_body: "<p>Nucleus</p>" },
        ],
      },
      scoring_algorithm: "Equivalence",
      scoring_data: { value: nestedChoiceA, weight: 1 },
      answer_feedback: { [nestedChoiceA]: "<p>Review the membrane.</p>" },
      feedback: { correct: "<p>Correct response.</p>", incorrect: "<p>Review the diagram.</p>", neutral: "<p>Consider each choice.</p>" },
    },
  };
  canvas.setQuizItem(nestedItem);
  const nestedChoiceGuard = {
    kind: "new_quiz_choice_image_alt", course_id: "42", assignment_id: "77", item_id: "145", choice_id: nestedChoiceA,
    body_sha256: createHash("sha256").update(nestedChoiceImage).digest("hex"),
    protected_state_sha256: newQuizItemProtectedStateDigest(nestedItem, (entry) => { delete entry.interaction_data.choices[0].item_body; }),
    image_index: 1, image_start: nestedChoiceImage.indexOf("<img"), image_end: nestedChoiceImage.length - 1,
    image_tag_sha256: createHash("sha256").update('<img src="/courses/42/files/13">').digest("hex"),
    image_src_sha256: createHash("sha256").update("/courses/42/files/13").digest("hex"),
    alt_text: "Cell membrane", decorative: false,
  };
  const nestedChoiceArgs = {
    course_id: "42", assignment_id: "77", item_id: "145",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: nestedChoiceGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:new-quiz-choice-image-alt-test", authorization: { kind: "edit_scope", policy_digest: newQuizNestedPermission.scopeDigest, policy_revision: newQuizNestedPermission.revision } },
    },
  };
  const nestedChoiceWrite = await runtime.call("canvas_update_quiz_item", nestedChoiceArgs);
  assert.equal(nestedChoiceWrite.ok, true, JSON.stringify(nestedChoiceWrite));
  assert.equal(nestedChoiceWrite.result.verification.status, "verified", JSON.stringify(nestedChoiceWrite));
  assert.match(nestedChoiceWrite.result.verification.evidence, /selected_image_alt_reaudited/);
  assert.equal(canvas.quizItem().entry.interaction_data.choices[0].item_body, '<p>Cell membrane</p><img src="/courses/42/files/13" alt="Cell membrane">');
  assert.deepEqual(canvas.quizItem().entry.interaction_data.choices[1], nestedItem.entry.interaction_data.choices[1]);
  assert.deepEqual(canvas.quizItem().entry.scoring_data, nestedItem.entry.scoring_data);
  assert.equal(canvas.quizItemWrites(), 3);

  canvas.setQuizItem({
    ...canvas.quizItem(),
    entry: {
      ...canvas.quizItem().entry,
      answer_feedback: { ...canvas.quizItem().entry.answer_feedback, [nestedChoiceA]: nestedAnswerFeedbackImage },
    },
  });
  const answerFeedbackBefore = canvas.quizItem();
  const nestedAnswerFeedbackGuard = {
    kind: "new_quiz_answer_feedback_image_alt", course_id: "42", assignment_id: "77", item_id: "145", choice_id: nestedChoiceA,
    body_sha256: createHash("sha256").update(nestedAnswerFeedbackImage).digest("hex"),
    protected_state_sha256: newQuizItemProtectedStateDigest(answerFeedbackBefore, (entry) => { delete entry.answer_feedback[nestedChoiceA]; }),
    image_index: 1, image_start: nestedAnswerFeedbackImage.indexOf("<img"), image_end: nestedAnswerFeedbackImage.length - 1,
    image_tag_sha256: createHash("sha256").update('<img src="/courses/42/files/14">').digest("hex"),
    image_src_sha256: createHash("sha256").update("/courses/42/files/14").digest("hex"),
    alt_text: "Cell membrane review", decorative: false,
  };
  const nestedAnswerFeedbackArgs = {
    course_id: "42", assignment_id: "77", item_id: "145",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: nestedAnswerFeedbackGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:new-quiz-answer-feedback-image-alt-test", authorization: { kind: "edit_scope", policy_digest: newQuizNestedPermission.scopeDigest, policy_revision: newQuizNestedPermission.revision } },
    },
  };
  const nestedAnswerFeedbackWrite = await runtime.call("canvas_update_quiz_item", nestedAnswerFeedbackArgs);
  assert.equal(nestedAnswerFeedbackWrite.ok, true, JSON.stringify(nestedAnswerFeedbackWrite));
  assert.equal(nestedAnswerFeedbackWrite.result.verification.status, "verified", JSON.stringify(nestedAnswerFeedbackWrite));
  assert.equal(canvas.quizItem().entry.answer_feedback[nestedChoiceA], '<p>Review the membrane.</p><img src="/courses/42/files/14" alt="Cell membrane review">');
  assert.deepEqual(canvas.quizItem().entry.scoring_data, nestedItem.entry.scoring_data);
  assert.equal(canvas.quizItemWrites(), 4);

  canvas.setQuizItem({
    ...canvas.quizItem(),
    entry: {
      ...canvas.quizItem().entry,
      feedback: { ...canvas.quizItem().entry.feedback, correct: nestedQuestionFeedbackImage },
    },
  });
  const questionFeedbackBefore = canvas.quizItem();
  const nestedQuestionFeedbackGuard = {
    kind: "new_quiz_feedback_image_alt", course_id: "42", assignment_id: "77", item_id: "145", feedback_type: "correct",
    body_sha256: createHash("sha256").update(nestedQuestionFeedbackImage).digest("hex"),
    protected_state_sha256: newQuizItemProtectedStateDigest(questionFeedbackBefore, (entry) => { delete entry.feedback.correct; }),
    image_index: 1, image_start: nestedQuestionFeedbackImage.indexOf("<img"), image_end: nestedQuestionFeedbackImage.length - 1,
    image_tag_sha256: createHash("sha256").update('<img src="/courses/42/files/15">').digest("hex"),
    image_src_sha256: createHash("sha256").update("/courses/42/files/15").digest("hex"),
    alt_text: "Correct response diagram", decorative: false,
  };
  const nestedQuestionFeedbackArgs = {
    course_id: "42", assignment_id: "77", item_id: "145",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      canvas_content_guard: nestedQuestionFeedbackGuard,
      outer_grant: { ...grant, effect_receipt_id: "effect:new-quiz-question-feedback-image-alt-test", authorization: { kind: "edit_scope", policy_digest: newQuizNestedPermission.scopeDigest, policy_revision: newQuizNestedPermission.revision } },
    },
  };
  const nestedQuestionFeedbackWrite = await runtime.call("canvas_update_quiz_item", nestedQuestionFeedbackArgs);
  assert.equal(nestedQuestionFeedbackWrite.ok, true, JSON.stringify(nestedQuestionFeedbackWrite));
  assert.equal(nestedQuestionFeedbackWrite.result.verification.status, "verified", JSON.stringify(nestedQuestionFeedbackWrite));
  assert.equal(canvas.quizItem().entry.feedback.correct, '<p>Correct response.</p><img src="/courses/42/files/15" alt="Correct response diagram">');
  assert.deepEqual(canvas.quizItem().entry.feedback.incorrect, nestedItem.entry.feedback.incorrect);
  assert.deepEqual(canvas.quizItem().entry.feedback.neutral, nestedItem.entry.feedback.neutral);
  assert.deepEqual(canvas.quizItem().entry.scoring_data, nestedItem.entry.scoring_data);
  assert.equal(canvas.quizItemWrites(), 5);

  canvas.setQuizItem({ ...canvas.quizItem(), entry: { ...canvas.quizItem().entry, scoring_data: { value: nestedChoiceB, weight: 1 } } });
  const staleNestedQuestionFeedback = await runtime.call("canvas_update_quiz_item", {
    ...nestedQuestionFeedbackArgs,
    _morrow: { ...nestedQuestionFeedbackArgs._morrow, outer_grant: { ...grant, effect_receipt_id: "effect:new-quiz-question-feedback-image-alt-stale", authorization: { kind: "edit_scope", policy_digest: newQuizNestedPermission.scopeDigest, policy_revision: newQuizNestedPermission.revision } } },
  });
  assert.equal(staleNestedQuestionFeedback.ok, false, JSON.stringify(staleNestedQuestionFeedback));
  assert.match(JSON.stringify(staleNestedQuestionFeedback), /canvas_content_changed/);
  assert.equal(canvas.quizItemWrites(), 5);

  await settings.getByRole("radio", { name: /^Edit/ }).check();
  const newQuizNestedCategory = settings.getByRole("checkbox", { name: "Add Canvas New Quiz choice and feedback image alternative text" });
  if (await newQuizNestedCategory.isChecked()) await newQuizNestedCategory.uncheck();
  await settings.getByRole("checkbox", { name: "Change Canvas Assignment due date" }).check();
  await settings.getByRole("button", { name: "Save Edit access" }).click();
  await settings.getByText(/Edit access saved for 1 course/).first().waitFor();
  const settingsDuePermission = await waitForPublishedEditPermission(
    (permission) => permission.enabledCategories?.join(",") === "canvas_assignment_due_date",
    "saved Assignment due-date Edit permission was not published",
  );
  assert.ok(settingsDuePermission.expiresAt > Date.now() + 59 * 60 * 1_000);
  const conversationalStartedAt = Date.now();
  const conversationalSet = await runtime.editPolicySet({
    mode: "edit",
    selections: [{
      sourceBindingId: binding.sourceBindingId,
      expectedPolicyRevision: settingsDuePermission.revision,
      enabledCategories: ["canvas_assignment_due_date"],
    }],
  });
  assert.equal(conversationalSet.ok, true, JSON.stringify(conversationalSet));
  const duePermission = await waitForPublishedEditPermission(
    (permission) => Number.isSafeInteger(permission.expiresAt),
    "temporary Assignment due-date Edit permission was not published",
  );
  assert.equal(duePermission.revision, settingsDuePermission.revision + 1);
  assert.ok(duePermission.expiresAt > conversationalStartedAt + 29 * 60 * 1_000);
  assert.ok(duePermission.expiresAt <= conversationalStartedAt + 30 * 60 * 1_000 + 1_000);
  assert.deepEqual(duePermission.rules, [{ operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment", toolName: "canvas_edit_assignment", allowedChangedFields: ["assignment_due_at"] }]);
  const dueAt = "2026-09-10T12:00:00-05:00";
  const dueWrite = await runtime.call("canvas_edit_assignment", {
    course_id: "42", id: "88", assignment_due_at: dueAt,
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: "operation:assignment-due-date-browser-test",
      outer_grant: { ...grant, effect_receipt_id: "effect:assignment-due-date-browser-test", authorization: { kind: "edit_scope", policy_digest: duePermission.scopeDigest, policy_revision: duePermission.revision } },
    },
  });
  assert.equal(dueWrite.ok, true, JSON.stringify(dueWrite));
  assert.equal(dueWrite.result.verification.status, "verified", JSON.stringify(dueWrite));
  // The extension keeps the read-only comparator with the write result, so an
  // unresolved change can be checked later without ever being sent again. It
  // carries the catalog route, its id arguments and the approved field value.
  assert.deepEqual(dueWrite.result.readDescriptor, {
    schema: "morrow.canvas-recovery-descriptor.v1",
    strategy: "updated-resource",
    writeMethod: "PUT",
    assertions: [{ inputName: "assignment_due_at", paths: [["assignment", "due_at"], ["due_at"]], expected: dueAt }],
    read: {
      readTool: "canvas_get_single_assignment",
      readOperationKey: "GET /v1/courses/{course_id}/assignments/{id}#get_single_assignment",
      arguments: { course_id: "42", id: "88" },
    },
  });
  assert.doesNotMatch(JSON.stringify(dueWrite.result.readDescriptor), /https?:\/\//);
  assert.equal(canvas.assignment().due_at, dueAt);
  assert.equal(canvas.assignment().description, '<p>Explain active transport.</p><img src="/courses/42/files/10" alt="Cell transport diagram"><p>Another edit.</p>');
  assert.equal(canvas.assignmentWrites(), 2);
  const refusedDueWrite = await runtime.call("canvas_edit_assignment", {
    course_id: "42", id: "88", assignment_due_at: dueAt, assignment_name: "Must stay unchanged",
    _morrow: {
      source_binding_id: binding.sourceBindingId,
      operation_id: "operation:assignment-due-date-refused-browser-test",
      outer_grant: { ...grant, effect_receipt_id: "effect:assignment-due-date-refused-browser-test", authorization: { kind: "edit_scope", policy_digest: duePermission.scopeDigest, policy_revision: duePermission.revision } },
    },
  });
  assert.equal(refusedDueWrite.ok, false);
  assert.match(JSON.stringify(refusedDueWrite), /(?:edit_policy_fields_refused|edit permission no longer authorizes)/);
  assert.equal(canvas.assignmentWrites(), 2);
  for (const [label, invalidDueAt] of [
    ["impossible calendar date", "2026-02-30T12:00:00-05:00"],
    ["missing offset", "2026-09-10T12:00:00"],
    ["whitespace", "   "],
  ]) {
    const invalidDueWrite = await runtime.call("canvas_edit_assignment", {
      course_id: "42", id: "88", assignment_due_at: invalidDueAt,
      _morrow: {
        source_binding_id: binding.sourceBindingId,
        operation_id: `operation:assignment-due-date-${label.replaceAll(" ", "-")}`,
        outer_grant: { ...grant, effect_receipt_id: `effect:assignment-due-date-${label.replaceAll(" ", "-")}`, authorization: { kind: "edit_scope", policy_digest: duePermission.scopeDigest, policy_revision: duePermission.revision } },
      },
    });
    assert.equal(invalidDueWrite.ok, false, JSON.stringify(invalidDueWrite));
    assert.match(JSON.stringify(invalidDueWrite), /assignment_due_date_invalid/);
    assert.equal(canvas.assignmentWrites(), 2);
  }
  // The course site tab is signed out while work is in flight. Chrome reports no tab change, so the
  // published connection still says it is current and the change reaches the extension. Every change
  // probes that tab again first, so this one is refused before anything is sent, the refusal names
  // the exact site to reopen, and the record settles as sent nothing rather than as uncertain.
  const sectionWritesBeforeLostSite = canvas.sectionWrites();
  canvas.setPrincipalId("8");
  const probesBeforeLostSiteWrite = await countAnchorProbes();
  const lostSiteWrite = await sectionCall("canvas_edit_section", { id: "302", course_section_name: "Must stay unchanged" }, "section-lost-course-site");
  assert.ok(await countAnchorProbes() - probesBeforeLostSiteWrite >= 1, "a change must probe the course site tab again rather than read what an earlier request kept");
  assert.equal(lostSiteWrite.ok, false, JSON.stringify(lostSiteWrite));
  assert.equal(lostSiteWrite.resultState, "not_sent", JSON.stringify(lostSiteWrite));
  assert.equal(lostSiteWrite.problem.code, "canvas_binding_required", JSON.stringify(lostSiteWrite));
  assert.equal(
    lostSiteWrite.problem.message,
    `Morrow sent nothing: the Canvas site tab for Introduction to Human Biology is not open and signed in. Open ${new URL(canvasUrl).origin} in Chrome, sign in, then select Connect Canvas in Morrow Bridge.`,
  );
  assert.equal(canvas.sectionWrites(), sectionWritesBeforeLostSite);
  assert.equal(canvas.section("302").name, "Section B evening");
  const lostSiteRead = await runtime.call("canvas_get_single_course_courses", { id: "42", _morrow: { source_binding_id: binding.sourceBindingId } });
  assert.equal(lostSiteRead.ok, false, JSON.stringify(lostSiteRead));
  assert.equal(lostSiteRead.problem.code, "canvas_binding_required", JSON.stringify(lostSiteRead));
  // A refusal is never kept. The same course site, signed in again with no tab change at all, is
  // proved again by the next read rather than held down by the answer before it.
  canvas.setPrincipalId("7");
  const restoredSiteRead = await runtime.call("canvas_get_single_course_courses", { id: "42", _morrow: { source_binding_id: binding.sourceBindingId } });
  assert.equal(restoredSiteRead.ok, true, JSON.stringify(restoredSiteRead));
  assert.equal(restoredSiteRead.result?.data?.id, "42");
  process.stderr.write("[browser-test] a course site tab lost mid-flight refuses the change before it is sent, names the exact site to reopen, and is proved again as soon as it returns\n");

  canvas.setPrincipalId("8");
  await canvasPage.goto(`${canvasUrl}?account=changed`, { waitUntil: "domcontentloaded" });
  await waitFor(() => runtime.bridge.listBindings().length === 3 && runtime.bridge.listBindings().every((entry) => entry.runtimeVerified === false), "anchor account change did not invalidate its selected courses");
  const staleAnchor = await runtime.call("canvas_get_new_quiz", { course_id: "42", assignment_id: "77", _morrow: { source_binding_id: binding.sourceBindingId } });
  assert.equal(staleAnchor.ok, false);
  assert.equal(staleAnchor.resultState, "not_sent");
  canvas.setPrincipalId("7");
  await canvasPage.goto(canvasUrl, { waitUntil: "domcontentloaded" });
  await waitFor(() => runtime.bridge.listBindings().length === 3 && runtime.bridge.listBindings().every((entry) => entry.runtimeVerified === true), "restored anchor did not reverify its selected courses");
  await canvasPage.close();
  await waitFor(() => runtime.bridge.listBindings().length === 3 && runtime.bridge.listBindings().every((entry) => entry.runtimeVerified === false), "closing the shared site anchor did not invalidate every selected course");

  // The closed course site tab reads as one state with one next action in both places a person
  // looks, and neither keeps the connected state it showed a moment earlier.
  await popup.bringToFront();
  await waitFor(async () => (await popup.locator("#canvas-value").innerText()) === "Canvas tab needed", "the popup did not name the closed Canvas tab");
  assert.equal(await popup.locator("#detail").innerText(), "This selected course is connected, but its Canvas tab is no longer open. Open the course in Chrome, sign in, then select Connect Canvas.");
  const reconnectControl = popup.getByRole("button", { name: "Connect Canvas", exact: true });
  assert.equal(await reconnectControl.isVisible(), true);
  assert.equal(await reconnectControl.isEnabled(), true);
  const lostSiteGuide = await context.newPage();
  await lostSiteGuide.goto(`chrome-extension://${EXTENSION_ID}/onboarding/onboarding.html`);
  await lostSiteGuide.getByText("Saved Canvas needs sign-in or reconnection", { exact: true }).waitFor();
  await lostSiteGuide.getByRole("heading", { name: "Reconnect Canvas", exact: true }).waitFor();
  await lostSiteGuide.close();
  process.stderr.write("[browser-test] a closed course site tab reads as one named state with one next action in the popup and the setup guide\n");

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

  process.stdout.write(`${JSON.stringify({ ok: true, pairingReadyMs, extensionId: EXTENSION_ID, sharedAnchor: true, selectedCourseIds: [binding.courseId, binding43.courseId, binding501.courseId], course501DiscoveredWithoutTab: true, wrongCourseRefused: true, queuedEditRevoked: true, anchorInvalidation: true, newQuiz: "New Quiz 77", newQuizItemWrites: canvas.quizItemWrites(), disconnectClearedPairing: true })}\n`);
} finally {
  await context?.close().catch(() => undefined);
  await new Promise((resolveClose) => canvas.server.close(resolveClose));
  await new Promise((resolveClose) => externalFileStore.server.close(resolveClose));
  await operationApproval.close();
  await runtime.close();
  rmSync(temporary, { recursive: true, force: true });
}
