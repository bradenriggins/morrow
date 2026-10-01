#!/usr/bin/env node
/**
 * First-use Bridge recovery: the ways a new person loses a course tab, runs two Chrome profiles, or
 * asks Morrow to read a course whose tab is closed, run against the shipped service worker, the
 * shipped loopback server and the shipped connector runtime. Chrome's extension APIs are fixtures;
 * every WebSocket is a real socket on an ephemeral loopback port. Nothing reaches port 32147.
 *
 * Failure modes this run must refuse or survive, each one a scenario below:
 *
 * Storage queue (a course tab that moved while a queued step checks it)
 *   D1 the connected tab closed and the course is open again in a new tab: discovery completes,
 *      the connection moves to the new tab, and Disconnect still completes
 *   D2 no course tab is open while Edit is saved: the Bridge opens the course itself, proves the
 *      same account there, saves, and Disconnect still completes
 *   D3 every course tab is closed: discovery fails at once as stale and nothing waits
 *   D4 the new tab is signed in as another account: the connection does not move, discovery fails
 *      as stale
 *   D5 Disconnect arrives while the moved tab is still proving its account: both finish, and the
 *      proof that lands afterwards writes nothing back
 *   D6 saving the moved tab fails in storage: that discovery fails, and the next one still runs
 *   D7 a course selection saved after the tab moved completes
 *
 * Two Chrome profiles
 *   P1 a second paired profile does not replace the profile that holds the connection
 *   P2 the waiting profile says another Chrome profile uses Morrow and offers to use this one
 *   P3 the person takes over from the waiting profile: it connects once, and the profile it replaced
 *      waits instead of taking the connection back
 *   P4 the owning profile shuts down: the waiting profile connects on its own
 *   P5 the owning profile's own worker reconnects: its new socket replaces its old one
 *   P6 a takeover from the wrong extension is refused and the owner keeps the connection
 *   P7 a takeover with the wrong proof is refused and the owner keeps the connection
 *
 * Opening a closed course for a request
 *   A1 the Bridge proves the course again: the read is admitted and dispatched once
 *   A2 the Bridge cannot prove the course: the read is refused before it is sent
 *   A3 the Bridge does not answer: recovery ends at its bound and the read is refused unsent
 *   A4 the shipped worker opens the closed course, proves the same account, and runs the read there
 *   A5 the opened tab shows another account: nothing is read
 *   A6 automatic opening is turned off: no tab opens and nothing is read
 *   A7 Chrome site access was removed: no tab opens and nothing is read
 *
 * Usage: node scripts/test/bridge-recovery-first-use.mjs [--receipt <absolute path>] [--only D1,P1-P4]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const ROOT = resolve(import.meta.dirname, "../..");
const receiptFlag = process.argv.indexOf("--receipt");
const RECEIPT = receiptFlag > 0 ? process.argv[receiptFlag + 1] : resolve(ROOT, "output/bridge-recovery-first-use/receipt.json");
if (!RECEIPT || !isAbsolute(RECEIPT)) throw new Error("--receipt needs an absolute path");

const { CanvasConnectorRuntime } = await import(pathToFileURL(resolve(ROOT, "packages/canvas-connector-mcp/dist/runtime.js")));
const { LoopbackBridgeServer } = await import(pathToFileURL(resolve(ROOT, "packages/bridge-loopback/dist/index.js")));
const { bridgeAuthenticationProofPayload } = await import(pathToFileURL(resolve(ROOT, "packages/bridge-protocol/dist/index.js")));
const { WebSocket } = await import(pathToFileURL(resolve(ROOT, "packages/bridge-loopback/node_modules/ws/wrapper.mjs")));

const EXTENSION_ID = "a".repeat(32);
const OTHER_EXTENSION_ID = "b".repeat(32);
const TOKEN = "first-use-token-".repeat(4);
const REVISION = "1.0.0-rc.2";
const ORIGIN = "https://school.instructure.com";
const ANCHOR = { siteAnchorId: "canvas:anchor:g1", provider: "canvas", origin: ORIGIN, principalId: "7", principalFingerprint: "a".repeat(64), sessionGeneration: 1, tabId: 1 };
const BINDING = { ...ANCHOR, sourceBindingId: "canvas:anchor:g1:c42", courseId: "42", courseName: "Course 42", runtimeVerified: true };
const CONSENT = { morrowCourseDataConsent: "morrow.course-data-consent.v1" };
const CATALOG = resolve(ROOT, "artifacts/canvas-api/canvas-api-catalog.json");
const READ_TOOL = "canvas_show_page_courses";
const READ_KEY = "GET /v1/courses/{course_id}/pages/{url_or_id}#show_page_courses";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const within = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${label} did not finish within ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------------------------
// One Chrome profile: the shipped service worker in its own thread, with fixture Chrome APIs.
// ---------------------------------------------------------------------------------------------
const PROFILE_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const { pathToFileURL } = await import("node:url");
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(workerData.root + "/connector/extension/manifest.json", "utf8"));
  const { WebSocket: RealWebSocket } = await import(pathToFileURL(workerData.root + "/packages/bridge-loopback/node_modules/ws/wrapper.mjs"));
  const fixture = { accountCourses: workerData.accountCourses, discoveryFailure: false, changePrincipalAfterList: false, tabs: new Map(workerData.tabs.map((tab) => [tab.id, tab])), nextTabId: 100, newTabPrincipal: workerData.newTabPrincipal ?? "7", permission: workerData.permission !== false, probeDelayMs: 0, failSetKey: null, counters: { tabsCreated: 0, probes: 0, executes: 0, queries: 0 } };
  const post = (value) => parentPort.postMessage(value);
  const event = () => ({ listeners: [], addListener(f) { this.listeners.push(f); }, removeListener(f) { this.listeners = this.listeners.filter((x) => x !== f); }, hasListener(f) { return this.listeners.includes(f); } });
  const area = (values = {}, name) => ({
    values,
    async get(keys) { keys = keys == null ? Object.keys(values) : Array.isArray(keys) ? keys : typeof keys === "object" ? Object.keys(keys) : [keys]; return structuredClone(Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]]))); },
    async set(v) {
      if (name === "local" && fixture.failSetKey && Object.hasOwn(v, fixture.failSetKey)) { fixture.failSetKey = null; throw new Error("fixture storage write failed"); }
      Object.assign(values, structuredClone(v));
    },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete values[k]; },
  });
  const id = workerData.extensionId;
  const port = workerData.port;
  let latestSocket;
  const sentMessages = [];
  globalThis.WebSocket = class extends RealWebSocket {
    constructor() {
      if (!port) throw new Error("this profile has no Morrow runtime");
      super("ws://127.0.0.1:" + port + "/morrow-bridge/v1", { origin: "chrome-extension://" + id });
      latestSocket = this;
      this.on("message", (raw) => { const m = JSON.parse(raw); if (m.schema === "morrow.bridge.ready.v1") post({ event: "ready", profile: workerData.name, generation: m.generation }); });
      this.on("close", (code, reason) => post({ event: "close", profile: workerData.name, code, reason: String(reason) }));
    }
  };
  globalThis.WebSocket.prototype.send = function(data, ...args) {
    sentMessages.push(JSON.parse(String(data)));
    return RealWebSocket.prototype.send.call(this, data, ...args);
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith("chrome-extension://" + id + "/")) throw new Error("fixture network refused " + url);
    return new Response(await readFile(workerData.root + "/connector/extension/" + url.slice(("chrome-extension://" + id + "/").length)), { headers: { "content-type": "application/json" } });
  };
  const local = area({ ...workerData.local }, "local");
  const session = area({}, "session");
  const messages = event(), updated = event(), alarms = event();
  const tabFor = (tabId) => fixture.tabs.get(tabId) || null;
  globalThis.chrome = {
    runtime: { id, getURL: (p) => "chrome-extension://" + id + "/" + p, getManifest: () => manifest, sendMessage: async () => {}, reload() {}, onMessage: messages, onStartup: event(), onInstalled: event() },
    management: { getSelf: async () => ({ id, version: manifest.version, installType: "development" }) },
    storage: { local, session, onChanged: event() },
    permissions: { contains: async () => fixture.permission, getAll: async () => ({ origins: fixture.permission ? [workerData.origin + "/*"] : [] }), remove: async () => true, onAdded: event(), onRemoved: event() },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: alarms },
    tabs: {
      get: async (tabId) => { const tab = tabFor(tabId); if (!tab) throw new Error("No tab with id: " + tabId); return { id: tab.id, url: tab.url }; },
      query: async () => { fixture.counters.queries += 1; return [...fixture.tabs.values()].map((tab) => ({ id: tab.id, url: tab.url, active: false })); },
      create: async ({ url }) => {
        fixture.counters.tabsCreated += 1;
        const tab = { id: fixture.nextTabId++, url, principalId: fixture.newTabPrincipal };
        fixture.tabs.set(tab.id, tab);
        post({ event: "tabCreated", profile: workerData.name, tabId: tab.id, url });
        setTimeout(() => { for (const f of [...updated.listeners]) f(tab.id, { status: "complete" }, { id: tab.id, url }); }, 5);
        return { id: tab.id, url };
      },
      update: async (tabId) => ({ id: tabId, url: tabFor(tabId)?.url }),
      sendMessage: async (tabId, message) => {
        const tab = tabFor(tabId);
        if (!tab) throw new Error("Could not establish connection. Receiving end does not exist.");
        const profile = { id: tab.principalId, origin: new URL(tab.url).origin };
        if (message.type === "morrow_canvas_probe") {
          fixture.counters.probes += 1;
          if (fixture.probeDelayMs) await new Promise((done) => setTimeout(done, fixture.probeDelayMs));
          return { ok: true, profile };
        }
        if (message.type === "morrow_canvas_list_courses") {
          if (fixture.discoveryFailure) return { ok: false };
          const all = fixture.accountCourses || [{ id: "42", name: "Course 42" }];
          const offset = message.next ? Number(new URL(message.next).searchParams.get("offset")) : 0;
          const courses = all.slice(offset, offset + 100);
          const complete = offset + courses.length >= all.length;
          if (fixture.changePrincipalAfterList) tab.principalId = "8";
          return { ok: true, profile, courses, pageUrl: workerData.origin + "/api/v1/courses?offset=" + offset, complete, nextUrl: complete ? null : workerData.origin + "/api/v1/courses?offset=" + (offset + 100) };
        }
        if (message.type === "morrow_canvas_check_course") return { ok: true, profile, course: { id: message.courseId, name: "Course " + message.courseId } };
        if (message.type === "morrow_canvas_execute") {
          fixture.counters.executes += 1;
          post({ event: "execute", profile: workerData.name, tabId, courseId: message.courseId, principalId: message.principalId });
          return { ok: false, sent: false, error: "fixture_read_answered" };
        }
        return null;
      },
      onRemoved: event(), onUpdated: updated, onActivated: event(),
    },
    scripting: { executeScript: async (request) => {
      if (request.func?.name !== "executeMoodleInPage") return [];
      const input = JSON.parse(request.args[0]);
      const tab = tabFor(request.target.tabId);
      const profile = { siteUrl: workerData.origin, principalId: tab?.principalId };
      if (input.mode === "probe") return [{ result: { ok: true, profile } }];
      if (input.mode === "discover_courses") {
        const all = fixture.accountCourses || [];
        const courses = all.slice(input.offset, input.offset + input.limit);
        const complete = input.offset + courses.length >= all.length;
        return [{ result: { ok: true, sent: true, data: { courses, complete, next_offset: complete ? null : input.offset + courses.length } } }];
      }
      return [];
    } },
    webNavigation: { onCommitted: event() }, webRequest: { onBeforeSendHeaders: event(), onHeadersReceived: event(), onCompleted: event(), onErrorOccurred: event() },
  };
  await import(pathToFileURL(workerData.root + "/connector/extension/src/service-worker.js"));
  const senders = {
    settings: { id, url: "chrome-extension://" + id + "/settings/settings.html" },
    popup: { id, url: "chrome-extension://" + id + "/popup/popup.html" },
    onboarding: { id, url: "chrome-extension://" + id + "/onboarding/onboarding.html" },
    course: { id, url: workerData.origin + "/courses/42" },
    otherExtension: { id: "b".repeat(32), url: "chrome-extension://" + id + "/popup/popup.html" },
    alteredPopup: { id, url: "chrome-extension://" + id + "/popup/popup.html?x=1" },
  };
  parentPort.on("message", async ({ seq, op, message, sender, key, value, name }) => {
    try {
      let result;
      if (op === "call") {
        result = await new Promise((done) => { for (const f of messages.listeners) { const answer = f(message, senders[sender || "settings"], done); if (answer === true) return; } });
      } else if (op === "set") {
        if (key === "closeTab") fixture.tabs.delete(value);
        else if (key === "openTab") fixture.tabs.set(value.id, value);
        else fixture[key] = value;
        result = true;
      } else if (op === "alarm") {
        for (const f of alarms.listeners) f({ name });
        result = true;
      } else if (op === "incoming") {
        latestSocket.onmessage({ data: value });
        result = true;
      } else if (op === "state") {
        result = { sentMessages: structuredClone(sentMessages), local: structuredClone(local.values), counters: { ...fixture.counters }, tabs: [...fixture.tabs.keys()] };
      }
      post({ seq, result });
    } catch (error) {
      post({ seq, error: String(error?.stack || error) });
    }
  });
  post({ event: "loaded", profile: workerData.name });
})().catch((error) => { parentPort.postMessage({ event: "error", message: String(error?.stack || error) }); process.exit(1); });
`;

function startProfile(name, { port = null, local = {}, tabs = [], newTabPrincipal = "7", permission = true, extensionId = EXTENSION_ID, accountCourses } = {}) {
  const worker = new Worker(PROFILE_SOURCE, { eval: true, workerData: { name, root: ROOT, port, origin: ORIGIN, extensionId, local: { ...CONSENT, ...local }, tabs, newTabPrincipal, permission, accountCourses } });
  const events = [];
  const replies = new Map();
  let seq = 0;
  const loaded = new Promise((done, fail) => {
    worker.on("message", (message) => {
      if (message.seq !== undefined) {
        const reply = replies.get(message.seq);
        replies.delete(message.seq);
        if (message.error) reply?.fail(new Error(message.error)); else reply?.done(message.result);
        return;
      }
      events.push({ ...message, at: Date.now() });
      if (message.event === "loaded") done();
      if (message.event === "error") fail(new Error(message.message));
    });
    worker.on("error", fail);
  });
  const rpc = (payload) => new Promise((done, fail) => { const id = ++seq; replies.set(id, { done, fail }); worker.postMessage({ seq: id, ...payload }); });
  return {
    name, worker, events, loaded,
    call: (message, sender = "settings") => rpc({ op: "call", message, sender }),
    set: (key, value) => rpc({ op: "set", key, value }),
    alarm: (alarmName) => rpc({ op: "alarm", name: alarmName }),
    state: () => rpc({ op: "state" }),
    incoming: (value) => rpc({ op: "incoming", value }),
    count: (predicate) => events.filter(predicate).length,
    stop: () => worker.terminate(),
  };
}

// ---------------------------------------------------------------------------------------------
// A raw authenticated Bridge client, for the loopback server's own rules.
// ---------------------------------------------------------------------------------------------
async function rawClient(port, { extensionId = EXTENSION_ID, token = TOKEN, catalogDigest, bindings = [], instanceId, takeover, onCommand } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/morrow-bridge/v1`, { origin: `chrome-extension://${extensionId}` });
  const client = { socket, generation: 0, commands: [], closed: null };
  const settled = new Promise((done) => {
    socket.on("close", (code, reason) => { client.closed = { code, reason: String(reason) }; done({ closed: client.closed }); });
    socket.on("error", () => undefined);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.schema === "morrow.bridge.ready.v1") { client.generation = message.generation; done({ ready: message.generation }); }
      if (message.schema === "morrow.bridge.command.v1") { client.commands.push(message); onCommand?.(message, client); }
      if (message.schema === "morrow.bridge.ping.v1") socket.send(JSON.stringify({ schema: "morrow.bridge.pong.v1", protocolVersion: 1, generation: message.generation, sentAt: Date.now() }));
    });
  });
  const opened = await new Promise((done) => { socket.once("open", () => done(null)); socket.once("error", (error) => done(error)); });
  if (opened) return { ...client, outcome: { refusedAtUpgrade: String(opened.message || opened) } };
  const auth = { schema: "morrow.bridge.authenticate.v1", protocolVersion: 1, clientNonce: randomBytes(32).toString("hex"), extensionId, runtimeRevision: REVISION, catalogDigest, sentAt: Date.now() };
  const challenge = await new Promise((done) => { socket.once("message", (raw) => done(JSON.parse(raw))); socket.send(JSON.stringify(auth)); });
  if (challenge.schema === "morrow.bridge.challenge.v1") {
    socket.send(JSON.stringify({
      schema: "morrow.bridge.hello.v1", protocolVersion: 1, clientNonce: auth.clientNonce, serverNonce: challenge.serverNonce,
      clientProof: createHmac("sha256", token).update(bridgeAuthenticationProofPayload("client", auth, challenge.serverNonce)).digest("hex"),
      extensionId, runtimeRevision: REVISION, catalogDigest, bindings,
      ...(instanceId ? { instanceId } : {}), ...(takeover ? { takeover: true } : {}),
      sentAt: Date.now(),
    }));
  }
  client.outcome = await within(settled, 5_000, "raw Bridge authentication");
  client.send = (value) => socket.send(JSON.stringify(value));
  client.result = (command, ok, result, problem) => client.send({ schema: "morrow.bridge.result.v1", protocolVersion: 1, requestId: command.requestId, operationId: command.operationId, generation: command.generation, ok, ...(ok ? { result } : { problem }), completedAt: Date.now() });
  client.bindings = (list) => client.send({ schema: "morrow.bridge.bindings.v1", protocolVersion: 1, generation: client.generation, bindings: list, sentAt: Date.now() });
  return client;
}

const CATALOG_DIGEST = "c".repeat(64);
function loopbackServer(options = {}) {
  return new LoopbackBridgeServer({ token: TOKEN, expectedRuntimeRevision: REVISION, expectedCatalogDigest: CATALOG_DIGEST, allowedExtensionIds: [EXTENSION_ID], port: 0, ...options });
}
const rawBinding = (runtimeVerified) => ({ sourceBindingId: BINDING.sourceBindingId, provider: "canvas", origin: ORIGIN, courseId: "42", catalogDigest: CATALOG_DIGEST, runtimeVerified });
const readInvocation = (label) => ({ kind: "invoke_read", toolName: READ_TOOL, operationKey: READ_KEY, sourceBindingId: BINDING.sourceBindingId, arguments: { course_id: "42", url_or_id: "welcome" }, operationId: `operation:first-use-${label}` });

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------
const scenarios = [];
function scenario(id, title, run) { scenarios.push({ id, title, run }); }

const discovery = (profile) => profile.call({ type: "morrow_course_discovery_start", siteAnchorId: ANCHOR.siteAnchorId });
const disconnect = (profile) => profile.call({ type: "morrow_disconnect" }, "popup");
const movedTabProfile = (name, extra = {}) => startProfile(name, { ...extra, local: { siteAnchors: [ANCHOR], bindings: [], ...extra.local }, tabs: extra.tabs ?? [{ id: 1, url: `${ORIGIN}/courses/42`, principalId: "7" }] });

scenario("D1", "a course reopened in a new tab moves the connection there, and Disconnect still completes", async () => {
  const profile = movedTabProfile("d1");
  try {
    await profile.loaded;
    assert.equal((await within(discovery(profile), 3_000, "baseline discovery")).ok, true);
    await profile.set("closeTab", 1);
    await profile.set("openTab", { id: 2, url: `${ORIGIN}/courses/42`, principalId: "7" });
    const moved = await within(discovery(profile), 3_000, "discovery after the tab moved");
    const state = await profile.state();
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(state.local.siteAnchors[0].tabId, 2);
    const out = await within(disconnect(profile), 3_000, "Disconnect after the move");
    assert.equal(out.ok, true, JSON.stringify(out));
    return { discovery: moved.ok, anchorTabId: state.local.siteAnchors[0].tabId, disconnect: out.ok };
  } finally { await profile.stop(); }
});

scenario("D2", "Edit saved with no course tab opens the course, proves the account, saves, and Disconnect completes", async () => {
  const profile = movedTabProfile("d2", { tabs: [], local: { bindings: [BINDING] } });
  try {
    await profile.loaded;
    const saved = await within(profile.call({ type: "morrow_edit_policy_save", sourceBindingId: BINDING.sourceBindingId, enabledCategories: ["canvas_page_content"] }), 5_000, "Edit save");
    const state = await profile.state();
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(state.counters.tabsCreated, 1);
    assert.equal(state.local.siteAnchors[0].tabId, 100);
    const out = await within(disconnect(profile), 3_000, "Disconnect after Edit save");
    assert.equal(out.ok, true);
    return { saved: saved.ok, tabsCreated: state.counters.tabsCreated, anchorTabId: state.local.siteAnchors[0].tabId, disconnect: out.ok };
  } finally { await profile.stop(); }
});

scenario("D3", "with every course tab closed, discovery fails as stale at once", async () => {
  const profile = movedTabProfile("d3", { tabs: [] });
  try {
    await profile.loaded;
    const answer = await within(discovery(profile), 3_000, "discovery with no tab");
    assert.equal(answer.ok, false);
    assert.match(String(answer.error || answer.code), /course_discovery_anchor_stale/);
    assert.equal((await within(disconnect(profile), 3_000, "Disconnect")).ok, true);
    return { error: answer.error || answer.code };
  } finally { await profile.stop(); }
});

scenario("D4", "a new tab signed in as another account does not take the connection", async () => {
  const profile = movedTabProfile("d4", { tabs: [{ id: 2, url: `${ORIGIN}/courses/42`, principalId: "8" }] });
  try {
    await profile.loaded;
    const answer = await within(discovery(profile), 3_000, "discovery with another account");
    const state = await profile.state();
    assert.equal(answer.ok, false);
    assert.equal(state.local.siteAnchors[0].tabId, 1);
    assert.equal((await within(disconnect(profile), 3_000, "Disconnect")).ok, true);
    return { error: answer.error || answer.code, anchorTabId: state.local.siteAnchors[0].tabId };
  } finally { await profile.stop(); }
});

scenario("D5", "Disconnect during a moved tab's proof finishes, and the late proof writes nothing back", async () => {
  const profile = movedTabProfile("d5", { tabs: [{ id: 2, url: `${ORIGIN}/courses/42`, principalId: "7" }] });
  try {
    await profile.loaded;
    await profile.set("probeDelayMs", 400);
    const running = discovery(profile);
    await pause(100);
    const out = await within(disconnect(profile), 3_000, "Disconnect during recovery");
    const answer = await within(running, 3_000, "discovery interrupted by Disconnect");
    await pause(600);
    const state = await profile.state();
    assert.equal(out.ok, true);
    assert.equal(answer.ok, false);
    assert.equal(state.local.siteAnchors, undefined, JSON.stringify(state.local.siteAnchors));
    assert.equal(state.local.token, undefined);
    return { disconnect: out.ok, discovery: answer.ok, siteAnchorsAfter: state.local.siteAnchors ?? null };
  } finally { await profile.stop(); }
});

scenario("D6", "a failed storage write while moving the tab fails that step, and the next discovery runs", async () => {
  const profile = movedTabProfile("d6", { tabs: [{ id: 2, url: `${ORIGIN}/courses/42`, principalId: "7" }] });
  try {
    await profile.loaded;
    await profile.set("failSetKey", "siteAnchors");
    const failed = await within(discovery(profile), 3_000, "discovery with a failing write");
    const retried = await within(discovery(profile), 3_000, "discovery after the failed write");
    const state = await profile.state();
    assert.equal(failed.ok, false);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(state.local.siteAnchors[0].tabId, 2);
    assert.equal((await within(disconnect(profile), 3_000, "Disconnect")).ok, true);
    return { failed: failed.ok, retried: retried.ok };
  } finally { await profile.stop(); }
});

scenario("D7", "a course selection saved after the tab moved completes", async () => {
  const profile = movedTabProfile("d7");
  try {
    await profile.loaded;
    const found = await within(discovery(profile), 3_000, "discovery");
    assert.equal(found.ok, true, JSON.stringify(found));
    const receipt = found.result?.discoveryReceiptId;
    assert.ok(receipt, JSON.stringify(found));
    await profile.set("closeTab", 1);
    await profile.set("openTab", { id: 3, url: `${ORIGIN}/courses/42`, principalId: "7" });
    const saved = await within(profile.call({ type: "morrow_course_selection_save", siteAnchorId: ANCHOR.siteAnchorId, discoveryReceiptId: receipt, courseIds: ["42"] }), 5_000, "course selection save");
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal((await within(disconnect(profile), 3_000, "Disconnect")).ok, true);
    return { saved: saved.ok };
  } finally { await profile.stop(); }
});

async function withConnectorRuntime(run) {
  const runtime = await CanvasConnectorRuntime.start({ token: TOKEN, port: 0, runtimeRevision: REVISION, catalogPath: CATALOG, allowedExtensionIds: [EXTENSION_ID], pairingSecret: async () => null, approveExtensionId: async () => {} });
  try { return await run(runtime, runtime.bridge.health().port); } finally { await runtime.close(); }
}
const pairedLocal = { token: TOKEN, bindings: [], siteAnchors: [] };
const replaced = (profile) => profile.count((e) => e.event === "close" && e.code === 4409 && /^superseded/.test(e.reason));
const ready = (profile) => profile.count((e) => e.event === "ready");
const waitFor = async (predicate, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return; await pause(50); } throw new Error(`${label} did not happen within ${ms} ms`); };

scenario("P1-P4", "two profiles: no eviction loop, a named waiting state, explicit takeover, and handoff on shutdown", async () => withConnectorRuntime(async (runtime, port) => {
  const a = startProfile("profileA", { port, local: pairedLocal });
  let b = null;
  try {
    await a.loaded;
    await waitFor(() => ready(a) === 1, 5_000, "profile A connecting");
    b = startProfile("profileB", { port, local: pairedLocal });
    await b.loaded;
    await pause(6_500);
    const generationWhileBothOpen = runtime.bridge.health().generation;
    assert.equal(replaced(a), 0, "P1: the waiting profile must not replace the owner");
    assert.equal(ready(a), 1, "P1: the owner stays connected");
    assert.equal(ready(b), 0, "P1: the waiting profile does not connect");
    assert.equal(generationWhileBothOpen, 1, "P1: the connection generation stays stable");
    const waiting = (await b.call({ type: "morrow_status" }, "popup")).result;
    assert.equal(waiting.connected, false);
    assert.equal(waiting.otherProfileOwnsConnection, true, `P2: ${JSON.stringify(waiting)}`);
    const takeover = await within(b.call({ type: "morrow_bridge_takeover" }, "popup"), 5_000, "P3 takeover");
    assert.equal(takeover.ok, true, JSON.stringify(takeover));
    await waitFor(() => ready(b) === 1, 5_000, "P3 profile B connecting after takeover");
    await pause(5_000);
    assert.equal(ready(b), 1, "P3: the new owner connected once");
    assert.equal(replaced(b), 0, "P3: the replaced profile does not take the connection back");
    assert.equal(ready(a), 1, "P3: the replaced profile waits");
    assert.equal(runtime.bridge.health().generation, 2);
    const aWaiting = (await a.call({ type: "morrow_status" }, "popup")).result;
    assert.equal(aWaiting.otherProfileOwnsConnection, true);
    await b.stop();
    b = null;
    await a.alarm("morrow-bridge-reconnect");
    await waitFor(() => ready(a) === 2, 10_000, "P4 profile A reconnecting after profile B shut down");
    const aOwner = (await a.call({ type: "morrow_status" }, "popup")).result;
    assert.equal(aOwner.connected, true);
    assert.equal(aOwner.otherProfileOwnsConnection, false);
    return { generationWhileBothOpen, readyA: ready(a), replacedA: replaced(a), waitingStatus: { connected: waiting.connected, otherProfileOwnsConnection: waiting.otherProfileOwnsConnection }, finalGeneration: runtime.bridge.health().generation };
  } finally { await a.stop(); if (b) await b.stop(); }
}));

scenario("P5-P7", "the owner's own reconnect replaces it; a wrong extension or proof cannot take over", async () => {
  const server = loopbackServer();
  await server.start();
  const port = server.health().port;
  try {
    const first = await rawClient(port, { catalogDigest: CATALOG_DIGEST, instanceId: "profile-owner-0001" });
    assert.equal(first.outcome.ready, 1);
    const other = await rawClient(port, { catalogDigest: CATALOG_DIGEST, instanceId: "profile-other-0002" });
    assert.equal(other.outcome.closed?.code, 4409);
    assert.equal(other.outcome.closed?.reason, "bridge_owned_by_other_profile");
    const again = await rawClient(port, { catalogDigest: CATALOG_DIGEST, instanceId: "profile-owner-0001" });
    assert.equal(again.outcome.ready, 2, "P5: the owner's reconnect is admitted");
    await pause(50);
    assert.equal(first.closed?.reason, "superseded_by_new_connection");
    const wrongExtension = await rawClient(port, { catalogDigest: CATALOG_DIGEST, extensionId: OTHER_EXTENSION_ID, instanceId: "profile-other-0002", takeover: true });
    assert.ok(wrongExtension.outcome.closed?.code === 4403 || wrongExtension.outcome.refusedAtUpgrade, `P6: ${JSON.stringify(wrongExtension.outcome)}`);
    const wrongProof = await rawClient(port, { catalogDigest: CATALOG_DIGEST, token: "wrong-token-".repeat(5), instanceId: "profile-other-0002", takeover: true });
    assert.equal(wrongProof.outcome.closed?.code, 4403, "P7");
    await pause(50);
    assert.equal(again.closed, null, "the owner keeps the connection");
    assert.equal(server.health().generation, 2);
    for (const client of [again]) client.socket.terminate();
    return { refusedReason: other.outcome.closed.reason, ownerReconnectGeneration: again.outcome.ready, wrongExtension: wrongExtension.outcome, wrongProof: wrongProof.outcome.closed };
  } finally { await server.close(); }
});

scenario("A1-A3", "a request for a closed course asks the Bridge to prove it again, within a bound, before admission", async () => {
  const server = loopbackServer({ bindingRecoveryTimeoutMs: 1_500 });
  await server.start();
  const port = server.health().port;
  try {
    // A1: the Bridge proves the course and publishes it verified, then answers.
    let reads = 0;
    const proving = await rawClient(port, {
      catalogDigest: CATALOG_DIGEST, instanceId: "profile-owner-0001", bindings: [rawBinding(false)],
      onCommand: (command, client) => {
        if (command.kind === "binding_recover") { client.bindings([rawBinding(true)]); client.result(command, true, { recovered: true }); }
        if (command.kind === "invoke_read") { reads += 1; client.result(command, false, null, { schema: "morrow.bridge.problem.v1", code: "test_read_answered", message: "The fixture answered the read.", recoverable: false }); }
      },
    });
    const a1 = await within(server.invoke(readInvocation("a1")), 5_000, "A1 read");
    assert.equal(a1.problem?.code, "test_read_answered", JSON.stringify(a1));
    assert.equal(reads, 1);
    assert.deepEqual(proving.commands.map((c) => c.kind), ["binding_recover", "invoke_read"]);
    proving.socket.terminate();
    await pause(50);

    // A2: the Bridge answers but cannot prove the course.
    const unproved = await rawClient(port, {
      catalogDigest: CATALOG_DIGEST, instanceId: "profile-owner-0001", bindings: [rawBinding(false)],
      onCommand: (command, client) => { if (command.kind === "binding_recover") client.result(command, true, { recovered: false }); },
    });
    await assert.rejects(within(server.invoke(readInvocation("a2")), 5_000, "A2 read"), (error) => error?.code === "bridge_unavailable");
    assert.deepEqual(unproved.commands.map((c) => c.kind), ["binding_recover"]);
    unproved.socket.terminate();
    await pause(50);

    // A3: the Bridge never answers recovery.
    const silent = await rawClient(port, { catalogDigest: CATALOG_DIGEST, instanceId: "profile-owner-0001", bindings: [rawBinding(false)] });
    const started = Date.now();
    await assert.rejects(within(server.invoke(readInvocation("a3")), 6_000, "A3 read"), (error) => error?.code === "bridge_unavailable");
    const boundedMs = Date.now() - started;
    assert.ok(boundedMs < 4_000, `A3 recovery took ${boundedMs} ms`);
    assert.deepEqual(silent.commands.map((c) => c.kind), ["binding_recover"]);
    silent.socket.terminate();
    return { a1: a1.problem.code, a2Commands: unproved.commands.map((c) => c.kind), a3BoundedMs: boundedMs };
  } finally { await server.close(); }
});

const closedCourseLocal = { token: TOKEN, siteAnchors: [ANCHOR], bindings: [BINDING] };
const readClosedCourse = (runtime) => runtime.call(READ_TOOL, { course_id: "42", url_or_id: "welcome", _morrow: { source_binding_id: BINDING.sourceBindingId } });

scenario("A4", "the shipped worker opens the closed course, proves the same account, and runs the read there", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = startProfile("a4", { port, local: closedCourseLocal });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "profile connecting");
    const result = await within(readClosedCourse(runtime), 30_000, "A4 read");
    const state = await profile.state();
    assert.equal(state.counters.tabsCreated, 1);
    assert.notEqual(result.problem?.code, "bridge_unavailable", JSON.stringify(result));
    const execute = profile.events.find((e) => e.event === "execute");
    assert.ok(execute, "the read reached the course tab");
    assert.equal(execute.tabId, 100);
    assert.equal(execute.courseId, "42");
    assert.equal(execute.principalId, "7");
    return { tabsCreated: state.counters.tabsCreated, executedOnTab: execute.tabId, resultState: result.resultState ?? null };
  } finally { await profile.stop(); }
}));

for (const [id, title, options] of [
  ["A5", "an opened tab signed in as another account reads nothing", { newTabPrincipal: "8", expectTabs: 1 }],
  ["A6", "with automatic opening off, no tab opens and nothing is read", { local: { openPlatformWhenNeeded: false }, expectTabs: 0 }],
  ["A7", "with Chrome site access removed, no tab opens and nothing is read", { permission: false, expectTabs: 0 }],
]) {
  scenario(id, title, async () => withConnectorRuntime(async (runtime, port) => {
    const profile = startProfile(id.toLowerCase(), { port, local: { ...closedCourseLocal, ...options.local }, newTabPrincipal: options.newTabPrincipal, permission: options.permission });
    try {
      await profile.loaded;
      await waitFor(() => ready(profile) === 1, 5_000, "profile connecting");
      const result = await within(readClosedCourse(runtime), 40_000, `${id} read`);
      const state = await profile.state();
      assert.equal(result.ok, false);
      assert.equal(result.resultState, "not_sent", JSON.stringify(result));
      assert.equal(state.counters.executes, 0);
      assert.equal(state.counters.tabsCreated, options.expectTabs);
      return { code: result.problem?.code, tabsCreated: state.counters.tabsCreated, executes: state.counters.executes };
    } finally { await profile.stop(); }
  }));
}

scenario("W1", "an unsupported protocol command performs no course probe or provider read", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = startProfile("wrong-version", { port, local: { ...pairedLocal, bindings: [BINDING], siteAnchors: [ANCHOR] }, tabs: [{ id: 1, url: `${ORIGIN}/courses/42`, principalId: "7" }] });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "profile connecting");
    const before = await profile.state();
    await profile.incoming(JSON.stringify({ schema: "morrow.bridge.command.v1", protocolVersion: 99,
      requestId: "wrong-version-command", operationId: "wrong-version-operation", generation: runtime.bridge.health().generation,
      kind: "invoke_read", sourceBindingId: BINDING.sourceBindingId, toolName: READ_TOOL, operationKey: READ_KEY,
      arguments: { course_id: "42", url_or_id: "lesson" }, expiresAt: Date.now() + 10_000 }));
    await waitFor(async () => (await profile.state()).sentMessages.some((m) => m.requestId === "wrong-version-command"), 3_000, "protocol refusal");
    const after = await profile.state();
    const refusal = after.sentMessages.find((m) => m.requestId === "wrong-version-command");
    assert.equal(after.counters.executes, before.counters.executes);
    assert.equal(after.counters.probes, before.counters.probes);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.problem.code, "bridge_protocol_version_unsupported");
    return { code: refusal.problem.code, executes: after.counters.executes - before.counters.executes, probes: after.counters.probes - before.counters.probes };
  } finally { await profile.stop(); }
}));

for (const [id, title, data] of [
  ["W2", "an oversized ASCII frame closes before JSON parsing", JSON.stringify({ schema: "morrow.bridge.ping.v1", padding: "x".repeat(2 * 1024 * 1024) })],
  ["W3", "an oversized UTF-8 frame closes even within the character bound", JSON.stringify({ schema: "morrow.bridge.ping.v1", padding: "é".repeat(1024 * 1024) })],
  ["W4", "a binary frame closes before command admission", new ArrayBuffer(64)],
]) {
  scenario(id, title, async () => withConnectorRuntime(async (runtime, port) => {
    const profile = startProfile(id.toLowerCase(), { port, local: pairedLocal });
    try {
      await profile.loaded;
      await waitFor(() => ready(profile) === 1, 5_000, "profile connecting");
      await profile.incoming(data);
      await waitFor(() => profile.events.some((e) => e.event === "close" && e.code === 4400 && e.reason === "invalid_message"), 2_000, "invalid-frame close");
      assert.equal((await profile.state()).counters.executes, 0);
      return { closeCode: 4400, reason: "invalid_message", executes: 0 };
    } finally { await profile.stop(); }
  }));
}

scenario("W5", "course pages and foreign senders cannot control setup or the saved connection", async () => {
  const profile = movedTabProfile("sender-admission");
  try {
    await profile.loaded;
    const before = await profile.state();
    let refusals = 0;
    for (const sender of ["course", "otherExtension", "alteredPopup"]) {
      for (const type of ["morrow_course_data_consent_accept", "morrow_course_data_consent_withdraw", "morrow_open_setup", "morrow_open_platform", "morrow_detect_course_platform", "morrow_connect_course_prepare", "morrow_connect_course_complete", "morrow_connect_course_cancel", "morrow_connect_course", "morrow_status", "morrow_disconnect"]) {
        const result = await within(profile.call({ type, tabId: 2, siteAnchorId: ANCHOR.siteAnchorId, sourceBindingId: BINDING.sourceBindingId, intentId: "untrusted-intent" }, sender), 3_000, type);
        assert.equal(result.ok, false, `${sender}: ${type}`);
        assert.equal(result.code, "bridge_extension_page_sender_refused", `${sender}: ${type}`);
        refusals += 1;
      }
    }
    const after = await profile.state();
    assert.deepEqual(after.local, before.local);
    assert.deepEqual(after.counters, before.counters);
    assert.deepEqual(after.tabs, before.tabs);
    for (const sender of ["popup", "settings", "onboarding"]) {
      assert.equal((await profile.call({ type: "morrow_course_data_consent_accept" }, sender)).ok, true, sender);
      assert.equal((await profile.call({ type: "morrow_status" }, sender)).ok, true, sender);
    }
    return { refusals, acceptedPages: ["popup", "settings", "onboarding"], mutationsFromRefusedSenders: 0 };
  } finally { await profile.stop(); }
});

// Account access changes course scope, never pairing identity or Edit permission.
const accountMode = (profile, mode = "account", sender = "popup") => profile.call({ type: "morrow_course_access_set", mode }, sender);
const accountCourses = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: `Course ${i + 1}` }));
scenario("Q1", "Account access admits thirty courses from one paired account without individual selection", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = movedTabProfile("q1", { port, accountCourses: accountCourses(30), local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    const result = await within(accountMode(profile), 5_000, "account access");
    assert.equal(result.ok, true, JSON.stringify(result));
    const state = await profile.state();
    assert.equal(state.local.courseAccessMode, "account");
    assert.equal(state.local.bindings.length, 30);
    assert.equal(new Set(state.local.bindings.map(b => b.siteAnchorId)).size, 1);
    assert.equal(state.local.token, TOKEN);
    assert.equal(Object.keys(state.local.editPolicies || {}).length, 0);
    assert.equal(state.counters.executes, 0);
    return { courses: state.local.bindings.length, pairedAccounts: 1, pairingUnchanged: true, editGrants: 0, courseWrites: 0 };
  } finally { await profile.stop(); }
}));
scenario("Q2", "returning to Selected courses restores the earlier scope and removes wider Edit access", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = movedTabProfile("q2", { port, accountCourses: [...accountCourses(30), { id: "42", name: "Course 42" }], local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    assert.equal((await within(accountMode(profile), 5_000, "account access")).ok, true);
    const wide = (await profile.state()).local.bindings.find(b => b.courseId === "1");
    for (const binding of [BINDING, wide]) {
      const saved = await within(profile.call({ type: "morrow_edit_policy_save", sourceBindingId: binding.sourceBindingId, enabledCategories: ["canvas_page_content"] }), 5_000, "Edit save");
      assert.equal(saved.ok, true, JSON.stringify(saved));
    }
    const widerRevision = (await profile.state()).local.editPolicies[wide.sourceBindingId].revision;
    assert.equal((await within(accountMode(profile, "selected"), 5_000, "selected access")).ok, true);
    const state = await profile.state();
    assert.equal(state.local.courseAccessMode, "selected");
    assert.deepEqual(state.local.bindings.map(b => b.courseId), ["42"]);
    assert.equal(state.local.token, TOKEN);
    assert.equal(state.local.editPolicies[wide.sourceBindingId], undefined);
    assert.equal(state.local.editPolicyRevisions[wide.sourceBindingId], widerRevision + 1);
    assert.deepEqual(state.local.editPolicies[BINDING.sourceBindingId].enabledCategories, ["canvas_page_content"]);
    return { restoredCourses: ["42"], pairingUnchanged: true, widerEditRevoked: true, retainedEditUnchanged: true };
  } finally { await profile.stop(); }
}));
scenario("Q3", "invalid access modes and untrusted senders cannot expand course access", async () => {
  const profile = movedTabProfile("q3", { accountCourses: accountCourses(30), local: { bindings: [BINDING] } });
  try {
    await profile.loaded;
    const before = await profile.state();
    for (const sender of ["course", "otherExtension", "alteredPopup"]) {
      const result = await within(accountMode(profile, "account", sender), 2_000, sender);
      assert.equal(result.ok, false);
      assert.equal(result.code, "course_access_sender_refused");
    }
    const bad = await within(accountMode(profile, "all"), 2_000, "invalid mode");
    assert.equal(bad.code, "course_access_mode_invalid");
    const after = await profile.state();
    assert.deepEqual(after.local, before.local);
    assert.equal(after.counters.executes, 0);
    return { refusedSenders: 3, invalidModeRefused: true, mutations: 0 };
  } finally { await profile.stop(); }
});
scenario("Q4", "an account change during enumeration cannot publish courses for the previous account", async () => {
  const profile = movedTabProfile("q4", { accountCourses: accountCourses(30), local: { bindings: [BINDING] } });
  try {
    await profile.loaded;
    await profile.set("changePrincipalAfterList", true);
    const result = await within(accountMode(profile), 5_000, "changed account");
    assert.equal(result.ok, false);
    const state = await profile.state();
    assert.notEqual(state.local.courseAccessMode, "account");
    assert.deepEqual(state.local.bindings.map(b => b.courseId), ["42"]);
    return { refused: true, unchangedScope: true };
  } finally { await profile.stop(); }
});
scenario("Q5", "a provider failure keeps the selected scope and permits a retry without pairing again", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = movedTabProfile("q5", { port, accountCourses: accountCourses(30), local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    await profile.set("discoveryFailure", true);
    assert.equal((await within(accountMode(profile), 5_000, "provider failure")).ok, false);
    assert.equal((await profile.state()).local.bindings.length, 1);
    await profile.set("discoveryFailure", false);
    assert.equal((await within(accountMode(profile), 5_000, "provider retry")).ok, true);
    const state = await profile.state();
    assert.equal(state.local.bindings.length, 30);
    assert.equal(state.local.token, TOKEN);
    return { coursesAfterRetry: 30, pairingUnchanged: true };
  } finally { await profile.stop(); }
}));
scenario("Q6", "Account access discovers more than 100 pages and transfers every course without a count limit", async () => withConnectorRuntime(async (runtime, port) => {
  let profile = movedTabProfile("q6", { port, accountCourses: accountCourses(12_001), local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    const result = await within(accountMode(profile), 30_000, "large paged account");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.pending, true);
    assert.equal((await profile.state()).local.bindings.length, 1, "an unfinished discovery keeps the previous scope");
    const checkpoint = (await profile.state()).local;
    assert.equal(checkpoint.accountCourseDiscovery.pagesRead, 50);
    await profile.stop();
    profile = movedTabProfile("q6-resumed", { port, accountCourses: accountCourses(12_001), local: checkpoint });
    await profile.loaded;
    for (let step = 0; step < 3; step += 1) {
      assert.equal((await within(accountMode(profile), 30_000, "resume discovery")).ok, true);
      if (!(await profile.state()).local.accountCourseDiscovery) break;
    }
    assert.equal((await profile.state()).local.bindings.length, 12_001);
    await waitFor(() => runtime.bindings().length === 12_001, 10_000, "complete large scope at assistant");
    assert.equal(runtime.bindings().some(b => b.courseId === "12001"), true);
    const saved = (await profile.state()).local;
    await profile.stop();
    const restarted = movedTabProfile("q6-restarted", { port, local: saved });
    try {
      await restarted.loaded;
      await waitFor(() => ready(restarted) === 1 && runtime.bindings().length === 12_001, 15_000, "large scope after restart");
      assert.equal((await restarted.state()).local.token, TOKEN);
    } finally { await restarted.stop(); }
    return { pagesFollowed: 121, courses: 12_001, coursesAfterRestart: 12_001, pairingUnchanged: true };
  } finally { await profile.stop(); }
}));
scenario("Q7", "the access mode and discovered courses survive a Chrome worker restart without pairing", async () => withConnectorRuntime(async (runtime, port) => {
  let profile = movedTabProfile("q7", { port, accountCourses: accountCourses(30), local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    assert.equal((await within(accountMode(profile), 5_000, "account access")).ok, true);
    const saved = (await profile.state()).local;
    await profile.stop();
    profile = startProfile("q7-restarted", { port, local: saved, tabs: [{ id: 1, url: `${ORIGIN}/courses/42`, principalId: "7" }] });
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    const status = await within(profile.call({ type: "morrow_status" }, "popup"), 3_000, "restarted status");
    assert.equal(status.ok, true);
    assert.equal(status.result.courseAccessMode, "account");
    assert.equal(status.result.bindings.length, 30);
    assert.equal((await profile.state()).local.token, TOKEN);
    return { coursesAfterRestart: 30, accountAccess: true, pairingUnchanged: true };
  } finally { await profile.stop(); }
}));

scenario("Q8", "automatic account refresh adds and removes courses without pairing or Edit grants", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = movedTabProfile("q8", { port, accountCourses: accountCourses(30), local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    assert.equal((await accountMode(profile)).ok, true);
    await profile.set("accountCourses", accountCourses(31).filter(course => course.id !== "2"));
    await profile.alarm("morrow-account-courses");
    await waitFor(async () => (await profile.state()).local.bindings.some(b => b.courseId === "31"), 5_000, "automatic course refresh");
    const saved = (await profile.state()).local;
    assert.equal(saved.bindings.some(b => b.courseId === "2"), false);
    assert.equal(saved.bindings.length, 30);
    assert.equal(saved.token, TOKEN);
    assert.equal(Object.keys(saved.editPolicies || {}).length, 0);
    return { added: "31", removed: "2", pairingUnchanged: true, editGrants: 0 };
  } finally { await profile.stop(); }
}));
scenario("Q9", "Moodle account discovery follows offsets and restores the selected scope", async () => {
  const anchor = { ...ANCHOR, provider: "moodle", siteUrl: ORIGIN, siteAnchorId: "moodle:anchor:g1" };
  const binding = { ...anchor, sourceBindingId: "moodle:anchor:g1:c42", courseId: "42", courseName: "Course 42", runtimeVerified: true };
  const profile = startProfile("q9", { local: { siteAnchors: [anchor], bindings: [binding] }, tabs: [{ id: 1, url: `${ORIGIN}/course/view.php?id=42`, principalId: "7" }], accountCourses: accountCourses(12_001) });
  try {
    await profile.loaded;
    for (let step = 0; step < 3; step += 1) assert.equal((await within(accountMode(profile), 30_000, "Moodle discovery")).ok, true);
    assert.equal((await profile.state()).local.bindings.length, 12_001);
    assert.equal((await accountMode(profile, "selected")).ok, true);
    assert.deepEqual((await profile.state()).local.bindings.map(b => b.courseId), ["42"]);
    return { provider: "moodle", courses: 12_001, pages: 121, restoredCourses: ["42"] };
  } finally { await profile.stop(); }
});

scenario("Q11", "one Plan access request can cover more than 500 courses", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = movedTabProfile("q11", { port, accountCourses: accountCourses(501), local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    assert.equal((await accountMode(profile)).ok, true);
    await waitFor(() => runtime.bindings().length === 501, 5_000, "all course bindings");
    const response = await runtime.editPolicySet({ mode: "plan", selections: runtime.bindings().map(binding => ({ sourceBindingId: binding.sourceBindingId, expectedPolicyRevision: binding.editPolicyRevision || 0 })) });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(Object.keys((await profile.state()).local.editPolicies).length, 0);
    return { selectedCourses: 501, mode: "plan", editGrants: 0 };
  } finally { await profile.stop(); }
}));

scenario("Q10", "Selected courses refuses site-wide requests before provider access", async () => withConnectorRuntime(async (runtime, port) => {
  const profile = movedTabProfile("q10", { port, accountCourses: [{ id: "42", name: "Course 42" }], local: { token: TOKEN, bindings: [BINDING] } });
  try {
    await profile.loaded;
    await waitFor(() => ready(profile) === 1, 5_000, "paired worker ready");
    for (const mode of ["selected", "account", "selected"]) {
      assert.equal((await accountMode(profile, mode)).ok, true);
      const before = (await profile.state()).counters.executes;
      const result = await runtime.call("canvas_list_your_courses", { _morrow: { source_binding_id: BINDING.sourceBindingId } });
      if (mode === "selected") {
        assert.equal(result.ok, false);
        assert.equal(result.problem?.code, "course_access_account_required", JSON.stringify(result));
        assert.equal((await profile.state()).counters.executes, before);
      } else {
        assert.equal((await profile.state()).counters.executes, before + 1);
        assert.equal(result.problem?.code, "fixture_read_answered");
      }
    }
    return { selectedRequestsRefused: 2, accountRequestDispatched: 1, pairingUnchanged: (await profile.state()).local.token === TOKEN };
  } finally { await profile.stop(); }
}));

// ---------------------------------------------------------------------------------------------
const head = (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
const dirty = (() => { try { return execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim().length > 0; } catch { return null; } })();
const onlyFlag = process.argv.indexOf("--only");
const only = onlyFlag > 0 ? new Set(String(process.argv[onlyFlag + 1] || "").split(",")) : null;
const results = [];
for (const entry of scenarios.filter((candidate) => !only || only.has(candidate.id))) {
  const started = Date.now();
  try {
    const evidence = await within(entry.run(), 120_000, entry.id);
    results.push({ id: entry.id, title: entry.title, ok: true, ms: Date.now() - started, evidence });
    console.log(`[first-use] PASS ${entry.id} ${entry.title}`);
  } catch (error) {
    results.push({ id: entry.id, title: entry.title, ok: false, ms: Date.now() - started, error: String(error?.message || error) });
    console.log(`[first-use] FAIL ${entry.id} ${entry.title}\n  ${String(error?.message || error).split("\n")[0]}`);
  }
}
const receipt = {
  schema: "morrow.bridge-recovery-first-use.v1",
  generatedAt: new Date().toISOString(),
  source: { head, dirty },
  node: process.version,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  scenarios: results,
};
mkdirSync(dirname(RECEIPT), { recursive: true });
writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ receipt: RECEIPT, passed: receipt.passed, failed: receipt.failed }));
process.exit(receipt.failed === 0 ? 0 : 1);
