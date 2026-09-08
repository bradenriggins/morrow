#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { parseGatewayConfig } from "../../packages/mcp-server/dist/config.js";
import { GatewayRuntime } from "../../packages/mcp-server/dist/runtime.js";

const ROOT = resolve(import.meta.dirname, "../..");
const EXTENSION = join(ROOT, "connector/extension");
const EXPECTED_EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const FILE_STORAGE_KEY = "courseFileStorageAccessEnabled";
const FILE_PERMISSION = Object.freeze(["https://*/*"]);
const FILE_TEXT = "\uFEFFStudent Jane Doe may review Cell membrane.";
const LEARNER_NAME = "Jane Doe";
const LEARNER_EMAIL = "jane.doe@example.test";
const CRITICAL_EXTENSION_FILES = Object.freeze({
  manifest: "manifest.json",
  serviceWorker: "src/service-worker.js",
  popup: "popup/popup.js",
  settings: "settings/settings.js",
  canvasFileContent: "src/canvas-file-content.js",
  courseConnectionIntent: "src/course-connection-intent.js",
});

let proofStage = "startup";
let proofReceiptPath;
let releaseEvidence;
const completedCheckpoints = [];

function checkpoint(name) {
  completedCheckpoints.push(name);
  process.stdout.write(`${JSON.stringify({ checkpoint: name, ok: true })}\n`);
}

function setStage(name) {
  proofStage = name;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function criticalExtensionHashes(directory) {
  return Object.fromEntries(Object.entries(CRITICAL_EXTENSION_FILES)
    .map(([name, relativePath]) => [name, sha256File(join(directory, relativePath))]));
}

function requestedProofDirectory() {
  return process.env.MORROW_OPTIONAL_PERMISSION_PROOF_DIR?.trim() || null;
}

function receiptPath(directory) {
  const requested = process.env.MORROW_OPTIONAL_PERMISSION_PROOF_RECEIPT?.trim();
  if (requested) {
    if (!isAbsolute(requested)) throw new Error("proof_receipt_path_must_be_absolute");
    return resolve(requested);
  }
  const requestedDirectory = requestedProofDirectory();
  return requestedDirectory
    ? join(resolve(requestedDirectory), "canvas-file-optional-permission-receipt.json")
    : join(directory, "canvas-file-optional-permission-receipt.json");
}

function receipt(finalResult, diagnostic = null) {
  return {
    schema: "morrow.canvas_file_optional_permission_receipt.v1",
    proof: "canvas_file_optional_permission",
    timestamp: new Date().toISOString(),
    releaseManifestSha256: releaseEvidence?.manifestSha256 || null,
    frozenExtensionCriticalSourceSha256: releaseEvidence?.criticalSourceSha256 || {},
    checkpoints: [...completedCheckpoints],
    finalResult,
    stage: proofStage,
    diagnostic,
  };
}

function persistReceipt(finalResult, diagnostic = null) {
  if (!proofReceiptPath) return false;
  try {
    mkdirSync(dirname(proofReceiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(proofReceiptPath, `${JSON.stringify(receipt(finalResult, diagnostic), null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function extensionIdFromManifest(manifest) {
  assert.equal(typeof manifest.key, "string", "release manifest key was missing");
  const alphabet = "abcdefghijklmnop";
  return [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
    .map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 0x0f]}`)
    .join("");
}

function sourceLineFrom(error) {
  if (!(error instanceof Error) || typeof error.stack !== "string") return null;
  const matches = [...error.stack.matchAll(/canvas-file-optional-permission-proof\.mjs:(\d+)(?::\d+)?/g)];
  const callSite = matches.at(-2) || matches.at(-1);
  return callSite ? `canvas-file-optional-permission-proof.mjs:${callSite[1]}` : null;
}

function emitFailure(error) {
  const errorName = error instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name)
    ? error.name
    : "UnknownError";
  const diagnostic = { errorName, sourceLine: sourceLineFrom(error) };
  const receiptSaved = persistReceipt("failed", diagnostic);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    proof: "canvas_file_optional_permission",
    stage: proofStage,
    ...diagnostic,
    receiptSaved,
  })}\n`);
}

async function waitFor(probe, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {}
    await delay(100);
  }
  throw new Error(message);
}

function proofRoot() {
  const requested = requestedProofDirectory();
  if (!requested) return mkdtempSync(join(tmpdir(), "morrow-canvas-optional-permission-"));
  if (!isAbsolute(requested)) throw new Error("proof_output_directory_must_be_absolute");
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  return join(resolve(requested), `run-${randomUUID()}`);
}

function keepProofFiles() {
  return process.env.MORROW_OPTIONAL_PERMISSION_PROOF_KEEP === "1";
}

async function availablePort() {
  const server = createTcpServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null, true, "proof bridge port was unavailable");
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function createCertificate(directory) {
  const key = join(directory, "fixture-key.pem");
  const certificate = join(directory, "fixture-certificate.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", key, "-out", certificate,
  ], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(certificate) };
}

function startFixtures(tls) {
  const externalRequests = [];
  let externalDownloadUrl = "";
  const json = (response, value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const canvas = createHttpsServer(tls, (request, response) => {
    const url = new URL(request.url || "/", "https://127.0.0.1");
    if (url.pathname === "/courses/42") {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "canvas_session=fixture; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
      response.end("<!doctype html><html><body><h1>Synthetic Canvas Course</h1></body></html>");
      return;
    }
    if (url.pathname === "/api/v1/users/self/profile") return json(response, { id: "7", name: "Synthetic Instructor" });
    if (url.pathname === "/api/v1/courses") return json(response, [{ id: "42", name: "Synthetic privacy course" }]);
    if (url.pathname === "/api/v1/courses/42") return json(response, { id: "42", name: "Synthetic privacy course" });
    if (url.pathname === "/api/v1/courses/42/users") {
      return json(response, [{ id: "17", name: LEARNER_NAME, email: LEARNER_EMAIL }]);
    }
    if (url.pathname === "/api/v1/courses/42/files/501") {
      return json(response, {
        id: "501",
        display_name: "Course text.txt",
        filename: "course-text.txt",
        "content-type": "text/plain",
        size: Buffer.byteLength(FILE_TEXT),
        updated_at: "2026-09-06T12:00:00Z",
        url: `https://${request.headers.host}/files/501/download?verifier=fixture-only-verifier`,
      });
    }
    if (url.pathname === "/files/501/download") {
      assert.equal(externalDownloadUrl.length > 0, true, "fixture file storage did not start");
      response.writeHead(302, { location: externalDownloadUrl });
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const storage = createHttpsServer(tls, (request, response) => {
    const url = new URL(request.url || "/", "https://localhost");
    externalRequests.push({ method: request.method, path: url.pathname, cookiePresent: Boolean(request.headers.cookie) });
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(FILE_TEXT)),
    });
    response.end(FILE_TEXT);
  });
  return {
    canvas,
    storage,
    externalRequests: () => [...externalRequests],
    setExternalDownloadUrl(value) { externalDownloadUrl = value; },
  };
}

