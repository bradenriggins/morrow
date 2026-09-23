import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import nodeTest from "node:test";
import { clearExtensionGlobals, loadExtensionPage } from "./lib/extension-dom.mjs";

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
const pairingUrl = "http://127.0.0.1:32147/morrow-bridge/v1/pair";
const pairingConfirmUrl = `${pairingUrl}/${pairingId}/confirm`;
const pairingChallenge = "c".repeat(43);
// The marker Morrow writes into the Bridge folder it set up. Its nonce is the pairing key.
const activeFolderMarker = {
  schema: "morrow.bridge.active-folder-challenge.v1",
  challengeId: "morrow-0123456789abcdef0123456789abcdef",
  extensionId,
  manifestVersion: "1.0.4",
  nonce: "n".repeat(43),
};

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
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

function fixture({ initialLocal = connectedState(), holdCatalog = false, loopbackFetch, tabMessage, failScriptInjection = false, tabs: tabOverrides = {}, folderMarker = null } = {}) {
  const local = storageArea(initialLocal);
  const session = storageArea({});
  const runtimeMessages = event();
  const runtimeStartup = event();
  const storageChanged = event();
  const permissionAdded = event();
  const permissionRemoved = event();
  const tabsUpdated = event();
  const granted = new Set(initialLocal.siteAnchors?.length ? [coursePermission] : []);
  const permissionRemovals = [];
  const createdTabs = [];
  const removedTabs = [];
  const alarmCreations = [];
  const alarmClears = [];
  const alarmFired = event();
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
    if (relative === "morrow-bridge-active-folder.json") {
      return folderMarker
        ? new Response(JSON.stringify(folderMarker), { headers: { "content-type": "application/json" } })
        : new Response("", { status: 404 });
    }
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
      onAlarm: alarmFired,
    },
    tabs: {
      get: tabOverrides.get ?? (async (id) => id === 9 ? { id: 9, windowId: 4, url: `${courseOrigin}/courses/42` } : null),
      query: tabOverrides.query ?? (async () => [{ id: 9, windowId: 4, url: `${courseOrigin}/courses/42` }]),
      create: async (value) => { createdTabs.push(value); return { id: 70 + createdTabs.length }; },
      remove: async (tabId) => { removedTabs.push(tabId); },
      update: async () => null,
      sendMessage: async (tabId, message, options) => tabMessage
        ? await tabMessage({ tabId, message, options })
        : message?.type === "morrow_canvas_probe"
          ? { ok: true, profile: { origin: courseOrigin, id: "7" } }
          : null,
      onRemoved: noOpEvent(),
      onUpdated: tabsUpdated,
    },
    scripting: {
      executeScript: async (injection) => {
        scriptExecutions.push(injection);
        if (failScriptInjection && injection.files?.includes("src/canvas-content.js")) throw new Error("transient injection failure");
        return injection.func ? [{ result: { ok: false } }] : [{ result: null }];
      },
    },
    webNavigation: { getAllFrames: async () => [], onCommitted: noOpEvent() },
    webRequest: { onBeforeSendHeaders: noOpEvent(), onBeforeRequest: noOpEvent(), onHeadersReceived: noOpEvent() },
  };
  return {
    FakeWebSocket,
    alarmClears,
    alarmFired,
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
    tabsUpdated,
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

function popupSender() {
  return { id: extensionId, url: `${extensionPrefix}popup/popup.html` };
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

async function existingCanvasListenerScenario() {
  let providerReads = 0;
  const value = fixture({
    failScriptInjection: true,
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_execute") {
        providerReads += 1;
        return { ok: true, sent: true, status: 200, truncated: false, data: { id: 42 } };
      }
      return null;
    },
  });
  await importWorker("existing-canvas-listener");
  const socket = await authenticate(value);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const command = bridgeCommand({ requestId: "request-existing-listener", operationId: "operation-existing-listener" });
  socket.receive(command);
  const result = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === command.requestId));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(providerReads, 1);
  assert.equal(value.scriptExecutions.some((injection) => injection.files?.includes("src/canvas-content.js")), false);
}

async function sameUrlReloadPublicationScenario() {
  const value = fixture();
  await importWorker("same-url-reload-publication");
  const socket = await authenticate(value);
  const before = socket.sent.filter((message) => message.schema === "morrow.bridge.bindings.v1").length;
  assert.equal(value.tabsUpdated.listeners.length, 1);
  value.tabsUpdated.listeners[0](9, { status: "complete" }, { id: 9, url: `${courseOrigin}/courses/42` });
  const after = await eventually(() => {
    const messages = socket.sent.filter((message) => message.schema === "morrow.bridge.bindings.v1");
    return messages.length > before ? messages.length : 0;
  });
  assert.equal(after, before + 1);
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

// WI-4.2 (F7): a policy-set merge unions the sent categories into an active grant. Edit is not
// timed, so neither grant carries an end time.
async function policySetMergeUnionScenario() {
  const value = fixture();
  await importWorker("policy-merge-union");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  assert.equal(options.ok, true);
  const editable = options.result.options.filter((candidate) => candidate.availability === "edit");
  assert.ok(editable.length >= 2, "fixture catalog must offer at least two editable categories");
  const [first, second] = editable;
  const initial = policySetCommand({
    requestId: "request-policy-merge-initial",
    operationId: "operation-policy-merge-initial",
    editPolicySet: { mode: "edit", selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 0, enabledCategories: [first.id] }] },
  });
  socket.receive(initial);
  const initialResult = await eventually(() => socket.sent.find((message) => message.requestId === initial.requestId));
  assert.equal(initialResult.ok, true);
  assert.equal(initialResult.result.entries[0].code, undefined);
  assert.equal(Object.hasOwn(value.local.values.editPolicies[bindingId], "expiresAt"), false, "a grant from a conversation must not end by itself");
  const merge = policySetCommand({
    requestId: "request-policy-merge-apply",
    operationId: "operation-policy-merge-apply",
    editPolicySet: {
      mode: "edit",
      merge: true,
      selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 1, enabledCategories: [second.id] }],
    },
  });
  socket.receive(merge);
  const mergeResult = await eventually(() => socket.sent.find((message) => message.requestId === merge.requestId));
  assert.equal(mergeResult.ok, true);
  assert.equal(mergeResult.result.entries[0].code, undefined);
  const merged = value.local.values.editPolicies[bindingId];
  assert.deepEqual(merged.enabledCategories, [first.id, second.id].sort());
  assert.equal(Object.hasOwn(merged, "expiresAt"), false);
  assert.equal(merged.revision, 2);
}

// WI-4.2: with no active grant to merge into, a merge command ("remember this kind") starts a
// fresh grant, and that grant has no end time.
async function policySetMergeFreshGrantScenario() {
  const value = fixture();
  await importWorker("policy-merge-fresh");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  assert.ok(category);
  const merge = policySetCommand({
    requestId: "request-policy-merge-fresh",
    operationId: "operation-policy-merge-fresh",
    editPolicySet: {
      mode: "edit",
      merge: true,
      selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 0, enabledCategories: [category.id] }],
    },
  });
  socket.receive(merge);
  const result = await eventually(() => socket.sent.find((message) => message.requestId === merge.requestId));
  assert.equal(result.ok, true);
  assert.equal(result.result.entries[0].code, undefined);
  const granted = value.local.values.editPolicies[bindingId];
  assert.deepEqual(granted.enabledCategories, [category.id]);
  assert.equal(Object.hasOwn(granted, "expiresAt"), false);
}

