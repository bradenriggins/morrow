import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const CATALOG_PREFIX = `chrome-extension://${EXTENSION_ID}/`;

globalThis.fetch = async (input) => {
  const url = String(input);
  const name = url.startsWith(CATALOG_PREFIX) ? url.slice(CATALOG_PREFIX.length) : "";
  if (!name.startsWith("generated/")) throw new Error(`unexpected request to ${url}`);
  const body = readFileSync(new URL(`connector/extension/${name}`, root), "utf8");
  return new Response(body, { headers: { "content-type": "application/json" } });
};

class ClosedSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor() { this.readyState = ClosedSocket.CONNECTING; }
  send() {}
  close() {}
}
globalThis.WebSocket = ClosedSocket;

function event() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

function storageArea(initial = {}) {
  const values = new Map(Object.entries(structuredClone(initial)));
  return {
    values,
    get: async (keys) => {
      const names = keys === undefined || keys === null
        ? [...values.keys()]
        : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const result = {};
      for (const name of names) {
        if (values.has(name)) result[name] = structuredClone(values.get(name));
        else if (keys && typeof keys === "object" && !Array.isArray(keys) && Object.hasOwn(keys, name)) result[name] = structuredClone(keys[name]);
      }
      return result;
    },
    set: async (next) => {
      for (const [name, value] of Object.entries(next)) values.set(name, structuredClone(value));
    },
    remove: async (keys) => {
      for (const name of Array.isArray(keys) ? keys : [keys]) values.delete(name);
    },
  };
}

function fixture({ local = {}, session = {}, framesByTab = {}, canvasProfile = null } = {}) {
  const tab = { id: 9, windowId: 4, url: "https://school.instructure.com/courses/42" };
  const localArea = storageArea({ morrowCourseDataConsent: "morrow.course-data-consent.v1", ...local });
  const sessionArea = storageArea(session);
  const granted = new Set(["https://school.instructure.com/*"]);
  const records = { createdTabs: [], removedTabs: [], scripts: [], messages: [] };
  return {
    records,
    localArea,
    sessionArea,
    api: {
      runtime: {
        id: EXTENSION_ID,
        getURL: (path) => `${CATALOG_PREFIX}${path}`,
        getManifest: () => ({ version: "1.0.2" }),
        sendMessage: async () => undefined,
        openOptionsPage: async () => undefined,
        onMessage: { addListener: (handler) => { messageHandler = handler; } },
        onStartup: event(),
        onInstalled: event(),
      },
      storage: { local: localArea, session: sessionArea, onChanged: event() },
      management: { getSelf: async () => ({ id: EXTENSION_ID, version: "1.0.2", installType: "development" }) },
      alarms: { create: async () => undefined, clear: async () => true, onAlarm: event() },
      permissions: {
        contains: async ({ origins }) => origins.every((origin) => granted.has(origin)),
        remove: async () => true,
        getAll: async () => ({ origins: [...granted] }),
        onAdded: event(),
      },
      tabs: {
        get: async (id) => {
          if (id !== tab.id) throw new Error("missing tab");
          return { ...tab };
        },
        query: async () => [{ ...tab }],
        sendMessage: async (tabId, message) => {
          records.messages.push({ tabId, type: message?.type });
          return message?.type === "morrow_canvas_probe" && canvasProfile
            ? { ok: true, profile: canvasProfile }
            : { ok: false };
        },
        create: async (options) => {
          records.createdTabs.push(structuredClone(options));
          return { id: 101 };
        },
        update: async (id, options) => ({ id, ...options }),
        remove: async (id) => { records.removedTabs.push(id); },
        onRemoved: event(),
        onUpdated: event(),
      },
      scripting: {
        executeScript: async (injection) => {
          records.scripts.push({ files: injection.files ? [...injection.files] : null, world: injection.world || null });
          return injection.files ? [{ result: null }] : [{ result: { ok: false } }];
        },
      },
      webNavigation: {
        getAllFrames: async ({ tabId }) => structuredClone(framesByTab[tabId] || []),
        onCommitted: event(),
      },
      webRequest: { onBeforeSendHeaders: event(), onBeforeRequest: event(), onHeadersReceived: event() },
    },
  };
}

let messageHandler = null;
function install(value) {
  globalThis.chrome = value.api;
  return value;
}

install(fixture());
await import("../../connector/extension/src/service-worker.js");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(typeof messageHandler, "function");

function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    if (messageHandler(message, sender, resolve) !== true) reject(new Error(`no response for ${message.type}`));
  });
}

