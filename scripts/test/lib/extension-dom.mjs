/**
 * A small DOM for the two Morrow Bridge extension pages.
 *
 * connector/extension/settings/settings.js and connector/extension/popup/popup.js are the pages a
 * person uses. Both are ES modules that read their elements out of the page markup, so a test can
 * drive the shipped file only when that markup is really present. This harness parses the page's
 * HTML file, gives the parsed elements the part of the DOM those two files use, installs a chrome
 * stub, and imports the module the HTML names.
 *
 * It is not Chrome. Layout, focus order, styles, real permission prompts and real message passing
 * stay with the Playwright harness in scripts/test/canvas-connector-browser.mjs. This harness owns
 * page logic and the words a page writes.
 */

import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    const named = NAMED_ENTITIES[name.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function escapeText(value) {
  return String(value).replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

// --- Selectors --------------------------------------------------------------------------------
// The subset the two pages use: "#id", ".class", "tag", "[data-binding-id]",
// '[data-binding-id="canvas:course-1"]', descendant combinations of those, and comma-separated
// lists such as "input, button, a, summary, details".

function parseCompound(text) {
  const compound = { tag: null, id: null, classes: [], attributes: [] };
  const token = /\[([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]|([.#]?[A-Za-z][\w-]*)/g;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match[1]) {
      compound.attributes.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? null });
      continue;
    }
    const simple = match[5];
    if (simple.startsWith("#")) compound.id = simple.slice(1);
    else if (simple.startsWith(".")) compound.classes.push(simple.slice(1));
    else compound.tag = simple.toLowerCase();
  }
  return compound;
}

function parseSelector(selector) {
  return String(selector).split(",").map((part) => part.trim()).filter(Boolean)
    .map((part) => part.split(/\s+/).map(parseCompound));
}

function matchesCompound(element, compound) {
  if (compound.tag && element.localName !== compound.tag) return false;
  if (compound.id && element.getAttribute("id") !== compound.id) return false;
  if (compound.classes.some((name) => !element.classList.contains(name))) return false;
  return compound.attributes.every(({ name, value }) => {
    const actual = element.getAttribute(name);
    return actual !== null && (value === null || actual === value);
  });
}

function matchesComplex(element, complex) {
  if (!matchesCompound(element, complex.at(-1))) return false;
  let ancestor = element.parentNode;
  for (let index = complex.length - 2; index >= 0; index -= 1) {
    while (ancestor instanceof DomElement && !matchesCompound(ancestor, complex[index])) ancestor = ancestor.parentNode;
    if (!(ancestor instanceof DomElement)) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

// --- Nodes ------------------------------------------------------------------------------------

class DomText {
  constructor(data) {
    this.data = data;
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }

  toHtml() {
    return escapeText(this.data);
  }
}

class DomEvent {
  constructor(type) {
    this.type = type;
    this.target = null;
    this.currentTarget = null;
  }
}

class DomElement {
  constructor(tag, attributes = [], ownerDocument = null) {
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map(attributes.map(({ name, value, bare }) => [name.toLowerCase(), { value, bare }]));
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = ownerDocument;
    this.listeners = new Map();
  }

  // --- attributes ---
  getAttribute(name) {
    const entry = this.attributes.get(String(name).toLowerCase());
    return entry === undefined ? null : entry.value;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), { value: String(value), bare: false });
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get classList() {
    const element = this;
    const names = () => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const write = (values) => element.setAttribute("class", [...new Set(values)].join(" "));
    return {
      contains: (name) => names().includes(name),
      add: (name) => write([...names(), name]),
      remove: (name) => write(names().filter((value) => value !== name)),
      toggle: (name, force) => {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        write(on ? [...names(), name] : names().filter((value) => value !== name));
        return on;
      },
    };
  }

  get dataset() {
    const values = {};
    for (const [name, entry] of this.attributes) {
      if (!name.startsWith("data-")) continue;
      values[name.slice(5).replace(/-([a-z])/g, (match, letter) => letter.toUpperCase())] = entry.value;
    }
    return values;
  }

  get hidden() {
    return this.hasAttribute("hidden");
  }

  set hidden(value) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(value) {
    if (value) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }

  get type() {
    return this.getAttribute("type") ?? "";
  }

  get dateTime() {
    return this.getAttribute("datetime") ?? "";
  }

  set dateTime(value) {
    this.setAttribute("datetime", value);
  }

  // --- tree ---
  get children() {
    return this.childNodes.filter((node) => node instanceof DomElement);
  }

  append(node) {
    node.parentNode = this;
    this.childNodes.push(node);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value) {
    this.childNodes = [];
    if (String(value) !== "") this.append(new DomText(String(value)));
  }

  get innerHTML() {
    return this.childNodes.map((node) => node.toHtml()).join("");
  }

  set innerHTML(html) {
    this.childNodes = [];
    for (const node of parseNodes(String(html), this.ownerDocument)) this.append(node);
  }

  toHtml() {
    const attributes = [...this.attributes].map(([name, entry]) => (entry.bare ? ` ${name}` : ` ${name}="${escapeAttribute(entry.value)}"`)).join("");
    if (VOID_TAGS.has(this.localName)) return `<${this.localName}${attributes}>`;
    return `<${this.localName}${attributes}>${this.innerHTML}</${this.localName}>`;
  }

  // --- selectors ---
  matches(selector) {
    return parseSelector(selector).some((complex) => matchesComplex(this, complex));
  }

  querySelectorAll(selector) {
    const selectors = parseSelector(selector);
    const found = [];
    const walk = (element) => {
      for (const child of element.children) {
        if (selectors.some((complex) => matchesComplex(child, complex))) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    for (let node = this; node instanceof DomElement; node = node.parentNode) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  // --- events ---
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /** Every event both pages listen for bubbles: the page listens on a container, not on a card. */
  dispatchEvent(event) {
    event.target = event.target ?? this;
    const path = [];
    for (let node = this; node instanceof DomElement; node = node.parentNode) path.push(node);
    if (this.ownerDocument) path.push(this.ownerDocument);
    for (const node of path) {
      for (const handler of [...(node.listeners.get(event.type) || [])]) {
        event.currentTarget = node;
        handler.call(node, event);
      }
    }
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  /** False when Chrome would ignore a person here: the control, or a fieldset around it, is off. */
  get interactive() {
    for (let node = this; node instanceof DomElement; node = node.parentNode) {
      if (node.disabled && (node === this || node.localName === "fieldset")) return false;
    }
    return true;
  }

  /** A person's click. A disabled control, or one inside a disabled fieldset, hears nothing. */
  click() {
    if (!this.interactive) return;
    this.dispatchEvent(new DomEvent("click"));
  }
}

class DomInputElement extends DomElement {
  constructor(tag, attributes, ownerDocument) {
    super(tag, attributes, ownerDocument);
    this.checked = this.hasAttribute("checked");
    this.currentValue = this.getAttribute("value") ?? "";
  }

  get value() {
    return this.currentValue;
  }

  set value(value) {
    this.currentValue = String(value);
  }

  get name() {
    return this.getAttribute("name") ?? "";
  }

  click() {
    if (!this.interactive) return;
    let changed = false;
    if (this.type === "checkbox") {
      this.checked = !this.checked;
      changed = true;
    } else if (this.type === "radio" && !this.checked) {
      for (const other of this.ownerDocument?.querySelectorAll("input") ?? []) {
        if (other !== this && other.type === "radio" && other.name === this.name) other.checked = false;
      }
      this.checked = true;
      changed = true;
    }
    this.dispatchEvent(new DomEvent("click"));
    if (changed) this.dispatchEvent(new DomEvent("change"));
  }
}

class DomSelectElement extends DomElement {
  constructor(tag, attributes, ownerDocument) {
    super(tag, attributes, ownerDocument);
    this.selectedIndex = -1;
  }

  get options() {
    return this.children.filter((child) => child.localName === "option");
  }

  set innerHTML(html) {
    super.innerHTML = html;
    this.selectedIndex = this.options.length ? 0 : -1;
  }

  get innerHTML() {
    return super.innerHTML;
  }

  get value() {
    return this.options[this.selectedIndex]?.value ?? "";
  }

  set value(value) {
    this.selectedIndex = this.options.findIndex((option) => option.value === String(value));
  }
}

class DomOptionElement extends DomElement {
  get value() {
    return this.getAttribute("value") ?? this.textContent;
  }

  get text() {
    return this.textContent;
  }
}

function createElement(tag, attributes, ownerDocument) {
  const name = String(tag).toLowerCase();
  if (name === "input") return new DomInputElement(name, attributes, ownerDocument);
  if (name === "select") return new DomSelectElement(name, attributes, ownerDocument);
  if (name === "option") return new DomOptionElement(name, attributes, ownerDocument);
  return new DomElement(name, attributes, ownerDocument);
}

// --- Parsing ----------------------------------------------------------------------------------

function parseAttributes(text) {
  const attributes = [];
  const token = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    const value = match[2] ?? match[3] ?? match[4];
    attributes.push({ name: match[1], value: value === undefined ? "" : decodeEntities(value), bare: value === undefined });
  }
  return attributes;
}

/** Parses one HTML fragment into nodes. The subset both extension pages write, and no more. */
function parseNodes(html, ownerDocument) {
  const roots = [];
  const stack = [];
  const append = (node) => {
    if (stack.length) stack.at(-1).append(node);
    else {
      node.parentNode = null;
      roots.push(node);
    }
  };
  const pattern = /<!--[\s\S]*?-->|<![^>]*>|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let index = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match.index > index) append(new DomText(decodeEntities(html.slice(index, match.index))));
    index = pattern.lastIndex;
    if (match[0].startsWith("<!")) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      const depth = stack.findLastIndex((element) => element.localName === name);
      if (depth >= 0) stack.length = depth;
      continue;
    }
    const tag = match[2].toLowerCase();
    const element = createElement(tag, parseAttributes(match[3] || ""), ownerDocument);
    append(element);
    if (VOID_TAGS.has(tag) || match[4] === "/") continue;
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}>`, index);
      const end = close === -1 ? html.length : close;
      if (end > index) element.append(new DomText(html.slice(index, end)));
      index = close === -1 ? html.length : close + tag.length + 3;
      pattern.lastIndex = index;
      continue;
    }
    stack.push(element);
  }
  if (index < html.length) append(new DomText(decodeEntities(html.slice(index))));
  return roots;
}

class DomDocument {
  constructor(html) {
    this.listeners = new Map();
    this.activeElement = null;
    this.hidden = false;
    this.roots = parseNodes(html, this);
  }

  querySelectorAll(selector) {
    const selectors = parseSelector(selector);
    const found = [];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (!(node instanceof DomElement)) continue;
        if (selectors.some((complex) => matchesComplex(node, complex))) found.push(node);
        walk(node.childNodes);
      }
    };
    walk(this.roots);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(event) {
    event.target = event.target ?? this;
    for (const handler of [...(this.listeners.get(event.type) || [])]) {
      event.currentTarget = this;
      handler.call(this, event);
    }
  }
}

// --- The chrome stub --------------------------------------------------------------------------

/**
 * The part of the extension API both pages call. `handlers` answers chrome.runtime.sendMessage by
 * message type: a handler may return the response itself (`{ ok: false, code }` for a failure), or
 * the result alone, which is answered as `{ ok: true, result }`.
 */
function createChromeStub({ handlers = {}, storage = {}, permission = {}, tabs = [] } = {}) {
  const messages = [];
  const permissionCalls = [];
  let optionsPageOpens = 0;
  const stored = { ...storage };
  const listeners = { storage: [], message: [], permissionAdded: [], permissionRemoved: [] };
  let granted = permission.granted === true;
  const chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        const handler = handlers[message?.type];
        if (!handler) return { ok: false, code: "test_handler_missing", error: `This test installed no handler for ${message?.type}.` };
        const answer = await handler(message);
        return answer && typeof answer === "object" && "ok" in answer ? answer : { ok: true, result: answer };
      },
      openOptionsPage() {
        optionsPageOpens += 1;
        return Promise.resolve();
      },
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
    },
    storage: {
      local: {
        async get(key) {
          return key in stored ? { [key]: stored[key] } : {};
        },
        async set(values) {
          Object.assign(stored, values);
        },
      },
      onChanged: { addListener: (listener) => listeners.storage.push(listener) },
    },
    permissions: {
      async contains() {
        return granted;
      },
      async request({ origins }) {
        permissionCalls.push({ method: "request", origins });
        granted = permission.onRequest ? await permission.onRequest({ origins }) === true : true;
        return granted;
      },
      async remove({ origins }) {
        permissionCalls.push({ method: "remove", origins });
        granted = false;
        return true;
      },
      onAdded: { addListener: (listener) => listeners.permissionAdded.push(listener) },
      onRemoved: { addListener: (listener) => listeners.permissionRemoved.push(listener) },
    },
    tabs: {
      async query() {
        return tabs;
      },
    },
  };
  return { chrome, messages, permissionCalls, storage: stored, listeners, optionsPageOpens: () => optionsPageOpens };
}

// --- Loading a page ---------------------------------------------------------------------------

let loadCount = 0;

/** Removes the page globals this harness installs. Call it once every test in a file has run. */
export function clearExtensionGlobals() {
  for (const name of ["document", "window", "chrome", "Element", "HTMLInputElement"]) delete globalThis[name];
}

/** Lets the work a load or a click starts run to its end. */
async function flush() {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Loads one extension page: parses its HTML file, installs the globals the page reads, then
 * imports the module the HTML names. Each call is a separate module instance, because both pages
 * read their state once as they load.
 */
export async function loadExtensionPage(pagePath, options = {}) {
  const pageUrl = new URL(`connector/extension/${pagePath}`, ROOT);
  const document = new DomDocument(readFileSync(pageUrl, "utf8"));
  const script = document.querySelector('script[type="module"]');
  if (!script?.getAttribute("src")) throw new Error(`${pagePath} names no module script, so no page code can run.`);
  const stub = createChromeStub(options);
  const window = {
    listeners: new Map(),
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of [...(this.listeners.get(event.type) || [])]) handler.call(this, event);
    },
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.chrome = stub.chrome;
  globalThis.Element = DomElement;
  globalThis.HTMLInputElement = DomInputElement;
  loadCount += 1;
  await import(new URL(`${script.getAttribute("src")}?load=${loadCount}`, pageUrl));
  await flush();

  const query = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`This page has no element matching ${selector}.`);
    return element;
  };
  return {
    document,
    window,
    storage: stub.storage,
    permissionCalls: stub.permissionCalls,
    listeners: stub.listeners,
    /** How many times the page has opened Plan and Edit settings. */
    get optionsPageOpens() {
      return stub.optionsPageOpens();
    },
    query,
    queryAll: (selector) => document.querySelectorAll(selector),
    text: (selector) => query(selector).textContent,
    hidden: (selector) => query(selector).hidden,
    /** Every message the page sent, or only those of one type. */
    messages: (type) => (type ? stub.messages.filter((message) => message?.type === type) : [...stub.messages]),
    flush,
    /** Clicks one control and lets the work that click starts finish. */
    async click(selector) {
      query(selector).click();
      await flush();
    },
    /** Types into a search field: the value the person sees, then the page's input handler. */
    async type(selector, value) {
      const element = query(selector);
      if (!element.interactive) throw new Error(`${selector} is disabled, so nothing can be typed into it.`);
      element.value = value;
      element.dispatchEvent(new DomEvent("input"));
      await flush();
    },
    /** Chooses one option in a select, then the page's change handler. */
    async choose(selector, value) {
      const element = query(selector);
      if (!element.interactive) throw new Error(`${selector} is disabled, so no option can be chosen in it.`);
      element.value = value;
      element.dispatchEvent(new DomEvent("change"));
      await flush();
    },
    /** Waits for a page state, because a click starts work the page finishes on its own. */
    async waitFor(check, description) {
      for (let attempt = 0; attempt < 2_000 && !check(); attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 1); });
      if (!check()) throw new Error(description);
    },
  };
}

export { DomEvent };
