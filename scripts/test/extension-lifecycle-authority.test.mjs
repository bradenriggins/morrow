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
  const permissionRemoved = event();
  const granted = new Set(initialLocal.siteAnchors?.length ? [coursePermission] : []);
  const permissionRemovals = [];
  const createdTabs = [];
  const removedTabs = [];
  const alarmCreations = [];
  const alarmClears = [];
  const scriptExecutions = [];
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
      onRemoved: permissionRemoved,
    },
    alarms: {
      create: async (name, options) => { alarmCreations.push({ name, options: structuredClone(options) }); },
      clear: async (name) => { alarmClears.push(name); return true; },
      onAlarm: noOpEvent(),
    },
    tabs: {
      get: async (id) => id === 9 ? { id: 9, windowId: 4, url: `${courseOrigin}/courses/42` } : null,
      query: async () => [{ id: 9, windowId: 4, url: `${courseOrigin}/courses/42` }],
      create: async (value) => { createdTabs.push(value); return { id: 70 + createdTabs.length }; },
      remove: async (tabId) => { removedTabs.push(tabId); },
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
      executeScript: async (injection) => {
        scriptExecutions.push(injection);
        return injection.func ? [{ result: { ok: false } }] : [{ result: null }];
      },
    },
    webNavigation: { getAllFrames: async () => [], onCommitted: noOpEvent() },
    webRequest: { onBeforeSendHeaders: noOpEvent(), onBeforeRequest: noOpEvent(), onHeadersReceived: noOpEvent() },
  };
  return {
    FakeWebSocket,
    alarmClears,
    alarmCreations,
    createdTabs,
    granted,
    local,
    permissionAdded,
    permissionRemoved,
    permissionRemovals,
    removedTabs,
    releaseCatalog: () => releaseCatalog?.(),
    runtimeMessages,
    runtimeStartup,
    scriptExecutions,
    session,
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

function bridgeCommand(overrides = {}) {
  return {
    schema: "morrow.bridge.command.v1",
    protocolVersion: 1,
    requestId: "request-lifecycle-command",
    operationId: "operation-lifecycle-command",
    generation: 9,
    kind: "invoke_read",
    toolName: "canvas_get_single_course_courses",
    operationKey: "GET /v1/courses/{id}#get_single_course_courses",
    sourceBindingId: bindingId,
    arguments: { id: "42" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function cancelCommand(command) {
  return {
    schema: "morrow.bridge.cancel.v1",
    protocolVersion: 1,
    requestId: command.requestId,
    operationId: command.operationId,
    generation: command.generation,
    cancelledAt: Date.now(),
  };
}

function withdrawConsent(value) {
  delete value.local.values[consentKey];
  value.storageChanged.listeners[0]({ [consentKey]: { oldValue: consentValue, newValue: undefined } }, "local");
}

async function sendRuntime(value, message, sender = {}) {
  const handler = value.runtimeMessages.listeners[0];
  return await new Promise((resolve, reject) => {
    if (handler(message, sender, resolve) !== true) reject(new Error(`message refused: ${message.type}`));
  });
}

function settingsSender() {
  return { id: extensionId, url: `${extensionPrefix}settings/settings.html` };
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

async function commandAdmissionCancellationScenario() {
  let providerExecutions = 0;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_execute") providerExecutions += 1;
      return null;
    },
  });
  await importWorker("command-admission-cancel");
  const socket = await authenticate(value);
  const originalGet = value.local.get.bind(value.local);
  let consentReads = 0;
  let admissionHeld = false;
  let releaseAdmission;
  value.local.get = async (keys) => {
    if (keys === consentKey) {
      consentReads += 1;
      if (consentReads === 2) {
        admissionHeld = true;
        await new Promise((resolve) => { releaseAdmission = resolve; });
      }
    }
    return await originalGet(keys);
  };
  const command = bridgeCommand({ requestId: "request-admission-cancel", operationId: "operation-admission-cancel" });
  socket.receive(command);
  await eventually(() => admissionHeld);
  socket.receive(cancelCommand(command));
  const cancelled = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === command.requestId));
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.problem.code, "request_cancelled_before_dispatch");
  releaseAdmission();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(providerExecutions, 0);
}

