/**
 * Executes installer/renderer/renderer.js against a small stand-in document.
 *
 * The stand-in models only what the renderer touches: element attributes, an
 * innerHTML setter that collects the buttons it writes, focus that a disabled
 * control gives up, and form values. It proves the renderer's own decisions.
 * It does not prove Chromium layout, real HTML parsing, or Electron behaviour.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { installerState } = require("../shared/contract.cjs");

const SELECTORS = [
  "#setup", "#refresh", "#header-status", ".intro", "#windows-note", "#macos-note", "#progress-list", "#loading",
  "#action-content", "#action-title", "#action-copy", "#action-body", "#problem",
  "#updates-panel", "#updates-copy", "#updates-actions", "#blackboard-panel", "#blackboard-copy",
  "#blackboard-admin-note", "#blackboard-tenant", "#blackboard-saved-note", "#blackboard-replace-note",
  "#blackboard-form", "#blackboard-base-url", "#blackboard-application-key", "#blackboard-application-secret", "#blackboard-submit",
  "#blackboard-base-url-error", "#blackboard-application-key-error", "#blackboard-application-secret-error",
  "#blackboard-courses", "#blackboard-courses-copy", "#blackboard-course-list",
  "#retention-panel", "#retention-title", "#retention-copy", "#retention-body",
  "#removal-status", "#support"
];

// The inline message index.html ties to each Blackboard field.
const BLACKBOARD_FIELD_ERRORS = {
  baseUrl: "#blackboard-base-url-error",
  applicationKey: "#blackboard-application-key-error",
  applicationSecret: "#blackboard-application-secret-error"
};

// The id index.html gives each field of the Blackboard connection form.
const BLACKBOARD_FIELD_SELECTORS = {
  baseUrl: "#blackboard-base-url",
  applicationKey: "#blackboard-application-key",
  applicationSecret: "#blackboard-application-secret"
};

// The platform each managed-device note in index.html claims to be true for.
const PLATFORM_NOTES = { "#windows-note": "win32", "#macos-note": "darwin" };

const BLACKBOARD_TENANT = {
  id: "learn-example-edu",
  baseUrl: "https://learn.example.edu",
  principalId: "_123_1",
  accountVerified: true,
  availableCourses: [
    { courseId: "_45_1", title: "Biology" },
    { courseId: "_46_2", title: "Chemistry" }
  ],
  courseBindings: []
};

const BLACKBOARD_FIELDS = {
  baseUrl: "https://learn.example.edu",
  applicationKey: "key-1",
  applicationSecret: "secret-1"
};

class ShimElement {
  constructor(document, tag, attributes = {}) {
    this.document = document;
    this.tagName = tag.toUpperCase();
    this.id = attributes.id || "";
    this.className = attributes.class || "";
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.children = [];
    this.hidden = false;
    this.open = false;
    this.value = "";
    this.textContent = "";
    this.htmlWrites = 0;
    this.name = attributes.name || "";
    this.disabledValue = Object.hasOwn(attributes, "disabled");
    this.html = "";
    for (const [attribute, value] of Object.entries(attributes)) {
      if (!attribute.startsWith("data-")) continue;
      const key = attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  get disabled() {
    return this.disabledValue;
  }

  set disabled(value) {
    this.disabledValue = value === true;
    if (this.disabledValue && this.document.activeElement === this) this.document.activeElement = null;
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value) {
    this.html = String(value);
    this.htmlWrites += 1;
    this.children = parseChildren(this.document, this.html);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  focus() {
    if (!this.disabledValue) this.document.activeElement = this;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  dispatch(type, event = {}) {
    const handler = this.listeners.get(type);
    assert.ok(handler, `no ${type} listener`);
    return handler({ target: this, preventDefault() {}, ...event });
  }

  closest(selector) {
    return matches(this, selector) ? this : null;
  }

  querySelectorAll(selector) {
    return this.children.filter((child) => matches(child, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matches(element, selector) {
  if (selector === "[data-action]") return typeof element.dataset.action === "string";
  if (selector === "button") return element.tagName === "BUTTON";
  if (selector.startsWith(".")) return element.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  throw new Error(`the stand-in document does not support ${selector}`);
}

function parseChildren(document, html) {
  const children = [];
  for (const [, tag, rest] of html.matchAll(/<(button|details)\b([^>]*)>/g)) {
    const attributes = {};
    for (const [, name, value] of rest.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attributes[name] = value ?? "";
    const element = new ShimElement(document, tag, attributes);
    element.open = Object.hasOwn(attributes, "open");
    children.push(element);
  }
  return children;
}

class ShimFormData {
  constructor(form) {
    this.values = new Map(Object.entries(form.fields).map(([name, input]) => [name, input.value]));
  }

  get(name) {
    return this.values.has(name) ? this.values.get(name) : null;
  }

  delete(name) {
    this.values.delete(name);
  }
}

function setupDocument() {
  const document = { activeElement: null };
  const elements = new Map();
  for (const selector of SELECTORS) {
    const inputs = Object.values(BLACKBOARD_FIELD_SELECTORS);
    const tag = selector.endsWith("-form") ? "form" : inputs.includes(selector) ? "input" : "div";
    const attributes = selector.startsWith("#") ? { id: selector.slice(1) } : { class: selector.slice(1) };
    if (Object.hasOwn(PLATFORM_NOTES, selector)) attributes["data-platform"] = PLATFORM_NOTES[selector];
    elements.set(selector, new ShimElement(document, tag, attributes));
  }
  document.querySelector = (selector) => {
    const element = elements.get(selector);
    assert.ok(element, `the stand-in document has no ${selector}`);
    return element;
  };
  const form = elements.get("#blackboard-form");
  form.fields = {};
  for (const [name, value] of Object.entries(BLACKBOARD_FIELDS)) {
    const input = elements.get(BLACKBOARD_FIELD_SELECTORS[name]);
    input.value = value;
    form.fields[name] = input;
  }
  form.resets = 0;
  form.reset = () => {
    form.resets += 1;
    for (const input of Object.values(form.fields)) input.value = "";
  };
  const window = { listeners: new Map() };
  window.addEventListener = (type, handler) => window.listeners.set(type, handler);
  window.dispatch = (type) => window.listeners.get(type)({});
  return { document, window, element: (selector) => elements.get(selector) };
}

function ok(state) {
  return { schema: "morrow.installer-result.v1", ok: true, state };
}

function failed(state, error) {
  return { schema: "morrow.installer-result.v1", ok: false, state, error };
}

const BASE = {
  lifecycle: "assistant_ready",
  assistants: [{ id: "codex", title: "ChatGPT", tier: "primary", supported: true, detected: true, configured: true, selected: true }],
  selectedAssistantId: "codex",
  workspaceSelected: true,
  runtimeStatus: "ready",
  bridgeDelivery: "developer_temporary",
  bridgeLoadedInChrome: true,
  bridgeFolderReady: true,
  bridgePaired: "unknown",
  courseSite: "unknown",
  runtimeVerifiedCourseCount: 0,
  selectedCourseName: null
};

function state(overrides = {}) {
  return installerState({ ...BASE, ...overrides });
}

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Selects Check status and waits for the answer. A window focus is throttled,
 * so a case that only needs the next state uses the control a person would use.
 */