// Edit is not timed, so a command that still names a duration is refused whole, and nothing is saved.
async function policySetDurationRefusedScenario() {
  const value = fixture();
  await importWorker("policy-duration-refused");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  const command = policySetCommand({
    requestId: "request-policy-duration",
    operationId: "operation-policy-duration",
    editPolicySet: {
      mode: "edit",
      merge: true,
      expiresInMs: 4 * 60 * 60 * 1_000,
      selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 0, enabledCategories: [category.id] }],
    },
  });
  socket.receive(command);
  const result = await eventually(() => socket.sent.find((message) => message.requestId === command.requestId));
  assert.equal(result.ok, false);
  assert.equal(result.problem.code, "edit_policy_set_invalid");
  assert.deepEqual(value.local.values.editPolicies, {});
}

/** A grant saved before Edit stopped being timed: the same shape, with its own end time in its scope. */
async function legacyTimedGrant(permission, binding, expiresAt) {
  const stable = (entry) => Array.isArray(entry) ? `[${entry.map(stable).join(",")}]`
    : entry && typeof entry === "object" ? `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${stable(entry[key])}`).join(",")}}`
      : JSON.stringify(entry === undefined ? null : entry);
  const scope = {
    schema: permission.schema, sourceBindingId: binding.sourceBindingId, provider: binding.provider, origin: binding.origin,
    siteUrl: binding.siteUrl || "", principalFingerprint: binding.principalFingerprint, courseId: binding.courseId || "",
    sessionGeneration: binding.sessionGeneration, catalogDigest: permission.catalogDigest, revision: permission.revision,
    expiresAt, enabledCategories: permission.enabledCategories, rules: permission.rules,
  };
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(scope))));
  return { ...permission, expiresAt, scopeDigest: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

// A merge into a grant saved while Edit was timed keeps that grant's own end time. It lapses to Plan
// then; a later conversation grant never turns it into Edit with no end.
async function policySetMergeLegacyTimedScenario() {
  const value = fixture();
  await importWorker("policy-merge-legacy");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const [first, second] = options.result.options.filter((candidate) => candidate.availability === "edit");
  const initial = policySetCommand({
    requestId: "request-policy-legacy-initial",
    operationId: "operation-policy-legacy-initial",
    editPolicySet: { mode: "edit", selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 0, enabledCategories: [first.id] }] },
  });
  socket.receive(initial);
  await eventually(() => socket.sent.find((message) => message.requestId === initial.requestId));
  const expiresAt = Date.now() + 60 * 60 * 1_000;
  value.local.values.editPolicies[bindingId] = await legacyTimedGrant(value.local.values.editPolicies[bindingId], connectedState().bindings[0], expiresAt);
  const status = await sendRuntime(value, { type: "morrow_edit_policy_status" }, settingsSender());
  assert.equal(status.result.bindings[0].editPermission?.expiresAt, expiresAt, "the legacy grant must still validate before its end time");
  const merge = policySetCommand({
    requestId: "request-policy-legacy-merge",
    operationId: "operation-policy-legacy-merge",
    editPolicySet: { mode: "edit", merge: true, selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 1, enabledCategories: [second.id] }] },
  });
  socket.receive(merge);
  const result = await eventually(() => socket.sent.find((message) => message.requestId === merge.requestId));
  assert.equal(result.ok, true);
  assert.equal(result.result.entries[0].code, undefined);
  const merged = value.local.values.editPolicies[bindingId];
  assert.deepEqual(merged.enabledCategories, [first.id, second.id].sort());
  assert.equal(merged.expiresAt, expiresAt);
}

// The popup reads Edit status and can return a course to Plan, the safe direction. Saving,
// granting, reading the Edit action list and course discovery stay with Plan and Edit settings, and
// every sender check is exact: this extension's id and the exact page address.
async function popupEditStatusScenario() {
  const value = fixture();
  await importWorker("popup-edit-status");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  const granted = await sendRuntime(value, { type: "morrow_edit_policy_save", sourceBindingId: bindingId, enabledCategories: [category.id] }, settingsSender());
  assert.equal(granted.ok, true);

  const status = await sendRuntime(value, { type: "morrow_edit_policy_status" }, popupSender());
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.result.bindings[0].sourceBindingId, bindingId);
  assert.deepEqual(status.result.bindings[0].editPermission.sourceBindingId, bindingId);
  assert.equal(Object.hasOwn(status.result, "privateChat"), false, "the popup's read carries no Private Chat conversation");

  for (const message of [
    { type: "morrow_edit_policy_save", sourceBindingId: bindingId, enabledCategories: [category.id] },
    { type: "morrow_edit_policy_options", sourceBindingId: bindingId },
    { type: "morrow_course_discovery_start", siteAnchorId: anchorId },
    { type: "morrow_course_selection_save", siteAnchorId: anchorId, discoveryReceiptId: "discovery:x", courseIds: ["42"] },
    { type: "morrow_private_chat_send", sourceBindingId: bindingId, text: "hi", assertedIdentifiers: ["x"] },
  ]) {
    const refused = await sendRuntime(value, message, popupSender());
    assert.equal(refused.ok, false, message.type);
    assert.match(refused.code, /_sender_refused$/, message.type);
  }
  for (const sender of [
    { id: "b".repeat(32), url: `${extensionPrefix}popup/popup.html` },
    { id: extensionId, url: `${extensionPrefix}popup/popup.html?x=1` },
    { id: extensionId, url: `${extensionPrefix}onboarding/onboarding.html` },
    { id: extensionId, url: "https://school.instructure.com/courses/42" },
  ]) {
    for (const type of ["morrow_edit_policy_status", "morrow_edit_policy_revoke"]) {
      const refused = await sendRuntime(value, { type, sourceBindingId: bindingId }, sender);
      assert.deepEqual(refused, { ok: false, code: "edit_policy_sender_refused", error: "edit_policy_sender_refused" }, `${type} from ${sender.url}`);
    }
  }
  assert.equal(Object.hasOwn(value.local.values.editPolicies, bindingId), true, "a refused sender changed nothing");

  const revoked = await sendRuntime(value, { type: "morrow_edit_policy_revoke", sourceBindingId: bindingId }, popupSender());
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.equal(revoked.result.revoked, true);
  assert.equal(Object.hasOwn(value.local.values.editPolicies, bindingId), false);
  socket.close(1000, "done");
}

function uiStateCommand(reviews, overrides = {}) {
  return bridgeCommand({
    requestId: `request-ui-state-${reviews.length}-${Math.random()}`,
    operationId: `operation-ui-state-${reviews.length}`,
    kind: "ui_state",
    toolName: undefined,
    operationKey: undefined,
    sourceBindingId: undefined,
    arguments: undefined,
    uiState: { reviews },
    ...overrides,
  });
}

// The reviews that wait belong to one Morrow connection. The popup is told as soon as they
// change, and they are gone, with their badge count, once that connection ends in any way.
async function reviewsFollowConnectionScenario(ending) {
  const value = fixture();
  const notices = [];
  const badge = [];
  globalThis.chrome.runtime.sendMessage = async (message) => { notices.push(message?.type); };
  globalThis.chrome.action = {
    setBadgeText: async ({ text }) => { badge.push(text); },
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  };
  await importWorker(`reviews-${ending}`);
  const socket = await authenticate(value);
  const reviews = [{ url: "http://127.0.0.1:44300/operations/op-12345678", label: "Update the syllabus page in Biology" }];
  notices.length = 0;
  const command = uiStateCommand(reviews);
  socket.receive(command);
  await eventually(() => socket.sent.find((message) => message.requestId === command.requestId));
  await eventually(() => notices.includes("morrow_bridge_status_changed"));
  assert.equal(badge.at(-1), "1");
  const waiting = await sendRuntime(value, { type: "morrow_status" });
  assert.deepEqual(waiting.result.reviews, reviews);

  notices.length = 0;
  if (ending === "socket") socket.close(1006, "transport_lost");
  else if (ending === "disconnect") assert.equal((await sendRuntime(value, { type: "morrow_disconnect" })).ok, true);
  else withdrawConsent(value);
  // Disconnect Morrow clears stored state, and the popup already reads again on that storage change.
  if (ending !== "disconnect") await eventually(() => notices.includes("morrow_bridge_status_changed"));
  await eventually(() => badge.at(-1) !== "1");
  assert.notEqual(badge.at(-1), "1", "the badge still counts reviews from an ended connection");
  if (ending !== "consent") {
    const after = await sendRuntime(value, { type: "morrow_status" });
    assert.deepEqual(after.result.reviews, [], "the popup still lists reviews from an ended connection");
  }
}

// One course can be disconnected on its own from Plan and Edit settings. Its connection, its Edit
// access and its first-read record go; the site, the other courses and Chrome site access stay, and
// the runtime learns the new course list at once.
async function courseDisconnectScenario() {
  const initial = connectedState();
  const other = { ...initial.bindings[0], sourceBindingId: `${anchorId}:c43`, courseId: "43", courseName: "Chemistry" };
  initial.bindings.push(other);
  const value = fixture({ initialLocal: initial });
  await importWorker("course-disconnect");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  assert.equal((await sendRuntime(value, { type: "morrow_edit_policy_save", sourceBindingId: bindingId, enabledCategories: [category.id] }, settingsSender())).ok, true);
  const revisionBefore = value.local.values.editPolicyRevisions[bindingId];

  const refused = await sendRuntime(value, { type: "morrow_course_disconnect", sourceBindingId: bindingId }, popupSender());
  assert.deepEqual(refused, { ok: false, code: "edit_policy_sender_refused", error: "edit_policy_sender_refused" });
  assert.equal(value.local.values.bindings.length, 2);

  const sentBefore = socket.sent.length;
  const result = await sendRuntime(value, { type: "morrow_course_disconnect", sourceBindingId: bindingId }, settingsSender());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { disconnected: true, sourceBindingId: bindingId });
  assert.deepEqual(value.local.values.bindings.map((binding) => binding.sourceBindingId), [other.sourceBindingId]);
  assert.equal(Object.hasOwn(value.local.values.editPolicies, bindingId), false);
  assert.ok(value.local.values.editPolicyRevisions[bindingId] > revisionBefore, "a change prepared under the old access must not apply later");
  assert.equal(value.local.values.siteAnchors.length, 1, "the site stays connected for its other courses");
  assert.deepEqual(value.permissionRemovals, [], "Chrome site access stays for the other courses");
  const published = socket.sent.slice(sentBefore).filter((message) => message.schema === "morrow.bridge.bindings.v1").at(-1);
  assert.deepEqual(published.bindings.map((binding) => binding.sourceBindingId), [other.sourceBindingId]);

  const missing = await sendRuntime(value, { type: "morrow_course_disconnect", sourceBindingId: bindingId }, settingsSender());
  assert.deepEqual(missing, { ok: false, code: "edit_policy_binding_missing", error: "edit_policy_binding_missing" });
}

// Plan and Edit settings saves Edit access with no duration, and the saved grant has no end time.
// Canvas's "Update/create page" routes create a page Canvas does not hold, and the front page route
// creates a published front page when the course has none. Edit access changes only a page that
// exists, so the Bridge reads the page right before an Edit change on either route and sends
// nothing when Canvas does not hold it. A reviewed change is not read first.
async function editScopePageCreateScenario() {
  const lesson = { page_id: "91", url: "lesson", title: "Cell structure", body: "<p>Cells have membranes.</p>", published: true, front_page: false };
  const calls = [];
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type !== "morrow_canvas_execute") return null;
      const toolName = message.operation?.toolName;
      const args = message.arguments || {};
      if (toolName === "canvas_show_page_courses") {
        calls.push(`read:${args.url_or_id}`);
        return args.url_or_id === "lesson"
          ? { ok: true, sent: true, status: 200, truncated: false, data: lesson }
          : { ok: false, sent: true, status: 404, error: { message: "page not found" } };
      }
      if (toolName === "canvas_show_front_page_courses") {
        calls.push("read:front_page");
        return { ok: false, sent: true, status: 404, error: { message: "No front page has been set" } };
      }
      if (toolName === "canvas_update_create_page_courses" || toolName === "canvas_update_create_front_page_courses") {
        calls.push(`write:${args.url_or_id || "front_page"}`);
        return { ok: true, sent: true, status: 200, truncated: false, data: { ...lesson, url: args.url_or_id || "front", title: args.wiki_page_title } };
      }
      throw new Error(`unexpected Canvas operation ${toolName}`);
    },
  });
  await importWorker("edit-scope-page-create");
  const socket = await authenticate(value);
  const saved = await sendRuntime(value, { type: "morrow_edit_policy_save", sourceBindingId: bindingId, enabledCategories: ["canvas_pages_text"] }, settingsSender());
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const editScope = { kind: "edit_scope", policyDigest: saved.result.editPermission.scopeDigest, policyRevision: saved.result.editPermission.revision };
  const send = async (id, fields, authorization = editScope) => {
    const command = bridgeCommand({
      requestId: `request-${id}`,
      operationId: `operation-${id}`,
      kind: "invoke_write",
      outerGrant: { effectReceiptId: `effect:${id}`, authorization },
      ...fields,
    });
    socket.receive(command);
    return await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.result.v1" && message.requestId === command.requestId));
  };
  const page = (urlOrId) => ({
    toolName: "canvas_update_create_page_courses",
    operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses",
    arguments: { course_id: "42", url_or_id: urlOrId, wiki_page_title: "Unit 7" },
  });

  const missing = await send("page-missing", page("new-unit-7"));
  assert.equal(missing.ok, false, JSON.stringify(missing));
  assert.equal(missing.problem.code, "edit_policy_page_missing");
  assert.deepEqual(calls, ["read:new-unit-7"]);

  calls.length = 0;
  const frontPage = await send("front-page-missing", {
    toolName: "canvas_update_create_front_page_courses",
    operationKey: "PUT /v1/courses/{course_id}/front_page#update_create_front_page_courses",
    arguments: { course_id: "42", wiki_page_title: "Welcome" },
  });
  assert.equal(frontPage.ok, false, JSON.stringify(frontPage));
  assert.equal(frontPage.problem.code, "edit_policy_page_missing");
  assert.deepEqual(calls, ["read:front_page"]);

  calls.length = 0;
  await send("page-exists", page("lesson"));
  assert.equal(calls[0], "read:lesson");
  assert.ok(calls.includes("write:lesson"), JSON.stringify(calls));

  calls.length = 0;
  await send("page-reviewed", page("new-unit-8"), { kind: "review" });
  assert.equal(calls[0], "write:new-unit-8", "a reviewed change is sent as the educator approved it");
}

// Every Private Chat send that fails reaches the drawer with its own reason, so the educator reads
// the one step that helps: reopen the course, keep it open while Morrow reads the class list, fix
// the student list, or ask the assistant to start Private Chat again.
async function privateChatSendCodesScenario() {
  let tabOpen = true;
  let rosterReadable = false;
  const courseTab = { id: 9, windowId: 4, url: `${courseOrigin}/courses/42` };
  const value = fixture({
    tabs: {
      get: async (id) => (tabOpen && id === 9 ? courseTab : null),
      query: async () => (tabOpen ? [courseTab] : []),
    },
    tabMessage: async ({ message }) => {
      if (!tabOpen) return null;
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type !== "morrow_canvas_execute") return null;
      if (!rosterReadable) return { ok: false, sent: true, status: 500, error: { message: "unavailable" } };
      if (message.operation?.toolName === "canvas_list_users_in_course_users") {
        return { ok: true, sent: true, status: 200, truncated: false, data: [{ id: "101", name: "Maria Lopez", sortable_name: "Lopez, Maria", short_name: "Maria", login_id: "mlopez" }] };
      }
      if (message.operation?.toolName === "canvas_list_enrollments_courses") return { ok: true, sent: true, status: 200, truncated: false, data: [] };
      throw new Error(`unexpected Canvas operation ${message.operation?.toolName}`);
    },
  });
  await importWorker("private-chat-send-codes");
  const socket = await authenticate(value);
  const send = async (text, assertedIdentifiers) => {
    const answer = await sendRuntime(value, { type: "morrow_private_chat_send", sourceBindingId: bindingId, text, assertedIdentifiers }, settingsSender());
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.equal(answer.error, answer.code);
    return answer.code;
  };

  assert.equal(await send("How is Maria doing?", ["Maria"]), "private_chat_exchange_changed", "no assistant is waiting for a message");

  socket.receive({
    schema: "morrow.bridge.command.v1", protocolVersion: 1,
    requestId: "bridge:pc-listen-0001", operationId: "private-chat:pc-listen-0001",
    kind: "private_chat_exchange",
    arguments: { schema: "morrow.private-chat.exchange.v1", sessionId: "session-0001", assistantName: "Claude", action: "listen" },
    generation: 9, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await sendRuntime(value, { type: "morrow_edit_policy_status" }, settingsSender());
    if (status.result?.privateChat?.waitingForMessage === true) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(await send("How is Maria doing?", ["Maria"]), "private_chat_roster_incomplete", "the class list could not be read");
  rosterReadable = true;
  assert.equal(await send("How is Jordan doing?", ["Jordan"]), "protected_request_identifier_unknown", "a listed student is not in the course");
  assert.equal(await send("How is she doing?", ["Maria Lopez"]), "protected_request_assertion_missing", "a listed student is not in the message");
  tabOpen = false;
  assert.equal(await send("How is Maria doing?", ["Maria"]), "private_chat_course_unavailable", "the course tab is closed");
}

async function settingsSaveUntimedScenario() {
  const value = fixture();
  await importWorker("settings-save-untimed");
  await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  const saved = await sendRuntime(value, { type: "morrow_edit_policy_save", sourceBindingId: bindingId, enabledCategories: [category.id] }, settingsSender());
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(Object.hasOwn(saved.result.editPermission, "expiresAt"), false);
  assert.equal(Object.hasOwn(value.local.values.editPolicies[bindingId], "expiresAt"), false);
  const status = await sendRuntime(value, { type: "morrow_edit_policy_status" }, settingsSender());
  assert.equal(Object.hasOwn(status.result, "editDurations"), false, "the settings page is offered no Edit length");
  assert.equal(status.result.bindings[0].editPermission.sourceBindingId, bindingId);
}

// WI-4.2: a merge is still refused, like any other selection, when the sender's expected
// revision is stale, and it leaves the active grant untouched.
async function policySetMergeStaleRevisionScenario() {
  const value = fixture();
  await importWorker("policy-merge-stale-revision");
  const socket = await authenticate(value);
  const options = await sendRuntime(value, { type: "morrow_edit_policy_options", sourceBindingId: bindingId }, settingsSender());
  const editable = options.result.options.filter((candidate) => candidate.availability === "edit");
  assert.ok(editable.length >= 2);
  const [first, second] = editable;
  const initial = policySetCommand({
    requestId: "request-policy-merge-stale-initial",
    operationId: "operation-policy-merge-stale-initial",
    editPolicySet: { mode: "edit", selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 0, enabledCategories: [first.id] }] },
  });
  socket.receive(initial);
  await eventually(() => socket.sent.find((message) => message.requestId === initial.requestId));
  const before = value.local.values.editPolicies[bindingId];
  const merge = policySetCommand({
    requestId: "request-policy-merge-stale-apply",
    operationId: "operation-policy-merge-stale-apply",
    editPolicySet: {
      mode: "edit",
      merge: true,
      selections: [{ sourceBindingId: bindingId, expectedPolicyRevision: 0, enabledCategories: [second.id] }],
    },
  });
  socket.receive(merge);
  const result = await eventually(() => socket.sent.find((message) => message.requestId === merge.requestId));
  assert.equal(result.ok, true);
  assert.equal(result.result.entries[0].code, "edit_policy_revision_stale");
  assert.deepEqual(value.local.values.editPolicies[bindingId], before);
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

async function restartedTabReattachScenario() {
  // Chrome restarted: the anchored tab 9 no longer exists, and the course is open again as tab 12.
  const probedTabs = [];
  const value = fixture({
    tabs: {
      get: async (id) => id === 12 ? { id: 12, windowId: 5, url: `${courseOrigin}/courses/42`, active: true } : null,
      query: async () => [
        { id: 11, windowId: 5, url: "https://other.instructure.com/courses/1" },
        { id: 12, windowId: 5, url: `${courseOrigin}/courses/42`, active: true },
      ],
    },
    tabMessage: async ({ tabId, message }) => {
      if (message?.type !== "morrow_canvas_probe") return null;
      probedTabs.push(tabId);
      return tabId === 12 ? { ok: true, profile: { origin: courseOrigin, id: "7" } } : null;
    },
  });
  await importWorker("restarted-tab-reattach");
  const socket = await authenticate(value);
  const hello = socket.sent.find((message) => message.schema === "morrow.bridge.hello.v1");
  assert.equal(hello.bindings[0].sourceBindingId, bindingId);
  assert.equal(hello.bindings[0].runtimeVerified, true);
  assert.equal(value.local.values.siteAnchors[0].tabId, 12);
  assert.ok(probedTabs.includes(12));
  assert.ok(!probedTabs.includes(11));
}

async function restartedTabDifferentAccountScenario() {
  // The course is open again, but signed in as a different account: the connection stays unverified.
  const value = fixture({
    tabs: {
      get: async () => null,
      query: async () => [{ id: 12, windowId: 5, url: `${courseOrigin}/courses/42`, active: true }],
    },
    tabMessage: async ({ message }) => message?.type === "morrow_canvas_probe"
      ? { ok: true, profile: { origin: courseOrigin, id: "8" } }
      : null,
  });
  await importWorker("restarted-tab-different-account");
  const socket = await authenticate(value);
  const hello = socket.sent.find((message) => message.schema === "morrow.bridge.hello.v1");
  assert.equal(hello.bindings[0].runtimeVerified, false);
  assert.equal(value.local.values.siteAnchors[0].tabId, 9);
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

async function suspendedReconnectAlarmScenario() {
  const value = fixture();
  await importWorker("suspended-reconnect-alarm");
  const active = await authenticate(value);
  assert.ok(value.alarmCreations.some((entry) => entry.name === "morrow-bridge-reconnect" && entry.options?.periodInMinutes === 1));
  // A suspended worker loses every pending timer, so the backoff retry never runs.
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => (delay >= 2_000 && delay <= 30_000 && delay !== 10_000
    ? 0
    : nativeSetTimeout(callback, delay, ...args));
  try {
    active.close(1006, "transport_lost");
    await new Promise((resolve) => nativeSetTimeout(resolve, 30));
    assert.equal(value.FakeWebSocket.instances.length, 1);
    for (const listener of value.alarmFired.listeners) listener({ name: "morrow-bridge-reconnect" });
    const reconnected = await eventually(() => value.FakeWebSocket.instances[1]);
    assert.equal(reconnected.readyState, value.FakeWebSocket.CONNECTING);
    // An open connection ignores a later alarm instead of opening a second socket.
    await authenticate(value, 10, 1);
    for (const listener of value.alarmFired.listeners) listener({ name: "morrow-bridge-reconnect" });
    await new Promise((resolve) => nativeSetTimeout(resolve, 30));
    assert.equal(value.FakeWebSocket.instances.length, 2);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
}

async function unscopedCanvasReadScenario() {
  const executed = [];
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_execute") {
        executed.push(message);
        return { ok: true, sent: true, status: 200, truncated: false, data: [] };
      }
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
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  // A read that names no course is a site request: the page receives it marked as one, for the
  // connection's own tab and signed-in person.
  assert.deepEqual(executed.map((message) => [message.operation.toolName, message.operation.morrowAuthority, message.principalId]), [
    ["canvas_activity_stream_summary", "site", "7"],
    ["canvas_list_bookmarks", "site", "7"],
  ]);
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

async function discoveryOptionalFieldsScenario() {
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_list_courses") {
        return {
          ok: true,
          profile: { origin: courseOrigin, id: "7" },
          courses: [{ id: "55", name: "Biology", code: "BIO-101", term: "Fall 2026", role: "TeacherEnrollment", favorite: true, published: true }],
          pageUrl: `${courseOrigin}/api/v1/courses?per_page=100`,
          nextUrl: null,
          complete: true,
        };
      }
      return null;
    },
  });
  await importWorker("discovery-optional-fields");
  const result = await sendRuntime(value, { type: "morrow_course_discovery_start", siteAnchorId: anchorId }, settingsSender());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.courses, [
    { id: "55", name: "Biology", code: "BIO-101", term: "Fall 2026", role: "TeacherEnrollment", favorite: true, published: true },
  ]);
  assert.deepEqual(value.local.values.courseMeta, {
    [`${courseOrigin}|55`]: { name: "Biology", code: "BIO-101", term: "Fall 2026", role: "TeacherEnrollment", favorite: true, published: true },
  });
}

async function discoveryUnknownFieldRefusedScenario() {
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_list_courses") {
        return {
          ok: true,
          profile: { origin: courseOrigin, id: "7" },
          courses: [{ id: "55", name: "Biology", grade: "A" }],
          pageUrl: `${courseOrigin}/api/v1/courses?per_page=100`,
          nextUrl: null,
          complete: true,
        };
      }
      return null;
    },
  });
  await importWorker("discovery-unknown-field-refused");
  const result = await sendRuntime(value, { type: "morrow_course_discovery_start", siteAnchorId: anchorId }, settingsSender());
  assert.equal(result.ok, false);
  assert.equal(result.code, "course_discovery_failed");
  assert.equal(value.local.values.courseMeta, undefined);
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

async function connectionWritesCourseMetaScenario() {
  const value = fixture({
    tabMessage: async ({ message }) => {
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin: courseOrigin, id: "7" } };
      if (message?.type === "morrow_canvas_check_course") {
        return { ok: true, profile: { origin: courseOrigin, id: "7" }, course: { id: "43", name: "Chemistry", code: "CHEM-201", favorite: false, published: true } };
      }
      return null;
    },
  });
  const receiptId = "discovery:connection-writes-course-meta";
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
  value.session.values.courseDiscoveries = { [receiptId]: receipt };
  await importWorker("connection-writes-course-meta");
  const result = await sendRuntime(value, {
    type: "morrow_course_selection_save",
    siteAnchorId: anchorId,
    discoveryReceiptId: receiptId,
    courseIds: ["43"],
  }, settingsSender());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(value.local.values.courseMeta, {
    [`${courseOrigin}|43`]: { name: "Chemistry", code: "CHEM-201", favorite: false, published: true },
  });
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
    schema: "morrow.bridge.pairing.v2",
    pairingId,
    challenge: pairingChallenge,
    confirmUrl: pairingConfirmUrl,
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

async function expectedPairingProof() {
  const { bridgePairingProofPayload } = await import(new URL("packages/bridge-protocol/dist/index.js", root));
  return createHmac("sha256", Buffer.from(activeFolderMarker.nonce, "utf8"))
    .update(bridgePairingProofPayload({ pairingId, challenge: pairingChallenge, extensionId, activeFolderChallengeId: activeFolderMarker.challengeId }))
    .digest("base64url");
}

/** A Morrow that pairs a Bridge only for the proof made with the folder secret, as the loopback server does. */
function pairingMorrow(requests, { confirm } = {}) {
  return async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (url === pairingUrl) return jsonResponse(pairingOffer(), { status: 201 });
    if (url === pairingConfirmUrl) {
      if (confirm) return await confirm(JSON.parse(init.body));
      return JSON.parse(init.body).proof === await expectedPairingProof()
        ? jsonResponse({ schema: "morrow.bridge.pairing-result.v2", status: "approved", token })
        : jsonResponse({ error: "pairing_proof_refused" }, { status: 403 });
    }
    throw new Error(`unexpected pairing request: ${url}`);
  };
}

// Connect Morrow pairs in one step: Morrow sends a challenge, the Bridge signs it with the secret in
// the Bridge folder Morrow set up, and Morrow answers that one proof with the token. No page opens.
async function pairingProofScenario() {
  const requests = [];
  const value = fixture({ initialLocal: { [consentKey]: consentValue }, folderMarker: activeFolderMarker, loopbackFetch: pairingMorrow(requests) });
  await importWorker("pairing-proof");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: true, result: { paired: true } });
  assert.deepEqual(requests.map((request) => request.url), [pairingUrl, pairingConfirmUrl]);
  assert.deepEqual(requests[1].body, {
    extensionId,
    activeFolderChallengeId: activeFolderMarker.challengeId,
    proof: await expectedPairingProof(),
  });
  assert.equal(JSON.stringify(requests[0].body).includes(activeFolderMarker.nonce), false, "the folder secret never leaves the Bridge");
  assert.equal(JSON.stringify(requests[1].body).includes(activeFolderMarker.nonce), false, "the folder secret never leaves the Bridge");
  assert.equal(value.local.values.token, token);
  assert.equal(value.local.values.pairingAuthority.status, "approved");
  assert.deepEqual(value.createdTabs, [], "pairing opens no page for another program to answer");
  assert.deepEqual(value.alarmCreations.filter((alarm) => alarm.name !== "morrow-bridge-reconnect"), []);
  await eventually(() => value.FakeWebSocket.instances.length === 1);
  const status = await sendRuntime(value, { type: "morrow_status" }, popupSender());
  assert.equal(status.result.paired, true);
  assert.equal(Object.hasOwn(status.result, "pairing"), false);
}

// A Bridge loaded from a folder Morrow did not set up has no marker, so it can prove nothing and
// sends nothing to confirm.
async function pairingFolderUnconfirmedScenario() {
  const requests = [];
  const value = fixture({ initialLocal: { [consentKey]: consentValue }, loopbackFetch: pairingMorrow(requests) });
  await importWorker("pairing-folder-unconfirmed");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_folder_unconfirmed", error: "bridge_pairing_folder_unconfirmed" });
  assert.deepEqual(requests.map((request) => request.url), [pairingUrl]);
  assert.equal(value.local.values.token, undefined);
  assert.equal(value.local.values.pairingAuthority.status, "refused");
}

// Morrow refuses a proof that does not match the folder it set up, for example a marker a repair
// replaced since Chrome loaded this copy.
async function pairingProofRefusedScenario() {
  const requests = [];
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    folderMarker: activeFolderMarker,
    loopbackFetch: pairingMorrow(requests, { confirm: async () => jsonResponse({ error: "pairing_proof_refused" }, { status: 403 }) }),
  });
  await importWorker("pairing-proof-refused");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_folder_unconfirmed", error: "bridge_pairing_folder_unconfirmed" });
  assert.equal(value.local.values.token, undefined);
  assert.equal(value.FakeWebSocket.instances.length, 0);
}

// Only the Bridge's own popup and setup guide start a pairing. A content script cannot.
async function pairingSenderScenario() {
  const requests = [];
  const value = fixture({ initialLocal: { [consentKey]: consentValue }, folderMarker: activeFolderMarker, loopbackFetch: pairingMorrow(requests) });
  await importWorker("pairing-sender");
  for (const sender of [{}, { id: extensionId, url: `${courseOrigin}/courses/42`, tab: { id: 9 } }, { id: "b".repeat(32), url: `chrome-extension://${"b".repeat(32)}/popup/popup.html` }]) {
    const result = await sendRuntime(value, { type: "morrow_pair" }, sender);
    assert.deepEqual(result, { ok: false, code: "bridge_pairing_sender_refused", error: "bridge_pairing_sender_refused" });
  }
  assert.deepEqual(requests, []);
  const guide = await sendRuntime(value, { type: "morrow_pair" }, { id: extensionId, url: `${extensionPrefix}onboarding/onboarding.html`, tab: { id: 12 } });
  assert.deepEqual(guide, { ok: true, result: { paired: true } });
}