function policySetCommand(overrides = {}) {
  return bridgeCommand({
    requestId: "request-policy-lifecycle",
    operationId: "operation-policy-lifecycle",
    kind: "edit_policy_set",
    toolName: undefined,
    operationKey: undefined,
    sourceBindingId: undefined,
    arguments: undefined,
    editPolicySet: {
      mode: "plan",
      selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 1 }],
    },
    ...overrides,
  });
}

async function editPolicyCancellationScenario(mode) {
  const initial = connectedState();
  initial.editPolicies[bindingId] = { revision: 1 };
  initial.editPolicyRevisions[bindingId] = 1;
  const value = fixture({ initialLocal: initial });
  await importWorker(`edit-policy-${mode}`);
  const socket = await authenticate(value);
  const originalGet = value.local.get.bind(value.local);
  let mutationHeld = false;
  let releaseMutation;
  value.local.get = async (keys) => {
    if (!mutationHeld && Array.isArray(keys) && keys.includes("editPolicies")) {
      mutationHeld = true;
      await new Promise((resolve) => { releaseMutation = resolve; });
    }
    return await originalGet(keys);
  };
  const command = policySetCommand({
    requestId: `request-policy-${mode}`,
    operationId: `operation-policy-${mode}`,
    ...(mode === "expiry" ? { expiresAt: Date.now() + 20 } : {}),
  });
  socket.receive(command);
  await eventually(() => mutationHeld);
  if (mode === "cancel") socket.receive(cancelCommand(command));
  else await new Promise((resolve) => setTimeout(resolve, 30));
  releaseMutation();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(value.local.values.editPolicies[bindingId], { revision: 1 });
  assert.equal(value.local.values.editPolicyRevisions[bindingId], 1);
  assert.equal(socket.sent.some((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === command.requestId && message.ok === true), false);
}

async function maintenanceMutationScenario(mode) {
  const value = fixture();
  await importWorker(`maintenance-${mode}`);
  const socket = await authenticate(value);
  let identityHeld = false;
  let releaseIdentity;
  chrome.management.getSelf = async () => {
    identityHeld = true;
    await new Promise((resolve) => { releaseIdentity = resolve; });
    return { id: extensionId, version: "1.0.4", installType: "development" };
  };
  const command = bridgeCommand({
    requestId: `request-maintenance-${mode}`,
    operationId: `operation-maintenance-${mode}`,
    kind: "bridge_maintenance",
    toolName: undefined,
    operationKey: undefined,
    sourceBindingId: undefined,
    arguments: undefined,
    maintenance: { action: "quiesce" },
    ...(mode === "expiry" ? { expiresAt: Date.now() + 20 } : {}),
  });
  socket.receive(command);
  await eventually(() => identityHeld);
  if (mode === "cancel") socket.receive(cancelCommand(command));
  else await new Promise((resolve) => setTimeout(resolve, 30));
  releaseIdentity();
  await eventually(() => socket.sent.some((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === command.requestId));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(value.local.values.morrowBridgeQuiesceFence, undefined);
}

async function permissionRemovalPublicationScenario() {
  const initial = connectedState();
  initial.courseFileStorageAccessEnabled = true;
  const value = fixture({ initialLocal: initial });
  await importWorker("permission-removal-publication");
  const socket = await authenticate(value);
  value.granted.delete(coursePermission);
  value.permissionRemoved.listeners[0]({ origins: [coursePermission] });
  const update = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.bindings.v1"));
  assert.equal(update.bindings[0].runtimeVerified, false);
  assert.equal(value.local.values.courseFileStorageAccessEnabled, false);
}

async function handshakeBackoffScenario() {
  const value = fixture();
  await importWorker("handshake-backoff");
  const active = await authenticate(value);
  const nativeSetTimeout = globalThis.setTimeout;
  const reconnectDelays = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    if ([2_000, 4_000, 8_000, 16_000, 30_000].includes(delay)) reconnectDelays.push(delay);
    const shortened = delay === 10_000 ? 5 : delay >= 2_000 ? 1 : delay;
    return nativeSetTimeout(callback, shortened, ...args);
  };
  active.close(1006, "transport_lost");
  await eventually(() => value.FakeWebSocket.instances.length >= 8);
  assert.deepEqual(value.FakeWebSocket.instances[1].closeRecord, { code: 4408, reason: "bridge_handshake_timeout" });
  assert.deepEqual(reconnectDelays.slice(0, 6), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(Math.max(...reconnectDelays), 30_000);
}

async function unscopedCanvasReadScenario() {
  let providerExecutions = 0;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_execute") providerExecutions += 1;
      return null;
    },
  });
  await importWorker("unscoped-canvas-read");
  const socket = await authenticate(value);
  const commands = [
    bridgeCommand({
      requestId: "request-unscoped-none",
      operationId: "operation-unscoped-none",
      toolName: "canvas_activity_stream_summary",
      operationKey: "GET /v1/users/self/activity_stream/summary#activity_stream_summary",
      arguments: {},
    }),
    bridgeCommand({
      requestId: "request-unscoped-self",
      operationId: "operation-unscoped-self",
      toolName: "canvas_list_bookmarks",
      operationKey: "GET /v1/users/self/bookmarks#list_bookmarks",
      arguments: {},
    }),
  ];
  for (const command of commands) {
    socket.receive(command);
    const result = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === command.requestId));
    assert.equal(result.ok, false);
    assert.equal(result.problem.code, "course_scope_required");
  }
  assert.equal(providerExecutions, 0);
}