async function checkStatus(dom) {
  await dom.element("#refresh").dispatch("click");
  await settle();
}

async function load(name, invoke, platform) {
  const dom = setupDocument();
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  globalThis.Element = ShimElement;
  globalThis.HTMLElement = ShimElement;
  globalThis.FormData = ShimFormData;
  globalThis.morrowInstaller = platform ? { invoke, platform } : { invoke };
  await import(`../renderer/renderer.js?case=${name}`);
  await settle();
  return dom;
}

test("a first load that returns no state stops claiming progress and offers a retry", async () => {
  let answer = () => ({ nothing: true });
  const dom = await load("unreadable", async (method) => answer(method));

  assert.equal(dom.element("#loading").hidden, true);
  assert.equal(dom.element("#action-content").hidden, false);
  assert.equal(dom.element("#action-title").textContent, "Morrow could not read its setup state.");
  assert.equal(dom.element("#header-status").textContent, "Morrow could not read its setup state");
  assert.match(dom.element("#problem").innerHTML, /Morrow returned an incomplete setup state\./);
  assert.equal(dom.element("#problem").hidden, false);
  assert.equal(dom.element("#progress-list").innerHTML.includes("Not checked yet"), true);
  assert.equal(dom.element("#progress-list").innerHTML.includes('aria-current="step"'), false);

  const retry = dom.element("#action-body").querySelector("[data-action]");
  assert.equal(retry.dataset.action, "check-setup-state");

  answer = () => ok(state());
  await dom.element("#action-body").dispatch("click", { target: retry });
  await settle();
  assert.equal(dom.element("#action-title").textContent, "Connect Morrow Bridge.");
  assert.equal(dom.element("#loading").hidden, true);
  assert.equal(dom.element("#problem").hidden, true);
});

