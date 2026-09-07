#!/usr/bin/env node
/**
 * The live-proof harness for one Moodle write.
 *
 * It drives the shipped gateway, the shipped bridge protocol, the shipped page
 * executor and the shipped approval server for one catalog write, and writes a
 * receipt in the shape of the other output/live-moodle/*-receipt.json files.
 *
 * Two targets:
 *   --target=fixture   a local HTTPS Moodle fixture this file serves (the default)
 *   --target=site      an authorized disposable Moodle site, with --site and --chrome-profile
 *
 * The connector role is played by this harness: it opens the real bridge
 * WebSocket and answers each command by running connector/extension/src/
 * moodle-executor.js in a real Chrome page, the way the extension service
 * worker does. The packaged extension itself does not run here, and every
 * receipt records that.
 *
 *   node scripts/moodle-live-proof.mjs --operation=moodle_update_label \
 *     --arguments='{"module_id":11,"content":"<p>Reviewed fixture text</p>"}'
 *   node scripts/moodle-live-proof.mjs --write-checklist
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { executeMoodleInPage } from "../connector/extension/src/moodle-executor.js";
import { collectMoodleCourseParticipantRoster } from "../connector/extension/src/moodle-privacy.js";
import { bridgeWriteFailureCode } from "../connector/extension/src/canvas-write-outcome.js";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const CATALOG_PATH = "connector/extension/generated/moodle-browser-catalog.json";
const CHECKLIST_PATH = "docs/implementation/MOODLE-LIVE-PROOF-CHECKLIST.md";
const README_PATH = "README.md";
const PARITY_PATH = "docs/implementation/THREE-LMS-BRIDGE-PARITY.md";
const RUNTIME_REVISION = "1.0.0-rc.2";
const BRIDGE_PATH = "/morrow-bridge/v1";
const BRIDGE_PROTOCOL_VERSION = 1;
const EXTENSION_ID = "a".repeat(32);
const BRIDGE_TOKEN = "morrow-live-proof-bridge-token-".repeat(2);
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** The one write class this file can serve locally. Every other operation needs a real target. */
const FIXTURE_CLASS = Object.freeze({
  operationKeys: ["moodle.form.course.modedit.label.write.v1"],
  courseId: 2,
  courseName: "Morrow live-proof fixture course",
  sectionId: 7,
  sectionNumber: 4,
  sectionTitle: "Topic 1",
  moduleId: 11,
  moduleName: "Orientation text",
  content: "<p>Fixture text before the reviewed change.</p>",
  principalId: "3",
  courseContextId: 25,
  participants: [{ id: "5", name: "Fixture Learner" }],
  role: "fixture editing teacher",
});

/** The capabilities connector/extension/src/moodle-privacy.js requires before it reads a roster. */
const ROSTER_CAPABILITIES = [
  "moodle/site:accessallgroups",
  "moodle/course:enrolreview",
  "moodle/course:viewsuspendedusers",
  "moodle/user:viewdetails",
];

function usage() {
  return [
    "node scripts/moodle-live-proof.mjs --operation=<tool or key> --arguments='<json>' [--target=fixture|site]",
    "node scripts/moodle-live-proof.mjs --write-checklist",
    "",
    "  --operation      a Moodle catalog write, by tool name or operation key",
    "  --arguments      the write arguments as JSON, without course_id and expected_digest",
    "  --target         fixture (default) or site",
    "  --site           https origin of an authorized disposable Moodle site, with --target=site",
    "  --chrome-profile a Chrome profile directory already signed in to that site",
    "  --course-id      the exact course, required with --target=site",
    "  --role           the role of the signed-in account, recorded in the receipt",
    "  --output-dir     where the receipt is written (default output/live-moodle)",
    "  --fixture-fault  lost-response, to check that a saved change with no answer is never called verified",
  ].join("\n");
}

function parseArguments(argv) {
  const options = new Map();
  for (const entry of argv) {
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(entry);
    if (!match) throw new Error(`unsupported argument: ${entry}\n\n${usage()}`);
    options.set(match[1], match[2] ?? "");
  }
  const known = ["operation", "arguments", "target", "site", "chrome-profile", "course-id", "role", "output-dir", "fixture-fault", "write-checklist", "help"];
  const unknown = [...options.keys()].filter((name) => !known.includes(name));
  if (unknown.length) throw new Error(`unsupported option: ${unknown.join(", ")}\n\n${usage()}`);
  return options;
}

function loadCatalog() {
  const catalog = JSON.parse(read(CATALOG_PATH));
  assert.ok(Array.isArray(catalog.operations), `${CATALOG_PATH} has no operations`);
  return catalog;
}

/**
 * The catalog digest a bridge hello must carry. It mirrors bridgeCatalogDigest
 * in packages/canvas-connector-mcp/src/browser-catalog.ts and the extension's
 * own computation in connector/extension/src/service-worker.js. A hello with
 * any other value is refused by a socket close, not by an error.
 */
function bridgeCatalogDigest() {
  const canvas = JSON.parse(read("artifacts/canvas-api/canvas-api-catalog.json")).catalogDigest;
  assert.match(String(canvas), /^[0-9a-f]{64}$/, "the Canvas API catalog carries no digest");
  const canvasBrowser = sha256(readFileSync(join(root, "connector/extension/generated/canvas-browser-catalog.json")));
  const moodle = sha256(readFileSync(join(root, CATALOG_PATH)));
  return sha256(`${canvas}\n${canvasBrowser}\n${moodle}`);
}