async function courseFileDeadlineScenario() {
  const initialLocal = { ...connectedState(), courseFileStorageAccessEnabled: true };
  const value = fixture({ initialLocal });
  const originalGet = value.local.get.bind(value.local);
  let accessStarted = false;
  let releaseAccess;
  value.local.get = async (keys) => {
    if (keys === "courseFileStorageAccessEnabled") {
      accessStarted = true;
      await new Promise((resolve) => { releaseAccess = resolve; });
    }
    return await originalGet(keys);
  };
  await importWorker("course-file-deadline");
  const socket = await authenticate(value);
  const command = bridgeCommand({
    requestId: "request-course-file-deadline",
    operationId: "operation-course-file-deadline",
    toolName: "canvas_read_course_file_text",
    operationKey: "CANVAS_COURSE_FILE_TEXT GET /v1/courses/{course_id}/files/{file_id}/text",
    arguments: { course_id: "42", file_id: "81" },
    expiresAt: Date.now() + 40,
  });
  socket.receive(command);
  await eventually(() => accessStarted);
  await new Promise((resolve) => setTimeout(resolve, 60));
  releaseAccess();
  const result = await eventually(() => socket.sent.find((message) => message.requestId === command.requestId));
  assert.equal(result.ok, false);
  assert.equal(value.scriptExecutions.some((injection) => injection.func?.name === "executeCanvasCourseFileTextInPage"), false);
}

async function settingsDiscoveryConsentScenario() {
  let listStarted = false;
  let releaseList;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_list_courses") {
        listStarted = true;
        await new Promise((resolve) => { releaseList = resolve; });
        return {
          ok: true,
          profile: { origin: courseOrigin, id: "7" },
          courses: [{ id: "42", name: "Biology" }],
          pageUrl: `${courseOrigin}/api/v1/courses?per_page=100`,
          nextUrl: null,
          complete: true,
        };
      }
      return null;
    },
  });
  await importWorker("settings-discovery-consent");
  const pending = sendRuntime(value, { type: "morrow_course_discovery_start", siteAnchorId: anchorId }, settingsSender());
  await eventually(() => listStarted);
  withdrawConsent(value);
  releaseList();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "course_data_consent_required");
  assert.equal(value.session.values.courseDiscoveries, undefined);
}