test("a window focus asks Morrow again at most once every five seconds, and never mid-step", async (t) => {
  let clock = 100_000;
  t.mock.method(Date, "now", () => clock);
  const calls = [];
  let answer = () => ok(state());
  const dom = await load("focus-throttle", async (method, payload) => {
    calls.push({ method, payload });
    return answer();
  });
  assert.equal(calls.length, 1, "setup reads the state once when it opens");
  assert.equal(calls[0].payload, undefined, "the read setup starts with asks for nothing extra");

  clock += 1_000;
  await dom.window.dispatch("focus");
  await settle();
  assert.equal(calls.length, 1, "a focus a second later reuses what Morrow already answered");

  clock += 4_000;
  await dom.window.dispatch("focus");
  await settle();
  assert.equal(calls.length, 2, "a focus five seconds later asks again");
  assert.equal(calls[1].payload, undefined, "a focus read never makes Morrow look at this computer again");

  // Check status is the person asking, so it is never throttled and it always
  // makes Morrow read this computer again.
  await checkStatus(dom);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].payload, { recheckAssistants: true });

  let finish = null;
  answer = () => new Promise((resolve) => { finish = () => resolve(ok(state())); });
  void dom.element("#refresh").dispatch("click");
  await settle();
  assert.equal(calls.length, 4, "the step the person started is running");
  clock += 60_000;
  await dom.window.dispatch("focus");
  await settle();
  assert.equal(calls.length, 4, "a focus while that step runs asks nothing");
  finish();
  await settle();
});

test("setup asks again on its own while the runtime is still uncertain", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => t.mock.timers.reset());
  const calls = [];
  let answer = () => ok(state({ runtimeStatus: "uncertain" }));
  const dom = await load("settling", async (method) => {
    calls.push(method);
    return answer();
  });
  assert.equal(calls.length, 1);
  assert.equal(dom.element("#action-title").textContent, "Morrow is getting ready.");

  answer = () => ok(state());
  t.mock.timers.tick(750);
  await settle();
  assert.equal(calls.length, 2, "setup asked again without the person doing anything");
  assert.equal(dom.element("#action-title").textContent, "Connect Morrow Bridge.");

  // A settled runtime stops the asking.
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls.length, 2);
});

test("a step that leaves the runtime uncertain settles without the person asking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => t.mock.timers.reset());
  const methods = [];
  let current = state({ lifecycle: "repair_required", runtimeStatus: "repair_required", assistants: [], selectedAssistantId: null });
  const dom = await load("settling-after-step", async (method) => {
    methods.push(method);
    // Repair answers with a runtime that has been started but not observed yet.
    if (method === "installer:repair") current = state({ runtimeStatus: "uncertain" });
    return ok(current);
  });

  const repair = dom.element("#action-body").querySelector("[data-action]");
  await dom.element("#action-body").dispatch("click", { target: repair });
  await settle();
  assert.deepEqual(methods, ["installer:get-state", "installer:repair"]);
  assert.equal(dom.element("#action-title").textContent, "Morrow is getting ready.");

  current = state();
  t.mock.timers.tick(750);
  await settle();
  assert.deepEqual(methods, ["installer:get-state", "installer:repair", "installer:get-state"]);
  assert.equal(dom.element("#action-title").textContent, "Connect Morrow Bridge.");
});

test("setup stops asking again after a limited number of tries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => t.mock.timers.reset());
  const calls = [];
  const dom = await load("settling-limit", async (method) => {
    calls.push(method);
    return ok(state({ runtimeStatus: "uncertain" }));
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    t.mock.timers.tick(750);
    await settle();
  }
  assert.equal(calls.length, 5, "the first read plus four tries, then it waits for the person");
  assert.equal(dom.element("#action-title").textContent, "Morrow is getting ready.");
});

