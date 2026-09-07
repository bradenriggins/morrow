import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { problemCopy } from "../../connector/extension/src/bridge-problem-copy.js";
import { parseCanvasBrowserCatalog, parseMoodleBrowserCatalog } from "../../packages/canvas-connector-mcp/dist/browser-catalog.js";

/**
 * The gate on Morrow Bridge's Blackboard refusal.
 *
 * Morrow reaches Blackboard Learn through the official REST API in the Morrow app. The Bridge
 * carries no Blackboard module and no browser token exchange, so a Blackboard site cannot be
 * connected in Chrome. docs/implementation/THREE-LMS-BRIDGE-PARITY.md records why.
 *
 * scripts/test/bridge-release-provider-scope.test.mjs proves the packaged Bridge ships no
 * Blackboard file, and scripts/test/popup-view.test.mjs proves the words a person reads. Neither
 * runs the refusal. This file does: it loads the shipped service worker with a Chrome stub, sends
 * it the same messages the popup sends, and holds the refusal to what it must be — a named state,
 * no request to the Blackboard site, no saved connection, and no site access kept afterwards. It
 * also holds the two sides that would have to change first for a browser route to exist: the
 * worker's catalog load and the Gateway's browser-catalog reader.
 */

const root = new URL("../../", import.meta.url);
const EXTENSION_ID = "abeloclekioohahgedmjcdbpllfjfhko";
const CATALOG_PREFIX = `chrome-extension://${EXTENSION_ID}/`;

/** Every request the worker made, and every socket it opened, across the whole file. */
const network = { requests: [], sockets: [] };

/**
 * The worker reads its catalogs out of the packaged extension. Those three files are served from
 * this checkout; every other address is recorded and refused, so a request to a course site fails
 * the test that made it.
 */
globalThis.fetch = async (input) => {
  const url = String(input);
  network.requests.push(url);
  const name = url.startsWith(CATALOG_PREFIX) ? url.slice(CATALOG_PREFIX.length) : null;
  if (!name || !name.startsWith("generated/")) throw new Error(`no request to ${url} is expected here`);
  const body = readFileSync(new URL(`connector/extension/${name}`, root), "utf8");
  return { ok: true, text: async () => body, json: async () => JSON.parse(body) };
};

class RecordedSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) {
    network.sockets.push(String(url));
    this.readyState = RecordedSocket.CONNECTING;
  }
  send() {}
  close() {}
}
globalThis.WebSocket = RecordedSocket;

function listener() {
  return { addListener() {}, removeListener() {}, hasListener: () => false };
}

/**
 * One Chrome for one connection attempt: the tabs it holds, the site access it has granted, what
 * the Moodle probe answers in the page, and what the Canvas content script answers. Everything the
 * worker writes or asks for is recorded.
 */
function chromeFixture({ tabs = [], granted = [], moodleProbe = { ok: false }, canvasProbe = { ok: false } } = {}) {
  const local = new Map();
  const grantedOrigins = new Set(granted);
  const records = { scripts: [], tabMessages: [], removedPermissions: [], stored: [] };
  const area = {
    get: async (keys) => {
      const names = keys === undefined || keys === null ? [...local.keys()] : Array.isArray(keys) ? keys : [keys];
      const value = {};
      for (const name of names) if (local.has(name)) value[name] = structuredClone(local.get(name));
      return value;
    },
    set: async (values) => {
      records.stored.push(structuredClone(values));
      for (const [name, value] of Object.entries(values)) local.set(name, structuredClone(value));
    },
    remove: async (keys) => {
      for (const name of Array.isArray(keys) ? keys : [keys]) local.delete(name);
    },
  };
  const api = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `${CATALOG_PREFIX}${path}`,
      getManifest: () => ({ version: "1.0.2" }),
      sendMessage: async () => undefined,
      openOptionsPage: async () => {},
      onMessage: { addListener: (handler) => { messageHandler = handler; } },
      onStartup: listener(),
      onInstalled: listener(),
    },
    storage: { local: area },
    management: { getSelf: async () => ({ id: EXTENSION_ID, version: "1.0.2", installType: "development" }) },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: listener() },
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => grantedOrigins.has(origin)),
      remove: async ({ origins }) => {
        records.removedPermissions.push([...origins]);
        for (const origin of origins) grantedOrigins.delete(origin);
        return true;
      },
      getAll: async () => ({ origins: [...grantedOrigins] }),
      onAdded: listener(),
    },
    tabs: {
      get: async (id) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error("No tab with that id");
        return { ...tab };
      },
      query: async () => tabs.map((tab) => ({ ...tab })),
      sendMessage: async (tabId, message) => {
        records.tabMessages.push({ tabId, type: message?.type });
        return canvasProbe;
      },
      create: async () => ({}),
      onRemoved: listener(),
      onUpdated: listener(),
    },
    scripting: {
      executeScript: async (injection) => {
        records.scripts.push({ tabId: injection.target?.tabId, files: injection.files ? [...injection.files] : null });
        return injection.files ? [{ result: null }] : [{ result: moodleProbe }];
      },
    },
    webNavigation: { getAllFrames: async () => [] },
    webRequest: { onBeforeRequest: listener(), onHeadersReceived: listener() },
  };
  return { api, records, grantedOrigins, local };
}