async function pairingOfferConsentScenario() {
  let fetchStarted = false;
  let releaseFetch;
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    folderMarker: activeFolderMarker,
    loopbackFetch: async () => {
      fetchStarted = true;
      await new Promise((resolve) => { releaseFetch = resolve; });
      return jsonResponse(pairingOffer(), { status: 201 });
    },
  });
  await importWorker("pairing-offer-consent");
  const pending = sendRuntime(value, { type: "morrow_pair" }, popupSender());
  await eventually(() => fetchStarted);
  withdrawConsent(value);
  releaseFetch();
  const result = await pending;
  assert.equal(result.ok, false);
  await eventually(() => value.local.values.pairingAuthority?.status === "consent_withdrawn");
  assert.equal(value.local.values.token, undefined);
  assert.deepEqual(value.createdTabs, []);
  assert.deepEqual(value.alarmCreations, []);
}

async function pairingConfirmConsentScenario() {
  let confirmStarted = false;
  let releaseConfirm;
  const requests = [];
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    folderMarker: activeFolderMarker,
    loopbackFetch: pairingMorrow(requests, {
      confirm: async () => {
        confirmStarted = true;
        await new Promise((resolve) => { releaseConfirm = resolve; });
        return jsonResponse({ schema: "morrow.bridge.pairing-result.v2", status: "approved", token });
      },
    }),
  });
  await importWorker("pairing-confirm-consent");
  const pending = sendRuntime(value, { type: "morrow_pair" }, popupSender());
  await eventually(() => confirmStarted);
  withdrawConsent(value);
  releaseConfirm();
  const result = await pending;
  assert.equal(result.ok, false);
  await eventually(() => value.local.values.pairingAuthority?.status === "consent_withdrawn");
  assert.equal(value.local.values.token, undefined);
  assert.equal(value.FakeWebSocket.instances.length, 0);
}