test("focus survives the busy re-render an action causes", async () => {
  const busy = [];
  const dom = await load("focus", async (method) => {
    if (method === "installer:reconcile-bridge") {
      busy.push({
        ariaBusy: dom.element("#setup").getAttribute("aria-busy"),
        refreshDisabled: dom.element("#refresh").disabled,
        actionsDisabled: dom.element("#action-body").querySelectorAll("[data-action]").every((button) => button.disabled)
      });
    }
    return ok(state());
  });

  const before = dom.element("#action-body").querySelector("[data-action]");
  assert.equal(before.dataset.action, "check-bridge");
  before.focus();
  assert.equal(dom.document.activeElement, before);

  await dom.element("#action-body").dispatch("click", { target: before });
  await settle();

  assert.deepEqual(busy, [{ ariaBusy: "true", refreshDisabled: true, actionsDisabled: true }]);
  assert.equal(dom.element("#setup").getAttribute("aria-busy"), "false");
  assert.equal(dom.element("#refresh").disabled, false);
  const after = dom.element("#action-body").querySelector("[data-action]");
  assert.notEqual(after, before);
  assert.equal(dom.document.activeElement, after);
  assert.equal(after.disabled, false);
});

test("choosing an assistant keeps focus on the chosen card and leaves the advanced group open", async () => {
  const assistants = [
    { id: "codex", title: "ChatGPT", tier: "primary", supported: true, detected: true },
    { id: "claude-code", title: "Claude Code", tier: "advanced", supported: true, detected: true, needsWorkspace: true }
  ];
  const dom = await load("choose", async () => ok(state({ lifecycle: "ready_for_assistant", assistants, selectedAssistantId: null })));

  const advanced = dom.element("#action-body").querySelector(".advanced-assistants");
  assert.ok(advanced);
  advanced.open = true;
  const card = dom.element("#action-body").querySelectorAll("[data-action]").find((entry) => entry.dataset.assistantId === "claude-code");
  card.focus();

  await dom.element("#action-body").dispatch("click", { target: card });
  await settle();

  const chosen = dom.element("#action-body").querySelectorAll("[data-action]").find((entry) => entry.dataset.assistantId === "claude-code");
  assert.notEqual(chosen, card);
  assert.equal(dom.document.activeElement, chosen);
  assert.equal(dom.element("#action-body").querySelector(".advanced-assistants").open, true);
  assert.match(dom.element("#action-body").innerHTML, /Set up Claude Code/);
});

test("the problem alert is written once for each distinct problem", async () => {
  let answer = () => ok(state());
  const dom = await load("problem", async () => answer());
  const problem = dom.element("#problem");
  assert.equal(problem.htmlWrites, 0);

  answer = () => failed(state(), { code: "setup_failed", message: "Morrow could not reach Chrome.", recovery: "Open Chrome, then check again." });
  await checkStatus(dom);
  assert.equal(problem.htmlWrites, 1);
  assert.match(problem.innerHTML, /Morrow could not reach Chrome\./);

  await checkStatus(dom);
  assert.equal(problem.htmlWrites, 1);

  answer = () => failed(state(), { code: "setup_failed", message: "Morrow could not read the Bridge folder.", recovery: "Check the folder, then check again." });
  await checkStatus(dom);
  assert.equal(problem.htmlWrites, 2);

  answer = () => ok(state());
  await checkStatus(dom);
  assert.equal(problem.htmlWrites, 3);
  assert.equal(problem.hidden, true);
});

test("a rejected Blackboard save keeps the three safe values and clears only the secret", async () => {
  let request = null;
  let answer = () => failed(state(), { code: "blackboard_configuration_invalid", message: "Morrow could not save that connection.", recovery: "Check the account ID, then save again." });
  const dom = await load("blackboard", async (method, payload) => {
    if (method === "installer:configure-blackboard") request = payload;
    return answer();
  });
  const form = dom.element("#blackboard-form");

  await form.dispatch("submit");
  await settle();
  assert.deepEqual(Object.keys(request), ["baseUrl", "applicationKey", "applicationSecret"]);
  assert.equal(form.resets, 0);
  assert.equal(form.fields.applicationSecret.value, "");
  assert.equal(form.fields.baseUrl.value, BLACKBOARD_FIELDS.baseUrl);
  assert.equal(form.fields.applicationKey.value, BLACKBOARD_FIELDS.applicationKey);
  assert.match(dom.element("#problem").innerHTML, /Morrow could not save that connection\./);
  // The emptied secret is the only field with something to correct.
  assert.match(dom.element(BLACKBOARD_FIELD_ERRORS.applicationSecret).textContent, /Paste the application secret/);
  for (const name of ["baseUrl", "applicationKey"]) {
    assert.equal(dom.element(BLACKBOARD_FIELD_ERRORS[name]).textContent, "", name);
  }
  assert.equal(dom.element("#blackboard-courses").hidden, true);
  assert.equal(dom.element("#blackboard-admin-note").hidden, false);
  assert.equal(dom.element("#blackboard-saved-note").hidden, true);

  form.fields.applicationSecret.value = BLACKBOARD_FIELDS.applicationSecret;
  form.fields.baseUrl.value = "https://learn.example.edu/ultra/institution-page";
  answer = () => ok(state({ blackboard: { status: "api_configured_live_untested", tenants: [BLACKBOARD_TENANT] } }));
  await form.dispatch("submit");
  await settle();
  assert.equal(request.baseUrl, "https://learn.example.edu");
  assert.equal(form.resets, 1);
  // The saved connection puts its saved site back into the form. The secret and
  // application key are never put back.
  assert.equal(form.fields.applicationSecret.value, "");
  assert.equal(form.fields.applicationKey.value, "");
  assert.equal(form.fields.baseUrl.value, BLACKBOARD_TENANT.baseUrl);
  assert.equal(dom.element("#blackboard-copy").textContent, "Blackboard verified this account and its accessible courses when Morrow saved the connection. Morrow has not tested a course action.");
  assert.equal(dom.element("#blackboard-admin-note").hidden, true);
  assert.equal(dom.element("#blackboard-saved-note").hidden, false);
  for (const selector of Object.values(BLACKBOARD_FIELD_ERRORS)) assert.equal(dom.element(selector).textContent, "", selector);
});