async function listen(server, host) {
  await new Promise((resolveListen) => server.listen(0, host, resolveListen));
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null, true, "fixture port was unavailable");
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

function assertReleaseManifest(copy) {
  const source = readFileSync(join(EXTENSION, "manifest.json"));
  const copied = readFileSync(join(copy, "manifest.json"));
  assert.deepEqual(copied, source, "proof copy must keep the release manifest byte-for-byte");
  const manifest = JSON.parse(source.toString("utf8"));
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"], "release host permission model changed");
  assert.deepEqual(manifest.optional_host_permissions, FILE_PERMISSION, "release optional-host permission model changed");
  const extensionId = extensionIdFromManifest(manifest);
  assert.equal(extensionId, EXPECTED_EXTENSION_ID, "release extension identity changed");
  return { extensionId, manifestSha256: sha256File(join(EXTENSION, "manifest.json")) };
}

function patchFixtureBridgePort(extensionCopy, port) {
  const worker = join(extensionCopy, "src/service-worker.js");
  const source = readFileSync(worker, "utf8");
  const needle = "const PORT = 32147;";
  assert.equal(source.split(needle).length, 2, "proof fixture must patch one bridge-port declaration");
  writeFileSync(worker, source.replace(needle, `const PORT = ${port};`));
}

function gatewayConfig(directory, port, extensionId) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Canvas Connector proof fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [join(ROOT, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: ROOT,
      env: {
        MORROW_CANVAS_CATALOG_PATH: join(ROOT, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector-state.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: randomBytes(48).toString("base64url"),
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: extensionId,
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "learner",
        maxRecords: 10_000,
        maxBytes: 2_000_000,
        freeText: "allow",
        learnerTokens: true,
        artifactInspection: "deny",
        aiClientAdmission: "allow",
      },
    }],
    sourcePolicy: { requireAttestation: false },
    publicationPolicy: { requiredForPublicProfile: false },
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: {
      canvasOrigin: "proof-fixture",
      account: "proof-fixture",
      principal: "proof-fixture",
      learnerVaultPath: join(directory, "learner-vault.json"),
    },
    maxCatalogTools: 2_000,
  });
}

