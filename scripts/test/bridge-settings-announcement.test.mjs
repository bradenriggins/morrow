import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const settingsHtml = readFileSync(new URL("connector/extension/settings/settings.html", root), "utf8");

/** Reads every opening tag with its attributes, so each check below runs against the shipped page. */
function elements(html) {
  const nodes = [];
  const opening = /<([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (let match = opening.exec(html); match; match = opening.exec(html)) {
    const attributes = {};
    for (const [, name, quoted, single] of match[2].matchAll(/([a-z][a-z0-9_:-]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/gi)) {
      attributes[name.toLowerCase()] = quoted ?? single ?? "";
    }
    nodes.push({ tag: match[1].toLowerCase(), attributes });
  }
  return nodes;
}

function nodeById(id) {
  const node = elements(settingsHtml).find((candidate) => candidate.attributes.id === id);
  assert.ok(node, `settings.html has no element with id "${id}"`);
  return node;
}

test("the tag reader finds the attributes the settings page really ships", () => {
  const nodes = elements('<p id="a" class="b" hidden></p>\n<input id="c" type="search">');
  assert.deepEqual(nodes, [
    { tag: "p", attributes: { id: "a", class: "b", hidden: "" } },
    { tag: "input", attributes: { id: "c", type: "search" } },
  ]);
  assert.equal(nodeById("notice").tag, "p");
  // A tag the reader cannot parse would hide its attributes from every check below.
  assert.equal(elements(settingsHtml).filter((node) => "id" in node.attributes).length, settingsHtml.match(/\sid="/g).length);
});

// The page has exactly one status region, one alert, and one log. The Private Chat transcript is
// a log because it is a running conversation, not a status: a screen reader reads each new message
// as it arrives without re-reading the page state. Nothing else may announce, so a result a person
// asked for is never buried under a re-render of a list or a state line.
test("the settings page announces through one polite status region, one alert, and one chat log", () => {
  const live = elements(settingsHtml).filter((node) => "aria-live" in node.attributes);
  assert.deepEqual(live.map((node) => [node.attributes.id, node.attributes["aria-live"], node.attributes.role]), [
    ["announcement", "polite", "status"],
    ["private-chat-history", "polite", "log"],
  ]);
  const regions = elements(settingsHtml).filter((node) => ["status", "alert", "log"].includes(node.attributes.role));
  assert.deepEqual(regions.map((node) => [node.attributes.id, node.attributes.role]), [
    ["error", "alert"],
    ["announcement", "status"],
    ["private-chat-history", "log"],
  ]);
  // The Private Chat state line is rewritten on every render, so it must not be a live region.
  assert.equal(nodeById("private-chat-status").attributes.role, undefined);
  assert.equal("aria-live" in nodeById("private-chat-status").attributes, false);
});

test("no settings collection or in-place status line is its own live region", () => {
  for (const id of ["course-list", "category-list", "page-status", "visible-scope", "site-anchor-details",
    "discovery-progress-text", "file-storage-status", "selection-summary", "edit-stage-hint", "notice", "save-confirmation-detail"]) {
    assert.equal("aria-live" in nodeById(id).attributes, false, id);
    assert.equal(nodeById(id).attributes.role, undefined, id);
  }
  // Focus moves into the confirmation group, so its detail is part of the name the group states.
  assert.equal(nodeById("save-confirmation").attributes["aria-labelledby"], "save-confirmation-title save-confirmation-detail");
});

test("the settings controls state their own labels in visible text", () => {
  for (const id of ["course-filter", "action-filter"]) {
    assert.equal("placeholder" in nodeById(id).attributes, false, id);
    const label = new RegExp(`<label class="search-field" for="${id}">\\s*<span>([^<]+)</span>`).exec(settingsHtml);
    assert.ok(label && label[1].trim().length > 0, `${id} has no visible label`);
  }
  const refresh = /<button id="refresh"([^>]*)>([^<]*)<\/button>/.exec(settingsHtml);
  assert.ok(refresh);
  assert.equal(refresh[2].trim(), "Refresh connected courses");
  assert.doesNotMatch(refresh[1], /aria-label|title=/);
  assert.equal("aria-label" in nodeById("course-list").attributes, false);
  assert.doesNotMatch(settingsHtml, /<span class="brand-wordmark"[^>]*aria-label/);
});

/** One stub element per id in settings.html, carrying the attributes the page ships. */
function stubDom(html) {
  const nodes = {};
  for (const node of elements(html)) {
    const id = node.attributes.id;
    if (!id) continue;
    nodes[`#${id}`] = {
      attributes: { ...node.attributes },
      textContent: "",
      innerHTML: "",
      value: "",
      options: [],
      selectedIndex: 0,
      hidden: "hidden" in node.attributes,
      disabled: "disabled" in node.attributes,
      checked: "checked" in node.attributes,
      listeners: {},
      setAttribute(name, text) { this.attributes[name] = text; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
      focus() {},
      querySelector: () => null,
    };
  }
  return nodes;
}

/** Waits for a click handler that starts asynchronous work to finish it. */
async function settle(check, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  assert.fail(description);
}

// settings.js is loaded once against a stub of the globals it uses, because the change this item
// makes lives in the wiring: the one status region has to receive a short list summary and the
// text of a visible notice, and no other element may become a live region at runtime.
test("the one status region carries the course-list summary and every notice", async () => {
  const nodes = stubDom(settingsHtml);
  const courses = Array.from({ length: 8 }, (unused, index) => ({
    sourceBindingId: `canvas:course-${index + 1}`,
    provider: "canvas",
    origin: "https://canvas.example.edu",
    courseId: String(index + 1),
    courseName: `Course ${index + 1}`,
    runtimeVerified: true,
    editPolicyRevision: 0,
  }));
  const status = { bindings: courses, editDurations: [{ value: 60 * 60 * 1_000, label: "1 hour" }], catalogDigest: "a".repeat(64), siteAnchors: [] };
  let filePermission = false;
  const stored = {};
  globalThis.document = { activeElement: null, querySelector: (selector) => nodes[selector] || null, addEventListener() {} };
  globalThis.HTMLInputElement = class HTMLInputElement {};
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => message.type === "morrow_edit_policy_status"
        ? { ok: true, result: status }
        : { ok: false, error: "unexpected request" },
    },
    storage: {
      local: {
        get: async (key) => (typeof key === "string" ? (key in stored ? { [key]: stored[key] } : {}) : { ...stored }),
        set: async (values) => { Object.assign(stored, values); },
      },
      onChanged: { addListener() {} },
    },
    permissions: {
      contains: async () => filePermission,
      request: async () => (filePermission = true),
      remove: async () => { filePermission = false; },
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
  };
  try {
    await import("../../connector/extension/settings/settings.js");
    assert.equal(nodes["#announcement"].textContent, "8 connected courses, page 1 of 2.");
    assert.equal(nodes["#page-status"].textContent, "Showing 1–6 of 8 matching connected courses. Page 1 of 2.");

    nodes["#next-page"].listeners.click[0]();
    assert.equal(nodes["#announcement"].textContent, "8 connected courses, page 2 of 2.");

    nodes["#course-filter"].value = "Course 3";
    nodes["#course-filter"].listeners.input[0]();
    assert.equal(nodes["#announcement"].textContent, "Search matches 1 connected course.");

    nodes["#course-filter"].value = "Rhetoric";
    nodes["#course-filter"].listeners.input[0]();
    assert.equal(nodes["#announcement"].textContent, "No connected course matches this search.");

    nodes["#course-filter"].value = "";
    nodes["#course-filter"].listeners.input[0]();
    assert.equal(nodes["#announcement"].textContent, "8 connected courses, page 1 of 2.");

    nodes["#enable-file-storage"].listeners.click[0]();
    await settle(() => nodes["#file-storage-status"].textContent.startsWith("On."), "course file access never reported on");
    assert.equal(nodes["#notice"].hidden, false);
    assert.equal(nodes["#announcement"].textContent, nodes["#notice"].textContent);
    assert.match(nodes["#announcement"].textContent, /^Course file access is on\./);

    // The visible notice keeps the region until the next action clears it, so a list summary
    // rendered right after an action result does not replace that result.
    nodes["#course-filter"].value = "Course 5";
    nodes["#course-filter"].listeners.input[0]();
    assert.match(nodes["#announcement"].textContent, /^Course file access is on\./);

    for (const selector of Object.keys(nodes)) {
      assert.equal("aria-live" in nodes[selector].attributes, ["#announcement", "#private-chat-history"].includes(selector), selector);
    }
  } finally {
    delete globalThis.document;
    delete globalThis.HTMLInputElement;
    delete globalThis.chrome;
  }
});