// Connect Morrow before the Morrow app is open: nothing answers at the local address, so the popup
// names that state, not a failure with no reason. A Morrow that answers and does not start a
// connection is its own state.
async function pairingNotRunningScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => { throw new TypeError("Failed to fetch"); },
  });
  await importWorker("pairing-not-running");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_not_connected", error: "bridge_not_connected" });
  assert.equal(value.local.values.token, undefined);
  assert.deepEqual(value.createdTabs, []);
}

async function pairingRefusedScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => jsonResponse({ error: "pairing_limit_reached" }, { status: 429 }),
  });
  await importWorker("pairing-refused");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_refused", error: "bridge_pairing_refused" });
  assert.equal(value.local.values.token, undefined);
  assert.deepEqual(value.createdTabs, []);
}

async function pairingDeclaredOverflowScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => jsonResponse(pairingOffer(), { headers: { "content-length": "4097" } }),
  });
  await importWorker("pairing-declared-overflow");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_too_large", error: "bridge_pairing_response_too_large" });
  assert.equal(value.local.values.token, undefined);
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
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_too_large", error: "bridge_pairing_response_too_large" });
  assert.equal(bodyCancelled, true);
  assert.equal(value.local.values.token, undefined);
}

// The catalog read has its own ten-second deadline. Loading the catalog before the pairing deadline
// is shortened keeps the shorter wait on the pairing response alone.
async function shortenPairingDeadline(value, delayMs) {
  await sendRuntime(value, { type: "morrow_status" });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 10_000 ? delayMs : delay, ...args);
}

