import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const extensionId = "a".repeat(32);
const extensionPrefix = `chrome-extension://${extensionId}/`;
const consentKey = "morrowCourseDataConsent";
const consentValue = "morrow.course-data-consent.v1";
const token = "t".repeat(32);
const courseOrigin = "https://school.instructure.com";
const coursePermission = `${courseOrigin}/*`;
const bindingId = "canvas:account:g1:c42";
const anchorId = "canvas:account:g1";
const pairingId = "11111111-1111-4111-8111-111111111111";
const pairingStatusUrl = `http://127.0.0.1:32147/morrow-bridge/v1/pair/${pairingId}/status`;

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

function storageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const names = keys === undefined || keys === null
        ? Object.keys(values)
        : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const result = {};
      for (const name of names) {
        if (Object.hasOwn(values, name)) result[name] = structuredClone(values[name]);
        else if (keys && typeof keys === "object" && !Array.isArray(keys) && Object.hasOwn(keys, name)) result[name] = structuredClone(keys[name]);
      }
      return result;
    },
    async set(update) {
      for (const [name, value] of Object.entries(update)) values[name] = structuredClone(value);
    },
    async remove(keys) {
      for (const name of Array.isArray(keys) ? keys : [keys]) delete values[name];
    },
  };
}

function connectedState() {
  return {
    [consentKey]: consentValue,
    token,
    bindings: [{
      sourceBindingId: bindingId,
      siteAnchorId: anchorId,
      provider: "canvas",
      origin: courseOrigin,
      principalFingerprint: "f".repeat(64),
      principalId: "7",
      sessionGeneration: 1,
      courseId: "42",
      courseName: "Biology",
      runtimeVerified: true,
      lastSeenAt: 1,
    }],
    siteAnchors: [{
      siteAnchorId: anchorId,
      provider: "canvas",
      origin: courseOrigin,
      principalFingerprint: "f".repeat(64),
      principalId: "7",
      sessionGeneration: 1,
      runtimeVerified: true,
      lastSeenAt: 1,
      tabId: 9,
    }],
    editPolicies: {},
    editPolicyRevisions: {},
  };
}

function fixture({ initialLocal = connectedState(), holdCatalog = false, loopbackFetch, tabMessage } = {}) {
  const local = storageArea(initialLocal);
  const session = storageArea({});
  const runtimeMessages = event();
  const runtimeStartup = event();
  const storageChanged = event();
  const permissionAdded = event();
  const granted = new Set(initialLocal.siteAnchors?.length ? [coursePermission] : []);
  const permissionRemovals = [];
  const createdTabs = [];
  let releaseCatalog;
  let catalogHeld = false;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeRecord = null;
      FakeWebSocket.instances.push(this);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close(code, reason) {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.closeRecord = { code, reason };
      this.onclose?.({ code, reason });
    }
  }

  const noOpEvent = () => event();
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(extensionPrefix)) {
      if (loopbackFetch) return await loopbackFetch(url, init);
      throw new Error(`unexpected network request: ${url}`);
    }
    const relative = url.slice(extensionPrefix.length);
    if (holdCatalog && relative === "generated/canvas-api-catalog.json" && !catalogHeld) {
      catalogHeld = true;
      await new Promise((resolve) => { releaseCatalog = resolve; });
    }
    const text = await readFile(new URL(`connector/extension/${relative}`, root), "utf8");
    return new Response(text, { headers: { "content-type": "application/json" } });
  };
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      getManifest: () => ({ version: "1.0.4" }),
      getURL: (path) => `${extensionPrefix}${path}`,
      sendMessage: async () => undefined,
      openOptionsPage: async () => undefined,
      onMessage: runtimeMessages,
      onStartup: runtimeStartup,
      onInstalled: noOpEvent(),
    },
    management: { getSelf: async () => ({ id: extensionId, version: "1.0.4", installType: "development" }) },
    storage: { local, session, onChanged: storageChanged },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => granted.has(origin)),
      getAll: async () => ({ origins: [...granted] }),
      remove: async ({ origins }) => {
        permissionRemovals.push(...origins);
        for (const origin of origins) granted.delete(origin);
        return true;
      },
      onAdded: permissionAdded,
      onRemoved: noOpEvent(),
    },
    alarms: { create: async () => undefined, clear: async () => true, onAlarm: noOpEvent() },
    tabs: {
      get: async (id) => id === 9 ? { id: 9, windowId: 4, url: `${courseOrigin}/courses/42` } : null,
      query: async () => [{ id: 9, windowId: 4, url: `${courseOrigin}/courses/42` }],
      create: async (value) => { createdTabs.push(value); return {}; },
      remove: async () => undefined,
      update: async () => null,
      sendMessage: async (tabId, message, options) => tabMessage
        ? await tabMessage({ tabId, message, options })
        : message?.type === "morrow_canvas_probe"
          ? { ok: true, profile: { origin: courseOrigin, id: "7" } }
          : null,
      onRemoved: noOpEvent(),
      onUpdated: noOpEvent(),
    },
    scripting: {
      executeScript: async (injection) => injection.func ? [{ result: { ok: false } }] : [{ result: null }],
    },
    webNavigation: { getAllFrames: async () => [], onCommitted: noOpEvent() },
    webRequest: { onBeforeSendHeaders: noOpEvent(), onBeforeRequest: noOpEvent(), onHeadersReceived: noOpEvent() },
  };
  return {
    FakeWebSocket,
    createdTabs,
    granted,
    local,
    permissionAdded,
    permissionRemovals,
    releaseCatalog: () => releaseCatalog?.(),
    runtimeMessages,
    runtimeStartup,
    storageChanged,
    catalogWasHeld: () => catalogHeld,
  };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition did not become true");
}