/** A recorded route keeps its path and its shape. Session material never reaches a receipt. */
function redactRoute(route) {
  return route.replace(/([?&](?:sesskey|token|csrf|itemid|secret|password)=)[^&\s]+/gi, "$1[redacted]");
}

function safeError(error) {
  return String(error?.stack || error)
    .replace(/(?:https?|file):\/\/[^\s"'<>]+/g, "[url]")
    .replace(/\b(sesskey|itemid|draft(?:id|_id)|token|secret|password|authorization|cookie)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 4000);
}

async function availablePort() {
  const listener = createTcpServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

function requestBody(request) {
  return new Promise((done) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * The local HTTPS Moodle fixture: the native routes one Text and media area
 * write reads, posts to, and reads back. Every request is recorded, so the
 * receipt can state exactly how many POSTs the write sent.
 */
async function startFixtureSite(directory, fault) {
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate,
  ], { stdio: "ignore" });
  const requests = [];
  const posts = [];
  const refusedPosts = [];
  const state = { name: FIXTURE_CLASS.moduleName, content: FIXTURE_CLASS.content, visible: true };
  let editorItemId = 500;
  // Moodle saves the whole form. A POST that drops one of these would silently
  // reset that setting, so the fixture refuses it instead of saving.
  const protectedControls = () => ({
    update: String(FIXTURE_CLASS.moduleId), course: String(FIXTURE_CLASS.courseId), modulename: "label",
    section: String(FIXTURE_CLASS.sectionNumber), name: state.name, "introeditor[format]": "1",
    visible: state.visible ? "1" : "0", completion: "2", showdescription: "1",
    availability: "fixture-availability", tags: "fixture-tag", sesskey: "fixture-session",
    submitbutton2: "Save changes and return to course",
  });
  const labelForm = (itemId) => `<!doctype html><html><body><form method="post" action="/course/modedit.php?update=${FIXTURE_CLASS.moduleId}&amp;return=0">
    <input name="update" value="${FIXTURE_CLASS.moduleId}"><input name="course" value="${FIXTURE_CLASS.courseId}"><input name="modulename" value="label"><input name="section" value="${FIXTURE_CLASS.sectionNumber}">
    <input name="name" value="${state.name}"><textarea name="introeditor[text]">${state.content}</textarea><input name="introeditor[format]" value="1"><input name="introeditor[itemid]" value="${itemId}">
    <input name="visible" value="${state.visible ? 1 : 0}"><input name="completion" value="2"><input name="showdescription" value="1"><input name="availability" value="fixture-availability"><input name="tags" value="fixture-tag">
    <input type="hidden" name="sesskey" value="fixture-session">
    <input type="submit" name="submitbutton2" value="Save changes and return to course">
  </form></body></html>`;
  const courseState = () => JSON.stringify({
    course: { id: FIXTURE_CLASS.courseId },
    section: [{ id: FIXTURE_CLASS.sectionId, number: FIXTURE_CLASS.sectionNumber, title: FIXTURE_CLASS.sectionTitle, visible: true, hasrestrictions: false, component: "" }],
    cm: [{
      id: FIXTURE_CLASS.moduleId, module: "label", sectionid: FIXTURE_CLASS.sectionId, name: state.name,
      visible: state.visible, uservisible: true, accessvisible: state.visible, hascmrestrictions: false,
      stealth: false, allowstealth: true,
    }],
  });
  const participantsTable = () => `<div data-region="core_table/dynamic" data-table-component="core_user" data-table-handler="participants" data-table-uniqueid="user-index-participants-${FIXTURE_CLASS.courseId}" data-table-total-rows="${FIXTURE_CLASS.participants.length}">
    <table><tbody>${FIXTURE_CLASS.participants.map((person) => `<tr><td><input type="checkbox" class="usercheckbox" name="user${person.id}"></td><td>${person.name}</td></tr>`).join("")}</tbody></table>
  </div>`;
  const capabilityPage = () => `<!doctype html><html><body>
    <form method="post" action="/admin/roles/check.php?contextid=${FIXTURE_CLASS.courseContextId}">
      <select name="reportuser"><option value="${FIXTURE_CLASS.principalId}" selected>Fixture Teacher</option></select>
    </form>
    <table id="explaincaps"><tbody>${ROSTER_CAPABILITIES.map((capability) => `<tr class="rolecap yes"><td><span class="cap-name">${capability}</span></td></tr>`).join("")}</tbody></table>
  </body></html>`;
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, async (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    const config = (extra = {}) => JSON.stringify({ wwwroot: `https://${request.headers.host}`, sesskey: "fixture-session", userId: Number(FIXTURE_CLASS.principalId), ...extra });
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/course/view.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-course course-${FIXTURE_CLASS.courseId}"><h1>${FIXTURE_CLASS.courseName}</h1><script>var M = {}; M.cfg = ${config()};</script></body>`);
      return;
    }
    if (url.pathname === "/user/index.php") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body class="path-user course-${FIXTURE_CLASS.courseId}"><script>var M = {}; M.cfg = ${config({ courseId: FIXTURE_CLASS.courseId, courseContextId: FIXTURE_CLASS.courseContextId })};</script>${participantsTable()}</body>`);
      return;
    }
    if (url.pathname === "/admin/roles/check.php") {
      await requestBody(request);
      response.writeHead(200, { "content-type": "text/html" });
      response.end(capabilityPage());
      return;
    }
    if (url.pathname === "/lib/ajax/service.php") {
      const body = await requestBody(request);
      const method = url.searchParams.get("info") || JSON.parse(body || "[{}]")[0]?.methodname;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([method === "core_table_get_dynamic_table_content"
        ? { data: { html: participantsTable() } }
        : { data: courseState() }]));
      return;
    }
    if (url.pathname === "/repository/draftfiles_ajax.php") {
      await requestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ filecount: 0, filesize: 0, list: [], tree: { children: [] } }));
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "GET") {
      if (url.searchParams.get("update") !== String(FIXTURE_CLASS.moduleId)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(labelForm(++editorItemId));
      return;
    }
    if (url.pathname === "/course/modedit.php" && request.method === "POST") {
      const values = new URLSearchParams(await requestBody(request));
      posts.push(values);
      const dropped = Object.entries(protectedControls()).filter(([field, value]) => values.get(field) !== value).map(([field]) => field);
      if (dropped.length || !/^[1-9][0-9]*$/.test(values.get("introeditor[itemid]") || "")) {
        refusedPosts.push(dropped.length ? dropped : ["introeditor[itemid]"]);
        response.writeHead(400).end();
        return;
      }
      state.content = values.get("introeditor[text]") || "";
      // The saved change with no answer: the case a proof must never call verified.
      if (fault === "lost-response") {
        request.socket.destroy();
        return;
      }
      response.writeHead(303, { location: `/course/view.php?id=${FIXTURE_CLASS.courseId}` }).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((done, fail) => server.listen(0, "127.0.0.1", (error) => error ? fail(error) : done()));
  const origin = `https://127.0.0.1:${server.address().port}`;
  return {
    origin,
    courseId: String(FIXTURE_CLASS.courseId),
    role: FIXTURE_CLASS.role,
    protectedControls: Object.keys(protectedControls()),
    requests,
    posts,
    refusedPosts,
    close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
  };
}

/**
 * One bridge connection that answers each command by running the shipped page
 * executor in the open course page, the way
 * connector/extension/src/service-worker.js does at its executeMoodleInPage
 * call sites.
 */
async function connectHarnessConnector({ port, binding, page, expiresAt, commands, operations }) {
  const { WebSocket } = require(require.resolve("ws", { paths: [join(root, "packages/mcp-server")] }));
  const socket = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { origin: `chrome-extension://${EXTENSION_ID}` });
  const closed = { code: 0, reason: "" };
  socket.on("close", (code, reason) => {
    closed.code = code;
    closed.reason = reason.toString();
  });
  await new Promise((done, fail) => {
    const deadline = setTimeout(() => fail(new Error("the bridge connection did not open")), 10_000);
    socket.once("open", () => {
      clearTimeout(deadline);
      done();
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      fail(new Error(`the bridge refused the connection with code ${closed.code} ${closed.reason}`));
    });
  });
  const send = (message) => socket.send(JSON.stringify(message));
  const ready = await new Promise((done, fail) => {
    const deadline = setTimeout(() => fail(new Error("the bridge did not accept the handshake")), 10_000);
    socket.on("message", function accept(raw) {
      const value = JSON.parse(raw.toString());
      if (value?.schema !== "morrow.bridge.ready.v1") return;
      socket.off("message", accept);
      clearTimeout(deadline);
      done(value);
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      fail(new Error(`the bridge refused the handshake with code ${closed.code} ${closed.reason}`));
    });
    send({
      schema: "morrow.bridge.hello.v1",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      token: BRIDGE_TOKEN,
      extensionId: EXTENSION_ID,
      runtimeRevision: RUNTIME_REVISION,
      catalogDigest: binding.catalogDigest,
      bindings: [binding],
      sentAt: Date.now(),
    });
  });
  const answered = new Map();
  const result = (command, ok, value, problem) => {
    if (!ok) Object.assign(answered.get(command.requestId) || {}, { problem: problem.code, detail: problem.message });
    send({
      schema: "morrow.bridge.result.v1",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      operationId: command.operationId,
      generation: command.generation,
      ok,
      ...(ok ? { result: value } : { problem }),
      completedAt: Date.now(),
    });
  };
  socket.on("message", async (raw) => {
    const command = JSON.parse(raw.toString());
    if (command?.schema !== "morrow.bridge.command.v1") return;
    const record = { kind: command.kind, toolName: command.toolName, operationKey: command.operationKey, dispatchAttempt: command.outerGrant?.dispatchAttempt ?? null };
    answered.set(command.requestId, record);
    commands.push(record);
    if (command.kind === "bindings_get") {
      send({ schema: "morrow.bridge.bindings.v1", protocolVersion: BRIDGE_PROTOCOL_VERSION, generation: ready.generation, bindings: [binding], sentAt: Date.now() });
      return;
    }
    if (command.kind === "edit_policy_options_get") {
      result(command, true, {
        schema: "morrow.bridge.edit-options.v1",
        sourceBindingId: binding.sourceBindingId,
        provider: "moodle",
        catalogDigest: binding.catalogDigest,
        policyRevision: 0,
        runtimeVerified: true,
        options: [{ id: "content", group: "Moodle content", label: "Edit saved content", description: "Update saved content fields.", availability: "review", reviewReason: "This harness reviews every change." }],
      });
      return;
    }
    if (command.kind !== "invoke_read" && command.kind !== "invoke_write") {
      result(command, false, null, { schema: "morrow.bridge.problem.v1", code: "bridge_command_unsupported", message: "The live-proof harness answers reads and writes only.", recoverable: false });
      return;
    }
    if (command.toolName === "moodle_get_course_participant_roster") {
      const roster = await page.evaluate(collectMoodleCourseParticipantRoster, JSON.stringify({
        courseId: String(command.arguments?.course_id),
        binding: {
          sourceBindingId: binding.sourceBindingId, courseId: binding.courseId, origin: binding.origin,
          siteUrl: binding.siteUrl, principalId: binding.principalId,
          principalFingerprint: binding.principalFingerprint, sessionGeneration: binding.sessionGeneration,
          catalogDigest: binding.catalogDigest,
        },
        expiresAt: Math.min(expiresAt(), Date.now() + 59_000),
      }));
      if (roster?.schema !== "morrow.moodle-course-roster.v1" || roster.catalogDigest !== binding.catalogDigest) {
        result(command, false, null, { schema: "morrow.bridge.problem.v1", code: "browser_command_failed", message: String(roster?.error || "the roster read was refused"), recoverable: true });
        return;
      }
      result(command, true, {
        schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, provider: "moodle",
        data: roster, truncated: !roster.complete, snapshot_digest: sha256(JSON.stringify(roster)),
      });
      return;
    }
    const operation = operations.find((entry) => entry.key === command.operationKey && entry.toolName === command.toolName);
    if (!operation) {
      result(command, false, null, { schema: "morrow.bridge.problem.v1", code: "operation_not_in_catalog", message: `${command.toolName} is not in the Moodle catalog`, recoverable: false });
      return;
    }
    let executed;
    try {
      executed = await page.evaluate(executeMoodleInPage, JSON.stringify({
        mode: "execute",
        operation,
        arguments: command.arguments || {},
        binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId },
        expiresAt: expiresAt(),
      }));
    } catch (error) {
      result(command, false, null, { schema: "morrow.bridge.problem.v1", code: "browser_execution_interrupted", message: safeError(error).slice(0, 300), recoverable: false });
      return;
    }
    if (!executed?.ok) {
      // The uncertain-outcome rule of connector/extension/src/service-worker.js:
      // a write that was sent without a verified readback is never retryable.
      const unknown = executed?.outcomeUnknown === true || (executed?.sent === true && command.kind === "invoke_write" && (
        !Number.isInteger(executed.status)
        || (executed.verification?.status !== "verified" && executed.error !== "moodle_form_validation_failed")
      ));
      result(command, false, null, {
        schema: "morrow.bridge.problem.v1",
        code: bridgeWriteFailureCode({ unknown, sent: executed?.sent, provider: "moodle", kind: command.kind, status: executed?.status }),
        message: String(executed?.error || "the page executor refused this command"),
        recoverable: !unknown,
      });
      return;
    }
    const verification = command.kind === "invoke_write"
      ? executed.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_verification_missing" }
      : null;
    result(command, true, { schema: "morrow.canvas-browser-result.v1", ...executed, provider: "moodle", ...(verification ? { verification } : {}) });
  });
  return {
    generation: ready.generation,
    close: () => new Promise((done) => {
      if (socket.readyState !== 1) return done();
      socket.once("close", () => done());
      socket.close();
    }),
  };
}

function unwrap(reply, runtime) {
  let value = reply?.structuredContent;
  if (value?.data?.schema === "morrow.result-artifact.v1") {
    let text = "";
    let offset = 0;
    do {
      const page = runtime.gateway.resultPage(value.data.handle, offset);
      text += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    value = JSON.parse(text).structuredContent;
  } else if (value?.data) value = value.data.structuredContent || value.data;
  return value;
}

async function waitFor(probe, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** The approval a person gives in the review page: read the page, then post its own nonce back. */
async function approveThroughReviewPage(url) {
  const page = await fetch(url);
  const html = await page.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(page.status === 200 && nonce && cookie, `the review page did not offer an approval (HTTP ${page.status})`);
  const confirmed = await fetch(`${url}/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: new URL(url).origin, referer: url },
    body: new URLSearchParams({ nonce }),
  });
  return { reviewStatus: page.status, approveStatus: confirmed.status, html };
}

function capabilitiesIn(description) {
  return [...new Set([...String(description || "").matchAll(/\b([a-z]+\/[a-z]+:[a-zA-Z]+)/g)].map((match) => match[1]))];
}

function writeClass(operationKey) {
  if (operationKey.startsWith("moodle.form.")) return "native form";
  if (operationKey.startsWith("moodle.ajax.")) return "same-site AJAX";
  return "unclassified";
}

async function runProof(options) {
  const catalog = loadCatalog();
  const name = options.get("operation");
  assert.ok(name, `--operation is required\n\n${usage()}`);
  const operation = catalog.operations.find((entry) => entry.toolName === name || entry.key === name);
  assert.ok(operation, `${name} is not in ${CATALOG_PATH}`);
  assert.equal(operation.readOnly, false, `${operation.toolName} is a read. This harness proves writes.`);
  assert.ok(operation.reviewTool, `${operation.toolName} has no reviewTool in the catalog`);
  const reviewOperation = catalog.operations.find((entry) => entry.toolName === operation.reviewTool);
  assert.ok(reviewOperation, `${operation.reviewTool} is not in ${CATALOG_PATH}`);

  const target = options.get("target") || "fixture";
  assert.ok(["fixture", "site"].includes(target), "--target must be fixture or site");
  if (target === "fixture") {
    assert.ok(
      FIXTURE_CLASS.operationKeys.includes(operation.key),
      `the local fixture serves ${FIXTURE_CLASS.operationKeys.join(", ")} only. ${operation.key} needs --target=site with an authorized disposable Moodle site.`,
    );
  }
  const site = options.get("site") || "";
  const chromeProfile = options.get("chrome-profile") || "";
  if (target === "site") {
    assert.match(site, /^https:\/\/[^/]+(?:\/[^\s]*)?$/, "--target=site needs --site=<https origin> of an authorized disposable Moodle site");
    assert.ok(chromeProfile && existsSync(chromeProfile), "--target=site needs --chrome-profile=<directory> already signed in to that site");
    assert.match(options.get("course-id") || "", /^[1-9][0-9]*$/, "--target=site needs --course-id=<id>");
  }

  const fault = options.get("fixture-fault") || "";
  assert.ok(["", "lost-response"].includes(fault), "--fixture-fault accepts lost-response only");
  assert.ok(!fault || target === "fixture", "--fixture-fault belongs to the local fixture");
  const requested = JSON.parse(options.get("arguments") || "{}");
  assert.ok(requested && typeof requested === "object" && !Array.isArray(requested), "--arguments must be a JSON object");
  const outputDirectory = resolve(options.get("output-dir") || join(root, "output/live-moodle"));
  mkdirSync(outputDirectory, { recursive: true });
  const capturedAt = new Date().toISOString();
  const receiptPath = join(outputDirectory, `moodle-live-proof-${operation.toolName}-${capturedAt.replace(/[.:]/g, "-")}-receipt.json`);
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-live-proof-"));
  const commands = [];
  const receipt = {
    schema: "morrow.moodle-live-proof.v1",
    capturedAt,
    evidenceClass: target === "fixture" ? "local_fixture" : "signed_in_site",
    ...(fault ? { fixtureFault: fault } : {}),
    scope: target === "fixture"
      ? "One reviewed Moodle write against a local HTTPS Moodle fixture served by this harness. No Moodle site took part. This is harness evidence, not tenant evidence."
      : "One reviewed Moodle write against the named disposable Moodle site, in one course, with one signed-in account. It proves that operation on that site only.",
    operation: {
      key: operation.key,
      toolName: operation.toolName,
      writeClass: writeClass(operation.key),
      reviewTool: operation.reviewTool,
      summary: operation.summary,
      documentation: operation.documentation,
    },
    connector: {
      mode: "harness_bridge_client",
      pageExecutor: "connector/extension/src/moodle-executor.js",
      note: "The shipped page executor ran in a Chrome page over the shipped bridge protocol. The packaged extension service worker did not run.",
    },
    sourceHashes: Object.fromEntries([
      CATALOG_PATH,
      "connector/extension/src/moodle-executor.js",
      "packages/mcp-server/dist/morrow-runtime.js",
      "packages/mcp-server/dist/full-server.js",
      "packages/canvas-connector-mcp/dist/index.js",
    ].map((path) => [path, sha256(readFileSync(join(root, path)))])),
    stage: "started",
  };
  const save = (stage) => {
    receipt.stage = stage;
    receipt.bridgeCommands = commands;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  };
  save("started");

  let fixture;
  let browser;
  let context;
  let runtime;
  let server;
  let client;
  let connector;
  try {
    for (const path of ["packages/mcp-server/dist/morrow-runtime.js", "packages/canvas-connector-mcp/dist/index.js"]) {
      assert.ok(existsSync(join(root, path)), `${path} is missing. Build the workspace first: pnpm -r --if-present build`);
    }
    fixture = target === "fixture" ? await startFixtureSite(directory, fault) : null;
    const siteBase = fixture ? fixture.origin : site.replace(/\/+$/, "");
    const courseId = fixture ? fixture.courseId : options.get("course-id");
    const port = await availablePort();
    const catalogDigest = bridgeCatalogDigest();

    browser = target === "fixture"
      ? await chromium.launch({ headless: true, executablePath: chromium.executablePath() })
      : null;
    context = browser
      ? await browser.newContext({ ignoreHTTPSErrors: true })
      : await chromium.launchPersistentContext(chromeProfile, { headless: false, executablePath: chromium.executablePath() });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${siteBase}/course/view.php?id=${courseId}`);
    // The open page is the authority on the site, the principal and the course.
    const probe = await page.evaluate(executeMoodleInPage, JSON.stringify({ mode: "probe" }));
    assert.equal(probe?.ok, true, `the open page is not a signed-in Moodle course page: ${JSON.stringify(probe)}`);
    const { origin, siteUrl, principalId, courseName } = probe.profile;
    assert.equal(origin, new URL(siteBase).origin, "the open page belongs to a different Moodle site");
    assert.ok(siteUrl === siteBase || siteUrl === `${siteBase}/`, `the open page belongs to Moodle installation ${siteUrl}`);
    assert.equal(String(probe.profile.courseId || ""), String(courseId), "the open page is not the exact course");
    assert.ok(courseName, "the open course page does not name its course");

    const { MorrowRuntime } = await import(pathToFileURL(join(root, "packages/mcp-server/dist/morrow-runtime.js")).href);
    const { parseGatewayConfig } = await import(pathToFileURL(join(root, "packages/mcp-server/dist/config.js")).href);
    const { createFullMorrowServer } = await import(pathToFileURL(join(root, "packages/mcp-server/dist/full-server.js")).href);
    const clientEntry = require.resolve("@modelcontextprotocol/client", { paths: [join(root, "packages/mcp-server")] });
    const { Client, InMemoryTransport } = await import(pathToFileURL(clientEntry).href);
    const config = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      toolSurface: "compact",
      upstreams: [{
        id: "browser-session",
        label: "Morrow Course Connector",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [join(root, "packages/canvas-connector-mcp/dist/index.js")],
        cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: join(root, "artifacts/canvas-api/canvas-api-catalog.json"),
          MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(port),
          MORROW_CANVAS_CONNECTOR_TOKEN: BRIDGE_TOKEN,
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
        },
        sourceDisposition: "adapted_owned",
        outputPrivacyDefault: {
          fieldPolicy: "scrub-sensitive", dataClass: "course", maxRecords: 1000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true,
        },
      }],
      operationJournal: { path: join(directory, "journal.sqlite3") },
      privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
      maxCatalogTools: 2000,
    });
    runtime = await MorrowRuntime.connect(config, { statePath: join(directory, "journal.sqlite3") });
    server = createFullMorrowServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "morrow-moodle-live-proof", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const sourceBindingId = `moodle:live-proof:${courseId}`;
    connector = await connectHarnessConnector({
      port,
      page,
      commands,
      operations: catalog.operations,
      expiresAt: () => Date.now() + 59_000,
      binding: {
        sourceBindingId, provider: "moodle", origin, siteUrl, courseId: String(courseId), courseName,
        principalId, principalFingerprint: sha256(`${siteUrl}\n${principalId}`), sessionGeneration: 1,
        catalogDigest, editPolicyRevision: 0, editOptionsAvailable: true, runtimeVerified: true,
      },
    });
    await waitFor(async () => {
      const value = unwrap(await runtime.gateway.call("morrow_browser_bindings", {}), runtime);
      return value?.bindings?.find((entry) => entry.sourceBindingId === sourceBindingId) || null;
    }, "the course binding to reach the gateway");
    receipt.target = {
      origin, siteUrl, courseId: String(courseId), courseName, principalId,
      sourceBindingId, requestedArguments: requested,
    };
    receipt.roleAndCapability = {
      role: options.get("role") || (fixture ? fixture.role : "unstated"),
      capabilitiesStatedInCatalog: capabilitiesIn(operation.description),
      reviewToolCapabilitiesStatedInCatalog: capabilitiesIn(reviewOperation.description),
      note: "Morrow never infers authority from a role label. The capability is the one Moodle enforces at this exact context.",
    };
    save("bound");

    const withBinding = (value) => ({ ...value, course_id: Number(courseId), _morrow: { source_binding_id: sourceBindingId } });
    const readTarget = Object.fromEntries(Object.entries(requested).filter(([field]) => Object.hasOwn(reviewOperation.inputSchema.properties || {}, field)));
    const before = unwrap(await client.callTool({ name: "morrow_capability_read", arguments: { name: operation.reviewTool, arguments: withBinding(readTarget) } }), runtime);
    assert.equal(before?.ok, true, `the review read failed: ${JSON.stringify(before)}`);
    assert.match(String(before.result?.snapshot_digest || ""), /^[a-f0-9]{64}$/, "the review read returned no snapshot digest");
    receipt.exactTargetBeforeChange = {
      targets: before.result.targets,
      data: before.result.data,
      snapshotDigest: before.result.snapshot_digest,
    };
    save("target_read");

    const planned = await client.callTool({
      name: "morrow_capability_change",
      arguments: { name: operation.toolName, arguments: withBinding({ ...requested, expected_digest: before.result.snapshot_digest }) },
    });
    const plan = planned.structuredContent;
    assert.equal(plan?.effectState, "awaiting_approval", `the change did not wait for approval: ${JSON.stringify(plan)}`);
    const operationId = plan.operationId;
    const approvalUrl = plan.receipts?.approvalUrl;
    assert.ok(approvalUrl, "the change returned no approval address");
    const frozen = runtime.gateway.operationGet(operationId);
    const notDispatched = await runtime.gateway.dispatchOperation(operationId);
    receipt.requestReview = {
      operationId,
      effectState: plan.effectState,
      approvalPath: new URL(approvalUrl).pathname,
      frozenArguments: frozen.plan?.arguments,
      authorization: frozen.plan?.authorization,
      dispatchBeforeApprovalRefused: notDispatched.isError === true,
    };
    save("awaiting_approval");
    assert.equal(notDispatched.isError, true, "an unapproved change was dispatched");

    const approved = await approveThroughReviewPage(approvalUrl);
    assert.equal(approved.approveStatus, 200, `the approval was refused (HTTP ${approved.approveStatus})`);
    receipt.requestReview.reviewPageStatus = approved.reviewStatus;
    receipt.requestReview.reviewPageNamesCourse = approved.html.includes(courseName);
    const settled = await waitFor(() => {
      const current = runtime.gateway.operationGet(operationId);
      return ["planned", "awaiting_approval", "approved", "dispatching", "running"].includes(current.state) ? null : current;
    }, "the approved change to settle");
    const replay = await runtime.gateway.dispatchOperation(operationId);
    receipt.dispatch = {
      state: settled.state,
      dispatchAttempt: settled.dispatchAttempt,
      bridgeWriteCommands: commands.filter((entry) => entry.kind === "invoke_write" && entry.toolName === operation.toolName).length,
      ...(fixture ? { providerPosts: fixture.posts.length } : {}),
    };
    receipt.replay = {
      refused: replay.isError === true,
      message: Array.isArray(replay.content) ? replay.content.map((item) => item?.text).filter(Boolean).join(" ") : "",
      dispatchAttemptAfterReplay: runtime.gateway.operationGet(operationId).dispatchAttempt,
    };
    save("dispatched");

    const after = unwrap(await client.callTool({ name: "morrow_capability_read", arguments: { name: operation.reviewTool, arguments: withBinding(readTarget) } }), runtime);
    assert.equal(after?.ok, true, `the saved-state read failed: ${JSON.stringify(after)}`);
    receipt.authoritativeSavedResult = {
      source: "fresh_read_after_the_change",
      targets: after.result.targets,
      data: after.result.data,
      snapshotDigest: after.result.snapshot_digest,
      changedFields: Object.keys(after.result.data || {}).filter((field) => JSON.stringify(after.result.data[field]) !== JSON.stringify(before.result.data?.[field])),
    };
    receipt.operationJournal = {
      totalOperations: (await runtime.gateway.health()).operationJournal?.totalOperations ?? null,
      writeEffects: runtime.gateway.operationList(10).operations.map(({ publicToolName, state, dispatchAttempt }) => ({ publicToolName, state, dispatchAttempt })),
    };
    if (fixture) {
      receipt.fixture = {
        servedOperationKeys: FIXTURE_CLASS.operationKeys,
        protectedControlsRequiredByEveryPost: fixture.protectedControls,
        postsRefusedForADroppedControl: fixture.refusedPosts.length,
      };
      receipt.providerRequestLog = fixture.requests.map(redactRoute);
    }
    save("saved_result_read");

    assert.equal(settled.state, "verified", `the change did not reach one verified dispatch: ${settled.state}`);
    assert.equal(settled.dispatchAttempt, 1, `the change dispatched ${settled.dispatchAttempt} times`);
    assert.equal(receipt.replay.refused, true, "the replay was not refused");
    assert.equal(receipt.dispatch.bridgeWriteCommands, 1, "the bridge carried more than one write command");
    if (fixture) assert.equal(fixture.posts.length, 1, `the fixture recorded ${fixture.posts.length} POSTs`);
    assert.ok(receipt.authoritativeSavedResult.changedFields.length > 0, "the saved state did not change");
    assert.notEqual(after.result.snapshot_digest, before.result.snapshot_digest, "the saved snapshot digest did not change");
    receipt.status = "passed";
    receipt.completedAt = new Date().toISOString();
    save("completed");
    process.stdout.write(`${receiptPath}\n`);
  } catch (error) {
    receipt.status = "failed";
    receipt.error = safeError(error);
    save("failed");
    process.exitCode = 1;
    process.stderr.write(`${receipt.error}\n${receiptPath}\n`);
  } finally {
    await connector?.close();
    await client?.close();
    await server?.close();
    await runtime?.close();
    await context?.close();
    await browser?.close();
    await fixture?.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return receiptPath;
}

