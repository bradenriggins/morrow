import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const extensionId = "a".repeat(32);
const consentKey = "morrowCourseDataConsent";
const consentValue = "morrow.course-data-consent.v1";

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

function storageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const names = keys === undefined || keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys];
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

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

test("Disconnect invalidates an in-flight pairing confirmation before it can restore the token", async (context) => {
  const pairingId = "11111111-1111-4111-8111-111111111111";
  const pairUrl = "http://127.0.0.1:32147/morrow-bridge/v1/pair";
  const confirmUrl = `${pairUrl}/${pairingId}/confirm`;
  const marker = {
    schema: "morrow.bridge.active-folder-challenge.v1",
    challengeId: "morrow-0123456789abcdef0123456789abcdef",
    extensionId,
    manifestVersion: "1.0.4",
    nonce: "n".repeat(43),
  };
  const local = storageArea({ [consentKey]: consentValue });
  const session = storageArea({});
  const runtimeMessages = event();
  const noOpEvent = () => event();
  let releaseConfirmation;
  let confirmationSignal;
  let socketCount = 0;
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  context.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalFetch === undefined) delete globalThis.fetch; else globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = originalWebSocket;
  });

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `chrome-extension://${extensionId}/morrow-bridge-active-folder.json`) return json(marker);
    if (url.startsWith(`chrome-extension://${extensionId}/`)) {
      const { readFile } = await import("node:fs/promises");
      return new Response(await readFile(new URL(`connector/extension/${url.slice(`chrome-extension://${extensionId}/`.length)}`, root), "utf8"), { headers: { "content-type": "application/json" } });
    }
    if (url === pairUrl) {
      return json({ schema: "morrow.bridge.pairing.v2", pairingId, challenge: "c".repeat(43), confirmUrl, expiresAt: Date.now() + 60_000 }, 201);
    }
    assert.equal(url, confirmUrl);
    confirmationSignal = init.signal;
    return await new Promise((resolve) => { releaseConfirmation = resolve; });
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { socketCount += 1; }
  };
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      getManifest: () => ({ version: "1.0.4" }),
      getURL: (path) => `chrome-extension://${extensionId}/${path}`,
      sendMessage: async () => undefined,
      openOptionsPage: async () => undefined,
      onMessage: runtimeMessages,
      onStartup: noOpEvent(),
      onInstalled: noOpEvent(),
    },
    management: { getSelf: async () => ({ id: extensionId, version: "1.0.4", installType: "development" }) },
    storage: { local, session, onChanged: noOpEvent() },
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

  await import(new URL(`connector/extension/src/service-worker.js?pairing-authority=${Date.now()}`, root));
  const onMessage = runtimeMessages.listeners[0];
  const popup = { id: extensionId, url: `chrome-extension://${extensionId}/popup/popup.html` };
  const pairing = new Promise((resolve) => { onMessage({ type: "morrow_pair" }, popup, resolve); });
  await eventually(() => releaseConfirmation);
  const generation = local.values.pairingAuthority.generation;
  assert.equal(local.values.pairingAuthority.status, "requesting");
  const disconnected = await new Promise((resolve, reject) => {
    if (onMessage({ type: "morrow_disconnect" }, {}, resolve) !== true) reject(new Error("Disconnect was not accepted"));
  });
  assert.deepEqual(disconnected, { ok: true, result: { disconnected: true, permissionsRevoked: true } });
  assert.equal(confirmationSignal.aborted, true);
  assert.equal(local.values.token, undefined);
  assert.equal(local.values.pairingAuthority.status, "disconnected");
  assert.notEqual(local.values.pairingAuthority.generation, generation);

  releaseConfirmation(new Response(JSON.stringify({
    schema: "morrow.bridge.pairing-result.v2",
    status: "approved",
    token: "t".repeat(32),
  }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal((await pairing).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(local.values.token, undefined);
  assert.equal(local.values.pairingAuthority.status, "disconnected");
  assert.equal(socketCount, 0);
});