async function importWorker(scenario) {
  await import(new URL(`connector/extension/src/service-worker.js?lifecycle=${scenario}-${Date.now()}`, root));
}

function serverProof(authentication, serverNonce) {
  const payload = JSON.stringify([
    "morrow.bridge.server-proof.v1",
    1,
    "/morrow-bridge/v1",
    authentication.clientNonce,
    serverNonce,
    authentication.extensionId,
    authentication.runtimeRevision,
    authentication.catalogDigest,
  ]);
  return createHmac("sha256", token).update(payload).digest("hex");
}

async function authenticate(value, generation = 9, socketIndex = 0) {
  const socket = await eventually(() => value.FakeWebSocket.instances[socketIndex]);
  socket.open();
  const authentication = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.authenticate.v1"));
  const serverNonce = "b".repeat(64);
  socket.receive({
    schema: "morrow.bridge.challenge.v1",
    protocolVersion: 1,
    clientNonce: authentication.clientNonce,
    serverNonce,
    serverProof: serverProof(authentication, serverNonce),
    issuedAt: Date.now(),
  });
  const hello = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.hello.v1"));
  socket.receive({
    schema: "morrow.bridge.ready.v1",
    protocolVersion: 1,
    generation,
    acceptedExtensionId: extensionId,
    catalogDigest: hello.catalogDigest,
    connectedAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return socket;
}

function semanticWriteCommand() {
  return {
    schema: "morrow.bridge.command.v1",
    protocolVersion: 1,
    requestId: "request-write-lifecycle",
    operationId: "operation-write-lifecycle",
    generation: 9,
    kind: "invoke_write",
    toolName: "canvas_edit_section",
    operationKey: "PUT /v1/sections/{id}#edit_section",
    sourceBindingId: bindingId,
    arguments: { id: "5", course_section_name: "Section B" },
    outerGrant: { effectReceiptId: "effect:write-lifecycle", authorization: { kind: "review" } },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

async function sendRuntime(value, message) {
  const handler = value.runtimeMessages.listeners[0];
  return await new Promise((resolve, reject) => {
    if (handler(message, {}, resolve) !== true) reject(new Error(`message refused: ${message.type}`));
  });
}

async function consentConnectScenario() {
  const value = fixture({ holdCatalog: true });
  const importing = importWorker("consent-connect");
  await eventually(() => value.catalogWasHeld());
  delete value.local.values[consentKey];
  value.storageChanged.listeners[0]({ [consentKey]: { oldValue: consentValue, newValue: undefined } }, "local");
  value.releaseCatalog();
  await importing;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(value.FakeWebSocket.instances.length, 0);
}

async function preEffectScenario(boundary) {
  let resolverReadStarted = false;
  let releaseResolverRead;
  let providerWrites = 0;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type !== "morrow_canvas_execute") return null;
      if (message.operation?.toolName === "canvas_get_section_information_sections") {
        resolverReadStarted = true;
        await new Promise((resolve) => { releaseResolverRead = resolve; });
        return { ok: true, sent: true, status: 200, truncated: false, data: { id: 5, course_id: 42, name: "Section A" } };
      }
      if (message.operation?.toolName === "canvas_edit_section") {
        providerWrites += 1;
        return { ok: true, sent: true, status: 200, truncated: false, data: { id: 5, course_id: 42, name: "Section B" } };
      }
      throw new Error(`unexpected Canvas operation ${message.operation?.toolName}`);
    },
  });
  await importWorker(`pre-effect-${boundary}`);
  const socket = await authenticate(value);
  socket.receive(semanticWriteCommand());
  await eventually(() => resolverReadStarted);
  if (boundary === "consent") {
    delete value.local.values[consentKey];
    value.storageChanged.listeners[0]({ [consentKey]: { oldValue: consentValue, newValue: undefined } }, "local");
  } else {
    socket.close(1006, "transport_lost");
  }
  releaseResolverRead();
  await eventually(() => Array.isArray(value.local.values.morrowBridgeMaintenanceReceipts));
  await eventually(() => value.local.values.morrowBridgeMaintenanceReceipts.length === 0);
  assert.equal(providerWrites, 0);
}