async function pairingStalledBodyScenario() {
  let bodyCancelled = false;
  const body = new ReadableStream({ cancel() { bodyCancelled = true; } });
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    loopbackFetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await importWorker("pairing-stalled-body");
  await shortenPairingDeadline(value, 20);
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_timeout", error: "bridge_pairing_response_timeout" });
  assert.equal(bodyCancelled, true);
  assert.equal(value.local.values.token, undefined);
}

async function pairingStalledCancellationScenario() {
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
  await shortenPairingDeadline(value, 100);
  const startedAt = Date.now();
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_timeout", error: "bridge_pairing_response_timeout" });
  assert.equal(bodyCancelled, true);
  // The bound guards against hanging on the never-settling cancel(), not
  // against scheduling jitter: the settle itself never awaits the cancel.
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(value.local.values.token, undefined);
}

async function pairingOfferExactSchemaScenario() {
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    folderMarker: activeFolderMarker,
    loopbackFetch: async () => jsonResponse(pairingOffer({ unexpected: true })),
  });
  await importWorker("pairing-offer-exact-schema");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_invalid", error: "bridge_pairing_response_invalid" });
  assert.equal(value.local.values.token, undefined);
  assert.deepEqual(value.createdTabs, []);
}

async function pairingExactSchemaScenario() {
  const requests = [];
  const value = fixture({
    initialLocal: { [consentKey]: consentValue },
    folderMarker: activeFolderMarker,
    loopbackFetch: pairingMorrow(requests, {
      confirm: async () => jsonResponse({ schema: "morrow.bridge.pairing-result.v2", status: "approved", token, unexpected: true }),
    }),
  });
  await importWorker("pairing-exact-schema");
  const result = await sendRuntime(value, { type: "morrow_pair" }, popupSender());
  assert.deepEqual(result, { ok: false, code: "bridge_pairing_response_invalid", error: "bridge_pairing_response_invalid" });
  assert.equal(value.local.values.token, undefined);
  assert.equal(value.FakeWebSocket.instances.length, 0);
}