test("the Blackboard form is offered only after an assistant is configured and the runtime is ready", async () => {
  let answer = () => ok(state({
    lifecycle: "ready_for_assistant",
    assistants: [{ id: "codex", title: "ChatGPT", tier: "primary", supported: true, detected: true }],
    selectedAssistantId: null
  }));
  const dom = await load("blackboard-offer", async () => answer());

  assert.equal(dom.element("#action-title").textContent, "Choose your assistant.");
  assert.equal(dom.element("#blackboard-panel").hidden, true, "the first screen asks for no credentials");

  // Saving, listing and removing a connection all read Morrow's own private
  // file access from the local runtime, so the panel waits for that runtime.
  answer = () => ok(state({ runtimeStatus: "uncertain" }));
  await checkStatus(dom);
  assert.equal(dom.element("#action-title").textContent, "Morrow is getting ready.");
  assert.equal(dom.element("#blackboard-panel").hidden, true);

  answer = () => ok(state());
  await checkStatus(dom);
  assert.equal(dom.element("#blackboard-panel").hidden, false);
  assert.equal(dom.element("#blackboard-panel").open, false, "the disclosure stays closed until a connection is saved");

  answer = () => ok(state({ blackboard: { status: "api_configured_live_untested", tenants: [BLACKBOARD_TENANT] } }));
  await checkStatus(dom);
  assert.equal(dom.element("#blackboard-panel").open, true, "a saved connection opens the disclosure");
});

