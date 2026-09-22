import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const extensionId = "a".repeat(32);
const extensionPrefix = `chrome-extension://${extensionId}/`;
const consentKey = "morrowCourseDataConsent";
const consentValue = "morrow.course-data-consent.v1";
const token = "t".repeat(32);

function proofPayload(direction, authentication, serverNonce) {
  return JSON.stringify([
    `morrow.bridge.${direction}-proof.v1`, 1, "/morrow-bridge/v1",
    authentication.clientNonce, serverNonce, authentication.extensionId,
    authentication.runtimeRevision, authentication.catalogDigest,
  ]);
}

function proveServer(socket, authentication, serverNonce) {
  socket.receive({
    schema: "morrow.bridge.challenge.v1",
    protocolVersion: 1,
    clientNonce: authentication.clientNonce,
    serverNonce,
    serverProof: createHmac("sha256", token).update(proofPayload("server", authentication, serverNonce)).digest("hex"),
    issuedAt: Date.now(),
  });
}

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener(listener) { return listeners.includes(listener); },
  };
}

function storageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const names = keys === undefined || keys === null
        ? Object.keys(values)
        : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, structuredClone(values[name])]));
    },
    async set(update) {
      for (const [name, value] of Object.entries(update)) values[name] = structuredClone(value);
    },
    async remove(keys) {
      for (const name of Array.isArray(keys) ? keys : [keys]) delete values[name];
    },
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
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
    this.readyState = FakeWebSocket.CLOSED;
    this.closeRecord = { code, reason };
    this.onclose?.({ code, reason });
  }
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