async function settingsSelectionConsentScenario() {
  let checkStarted = false;
  let releaseCheck;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_check_course") {
        checkStarted = true;
        await new Promise((resolve) => { releaseCheck = resolve; });
        return { ok: true, profile: { origin: courseOrigin, id: "7" }, course: { id: "43", name: "Chemistry" } };
      }
      return null;
    },
  });
  const receiptId = "discovery:settings-selection-consent";
  const receipt = {
    schema: "morrow.course-discovery.v1",
    discoveryReceiptId: receiptId,
    siteAnchorId: anchorId,
    provider: "canvas",
    origin: courseOrigin,
    principalFingerprint: "f".repeat(64),
    sessionGeneration: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    snapshotDigest: "d".repeat(64),
    courses: [{ id: "43", name: "Chemistry" }],
    pageNumber: 1,
    visited: [`${courseOrigin}/api/v1/courses?per_page=100`],
    complete: true,
    next: null,
  };
  const initialBindings = structuredClone(value.local.values.bindings);
  value.session.values.courseDiscoveries = { [receiptId]: receipt };
  await importWorker("settings-selection-consent");
  const pending = sendRuntime(value, {
    type: "morrow_course_selection_save",
    siteAnchorId: anchorId,
    discoveryReceiptId: receiptId,
    courseIds: ["43"],
  }, settingsSender());
  await eventually(() => checkStarted);
  withdrawConsent(value);
  releaseCheck();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "course_data_consent_required");
  assert.deepEqual(value.local.values.bindings, initialBindings);
}

async function settingsPolicyConsentScenario() {
  let holdProbe = false;
  let probeStarted = false;
  let releaseProbe;
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type !== "morrow_canvas_probe") return null;
      if (holdProbe) {
        probeStarted = true;
        await new Promise((resolve) => { releaseProbe = resolve; });
      }
      return { ok: true, profile: { origin: courseOrigin, id: "7" } };
    },
  });
  await importWorker("settings-policy-consent");
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  assert.equal(options.ok, true);
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  assert.ok(category);
  holdProbe = true;
  const pending = sendRuntime(value, {
    type: "morrow_edit_policy_save",
    sourceBindingId: bindingId,
    enabledCategories: [category.id],
    expiresInMs: 60 * 60 * 1_000,
  }, settingsSender());
  await eventually(() => probeStarted);
  withdrawConsent(value);
  releaseProbe();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "course_data_consent_required");
  assert.deepEqual(value.local.values.editPolicies, {});
  assert.deepEqual(value.local.values.editPolicyRevisions, {});
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

async function pairingOfferConsentScenario() {
  let fetchStarted = false;
  let releaseFetch;
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => {
      fetchStarted = true;
      await new Promise((resolve) => { releaseFetch = resolve; });
      return jsonResponse(pairingOffer());
    },
  });
  await importWorker("pairing-offer-consent");
  const pending = sendRuntime(value, { type: "morrow_pair" });
  await eventually(() => fetchStarted);
  withdrawConsent(value);
  releaseFetch();
  const result = await pending;
  assert.equal(result.ok, false);
  await eventually(() => value.local.values.pairing === null);
  assert.equal(value.local.values.token, undefined);
  assert.deepEqual(value.createdTabs, []);
  assert.deepEqual(value.alarmCreations, []);
}

async function pairingStatusConsentScenario() {
  const generation = "22222222-2222-4222-8222-222222222222";
  const expiresAt = Date.now() + 60_000;
  let fetchStarted = false;
  let releaseFetch;
  const value = fixture({
    initialLocal: {
      [consentKey]: consentValue,
      pairing: { ...pairingOffer({ expiresAt }), pairingGeneration: generation },
      pairingAuthority: { schema: "morrow.bridge-pairing-authority.v1", generation, status: "pending", changedAt: Date.now() },
    },
    loopbackFetch: async () => {
      fetchStarted = true;
      await new Promise((resolve) => { releaseFetch = resolve; });
      return jsonResponse({ schema: "morrow.bridge.pairing-status.v1", status: "approved", expiresAt, token });
    },
  });
  await importWorker("pairing-status-consent");
  await eventually(() => fetchStarted);
  withdrawConsent(value);
  releaseFetch();
  await eventually(() => value.local.values.pairing === null);
  assert.equal(value.local.values.token, undefined);
  assert.equal(value.FakeWebSocket.instances.length, 0);
}