test("each Blackboard connection field states its own rule, and correcting it clears the message", async () => {
  const methods = [];
  const dom = await load("blackboard-rules", async (method) => {
    methods.push(method);
    return ok(state());
  });
  const form = dom.element("#blackboard-form");
  form.fields.baseUrl.value = "learn.example.edu";
  form.fields.applicationKey.value = "";
  form.fields.applicationSecret.value = "";

  await form.dispatch("submit");
  await settle();

  assert.deepEqual(methods, ["installer:get-state"], "an incomplete form reaches no IPC call");
  assert.match(dom.element(BLACKBOARD_FIELD_ERRORS.baseUrl).textContent, /starts with https:\/\//);
  assert.match(dom.element(BLACKBOARD_FIELD_ERRORS.applicationKey).textContent, /Paste the application key/);
  assert.match(dom.element(BLACKBOARD_FIELD_ERRORS.applicationSecret).textContent, /Paste the application secret/);
  for (const input of Object.values(form.fields)) assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(dom.document.activeElement, form.fields.baseUrl, "focus moves to the first field to correct");
  assert.equal(form.fields.baseUrl.value, "learn.example.edu");
  assert.equal(form.resets, 0);

  form.fields.baseUrl.value = "https://learn.example.edu";
  await form.dispatch("input");
  assert.equal(dom.element(BLACKBOARD_FIELD_ERRORS.baseUrl).textContent, "");
  assert.equal(form.fields.baseUrl.getAttribute("aria-invalid"), "false");
  assert.match(dom.element(BLACKBOARD_FIELD_ERRORS.applicationKey).textContent, /Paste the application key/, "a field still to correct keeps its message");

  for (const [name, value] of Object.entries(BLACKBOARD_FIELDS)) form.fields[name].value = value;
  await form.dispatch("submit");
  await settle();
  assert.deepEqual(methods, ["installer:get-state", "installer:configure-blackboard"]);
  for (const selector of Object.values(BLACKBOARD_FIELD_ERRORS)) assert.equal(dom.element(selector).textContent, "", selector);
});

test("a Blackboard course selected from discovery is added and removed from the stored selection", async () => {
  let courseBindings = [];
  const requests = [];
  const dom = await load("blackboard-courses", async (method, payload) => {
    if (method === "installer:select-blackboard-courses") {
      requests.push(payload);
      courseBindings = payload.courseBindings.map((binding) => ({ sourceBindingId: `blackboard:derived-${binding.courseId}`, courseId: binding.courseId }));
    }
    return ok(state({ blackboard: { status: "api_configured_live_untested", tenants: [{ ...BLACKBOARD_TENANT, courseBindings }] } }));
  });

  assert.equal(dom.element("#blackboard-courses").hidden, false);
  assert.match(dom.element("#blackboard-courses-copy").textContent, /Select the Blackboard courses/);
  assert.match(dom.element("#blackboard-course-list").innerHTML, /Biology/);
  const selectBiology = dom.element("#blackboard-course-list").querySelectorAll("[data-action]").find((entry) => entry.dataset.courseId === "_45_1");
  assert.equal(selectBiology.dataset.action, "select-blackboard-course");
  await dom.element("#blackboard-panel").dispatch("click", { target: selectBiology });
  await settle();
  assert.deepEqual(requests, [{ tenantId: "learn-example-edu", courseBindings: [{ courseId: "_45_1" }] }]);
  assert.equal(JSON.stringify(requests).includes("sourceBindingId"), false);

  const selectChemistry = dom.element("#blackboard-course-list").querySelectorAll("[data-action]").find((entry) => entry.dataset.courseId === "_46_2");
  await dom.element("#blackboard-panel").dispatch("click", { target: selectChemistry });
  await settle();
  assert.deepEqual(requests[1], { tenantId: "learn-example-edu", courseBindings: [{ courseId: "_45_1" }, { courseId: "_46_2" }] });

  const remove = dom.element("#blackboard-course-list").querySelectorAll("[data-action]").find((entry) => entry.dataset.courseId === "_45_1");
  assert.equal(remove.dataset.action, "remove-blackboard-course");
  await dom.element("#blackboard-panel").dispatch("click", { target: remove });
  await settle();
  assert.deepEqual(requests[2], { tenantId: "learn-example-edu", courseBindings: [{ courseId: "_46_2" }] });
  assert.equal(dom.element("#blackboard-course-list").innerHTML.includes("Biology"), true);
});

test("a saved Blackboard connection names its site, account and stored name, and can be removed", async () => {
  let tenants = [{ ...BLACKBOARD_TENANT, courseBindings: [{ sourceBindingId: "blackboard:derived-_45_1", courseId: "_45_1" }] }];
  const requests = [];
  const dom = await load("blackboard-remove", async (method, payload) => {
    if (method === "installer:remove-blackboard-tenant") {
      requests.push(payload);
      tenants = tenants.filter((tenant) => tenant.id !== payload.tenantId);
    }
    return ok(state({ blackboard: { status: tenants.length > 0 ? "api_configured_live_untested" : "not_configured", tenants } }));
  });

  const row = dom.element("#blackboard-tenant");
  assert.equal(row.hidden, false);
  for (const value of ["https://learn.example.edu", "_123_1", "learn-example-edu"]) {
    assert.equal(row.innerHTML.includes(value), true, `the saved connection does not name ${value}`);
  }
  assert.match(row.innerHTML, /Remove takes this connection and the secret saved for it off this computer\./);
  const remove = row.querySelector("[data-action]");
  assert.equal(remove.dataset.action, "remove-blackboard-tenant");
  assert.equal(remove.dataset.tenantId, "learn-example-edu");

  await dom.element("#blackboard-panel").dispatch("click", { target: remove });
  await settle();

  assert.deepEqual(requests, [{ tenantId: "learn-example-edu" }]);
  assert.equal(row.hidden, true);
  assert.equal(row.innerHTML, "");
  assert.equal(dom.element("#blackboard-courses").hidden, true);
  assert.equal(dom.element("#blackboard-saved-note").hidden, true);
  assert.equal(dom.element("#blackboard-admin-note").hidden, false);
  assert.equal(dom.element("#blackboard-copy").textContent, "Morrow verifies the Blackboard account and its accessible courses before it saves this connection on this computer.");
  // The site and account in the form were the saved ones, so a removal leaves
  // no removed connection sitting in the form as if it were still saved.
  const form = dom.element("#blackboard-form");
  assert.equal(form.resets, 1);
  for (const [name, input] of Object.entries(form.fields)) assert.equal(input.value, "", name);
});

test("a refused Blackboard removal keeps the connection and says so", async () => {
  const tenant = { ...BLACKBOARD_TENANT, courseBindings: [{ sourceBindingId: "blackboard:derived-_45_1", courseId: "_45_1" }] };
  const dom = await load("blackboard-remove-refused", async (method) => {
    const current = state({ blackboard: { status: "api_configured_live_untested", tenants: [tenant] } });
    if (method !== "installer:remove-blackboard-tenant") return ok(current);
    return failed(current, {
      code: "blackboard_removal_failed",
      message: "Morrow could not remove that Blackboard connection.",
      recovery: "Check status to see the Blackboard connection Morrow has now, then remove it again."
    });
  });

  await dom.element("#blackboard-panel").dispatch("click", { target: dom.element("#blackboard-tenant").querySelector("[data-action]") });
  await settle();

  assert.equal(dom.element("#problem").hidden, false);
  assert.match(dom.element("#problem").innerHTML, /Morrow could not remove that Blackboard connection\./);
  assert.equal(dom.element("#blackboard-tenant").hidden, false, "a refused removal took the connection off the screen");
  assert.equal(dom.element("#blackboard-tenant").innerHTML.includes("https://learn.example.edu"), true);
  assert.equal(dom.element("#blackboard-form").resets, 0);
});

test("a saved Blackboard connection warns before a different site replaces it", async () => {
  const dom = await load("blackboard-replacement", async () => ok(state({
    blackboard: { status: "api_configured_live_untested", tenants: [{ ...BLACKBOARD_TENANT, courseBindings: [{ sourceBindingId: "blackboard:derived-_45_1", courseId: "_45_1" }] }] }
  })));
  const form = dom.element("#blackboard-form");
  const note = dom.element("#blackboard-replace-note");

  // The stored site is the one in the form, so nothing is being replaced.
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, "");
  assert.equal(dom.element("#blackboard-saved-note").hidden, false);
  assert.equal(
    dom.element("#blackboard-courses-copy").textContent,
    "Select the Blackboard courses Morrow can work in on https://learn.example.edu. Blackboard verified this list when you saved the connection.",
  );

  form.fields.baseUrl.value = "https://learn.other.edu";
  await form.dispatch("input");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "Saving this replaces the Blackboard connection Morrow saved for https://learn.example.edu: its courses and the secret saved for it are removed from this computer.");

  // A different account on the same site updates that connection instead.
  form.fields.baseUrl.value = "https://learn.example.edu/ultra/institution-page";
  await form.dispatch("input");
  assert.equal(note.hidden, true);

  // A half-typed address names no site, so it warns about replacing nothing.
  form.fields.baseUrl.value = "learn.other";
  await form.dispatch("input");
  assert.equal(note.hidden, true);
});