test("a rogue Bridge learns no secret, and withdrawing consent terminates Private Chat before reconnection", async () => {
  const storageChanged = event();
  const runtimeMessages = event();
  const local = storageArea({ [consentKey]: consentValue, token });
  const session = storageArea({});
  const noOpEvent = () => event();
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith(extensionPrefix)) throw new Error(`unexpected network request: ${url}`);
    const relative = url.slice(extensionPrefix.length);
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
      onStartup: noOpEvent(),
      onInstalled: noOpEvent(),
    },
    management: { getSelf: async () => ({ id: extensionId, version: "1.0.4", installType: "development" }) },
    storage: { local, session, onChanged: storageChanged },
    permissions: {
      contains: async () => true,
      getAll: async () => ({ origins: [] }),
      remove: async () => true,
      onAdded: noOpEvent(),
      onRemoved: noOpEvent(),
    },
    alarms: { create: async () => undefined, clear: async () => true, onAlarm: noOpEvent() },
    tabs: {
      query: async () => [], get: async () => null, create: async () => ({}), remove: async () => undefined,
      update: async () => null, sendMessage: async () => null, onRemoved: noOpEvent(), onUpdated: noOpEvent(),
    },
    scripting: { executeScript: async () => [] },
    webNavigation: { getAllFrames: async () => [], onCommitted: noOpEvent() },
    webRequest: { onBeforeSendHeaders: noOpEvent() },
  };

  await import(new URL(`connector/extension/src/service-worker.js?consent-private-chat=${Date.now()}`, root));
  const onMessage = runtimeMessages.listeners[0];
  const settingsSender = { id: extensionId, url: `${extensionPrefix}settings/settings.html` };
  const send = (message, sender = settingsSender) => new Promise((resolve, reject) => {
    if (onMessage(message, sender, resolve) !== true) reject(new Error(`message was not accepted: ${message.type}`));
  });
  const socket = await eventually(() => FakeWebSocket.instances[0]);
  socket.open();
  const authentication = await eventually(() => socket.sent.find((message) => message.schema === "morrow.bridge.authenticate.v1"));
  assert.deepEqual(Object.keys(authentication).sort(), ["catalogDigest", "clientNonce", "extensionId", "protocolVersion", "runtimeRevision", "schema", "sentAt"]);
  assert.equal(JSON.stringify(authentication).includes(token), false);
  socket.receive({
    schema: "morrow.bridge.challenge.v1",
    protocolVersion: 1,
    clientNonce: authentication.clientNonce,
    serverNonce: "a".repeat(64),
    serverProof: "0".repeat(64),
    issuedAt: Date.now(),
  });
  await eventually(() => socket.closeRecord);
  assert.deepEqual(socket.closeRecord, { code: 4403, reason: "bridge_server_identity_refused" });
  assert.equal(socket.sent.some((message) => message.schema === "morrow.bridge.hello.v1"), false);
  assert.equal(local.values.token, token);
  await send({ type: "morrow_course_data_consent_accept" }, {});

  const authenticatedSocket = await eventually(() => FakeWebSocket.instances[1]);
  authenticatedSocket.open();
  const authenticatedRequest = await eventually(() => authenticatedSocket.sent.find((message) => message.schema === "morrow.bridge.authenticate.v1"));
  proveServer(authenticatedSocket, authenticatedRequest, "b".repeat(64));
  const hello = await eventually(() => authenticatedSocket.sent.find((message) => message.schema === "morrow.bridge.hello.v1"));
  assert.equal(Object.hasOwn(hello, "token"), false);
  authenticatedSocket.receive({
    schema: "morrow.bridge.ready.v1",
    protocolVersion: 1,
    generation: 1,
    acceptedExtensionId: extensionId,
    catalogDigest: hello.catalogDigest,
    connectedAt: Date.now(),
  });
  const first = {
    schema: "morrow.bridge.command.v1",
    protocolVersion: 1,
    requestId: "bridge:consent-private-chat-first",
    operationId: "private-chat:consent-private-chat-first",
    kind: "private_chat_exchange",
    arguments: {
      schema: "morrow.private-chat.exchange.v1",
      sessionId: "consent-private-chat-first",
      assistantName: "First Assistant",
      action: "listen",
    },
    generation: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  authenticatedSocket.receive(first);
  await new Promise((resolve) => setTimeout(resolve, 0));

  delete local.values[consentKey];
  storageChanged.listeners[0]({ [consentKey]: { oldValue: consentValue, newValue: undefined } }, "local");
  assert.deepEqual(authenticatedSocket.closeRecord, { code: 1000, reason: "course_data_consent_removed" });
  assert.deepEqual(authenticatedSocket.sent.find((message) => message.requestId === first.requestId), {
    schema: "morrow.bridge.result.v1",
    protocolVersion: 1,
    requestId: first.requestId,
    operationId: first.operationId,
    generation: 1,
    ok: true,
    result: { schema: "morrow.private-chat.exchange.v1", status: "closed" },
    completedAt: authenticatedSocket.sent.find((message) => message.requestId === first.requestId).completedAt,
  });

  assert.deepEqual(await send({ type: "morrow_course_data_consent_accept" }, {}), {
    ok: true,
    result: { accepted: true },
  });
  const secondSocket = await eventually(() => FakeWebSocket.instances[2]);
  secondSocket.open();
  const secondAuthentication = await eventually(() => secondSocket.sent.find((message) => message.schema === "morrow.bridge.authenticate.v1"));
  proveServer(secondSocket, secondAuthentication, "c".repeat(64));
  const secondHello = await eventually(() => secondSocket.sent.find((message) => message.schema === "morrow.bridge.hello.v1"));
  secondSocket.receive({
    schema: "morrow.bridge.ready.v1",
    protocolVersion: 1,
    generation: 2,
    acceptedExtensionId: extensionId,
    catalogDigest: secondHello.catalogDigest,
    connectedAt: Date.now(),
  });
  const afterReconnect = await send({ type: "morrow_edit_policy_status" });
  assert.equal(afterReconnect.result.privateChat.clients.length, 0);
  assert.equal(afterReconnect.result.privateChat.waitingForMessage, false);

  const second = {
    ...first,
    requestId: "bridge:consent-private-chat-second",
    operationId: "private-chat:consent-private-chat-second",
    generation: 2,
    arguments: { ...first.arguments, sessionId: "consent-private-chat-second", assistantName: "Second Assistant" },
  };
  secondSocket.receive(second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterNewWait = await send({ type: "morrow_edit_policy_status" });
  assert.equal(afterNewWait.result.privateChat.clients[0].id, "consent-private-chat-second");
  assert.equal(afterNewWait.result.privateChat.waitingForMessage, true);
  assert.equal(secondSocket.sent.some((message) => message.requestId === second.requestId && message.ok === false), false);
  await send({ type: "morrow_private_chat_close" });
});