async function pairingAlarmPeriodScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => jsonResponse(pairingOffer()),
  });
  await importWorker("pairing-alarm-period");
  const result = await sendRuntime(value, { type: "morrow_pair" });
  assert.equal(result.ok, true);
  assert.deepEqual(value.alarmCreations, [{ name: "morrow-pairing", options: { periodInMinutes: 1 } }]);
  assert.equal(value.createdTabs.length, 1);
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
  // The bound guards against hanging on the never-settling cancel(), not
  // against scheduling jitter: the settle itself never awaits the cancel.
  assert.ok(Date.now() - startedAt < 2000);
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
  "command-admission-cancel": commandAdmissionCancellationScenario,
  "edit-policy-cancel": () => editPolicyCancellationScenario("cancel"),
  "edit-policy-expiry": () => editPolicyCancellationScenario("expiry"),
  "maintenance-cancel": () => maintenanceMutationScenario("cancel"),
  "maintenance-expiry": () => maintenanceMutationScenario("expiry"),
  "permission-removal-publication": permissionRemovalPublicationScenario,
  "handshake-backoff": handshakeBackoffScenario,
  "unscoped-canvas-read": unscopedCanvasReadScenario,
  "course-file-deadline": courseFileDeadlineScenario,
  "settings-discovery-consent": settingsDiscoveryConsentScenario,
  "settings-selection-consent": settingsSelectionConsentScenario,
  "settings-policy-consent": settingsPolicyConsentScenario,
  "pairing-offer-consent": pairingOfferConsentScenario,
  "pairing-status-consent": pairingStatusConsentScenario,
  "pairing-alarm-period": pairingAlarmPeriodScenario,
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

test("a cancellation reaches a command while its async admission check is pending", async () => {
  await isolatedScenario("command-admission-cancel");
});

test("cancellation fences a queued Edit-policy mutation", async () => {
  await isolatedScenario("edit-policy-cancel");
});

test("expiresAt fences a queued Edit-policy mutation", async () => {
  await isolatedScenario("edit-policy-expiry");
});

test("expiresAt fences a Bridge maintenance mutation", async () => {
  await isolatedScenario("maintenance-expiry");
});

test("cancellation fences a Bridge maintenance mutation", async () => {
  await isolatedScenario("maintenance-cancel");
});

test("permission removal immediately publishes an unavailable binding", async () => {
  await isolatedScenario("permission-removal-publication");
});

test("a silent socket hits its client handshake deadline and retries with capped backoff", async () => {
  await isolatedScenario("handshake-backoff");
});

test("unscoped Canvas reads are refused without provider execution", async () => {
  await isolatedScenario("unscoped-canvas-read");
});

test("an expired private file read starts no provider execution after its permission check", async () => {
  await isolatedScenario("course-file-deadline");
});

test("consent withdrawal fences a late Settings course discovery", async () => {
  await isolatedScenario("settings-discovery-consent");
});

test("consent withdrawal fences a late Settings course selection", async () => {
  await isolatedScenario("settings-selection-consent");
});

test("consent withdrawal fences a late Settings Edit-policy save", async () => {
  await isolatedScenario("settings-policy-consent");
});

test("consent withdrawal fences a late pairing offer", async () => {
  await isolatedScenario("pairing-offer-consent");
});

test("consent withdrawal fences a late pairing approval", async () => {
  await isolatedScenario("pairing-status-consent");
});

test("pairing uses the one-minute alarm floor supported by Chrome 116", async () => {
  await isolatedScenario("pairing-alarm-period");
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