async function nativeFileAccess(page) {
  return await page.evaluate(async ({ permission, key }) => ({
    browserPermission: await chrome.permissions.contains({ origins: permission }),
    optedIn: (await chrome.storage.local.get(key))[key] === true,
  }), { permission: FILE_PERMISSION, key: FILE_STORAGE_KEY });
}

async function askOperator(reader, expected, instruction) {
  process.stderr.write(`[proof] action_required: ${instruction}\n`);
  const answer = (await reader.question(`[proof] type ${expected} to continue: `)).trim().toLowerCase();
  if (answer !== expected) throw new Error("operator_checkpoint_not_confirmed");
}

function findFileTool(gateway) {
  const matches = gateway.catalog.tools.filter((tool) => tool.upstreamName === "canvas_read_course_file_text");
  assert.equal(matches.length, 1, "gateway did not expose one course-file read capability");
  return matches[0].publicName;
}

async function readFileThroughGateway(gateway, toolName, sourceBindingId) {
  return await gateway.call(toolName, {
    course_id: "42",
    file_id: "501",
    _morrow: { source_binding_id: sourceBindingId },
  });
}

function rawCanvasFileData(value) {
  const structured = value?.structuredContent;
  assert.equal(structured?.schema, "morrow.canvas-connector.result.v1", "raw file read did not return a connector result");
  assert.equal(structured?.ok, true, "raw file read did not succeed");
  assert.equal(structured?.commandKind, "invoke_read", "raw file read was not a read operation");
  const data = structured?.result?.data;
  assert.equal(typeof data?.content, "string", "raw file read content was missing");
  assert.equal(typeof data?.content_sha256, "string", "raw file read content hash was missing");
  return data;
}