// Morrow closes a connection from a Bridge build it does not expect as a version mismatch, which is
// not a refused connection: the popup and the setup guide ask for a reload, not a new approval.
async function versionMismatchScenario() {
  const value = fixture();
  await importWorker("version-mismatch");
  const refused = await eventually(() => value.FakeWebSocket.instances[0]);
  refused.open();
  await eventually(() => refused.sent.find((message) => message.schema === "morrow.bridge.authenticate.v1"));
  refused.close(4403, "bridge_version_mismatch");
  const mismatch = await sendRuntime(value, { type: "morrow_status" }, popupSender());
  assert.deepEqual(
    [mismatch.result.paired, mismatch.result.connected, mismatch.result.authenticationFailed, mismatch.result.versionMismatch, mismatch.result.runtimeHealthy],
    [true, false, false, true, false],
  );
  // The next accepted connection, after the reload or the update, clears the state.
  value.alarmFired.listeners[0]({ name: "morrow-bridge-reconnect" });
  await authenticate(value, 9, 1);
  const healthy = await sendRuntime(value, { type: "morrow_status" }, popupSender());
  assert.deepEqual(
    [healthy.result.connected, healthy.result.authenticationFailed, healthy.result.versionMismatch, healthy.result.runtimeHealthy],
    [true, false, false, true],
  );
}