/**
 * The evidence state of one write, from the two tracked sources that decide it:
 * the README evidence groups and the dated receipts named in the parity record.
 */
function evidenceState(toolName) {
  const readme = read(README_PATH);
  const start = readme.indexOf("### Checked on a signed-in Moodle test course");
  const end = readme.indexOf("### Implemented and locally tested only");
  assert.ok(start !== -1 && end > start, `${README_PATH} no longer carries the two Moodle evidence groups`);
  const signedIn = readme.slice(start, end).includes(`\`${toolName}\``);
  if (!signedIn) return "fixture-only";
  const paragraph = read(PARITY_PATH).split(/\n\s*\n/).find((entry) => entry.includes(`\`${toolName}\``) && entry.includes("output/live-moodle/"));
  const receiptPath = paragraph ? /`(output\/live-moodle\/[^`]+\.json)`/.exec(paragraph)?.[1] : null;
  return receiptPath ? `signed-in checked, \`${receiptPath}\`` : `signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md)`;
}

function buildChecklist() {
  const catalog = loadCatalog();
  const writes = catalog.operations.filter((entry) => entry.readOnly !== true);
  const classes = [
    ["native form", "Moodle's own `mod_form` or `edit.php` POST. The proof must show the reloaded form immediately before the POST, exactly one POST, and the fresh native settings read after it."],
    ["same-site AJAX", "Moodle's own `/lib/ajax/service.php` method. The proof must show the exact method name, exactly one call, and the fresh state read after it."],
    ["unclassified", "An operation key that is neither `moodle.form.` nor `moodle.ajax.`. Classify it before proving it."],
  ];
  const used = new Set(writes.map((entry) => writeClass(entry.key)));
  const lines = [
    "# Moodle live-proof checklist",
    "",
    "Every Moodle write in the shipped catalog, the proof fields its receipt must carry, and the evidence that exists for it today.",
    "",
    `This file is generated. Run \`node scripts/moodle-live-proof.mjs --write-checklist\` after any change to \`${CATALOG_PATH}\`, to the Moodle capability surface in \`${README_PATH}\`, or to the receipts named in \`${PARITY_PATH}\`. \`scripts/test/moodle-live-proof.test.mjs\` fails when it drifts.`,
    "",
    "## The harness",
    "",
    "`scripts/moodle-live-proof.mjs` runs one write end to end and writes the receipt:",
    "",
    "```",
    "node scripts/moodle-live-proof.mjs --operation=moodle_update_label \\",
    '  --arguments=\'{"module_id":11,"content":"<p>Reviewed fixture text</p>"}\'',
    "```",
    "",
    "It drives the shipped gateway, the shipped bridge protocol, the shipped page executor and the shipped approval server. It plays the connector role itself, so the packaged extension service worker does not run, and every receipt records that.",
    "",
    "`--target=fixture` is the default and serves a local HTTPS Moodle fixture for the one write class named below. Nothing reaches a Moodle site. `--target=site --site=<https origin> --chrome-profile=<directory> --course-id=<id>` runs the same path against an authorized disposable Moodle site, which this machine does not have.",
    "",
    "`--fixture-fault=lost-response` makes the fixture save the change and answer nothing. The proof then ends `failed` with `applied_or_unknown`, one dispatch, and a refused replay. A saved change with no answer is never a passed proof.",
    "",
    "## Required proof fields",
    "",
    "A receipt is complete when it carries all of these. The harness writes each one:",
    "",
    "| Receipt field | What it proves |",
    "| --- | --- |",
    "| `target` | The exact site, installation subpath, signed-in principal and course the write bound to. |",
    "| `exactTargetBeforeChange` | The fresh read of the exact target, with the snapshot digest the change was bound to. |",
    "| `requestReview` | The frozen request a person approved, its authorization, and the refusal of a dispatch before approval. |",
    "| `dispatch` | One dispatch: `dispatchAttempt: 1`, one bridge write command, and one provider POST or AJAX call. |",
    "| `authoritativeSavedResult` | The fresh read after the change, from Moodle's own saved state, and the fields that changed. |",
    "| `replay` | The refusal of the repeated dispatch, and the unchanged dispatch count after it. |",
    "| `roleAndCapability` | The role of the account that ran it and the Moodle capability the catalog states for the operation. |",
    "| `evidenceClass` | `local_fixture` or `signed_in_site`. A fixture receipt is never tenant evidence. |",
    "",
    "## Write classes",
    "",
  ];
  for (const [id, description] of classes) {
    if (!used.has(id)) continue;
    lines.push(`- **${id}** (${writes.filter((entry) => writeClass(entry.key) === id).length} operations). ${description}`);
  }
  const fileBearing = writes.filter((entry) => JSON.stringify(entry.inputSchema || {}).includes('"sha256"')).map((entry) => entry.toolName).sort();
  lines.push(
    "",
    "The local fixture in the harness serves one write class today: `moodle.form.course.modedit.label.write.v1`, the Text and media area content edit. Every other write needs an authorized disposable Moodle site.",
    "",
    `A write that carries reviewed local file bytes is planned through its own \`morrow_plan_moodle_*\` tool, not through \`morrow_capability_change\`. The harness has no local file staging step, so it cannot yet run these ${fileBearing.length} writes on any target: ${fileBearing.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    "## Every catalog write",
    "",
    `${writes.length} writes, from \`${CATALOG_PATH}\`.`,
    "",
    "| Tool | Class | Review read | Capability stated in the catalog | Current evidence |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of [...writes].sort((left, right) => left.toolName.localeCompare(right.toolName))) {
    const capabilities = capabilitiesIn(entry.description);
    lines.push([
      "",
      `\`${entry.toolName}\``,
      writeClass(entry.key),
      `\`${entry.reviewTool}\``,
      capabilities.length ? capabilities.map((value) => `\`${value}\``).join(", ") : "not stated; record the capability observed at proof time",
      evidenceState(entry.toolName),
      "",
    ].join(" | ").replace(/^ \| /, "| ").replace(/ \| $/, " |"));
  }
  lines.push(
    "",
    "## What a fixture receipt does not establish",
    "",
    "- Any signed-in Moodle behaviour. A fixture receipt proves the harness, the gateway, the approval path and the page executor against markup this repository serves.",
    "- Any role other than the one the receipt names.",
    "- Learner-visible outcomes: completion, restrictions, launches, and visibility to students.",
    "- The packaged extension. The harness plays the connector role itself.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.has("help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.has("write-checklist")) {
    writeFileSync(join(root, CHECKLIST_PATH), buildChecklist());
    process.stdout.write(`${CHECKLIST_PATH}\n`);
    return;
  }
  await runProof(options);
}

export { buildChecklist, capabilitiesIn, writeClass };

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