async function main() {
  setStage("interactive_terminal");
  if (!process.stdin.isTTY) throw new Error("interactive_terminal_required");
  const directory = proofRoot();
  proofReceiptPath = receiptPath(directory);
  const keep = keepProofFiles();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let fixtures;
  let gateway;
  let context;
  let reader;
  try {
    setStage("prepare_extension_fixture");
    const extensionCopy = join(directory, "extension");
    const criticalSourceSha256 = criticalExtensionHashes(EXTENSION);
    cpSync(EXTENSION, extensionCopy, { recursive: true });
    assert.deepEqual(criticalExtensionHashes(extensionCopy), criticalSourceSha256, "proof copy did not preserve frozen extension sources");
    const { extensionId, manifestSha256 } = assertReleaseManifest(extensionCopy);
    releaseEvidence = { manifestSha256, criticalSourceSha256 };
    const bridgePort = await availablePort();
    patchFixtureBridgePort(extensionCopy, bridgePort);
    setStage("prepare_https_fixtures");
    const tls = createCertificate(directory);
    fixtures = startFixtures(tls);
    const canvasPort = await listen(fixtures.canvas, "127.0.0.1");
    const storagePort = await listen(fixtures.storage, "127.0.0.1");
    fixtures.setExternalDownloadUrl(`https://localhost:${storagePort}/fixture-file`);

    setStage("connect_gateway");
    gateway = await GatewayRuntime.connect(gatewayConfig(directory, bridgePort, extensionId), {
      journalPath: join(directory, "gateway.sqlite3"),
      workingDirectory: ROOT,
    });
    const fileTool = findFileTool(gateway);
    const profile = join(directory, "chrome-for-testing-profile");
    const cftExecutable = chromium.executablePath();
    setStage("verify_chrome_for_testing");
    assert.equal(existsSync(cftExecutable), true, "chrome_for_testing_executable_missing");
    assert.equal(basename(cftExecutable), "Google Chrome for Testing", "chrome_for_testing_executable_required");
    setStage("launch_chrome_for_testing");
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      executablePath: cftExecutable,
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
    setStage("wait_for_connector_service_worker");
    const worker = await waitFor(
      () => context.serviceWorkers().find((candidate) => {
        try {
          const url = new URL(candidate.url());
          return url.protocol === "chrome-extension:" && url.hostname === extensionId && url.pathname === "/src/service-worker.js";
        } catch {
          return false;
        }
      }),
      "connector_service_worker_not_ready",
    );
    setStage("open_synthetic_canvas_course");
    const canvasPage = context.pages()[0] || await context.newPage();
    await canvasPage.goto(`https://127.0.0.1:${canvasPort}/courses/42`, { waitUntil: "domcontentloaded" });
    await canvasPage.getByRole("heading", { name: "Synthetic Canvas Course" }).waitFor();

    setStage("open_local_pairing_page");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    setStage("approve_local_pairing");
    await popup.getByRole("button", { name: "Connect Morrow", exact: true }).click();
    const pairingPage = await waitFor(() => context.pages().find((page) => {
      try {
        const url = new URL(page.url());
        return url.origin === `http://127.0.0.1:${bridgePort}` && /^\/morrow-bridge\/v1\/pair\/[0-9a-f-]+$/.test(url.pathname);
      } catch { return false; }
    }), "local_pairing_page_unavailable");
    await pairingPage.getByRole("button", { name: "Allow connection", exact: true }).click();
    setStage("wait_for_local_pairing");
    await waitFor(async () => (await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: "morrow_status" })))?.result?.connected === true,
      "connector_pairing_not_ready");
    await pairingPage.close();
    await canvasPage.bringToFront();
    checkpoint("fresh_cft_profile_and_release_manifest");

    reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    setStage("operator_course_site_permission");
    await askOperator(reader, "course-ready", "In Chrome for Testing, use the Morrow Bridge toolbar popup on the visible Canvas course. Select Connect Canvas and allow the exact Canvas-site permission.");
    setStage("verify_course_site_permission");
    await waitFor(async () => {
      const site = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: "morrow_status" }));
      return site?.result?.connected === true && site.result.anchorCount === 1 ? site : null;
    }, "course_site_permission_or_anchor_not_ready");
    assert.equal(await worker.evaluate(async () => await chrome.permissions.contains({ origins: ["https://127.0.0.1/*"] })), true,
      "exact_canvas_site_permission_not_granted");

    setStage("bind_synthetic_canvas_course");
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings/settings.html`);
    await settings.getByRole("heading", { name: "Plan and Edit" }).waitFor();
    await settings.getByRole("button", { name: "Find available courses" }).click();
    await settings.getByRole("checkbox", { name: "Select Synthetic privacy course to connect" }).check();
    await settings.getByRole("button", { name: "Connect 1 selected course in Plan" }).click();
    await settings.locator("#notice").filter({ hasText: /1 course connected in Plan/ }).waitFor();
    const bound = await waitFor(async () => {
      const state = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: "morrow_status" }));
      return state?.result?.bindings?.find((binding) => binding?.provider === "canvas" && binding.courseId === "42" && binding.runtimeVerified === true) || null;
    }, "course_binding_not_ready");
    const sourceBindingId = bound.sourceBindingId;
    assert.equal(typeof sourceBindingId === "string" && sourceBindingId.length > 0, true, "course_binding_identifier_missing");

    setStage("verify_initial_refusal");
    assert.deepEqual(await nativeFileAccess(settings), { browserPermission: false, optedIn: false }, "file access was not initially off");
    const requestsBeforeInitialRefusal = fixtures.externalRequests().length;
    const initialRefusal = await readFileThroughGateway(gateway, fileTool, sourceBindingId);
    assert.equal(initialRefusal.isError === true, true, "file read did not fail while access was off");
    assert.equal(fixtures.externalRequests().length, requestsBeforeInitialRefusal, "refused file read reached file storage");
    checkpoint("initial_file_access_off_and_refused");

    setStage("operator_decline_file_access");
    await settings.bringToFront();
    await settings.getByRole("button", { name: "Enable course file access" }).click();
    await askOperator(reader, "declined", "Decline Chrome's optional HTTPS file-access request in the Morrow Bridge settings page.");
    setStage("verify_declined_file_access");
    await settings.locator("#notice").filter({ hasText: "Course file access remains off. Chrome did not grant HTTPS file access." }).waitFor();
    assert.deepEqual(await nativeFileAccess(settings), { browserPermission: false, optedIn: false }, "declined permission did not fail closed");
    const declineRefusal = await readFileThroughGateway(gateway, fileTool, sourceBindingId);
    assert.equal(declineRefusal.isError === true, true, "file read succeeded after the permission was declined");
    checkpoint("native_enable_declined_and_refused");

    setStage("operator_allow_file_access");
    await settings.getByRole("button", { name: "Enable course file access" }).click();
    await askOperator(reader, "allowed", "Allow Chrome's optional HTTPS file-access request in the Morrow Bridge settings page.");
    setStage("verify_allowed_file_access");
    await settings.locator("#notice").filter({ hasText: "Course file access is on. Morrow will still use only files it confirms belong to selected Canvas courses." }).waitFor();
    assert.deepEqual(await nativeFileAccess(settings), { browserPermission: true, optedIn: true }, "allowed permission did not set both browser permission and local opt-in");
    checkpoint("native_enable_allowed");

    setStage("verify_course_scope_and_privacy");
    const requestsBeforeWrongCourse = fixtures.externalRequests().length;
    const wrongCourse = await gateway.call(fileTool, {
      course_id: "43",
      file_id: "501",
      _morrow: { source_binding_id: sourceBindingId },
    });
    assert.equal(wrongCourse.isError === true, true, "file read accepted a course outside the selected binding");
    assert.equal(fixtures.externalRequests().length, requestsBeforeWrongCourse, "wrong-course file read reached file storage");

    const externalRequestsBeforeRawRead = fixtures.externalRequests().length;
    const rawRead = await gateway.callSourceOwned(fileTool, {
      course_id: "42",
      file_id: "501",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const rawFile = rawCanvasFileData(rawRead);
    assert.equal(rawFile.content, FILE_TEXT, "raw file read did not preserve the UTF-8 BOM");
    assert.equal(rawFile.content_sha256, createHash("sha256").update(rawFile.content, "utf8").digest("hex"),
      "raw file content hash did not match its returned UTF-8 text");
    assert.equal(rawFile.content_byte_length, Buffer.byteLength(rawFile.content, "utf8"),
      "raw file byte length did not match its returned UTF-8 text");
    assert.deepEqual(fixtures.externalRequests().slice(externalRequestsBeforeRawRead), [{ method: "GET", path: "/fixture-file", cookiePresent: false }],
      "raw cross-origin file storage read received browser credentials or an unexpected request");

    const externalRequestsBeforeRead = fixtures.externalRequests().length;
    const read = await readFileThroughGateway(gateway, fileTool, sourceBindingId);
    const serializedRead = JSON.stringify(read);
    assert.equal(read.isError === true, false, "course-bound file read did not complete");
    assert.equal(serializedRead.includes(LEARNER_NAME), false, "learner name reached gateway output");
    assert.equal(serializedRead.includes(LEARNER_EMAIL), false, "learner email reached gateway output");
    assert.equal(serializedRead.includes("fixture-only-verifier"), false, "signed download verifier reached gateway output");
    assert.equal(/learner_[\w-]+/.test(serializedRead), true, "gateway output did not contain a learner token");
    assert.deepEqual(fixtures.externalRequests().slice(externalRequestsBeforeRead), [{ method: "GET", path: "/fixture-file", cookiePresent: false }],
      "cross-origin file storage received browser credentials or an unexpected request");
    checkpoint("course_bound_cross_origin_read_redacted");

    setStage("revoke_file_access");
    await settings.getByRole("button", { name: "Remove HTTPS file access" }).click();
    await settings.locator("#notice").filter({ hasText: /Course file access.*off\./ }).waitFor();
    setStage("verify_revocation_refusal");
    assert.deepEqual(await nativeFileAccess(settings), { browserPermission: false, optedIn: false }, "native revoke did not clear both file-access controls");
    const requestsBeforeRevocationRefusal = fixtures.externalRequests().length;
    const revokedRefusal = await readFileThroughGateway(gateway, fileTool, sourceBindingId);
    assert.equal(revokedRefusal.isError === true, true, "file read succeeded after native revoke");
    assert.equal(fixtures.externalRequests().length, requestsBeforeRevocationRefusal, "revoked file read reached file storage");
    checkpoint("native_revoke_and_refused");
    setStage("complete");
    const receiptSaved = persistReceipt("passed");
    assert.equal(receiptSaved, true, "safe_proof_receipt_not_saved");
    process.stdout.write(`${JSON.stringify({ ok: true, proof: "canvas_file_optional_permission", receiptSaved })}\n`);
  } finally {
    reader?.close();
    if (context) await context.close().catch(() => undefined);
    if (gateway) await gateway.close().catch(() => undefined);
    if (fixtures) {
      await Promise.allSettled([closeServer(fixtures.canvas), closeServer(fixtures.storage)]);
    }
    if (!keep) rmSync(directory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  emitFailure(error);
  process.exitCode = 1;
}