async function startedWriteScenario() {
  let providerWriteStarted = false;
  let releaseProviderWrite;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type !== "morrow_canvas_execute") return null;
      if (message.operation?.toolName === "canvas_get_section_information_sections") {
        return { ok: true, sent: true, status: 200, truncated: false, data: { id: 5, course_id: 42, name: "Section B" } };
      }
      if (message.operation?.toolName === "canvas_edit_section") {
        providerWriteStarted = true;
        await new Promise((resolve) => { releaseProviderWrite = resolve; });
        return { ok: true, sent: true, status: 200, truncated: false, data: { id: 5, course_id: 42, name: "Section B" } };
      }
      throw new Error(`unexpected Canvas operation ${message.operation?.toolName}`);
    },
  });
  await importWorker("started-write");
  const socket = await authenticate(value);
  socket.receive(semanticWriteCommand());
  await eventually(() => providerWriteStarted);
  socket.close(1006, "transport_lost");
  value.runtimeStartup.listeners[0]();
  const replacement = await authenticate(value, 9, 1);
  releaseProviderWrite();
  await eventually(() => value.local.values.morrowBridgeMaintenanceReceipts?.[0]?.state === "unknown");
  assert.equal(value.local.values.morrowBridgeMaintenanceReceipts.length, 1);
  assert.equal(replacement.sent.some((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === "request-write-lifecycle"), false);
}