const otherOrigin = "https://other.instructure.com";
const otherAnchorId = "canvas:account:g2";

/**
 * Keeps the real worker running in this child process and answers a shipped page's runtime
 * messages over IPC, so a page test sees exactly the fields the worker sends. `site` names the
 * Chrome tabs open at the start: "closed-course" has none, and "two-sites" has a second saved
 * Canvas site open while the Biology course on the first site is closed. A tab the worker opens
 * loads, and a Canvas tab answers the probe as the saved account.
 */
async function servePagesScenario(site) {
  const tabs = site === "two-sites" ? [{ id: 11, windowId: 4, url: `${otherOrigin}/courses/7` }] : [];
  const initialLocal = connectedState();
  if (site === "two-sites") {
    initialLocal.siteAnchors.push({ ...initialLocal.siteAnchors[0], siteAnchorId: otherAnchorId, origin: otherOrigin, principalFingerprint: "e".repeat(64), tabId: 11 });
  }
  const value = fixture({
    initialLocal,
    tabs: {
      get: async (id) => tabs.find((tab) => tab.id === id) ?? null,
      query: async ({ url } = {}) => tabs.filter((tab) => typeof url !== "string" || tab.url.startsWith(url.replace(/\*$/, ""))),
    },
    tabMessage: async ({ tabId, message }) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) return null;
      const origin = new URL(tab.url).origin;
      if (message?.type === "morrow_canvas_probe") return { ok: true, profile: { origin, id: "7" } };
      // A signed-in Canvas tab lists the teacher's courses, as Plan and Edit settings asks once a site is verified.
      if (message?.type === "morrow_canvas_list_courses") {
        return { ok: true, profile: { origin, id: "7" }, courses: [{ id: "42", name: "Biology" }, { id: "43", name: "Chemistry" }], pageUrl: `${origin}/api/v1/courses?per_page=100`, nextUrl: null, complete: true };
      }
      return null;
    },
  });
  value.granted.add(`${otherOrigin}/*`);
  globalThis.chrome.tabs.create = async (properties) => {
    value.createdTabs.push(properties);
    const tab = { id: 70 + value.createdTabs.length, windowId: 4, url: properties.url };
    tabs.push(tab);
    setTimeout(() => { for (const listener of [...value.tabsUpdated.listeners]) listener(tab.id, { status: "complete" }, tab); }, 0);
    return tab;
  };
  await importWorker(`serve-${site}`);
  await authenticate(value);
  const senders = { settings: settingsSender(), popup: popupSender() };
  process.on("message", async ({ id, kind, page, message }) => {
    const response = kind === "tabsCreated"
      ? value.createdTabs
      : await sendRuntime(value, message, senders[page]).catch((cause) => ({ ok: false, code: "message_refused", error: String(cause?.message || cause) }));
    process.send({ id, response });
  });
  process.send({ ready: true });
}

const scenarios = {
  "consent-connect": consentConnectScenario,
  "consent-pre-effect": () => preEffectScenario("consent"),
  "socket-pre-effect": () => preEffectScenario("socket"),
  "started-write": startedWriteScenario,
  "socket-read": socketReadScenario,
  "existing-canvas-listener": existingCanvasListenerScenario,
  "same-url-reload-publication": sameUrlReloadPublicationScenario,
  "late-permission": latePermissionScenario,
  "command-admission-cancel": commandAdmissionCancellationScenario,
  "edit-policy-cancel": () => editPolicyCancellationScenario("cancel"),
  "edit-policy-expiry": () => editPolicyCancellationScenario("expiry"),
  "policy-merge-union": policySetMergeUnionScenario,
  "policy-merge-fresh": policySetMergeFreshGrantScenario,
  "policy-duration-refused": policySetDurationRefusedScenario,
  "policy-merge-legacy": policySetMergeLegacyTimedScenario,
  "settings-save-untimed": settingsSaveUntimedScenario,
  "edit-scope-page-create": editScopePageCreateScenario,
  "private-chat-send-codes": privateChatSendCodesScenario,
  "popup-edit-status": popupEditStatusScenario,
  "course-disconnect": courseDisconnectScenario,
  "reviews-socket": () => reviewsFollowConnectionScenario("socket"),
  "reviews-disconnect": () => reviewsFollowConnectionScenario("disconnect"),
  "reviews-consent": () => reviewsFollowConnectionScenario("consent"),
  "policy-merge-stale-revision": policySetMergeStaleRevisionScenario,
  "maintenance-cancel": () => maintenanceMutationScenario("cancel"),
  "maintenance-expiry": () => maintenanceMutationScenario("expiry"),
  "permission-removal-publication": permissionRemovalPublicationScenario,
  "restarted-tab-reattach": restartedTabReattachScenario,
  "restarted-tab-different-account": restartedTabDifferentAccountScenario,
  "handshake-backoff": handshakeBackoffScenario,
  "unscoped-canvas-read": unscopedCanvasReadScenario,
  "course-file-deadline": courseFileDeadlineScenario,
  "settings-discovery-consent": settingsDiscoveryConsentScenario,
  "discovery-optional-fields": discoveryOptionalFieldsScenario,
  "discovery-unknown-field-refused": discoveryUnknownFieldRefusedScenario,
  "connection-writes-course-meta": connectionWritesCourseMetaScenario,
  "settings-selection-consent": settingsSelectionConsentScenario,
  "settings-policy-consent": settingsPolicyConsentScenario,
  "pairing-proof": pairingProofScenario,
  "pairing-folder-unconfirmed": pairingFolderUnconfirmedScenario,
  "pairing-proof-refused": pairingProofRefusedScenario,
  "pairing-sender": pairingSenderScenario,
  "pairing-offer-consent": pairingOfferConsentScenario,
  "pairing-confirm-consent": pairingConfirmConsentScenario,
  "suspended-reconnect-alarm": suspendedReconnectAlarmScenario,
  "pairing-declared-overflow": pairingDeclaredOverflowScenario,
  "pairing-stream-overflow": pairingStreamOverflowScenario,
  "pairing-stalled-body": pairingStalledBodyScenario,
  "pairing-stalled-cancellation": pairingStalledCancellationScenario,
  "pairing-offer-exact-schema": pairingOfferExactSchemaScenario,
  "pairing-exact-schema": pairingExactSchemaScenario,
  "version-mismatch": versionMismatchScenario,
  "pairing-not-running": pairingNotRunningScenario,
  "pairing-refused": pairingRefusedScenario,
};

async function runScenario(name) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);
  await scenario();
}

const scenarioName = process.argv[2];
// A scenario child runs only its scenario. The served-pages child stays alive
// after its scenario, so it must not register this file's tests: each would
// fork another served child, without end.
const test = scenarioName ? () => undefined : nodeTest;
if (scenarioName === "serve-pages") {
  await servePagesScenario(process.argv[3]);
} else if (scenarioName) {
  await runScenario(scenarioName);
  process.stdout.write(`${scenarioName}: ok\n`);
  process.exit(0);
}

const execute = promisify(execFile);
/** A real worker in a child process, and the page handlers that send each message to it. */
async function servedWorker(site) {
  const child = fork(fileURLToPath(import.meta.url), ["serve-pages", site], { cwd: fileURLToPath(root), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waiting = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`the served worker exited with ${code}: ${stderr}`)));
    child.on("message", (reply) => {
      if (reply?.ready) resolve();
      else waiting.get(reply?.id)?.(reply.response);
    });
  });
  await ready;
  const ask = (request) => new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.send({ id, ...request });
  });
  return {
    handlers: (page) => new Proxy({}, { get: (_target, type) => typeof type === "string" ? (message) => ask({ kind: "message", page, message }) : undefined }),
    tabsCreated: () => ask({ kind: "tabsCreated" }),
    close: () => { child.removeAllListeners("exit"); child.kill(); },
  };
}

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