test("the managed-device note shown is the one true for the platform the preload reports", async () => {
  const mac = await load("mac-note", async () => ok(state()), "darwin");
  assert.equal(mac.element("#macos-note").hidden, false);
  assert.equal(mac.element("#windows-note").hidden, true);

  const windows = await load("windows-note", async () => ok(state()), "win32");
  assert.equal(windows.element("#windows-note").hidden, false);
  assert.equal(windows.element("#macos-note").hidden, true);

  const unknown = await load("unknown-note", async () => ok(state()));
  assert.equal(unknown.element("#windows-note").hidden, true);
  assert.equal(unknown.element("#macos-note").hidden, true);
});

test("the repair panel starts the in-app repair and then shows the state repair reached", async () => {
  const methods = [];
  let current = state({ lifecycle: "repair_required", runtimeStatus: "repair_required", assistants: [], selectedAssistantId: null });
  const dom = await load("repair", async (method) => {
    methods.push(method);
    if (method === "installer:repair") current = state();
    return ok(current);
  });

  assert.equal(dom.element("#action-title").textContent, "Repair Morrow before you connect a course.");
  const repair = dom.element("#action-body").querySelector("[data-action]");
  assert.equal(repair.dataset.action, "repair");

  await dom.element("#action-body").dispatch("click", { target: repair });
  await settle();
  assert.deepEqual(methods, ["installer:get-state", "installer:repair"]);
  assert.equal(dom.element("#action-title").textContent, "Connect Morrow Bridge.");
  assert.equal(dom.element("#header-status").textContent, "Assistant is ready");
  assert.equal(dom.element("#problem").innerHTML, "", "a repair that finished reports no problem");
});