test("course permission preparation never opens an optional Item Banks launch", async () => {
  const value = install(fixture({
    framesByTab: {
      9: [
        { frameId: 0, url: "https://school.instructure.com/courses/42/external_tools/71234" },
        { frameId: 7, url: "https://school.quiz-lti-iad-prod.instructure.com/lti/launch" },
      ],
      101: [
        { frameId: 0, url: "https://school.instructure.com/courses/42/external_tools/71234" },
        { frameId: 7, url: "https://school.quiz-lti-iad-prod.instructure.com/lti/launch" },
      ],
    },
  }));

  const answer = await send({ type: "morrow_connect_course_prepare", tabId: 9 });

  assert.equal(answer.ok, true);
  assert.deepEqual(answer.result.origins, [
    "https://school.instructure.com/*",
    "https://school.quiz-lti-iad-prod.instructure.com/*",
    "https://school.quiz-api-iad-prod.instructure.com/*",
  ]);
  assert.deepEqual(value.records.createdTabs, []);
  assert.deepEqual(value.records.removedTabs, []);
});

test("checking the same Canvas account rotates its session and migrates selected courses and Edit policy", async () => {
  const encoder = new TextEncoder();
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode("canvas\0https://school.instructure.com\0principal-7"));
  const fingerprint = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const siteAnchorId = `canvas:${fingerprint.slice(0, 20)}:g3`;
  const anchor = {
    siteAnchorId,
    provider: "canvas",
    origin: "https://school.instructure.com",
    principalFingerprint: fingerprint,
    principalId: "principal-7",
    sessionGeneration: 3,
    runtimeVerified: true,
    lastSeenAt: 1_000,
    tabId: 9,
  };
  const binding = {
    sourceBindingId: `${siteAnchorId}:c42`,
    siteAnchorId,
    provider: "canvas",
    origin: anchor.origin,
    principalFingerprint: fingerprint,
    principalId: anchor.principalId,
    sessionGeneration: 3,
    courseId: "42",
    courseName: "Biology",
    runtimeVerified: true,
    lastSeenAt: 1_000,
  };
  const discovery = {
    schema: "morrow.course-discovery.v1",
    siteAnchorId,
    provider: "canvas",
    origin: anchor.origin,
    principalFingerprint: fingerprint,
    sessionGeneration: 3,
    marker: "old-session",
  };
  const value = install(fixture({
    local: { siteAnchors: [anchor], bindings: [binding], editPolicies: {}, editPolicyRevisions: {} },
    canvasProfile: { id: "principal-7", origin: anchor.origin },
  }));
  const settingsSender = { id: EXTENSION_ID, url: `${CATALOG_PREFIX}settings/settings.html` };
  const options = await send({ type: "morrow_edit_policy_options", sourceBindingId: binding.sourceBindingId }, settingsSender);
  const category = options.result.options.find((candidate) => candidate.availability === "edit");
  assert.ok(category, "the Canvas binding exposes no Edit category for this regression");
  const savedPolicy = await send({
    type: "morrow_edit_policy_save",
    sourceBindingId: binding.sourceBindingId,
    enabledCategories: [category.id],
  }, settingsSender);
  assert.equal(savedPolicy.ok, true);
  await value.sessionArea.set({ courseDiscoveries: { "discovery:old-session": discovery } });

  const answer = await send({ type: "morrow_connect_course", tabId: 9 });

  assert.equal(answer.ok, true);
  assert.notEqual(answer.result.siteAnchorId, siteAnchorId);
  assert.equal(answer.result.sessionGeneration, 4);
  const savedAnchors = value.localArea.values.get("siteAnchors");
  const savedBindings = value.localArea.values.get("bindings");
  const migratedBindingId = `${answer.result.siteAnchorId}:c42`;
  assert.equal(savedAnchors.length, 1);
  assert.equal(savedAnchors[0].tabId, 9);
  assert.equal(savedAnchors[0].sessionGeneration, 4);
  assert.equal(savedBindings.length, 1);
  assert.equal(savedBindings[0].sourceBindingId, migratedBindingId);
  assert.equal(savedBindings[0].sessionGeneration, 4);
  assert.equal(savedBindings[0].courseId, "42");
  assert.equal(savedBindings[0].courseName, "Biology");
  const policies = value.localArea.values.get("editPolicies");
  assert.equal(Object.hasOwn(policies, binding.sourceBindingId), false);
  assert.deepEqual(policies[migratedBindingId].enabledCategories, [category.id]);
  assert.equal(policies[migratedBindingId].revision, savedPolicy.result.editPermission.revision);
  assert.equal(policies[migratedBindingId].expiresAt, savedPolicy.result.editPermission.expiresAt);
  assert.deepEqual(value.sessionArea.values.get("courseDiscoveries"), {});
  const migratedOptions = await send({ type: "morrow_edit_policy_options", sourceBindingId: migratedBindingId }, settingsSender);
  assert.deepEqual(migratedOptions.result.editPermission, policies[migratedBindingId]);
});