test("a ready Canvas listener completes a read when script reinjection is unavailable", async () => {
  await isolatedScenario("existing-canvas-listener");
});

test("a same-URL course reload republishes the freshly probed binding", async () => {
  await isolatedScenario("same-url-reload-publication");
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

test("a policy-set merge unions new categories into an active grant, and neither grant ends by itself", async () => {
  await isolatedScenario("policy-merge-union");
});

test("a policy-set merge with no active grant starts a fresh grant with no end time", async () => {
  await isolatedScenario("policy-merge-fresh");
});

test("a policy-set that still names a duration is refused and saves nothing", async () => {
  await isolatedScenario("policy-duration-refused");
});

test("a policy-set merge into a grant saved with an end time keeps that end time", async () => {
  await isolatedScenario("policy-merge-legacy");
});

test("the popup reads Edit status and returns a course to Plan, and nothing else, from its exact page", async () => {
  await isolatedScenario("popup-edit-status");
});

test("reviews that wait reach the open popup at once, and a closed Morrow connection clears them and their badge", async () => {
  await isolatedScenario("reviews-socket");
});

test("Disconnect Morrow clears the reviews that wait and their badge", async () => {
  await isolatedScenario("reviews-disconnect");
});

test("withdrawing course data consent clears the reviews that wait and their badge", async () => {
  await isolatedScenario("reviews-consent");
});

test("Plan and Edit settings disconnects one course, its Edit access, and nothing else", async () => {
  await isolatedScenario("course-disconnect");
});

test("a Settings save creates Edit access with no end time", async () => {
  await isolatedScenario("settings-save-untimed");
});

test("a policy-set merge is refused, and leaves the active grant untouched, on a stale revision", async () => {
  await isolatedScenario("policy-merge-stale-revision");
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

test("a course connection moves to a restarted tab signed in as the same account", async () => {
  await isolatedScenario("restarted-tab-reattach");
});

test("a course connection stays unverified when the reopened tab is a different account", async () => {
  await isolatedScenario("restarted-tab-different-account");
});

test("a silent socket hits its client handshake deadline and retries with capped backoff", async () => {
  await isolatedScenario("handshake-backoff");
});

test("a paired Bridge reconnects from its alarm after a suspended worker lost its retry timer", async () => {
  await isolatedScenario("suspended-reconnect-alarm");
});

test("Canvas reads that name no course reach the page as site requests", async () => {
  await isolatedScenario("unscoped-canvas-read");
});

test("an expired private file read starts no provider execution after its permission check", async () => {
  await isolatedScenario("course-file-deadline");
});

test("consent withdrawal fences a late Settings course discovery", async () => {
  await isolatedScenario("settings-discovery-consent");
});

test("discovery passes through code, term, role, favorite and published, and writes courseMeta keyed by origin and course id", async () => {
  await isolatedScenario("discovery-optional-fields");
});

test("discovery refuses a course carrying a key outside the optional-field allow list", async () => {
  await isolatedScenario("discovery-unknown-field-refused");
});

test("connecting a course writes its optional fields into courseMeta keyed by origin and course id", async () => {
  await isolatedScenario("connection-writes-course-meta");
});

test("consent withdrawal fences a late Settings course selection", async () => {
  await isolatedScenario("settings-selection-consent");
});

test("an Edit change on a Canvas Update/create page route is sent only when Canvas holds the page", async () => {
  await isolatedScenario("edit-scope-page-create");
});

test("a Private Chat send that fails names its own reason to the drawer", async () => {
  await isolatedScenario("private-chat-send-codes");
});

test("consent withdrawal fences a late Settings Edit-policy save", async () => {
  await isolatedScenario("settings-policy-consent");
});

test("consent withdrawal fences a late pairing offer", async () => {
  await isolatedScenario("pairing-offer-consent");
});

test("consent withdrawal fences a late pairing confirmation", async () => {
  await isolatedScenario("pairing-confirm-consent");
});

test("Connect Morrow pairs by signing Morrow's challenge with the Bridge folder secret, and opens no page", async () => {
  await isolatedScenario("pairing-proof");
});

test("a Bridge with no folder secret from Morrow cannot pair, and names the folder to load", async () => {
  await isolatedScenario("pairing-folder-unconfirmed");
});

test("a proof Morrow refuses pairs nothing", async () => {
  await isolatedScenario("pairing-proof-refused");
});

test("only the popup and the setup guide start a pairing", async () => {
  await isolatedScenario("pairing-sender");
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

test("pairing ignores an approved answer with fields outside the exact schema", async () => {
  await isolatedScenario("pairing-exact-schema");
});

test("Connect Morrow with the Morrow app closed says Morrow is not running", async () => {
  await isolatedScenario("pairing-not-running");
});

test("a Morrow that answers Connect Morrow without starting a connection is named as that", async () => {
  await isolatedScenario("pairing-refused");
});

test("a version mismatch names a reload, not a refused connection", async () => {
  await isolatedScenario("version-mismatch");
});

// A shipped page must work with the fields the worker really sends, not a fixture's guess at them.
test("Plan and Edit settings reopens a closed course at its own address through the real worker", { timeout: 20_000 }, async (t) => {
  const worker = await servedWorker("closed-course");
  t.after(() => { worker.close(); clearExtensionGlobals(); });
  const page = await loadExtensionPage("settings/settings.html", { handlers: worker.handlers("settings") });
  const open = `[data-open-platform="${bindingId}"]`;
  assert.equal(page.text('[data-row-kind="attention"] .course-row-note'), "Canvas is closed. Morrow Bridge can open it for you.");
  assert.equal(page.text(open), "Open Canvas");
  await page.click(open);
  await page.waitFor(() => page.messages("morrow_open_platform").length === 1, "Open Canvas sent nothing to the worker");
  assert.deepEqual(page.messages("morrow_open_platform"), [{ type: "morrow_open_platform", siteAnchorId: anchorId, sourceBindingId: bindingId }]);
  await page.waitFor(() => page.queryAll(open).length === 0 && page.queryAll(`[data-binding-id="${bindingId}"]`).length === 1,
    "the reopened course never became connected");
  assert.deepEqual(await worker.tabsCreated(), [{ url: `${courseOrigin}/courses/42`, active: false }]);
  await page.waitFor(() => page.queryAll('[data-row-kind="available"]').length === 1,
    "the reopened site's other course was never listed");
  assert.equal(page.text('[data-row-kind="available"] .course-row-name'), "Chemistry");
  assert.equal(page.hidden("#error"), true);
});

test("the popup reopens the selected closed course, not a different saved site that is open", { timeout: 20_000 }, async (t) => {
  const worker = await servedWorker("two-sites");
  t.after(() => { worker.close(); clearExtensionGlobals(); });
  const page = await loadExtensionPage("popup/popup.html", { handlers: worker.handlers("popup") });
  assert.equal(page.text("#canvas-value"), "Canvas is closed");
  assert.equal(page.text("#open-platform-action"), "Open Canvas");
  await page.click("#open-platform-action");
  await page.waitFor(() => page.messages("morrow_open_platform").length === 1, "Open Canvas sent nothing to the worker");
  assert.deepEqual(page.messages("morrow_open_platform"), [{ type: "morrow_open_platform", siteAnchorId: anchorId, sourceBindingId: bindingId }]);
  await page.waitFor(() => page.text("#canvas-value") === "Connected", "the selected course never became connected");
  assert.deepEqual(await worker.tabsCreated(), [{ url: `${courseOrigin}/courses/42`, active: false }]);
  assert.equal(page.hidden("#error"), true);
});