test("a repair Morrow cannot finish reports the exact reason and leaves the repair panel in place", async () => {
  const current = state({ lifecycle: "repair_required", runtimeStatus: "repair_required", assistants: [], selectedAssistantId: null });
  const dom = await load("repair-refused", async (method) => (method === "installer:repair"
    ? failed(current, {
      code: "active_or_uncertain_operations",
      message: "Morrow has work in progress, or cannot confirm that it is idle.",
      recovery: "Wait for the current step to finish, then start that step again."
    })
    : ok(current)));

  await dom.element("#action-body").dispatch("click", { target: dom.element("#action-body").querySelector("[data-action]") });
  await settle();
  assert.equal(dom.element("#problem").hidden, false);
  assert.match(dom.element("#problem").innerHTML, /Morrow has work in progress, or cannot confirm that it is idle\./);
  assert.match(dom.element("#problem").innerHTML, /then start that step again/);
  assert.equal(dom.element("#action-title").textContent, "Repair Morrow before you connect a course.");
});

test("an update that did not start names the running version and offers the retry", async () => {
  const updates = (reason) => ({
    schema: "morrow.desktop-update.v1",
    status: "error",
    currentVersion: "1.0.0",
    availableVersion: null,
    automatic: true,
    reason
  });
  let reason = "update_rolled_back";
  const dom = await load("update-recovery", async () => ok(state({ updates: updates(reason) })));

  assert.equal(dom.element("#updates-panel").hidden, false);
  assert.equal(dom.element("#updates-copy").textContent, "The update did not start; Morrow is running version 1.0.0.");
  const retry = dom.element("#updates-actions").querySelector("[data-action]");
  assert.equal(retry.dataset.action, "check-for-updates");
  assert.match(dom.element("#updates-actions").innerHTML, /Retry the update/);

  reason = "disk_space_unavailable";
  await dom.element("#updates-actions").dispatch("click", { target: retry });
  await settle();
  assert.equal(
    dom.element("#updates-copy").textContent,
    "Morrow could not download the update: this computer does not have enough free space for it."
  );
  assert.equal(dom.element("#updates-actions").querySelector("[data-action]").dataset.action, "check-for-updates");
});

test("the data-retention panel names every path and shows the removal Morrow reports", async () => {
  const retention = {
    uninstall: "move_to_trash",
    locations: [
      { id: "state", label: "Morrow's setup record and local journal", path: "/Morrow/State", removable: true, keptReason: null },
      { id: "bridge", label: "The Morrow Bridge folder Chrome loads", path: "/Morrow/Bridge", removable: true, keptReason: null },
      { id: "assistant_configuration", label: "ChatGPT settings file", path: "/Home/.codex/config.toml", removable: false, keptReason: "assistant_configuration" }
    ],
    removal: null
  };
  const methods = [];
  let current = state({ retention });
  const dom = await load("retention", async (method) => {
    methods.push(method);
    if (method === "installer:remove-data") {
      current = state({
        retention: {
          ...retention,
          removal: { status: "incomplete", removed: ["/Morrow/State"], remaining: ["/Morrow/Bridge"], kept: ["/Home/.codex/config.toml"] }
        }
      });
    }
    return ok(current);
  }, "darwin");

  const panel = dom.element("#retention-panel");
  const body = dom.element("#retention-body");
  assert.equal(panel.hidden, false);
  assert.equal(dom.element("#retention-title").textContent, "What stays on this computer");
  for (const value of ["/Morrow/State", "/Morrow/Bridge", "/Home/.codex/config.toml"]) assert.ok(body.innerHTML.includes(value), `the panel names ${value}`);
  assert.match(body.innerHTML, /move it to the Trash/);
  const remove = body.querySelector("[data-action]");
  assert.equal(remove.dataset.action, "remove-data");

  await body.dispatch("click", { target: remove });
  await settle();
  assert.deepEqual(methods, ["installer:get-state", "installer:remove-data"]);
  assert.match(body.innerHTML, /Morrow could not remove everything/);
  assert.match(body.innerHTML, /These are still on this computer/);

  // A state that names no place to keep data hides the section instead of
  // claiming an empty list.
  const empty = await load("retention-empty", async () => ok(state()));
  assert.equal(empty.element("#retention-panel").hidden, true);
});