async function socketReadScenario() {
  let probeCount = 0;
  let commandProbeStarted = false;
  let releaseCommandProbe;
  let providerReads = 0;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") {
        probeCount += 1;
        if (probeCount === 2) {
          commandProbeStarted = true;
          await new Promise((resolve) => { releaseCommandProbe = resolve; });
        }
        return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      }
      if (message?.type === "morrow_canvas_execute") {
        providerReads += 1;
        return { ok: true, sent: true, status: 200, truncated: false, data: { id: 42 } };
      }
      return null;
    },
  });
  await importWorker("socket-read");
  const socket = await authenticate(value);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  socket.receive({
    schema: "morrow.bridge.command.v1",
    protocolVersion: 1,
    requestId: "request-read-lifecycle",
    operationId: "operation-read-lifecycle",
    generation: 9,
    kind: "invoke_read",
    toolName: "canvas_get_single_course_courses",
    operationKey: "GET /v1/courses/{id}#get_single_course_courses",
    sourceBindingId: bindingId,
    arguments: { id: "42" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  await eventually(() => commandProbeStarted);
  socket.close(1006, "transport_lost");
  releaseCommandProbe();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(providerReads, 0);
}

async function latePermissionScenario() {
  const value = fixture({ initialLocal: { [consentKey]: consentValue } });
  await importWorker("late-permission");
  const prepared = await sendRuntime(value, { type: "morrow_connect_course_prepare", tabId: 9 });
  assert.equal(prepared.ok, true);
  assert.equal(value.local.values.pendingCourseConnection.id, prepared.result.id);
  assert.equal(value.local.values.pendingCourseConnection.authorityGeneration, value.local.values.courseConnectionAuthority.generation);
  const disconnected = await sendRuntime(value, { type: "morrow_disconnect" });
  assert.equal(disconnected.ok, true);
  assert.equal(value.local.values.pendingCourseConnection, undefined);
  assert.equal(value.local.values.courseConnectionAuthority.status, "disconnected");
  value.granted.add(coursePermission);
  value.permissionAdded.listeners[0]({ origins: [coursePermission] });
  await eventually(() => !value.granted.has(coursePermission));
  assert.equal(value.local.values.siteAnchors, undefined);
  assert.equal(value.permissionRemovals.includes(coursePermission), true);
  const staleCompletion = await sendRuntime(value, { type: "morrow_connect_course_complete", intentId: prepared.result.id });
  assert.deepEqual(staleCompletion, { ok: true, result: { completed: false } });
}

function pairingOffer(extra = {}) {
  return {
    schema: "morrow.bridge.pairing.v1",
    pairingId,
    status: "pending",
    approvalUrl: `http://127.0.0.1:32147/morrow-bridge/v1/pair/${pairingId}`,
    statusUrl: pairingStatusUrl,
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

async function pairingDeclaredOverflowScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => jsonResponse(pairingOffer(), { headers: { "content-length": "4097" } }),
  });
  await importWorker("pairing-declared-overflow");
  const result = await sendRuntime(value, { type: "morrow_pair" });
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_too_large", error: "bridge_pairing_response_too_large" });
  assert.equal(value.local.values.pairing, undefined);
  assert.deepEqual(value.createdTabs, []);
}

async function pairingStreamOverflowScenario() {
  let bodyCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4_096));
      controller.enqueue(new Uint8Array([0]));
    },
    cancel() { bodyCancelled = true; },
  });
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await importWorker("pairing-stream-overflow");
  const result = await sendRuntime(value, { type: "morrow_pair" });
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_too_large", error: "bridge_pairing_response_too_large" });
  assert.equal(bodyCancelled, true);
  assert.equal(value.local.values.pairing, undefined);
}

async function pairingStalledBodyScenario() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 10_000 ? 20 : delay, ...args);
  let bodyCancelled = false;
  const body = new ReadableStream({ cancel() { bodyCancelled = true; } });
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await importWorker("pairing-stalled-body");
  const result = await sendRuntime(value, { type: "morrow_pair" });
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_timeout", error: "bridge_pairing_response_timeout" });
  assert.equal(bodyCancelled, true);
  assert.equal(value.local.values.pairing, undefined);
}

async function pairingStalledCancellationScenario() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 10_000 ? 20 : delay, ...args);
  let bodyCancelled = false;
  const body = new ReadableStream({
    cancel() {
      bodyCancelled = true;
      return new Promise(() => {});
    },
  });
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await importWorker("pairing-stalled-cancellation");
  const startedAt = Date.now();
  const result = await sendRuntime(value, { type: "morrow_pair" });
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_timeout", error: "bridge_pairing_response_timeout" });
  assert.equal(bodyCancelled, true);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(value.local.values.pairing, undefined);
}

async function pairingOfferExactSchemaScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => jsonResponse(pairingOffer({ unexpected: true })),
  });
  await importWorker("pairing-offer-exact-schema");
  const result = await sendRuntime(value, { type: "morrow_pair" });
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_invalid", error: "bridge_pairing_response_invalid" });
  assert.equal(value.local.values.pairing, undefined);
  assert.deepEqual(value.createdTabs, []);
}

async function pairingExactSchemaScenario() {
  const generation = "22222222-2222-4222-8222-222222222222";
  const expiresAt = Date.now() + 60_000;
  let statusReads = 0;
  const value = fixture({
    initialLocal: {
      [consentKey]: consentValue,
      pairing: { ...pairingOffer({ expiresAt }), pairingGeneration: generation },
      pairingAuthority: { schema: "morrow.bridge-pairing-authority.v1", generation, status: "pending", changedAt: Date.now() },
    },
    loopbackFetch: async (url) => {
      assert.equal(url, pairingStatusUrl);
      statusReads += 1;
      return jsonResponse({
        schema: "morrow.bridge.pairing-status.v1",
        status: "approved",
        expiresAt,
        token,
        unexpected: true,
      });
    },
  });
  await importWorker("pairing-exact-schema");
  await eventually(() => statusReads === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(value.local.values.token, undefined);
  assert.equal(value.local.values.pairing.status, "pending");
  assert.equal(value.FakeWebSocket.instances.length, 0);
}

const scenarios = {
  "consent-connect": consentConnectScenario,
  "consent-pre-effect": () => preEffectScenario("consent"),
  "socket-pre-effect": () => preEffectScenario("socket"),
  "started-write": startedWriteScenario,
  "socket-read": socketReadScenario,
  "late-permission": latePermissionScenario,
  "pairing-declared-overflow": pairingDeclaredOverflowScenario,
  "pairing-stream-overflow": pairingStreamOverflowScenario,
  "pairing-stalled-body": pairingStalledBodyScenario,
  "pairing-stalled-cancellation": pairingStalledCancellationScenario,
  "pairing-offer-exact-schema": pairingOfferExactSchemaScenario,
  "pairing-exact-schema": pairingExactSchemaScenario,
};

async function runScenario(name) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);
  await scenario();
}

const scenarioName = process.argv[2];
if (scenarioName) {
  await runScenario(scenarioName);
  process.stdout.write(`${scenarioName}: ok\n`);
  process.exit(0);
}

const execute = promisify(execFile);
async function isolatedScenario(name) {
  const result = await execute(process.execPath, [fileURLToPath(import.meta.url), name], {
    cwd: fileURLToPath(root),
    timeout: 10_000,
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${name}: ok\n`);
}

test("consent withdrawal fences a Bridge connection still loading its catalog", async () => {
  await isolatedScenario("consent-connect");
});

test("consent withdrawal fences a provider write still resolving ownership", async () => {
  await isolatedScenario("consent-pre-effect");
});

test("socket closure fences a provider write still resolving ownership", async () => {
  await isolatedScenario("socket-pre-effect");
});

test("socket closure retains unknown state for a provider write that already started", async () => {
  await isolatedScenario("started-write");
});

test("socket closure fences a provider read still checking its course session", async () => {
  await isolatedScenario("socket-read");
});

test("Disconnect invalidates pending course access and compensates a late grant", async () => {
  await isolatedScenario("late-permission");
});

test("pairing refuses a declared response larger than four KiB", async () => {
  await isolatedScenario("pairing-declared-overflow");
});

test("pairing cancels a streamed response at the first byte over four KiB", async () => {
  await isolatedScenario("pairing-stream-overflow");
});

test("pairing aborts a response body that does not finish before its deadline", async () => {
  await isolatedScenario("pairing-stalled-body");
});

test("pairing settles when response cancellation itself never finishes", async () => {
  await isolatedScenario("pairing-stalled-cancellation");
});

test("pairing refuses an offer with fields outside the exact schema", async () => {
  await isolatedScenario("pairing-offer-exact-schema");
});

test("pairing ignores an approved status with fields outside the exact schema", async () => {
  await isolatedScenario("pairing-exact-schema");
});