let messageHandler = null;

/** Installs one fixture as the Chrome the worker sees, and returns it. */
function install(fixture) {
  globalThis.chrome = fixture.api;
  return fixture;
}

install(chromeFixture());
await import("../../connector/extension/src/service-worker.js");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(typeof messageHandler, "function", "the service worker registered no message handler");

/** Sends the worker one of the messages the popup sends, and answers with what it replies. */
function send(message) {
  return new Promise((resolve, reject) => {
    const answered = messageHandler(message, {}, resolve);
    if (answered !== true) reject(new Error(`the service worker did not answer ${message.type}`));
  });
}

const ULTRA_TAB = { id: 7, url: "https://learn.example.edu/ultra/courses/_123_1/outline" };
const ORIGINAL_TAB = { id: 8, url: "https://learn.example.edu/webapps/blackboard/execute/announcement?course_id=_123_1" };
const LEARN_ORIGIN = "https://learn.example.edu/*";
const CANVAS_TAB = { id: 9, url: "https://canvas.example.edu/courses/42" };
const CANVAS_ORIGIN = "https://canvas.example.edu/*";
const MOODLE_TAB = { id: 10, url: "https://moodle.example.edu/course/view.php?id=9" };
const MOODLE_ORIGIN = "https://moodle.example.edu/*";
const MOODLE_PROFILE = {
  provider: "moodle",
  origin: "https://moodle.example.edu",
  siteUrl: "https://moodle.example.edu/",
  principalId: "31",
  courseId: "9",
};

/** The site requests a fixture made, which for a refused connection has to be none. */
function siteRequests() {
  return network.requests.filter((url) => !url.startsWith(CATALOG_PREFIX));
}

test("a Blackboard Ultra tab is refused by name, and Morrow sends nothing to the site", async () => {
  const fixture = install(chromeFixture({ tabs: [ULTRA_TAB], granted: [LEARN_ORIGIN] }));
  const before = siteRequests().length;

  const answer = await send({ type: "morrow_connect_course", tabId: ULTRA_TAB.id });

  assert.deepEqual(answer, { ok: false, code: "blackboard_browser_unsupported", error: "blackboard_browser_unsupported" });
  assert.equal(problemCopy("blackboard_browser_unsupported").known, true, "the refused state has no words for the person who sees it");
  assert.deepEqual(siteRequests().slice(before), [], "Morrow reached the Blackboard site");
  assert.deepEqual(network.sockets, [], "Morrow opened a connection while refusing");
  assert.deepEqual(fixture.records.stored, [], "Morrow saved state for a connection it refused");
  assert.deepEqual(fixture.records.tabMessages, [], "Morrow spoke to the page after refusing it");
  assert.deepEqual(fixture.records.scripts.filter((entry) => entry.files), [], "Morrow injected the Canvas content script into Blackboard");
});

test("a Blackboard Original tab is refused the same way", async () => {
  const fixture = install(chromeFixture({ tabs: [ORIGINAL_TAB], granted: [LEARN_ORIGIN] }));
  const before = siteRequests().length;

  const answer = await send({ type: "morrow_connect_course", tabId: ORIGINAL_TAB.id });

  assert.equal(answer.code, "blackboard_browser_unsupported");
  assert.deepEqual(siteRequests().slice(before), []);
  assert.deepEqual(fixture.records.stored, []);
});

test("a Blackboard site Morrow was never given runs no code and saves nothing", async () => {
  const fixture = install(chromeFixture({ tabs: [ULTRA_TAB], granted: [] }));

  const answer = await send({ type: "morrow_connect_course", tabId: ULTRA_TAB.id });

  // Access answers first, because Morrow cannot read a site it was never given.
  assert.equal(answer.code, "course_site_access_required");
  assert.deepEqual(fixture.records.scripts, [], "Morrow ran code on a site it has no access to");
  assert.deepEqual(fixture.records.stored, []);
});

test("a refused Blackboard connection keeps none of the site access it was just granted", async () => {
  const fixture = install(chromeFixture({ tabs: [ULTRA_TAB], granted: [] }));

  const intent = await send({ type: "morrow_connect_course_prepare", tabId: ULTRA_TAB.id });
  assert.deepEqual(intent.result.origins, [LEARN_ORIGIN]);
  assert.deepEqual(intent.result.preGrantedOrigins, []);
  // Chrome asked the person, and the person allowed it.
  fixture.grantedOrigins.add(LEARN_ORIGIN);

  const answer = await send({ type: "morrow_connect_course_complete", intentId: intent.result.id });

  assert.equal(answer.code, "blackboard_browser_unsupported");
  assert.deepEqual(fixture.records.removedPermissions, [[LEARN_ORIGIN]]);
  assert.equal(fixture.grantedOrigins.has(LEARN_ORIGIN), false, "Morrow kept access to a site it refuses to use");
});

test("a refused Blackboard connection leaves alone the access Morrow already had", async () => {
  // Chrome asks nobody when Morrow already holds the site, so there is nothing this attempt
  // granted and nothing for it to give back. Taking the site away here would take away access the
  // person allowed for something else, which a refusal must never do.
  const fixture = install(chromeFixture({ tabs: [ULTRA_TAB], granted: [LEARN_ORIGIN] }));

  const intent = await send({ type: "morrow_connect_course_prepare", tabId: ULTRA_TAB.id });
  assert.deepEqual(intent.result.preGrantedOrigins, [LEARN_ORIGIN]);

  const answer = await send({ type: "morrow_connect_course_complete", intentId: intent.result.id });

  assert.equal(answer.code, "blackboard_browser_unsupported");
  assert.deepEqual(fixture.records.removedPermissions, [], "Morrow took away access it had not just asked for");
  assert.equal(fixture.grantedOrigins.has(LEARN_ORIGIN), true);
});

test("a Canvas connection that can be tried again keeps the access it was granted", async () => {
  const fixture = install(chromeFixture({ tabs: [CANVAS_TAB], granted: [], canvasProbe: { ok: false } }));

  const intent = await send({ type: "morrow_connect_course_prepare", tabId: CANVAS_TAB.id });
  fixture.grantedOrigins.add(CANVAS_ORIGIN);
  const answer = await send({ type: "morrow_connect_course_complete", intentId: intent.result.id });

  assert.equal(answer.code, "course_sign_in_required");
  assert.deepEqual(fixture.records.removedPermissions, [], "signing in and trying again would need a second Chrome prompt");
  assert.equal(fixture.grantedOrigins.has(CANVAS_ORIGIN), true);
});

test("a Moodle site that answers its own probe is never refused as Blackboard", async () => {
  // The refusal reads the address, so a Moodle installed under one of Blackboard's paths still
  // connects: the page answers as Moodle before the address is ever read.
  const tab = { id: 11, url: "https://moodle.example.edu/ultra/course/view.php?id=9" };
  const fixture = install(chromeFixture({
    tabs: [tab],
    granted: [MOODLE_ORIGIN],
    moodleProbe: { ok: true, profile: MOODLE_PROFILE },
  }));

  const answer = await send({ type: "morrow_connect_course", tabId: tab.id });

  assert.equal(answer.ok, true);
  assert.equal(answer.result.provider, "moodle");
  assert.match(answer.result.siteAnchorId, /^moodle:[0-9a-f]{20}:g1$/);
  assert.deepEqual(fixture.records.removedPermissions, []);
});

test("a Canvas course still connects, and Morrow digests no Blackboard catalog", async () => {
  const fixture = install(chromeFixture({
    tabs: [MOODLE_TAB, CANVAS_TAB],
    granted: [CANVAS_ORIGIN],
    canvasProbe: { ok: true, profile: { id: "5", origin: "https://canvas.example.edu", name: "Ada Lovelace" } },
  }));

  const answer = await send({ type: "morrow_connect_course", tabId: CANVAS_TAB.id });

  assert.equal(answer.ok, true);
  assert.equal(answer.result.provider, "canvas");
  assert.equal(answer.result.sessionGeneration, 1);
  assert.deepEqual(fixture.records.scripts.filter((entry) => entry.files)[0].files, ["src/canvas-content.js"]);
  // The connection loaded the worker's catalogs. There is no Blackboard one to load.
  const catalogs = network.requests.filter((url) => url.startsWith(CATALOG_PREFIX)).map((url) => url.slice(CATALOG_PREFIX.length));
  assert.deepEqual([...new Set(catalogs)].sort(), [
    "generated/canvas-api-catalog.json",
    "generated/canvas-browser-catalog.json",
    "generated/moodle-browser-catalog.json",
  ]);
  assert.deepEqual(siteRequests(), []);
});

test("the extension carries no Blackboard catalog, and the Gateway reader accepts none", () => {
  const generated = readdirSync(new URL("connector/extension/generated/", root));
  assert.deepEqual(generated.filter((name) => /blackboard/i.test(name)), []);

  const catalog = {
    schema: "morrow.browser-catalog.v1",
    provider: "blackboard",
    operations: [{
      key: "blackboard.browser.read.v1",
      toolName: "blackboard_read_course",
      provider: "blackboard",
      summary: "Read a Blackboard course",
      description: "Read a Blackboard course in the browser.",
      readOnly: true,
      inputSchema: { type: "object" },
      documentation: "https://docs.blackboard.com/",
    }],
  };
  const digest = "0".repeat(64);
  assert.throws(() => parseCanvasBrowserCatalog(catalog, digest), /Canvas browser catalog is invalid/);
  assert.throws(() => parseMoodleBrowserCatalog(catalog, digest), /Moodle browser catalog is invalid/);
});
