/**
 * Moodle Glossary entries and Wiki pages: the child records that live inside
 * one exact Glossary or Wiki activity.
 *
 * Every operation binds the activity through the native `course/modedit.php`
 * form first, so the course module, its module type and its instance are the
 * ones the request named. No route here opens `/mod/glossary/view.php`,
 * `/mod/glossary/showentry.php` or `/mod/wiki/view.php`, each of which records
 * a module view, a completion state or a Moodle view event.
 *
 * Routes, read from Moodle v5.2.2 source:
 * - The Glossary entry list is Moodle's own XML export. `/mod/glossary/export.php`
 *   states the exact pluginfile URL of that export in its one form, and
 *   `glossary_pluginfile` serves it after `require_capability('mod/glossary:export')`.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/glossary/export.php#L34-L65
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/glossary/lib.php#L1831-L1846
 *   The export carries no entry ID and omits every entry that is not approved,
 *   because `glossary_generate_export_file` writes only `$entry->approved` rows.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/glossary/lib.php#L2377-L2404
 * - One entry, and both entry writes, use the native entry form at
 *   `/mod/glossary/edit.php?cmid=<cmid>` (new) or `&id=<entryid>` (existing),
 *   which requires `mod/glossary:write` and, for an entry somebody else wrote,
 *   the check in `mod_glossary_can_update_entry`.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/glossary/edit.php#L33-L77
 * - The saved approval state comes from `mod_glossary_get_entry_by_id`, which
 *   `mod/glossary/db/services.php` registers with 'ajax' => true and
 *   'type' => 'read'. `glossary_edit_entry` sets `approved` to 0 on every save
 *   and back to 1 only when the Glossary approves by default or the signed-in
 *   person holds `mod/glossary:approve`, so the state is read back each time.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/glossary/lib.php#L4346-L4358
 * - The Wiki page list is `/mod/wiki/search.php?cmid=<cmid>&searchstring=`,
 *   which lists every page of the current group's subwiki through
 *   `wiki_search_title($swid, '')` and triggers no Moodle event.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/wiki/search.php#L29-L88
 * - One Wiki page, and the page write, use `/mod/wiki/edit.php?pageid=<id>`.
 *   `page_wiki_edit::print_edit` takes Moodle's own editing lock through
 *   `wiki_set_lock`, prints the locked notice instead of the form when another
 *   person holds it, and carries the page's exact version in a hidden control.
 *   `page_wiki_save` requires `mod/wiki:editpage` and saves version + 1.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/wiki/pagelib.php#L508-L604
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/wiki/locallib.php#L240-L258
 *
 * Route limit: `wiki_set_lock` writes a `wiki_locks` row that expires
 * LOCK_TIMEOUT (30 seconds) after it is taken. Reading or writing one Wiki page
 * takes that lock exactly as Moodle takes it when a person opens the page for
 * editing, and Morrow never renews it.
 *
 * No result carries a learner name, a learner ID or an author. Glossary and
 * Wiki content is course content and is returned as the site stores it.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleGlossaryWikiInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_FORM_BYTES = 512 * 1024;
  const MAX_VALUE_BYTES = 256 * 1024;
  const MAX_ENTRIES = 500;
  const MAX_PAGES = 500;
  const MAX_ALIASES = 50;
  const MAX_CATEGORIES = 50;
  const MAX_CONCEPT = 255;
  const MAX_TITLE = 255;
  const MAX_DEFINITION = 40_000;
  const MAX_CONTENT = 100_000;
  const ID = /^[1-9][0-9]{0,18}$/;
  const VERSION = /^(?:0|[1-9][0-9]{0,9})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  // Moodle normalizes a carriage return out of its own XML export, so approved
  // text that carries one could not be compared to the saved text exactly.
  const CONTROL_OUTSIDE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/;
  // A Moodle file reference only resolves inside a saved file area. Morrow
  // reviews no file here, so it neither writes one nor rewrites one.
  const FILE_REFERENCE = /@@PLUGINFILE@@|pluginfile\.php|draftfile\.php/i;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|csrf|token|secret|password|authorization|cookie)/i;
  const MODEDIT_PATH = "/course/modedit.php";
  const GLOSSARY_EDIT_PATH = "/mod/glossary/edit.php";
  const GLOSSARY_EXPORT_PATH = "/mod/glossary/export.php";
  const WIKI_EDIT_PATH = "/mod/wiki/edit.php";
  const WIKI_SEARCH_PATH = "/mod/wiki/search.php";
  const WIKI_VIEW_PATH = "/mod/wiki/view.php";
  const WIKI_OVERRIDE_LOCKS_PATH = "/mod/wiki/overridelocks.php";
  const PLUGINFILE_PATH = "/pluginfile.php";
  const AJAX_PATH = "/lib/ajax/service.php";
  const DRAFT_FILES_PATH = "/repository/draftfiles_ajax.php";
  const ENTRY_STATE_METHOD = "mod_glossary_get_entry_by_id";
  const MODULE_BINDING = "course_modedit_form";
  const definitions = Object.freeze({
    "moodle.form.glossary.entries.read.v1": {
      toolName: "moodle_list_glossary_entries", readOnly: true, kind: "glossary_entries", module: "glossary",
      prefix: "moodle_glossary", schema: "morrow.moodle-glossary-entries.v1", capability: "mod/glossary:export",
    },
    "moodle.form.glossary.entry.read.v1": {
      toolName: "moodle_get_glossary_entry", readOnly: true, kind: "glossary_entry", module: "glossary",
      prefix: "moodle_glossary", schema: "morrow.moodle-glossary-entry.v1", capability: "mod/glossary:write",
    },
    "moodle.form.glossary.entry.create.write.v1": {
      toolName: "moodle_create_glossary_entry", readOnly: false, kind: "glossary_entry_create", module: "glossary",
      prefix: "moodle_glossary", schema: "morrow.moodle-glossary-entries.v1", capability: "mod/glossary:write",
    },
    "moodle.form.glossary.entry.update.write.v1": {
      toolName: "moodle_update_glossary_entry", readOnly: false, kind: "glossary_entry_update", module: "glossary",
      prefix: "moodle_glossary", schema: "morrow.moodle-glossary-entry.v1", capability: "mod/glossary:write",
    },
    "moodle.form.wiki.pages.read.v1": {
      toolName: "moodle_list_wiki_pages", readOnly: true, kind: "wiki_pages", module: "wiki",
      prefix: "moodle_wiki", schema: "morrow.moodle-wiki-pages.v1", capability: "mod/wiki:viewpage",
    },
    "moodle.form.wiki.page.read.v1": {
      toolName: "moodle_get_wiki_page", readOnly: true, kind: "wiki_page", module: "wiki",
      prefix: "moodle_wiki", schema: "morrow.moodle-wiki-page.v1", capability: "mod/wiki:editpage",
    },
    "moodle.form.wiki.page.update.write.v1": {
      toolName: "moodle_update_wiki_page", readOnly: false, kind: "wiki_page_update", module: "wiki",
      prefix: "moodle_wiki", schema: "morrow.moodle-wiki-page.v1", capability: "mod/wiki:editpage",
    },
  });

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const input = (() => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  })();
  const definition = object(input) && object(input.operation) && typeof input.operation.key === "string"
    ? definitions[input.operation.key]
    : undefined;
  if (!definition) return { ok: false, sent: false, error: "moodle_glossary_wiki_operation_unsupported" };
  const failure = (reason, status) => ({
    ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error: `${definition.prefix}_${reason}`,
  });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${definition.prefix}_incomplete` });
  const unconfirmedWrite = (reason, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: `${definition.prefix}_${reason}` },
    error: `${definition.prefix}_${reason}`,
  });
  const mismatchWrite = (reason, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: `${definition.prefix}_${reason}` },
    error: "moodle_write_not_verified",
  });
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const validText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_glossary_wiki_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !validText(cfg.sesskey, 1024)) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = site.pathname.replace(/\/$/, "");
    if (site.origin !== currentOrigin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configuredCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configuredCourse && bodyCourse && bodyCourse !== configuredCourse) return null;
    const anchorCourseId = configuredCourse || bodyCourse;
    if (!anchorCourseId) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId, sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin && binding.siteUrl === context.siteUrl
    && id(binding.principalId) === context.principalId && id(binding.courseId) === context.anchorCourseId;
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const argumentsFor = (args, courseId) => {
    const base = (extra) => {
      if (!exactKeys(args, ["course_id", "module_id", ...extra]) || id(args.course_id) !== courseId || !id(args.module_id)) return null;
      return { courseId, moduleId: id(args.module_id) };
    };
    if (definition.kind === "glossary_entries" || definition.kind === "wiki_pages") return base([]);
    if (definition.kind === "glossary_entry") {
      const bound = base(["entry_id"]);
      const entryId = id(args.entry_id);
      return bound && entryId ? { ...bound, entryId } : null;
    }
    if (definition.kind === "wiki_page") {
      const bound = base(["page_id"]);
      const pageId = id(args.page_id);
      return bound && pageId ? { ...bound, pageId } : null;
    }
    if (definition.kind === "glossary_entry_create") {
      const bound = base(["concept", "definition_html", "learner_visibility_confirmed", "expected_digest"]);
      if (!bound || !DIGEST.test(String(args.expected_digest || "")) || typeof args.learner_visibility_confirmed !== "boolean") return null;
      // Moodle saves a concept as plain text and matches a duplicate on it.
      if (!validText(args.concept, MAX_CONCEPT) || args.concept !== args.concept.trim() || /[<>&]/.test(args.concept)) return null;
      if (typeof args.definition_html !== "string" || !args.definition_html.trim() || args.definition_html.length > MAX_DEFINITION
        || CONTROL_OUTSIDE_TEXT.test(args.definition_html)) return null;
      return {
        ...bound,
        concept: args.concept,
        definition: args.definition_html,
        learnerVisibilityConfirmed: args.learner_visibility_confirmed,
        expectedDigest: args.expected_digest,
      };
    }
    if (definition.kind === "glossary_entry_update") {
      const withConcept = Object.hasOwn(args, "concept");
      const withDefinition = Object.hasOwn(args, "definition_html");
      if (!withConcept && !withDefinition) return null;
      const bound = base([
        "entry_id",
        ...(withConcept ? ["concept"] : []),
        ...(withDefinition ? ["definition_html"] : []),
        "expected_digest",
      ]);
      const entryId = id(args.entry_id);
      if (!bound || !entryId || !DIGEST.test(String(args.expected_digest || ""))) return null;
      if (withConcept && (!validText(args.concept, MAX_CONCEPT) || args.concept !== args.concept.trim() || /[<>&]/.test(args.concept))) return null;
      if (withDefinition && (typeof args.definition_html !== "string" || !args.definition_html.trim()
        || args.definition_html.length > MAX_DEFINITION || CONTROL_OUTSIDE_TEXT.test(args.definition_html))) return null;
      return {
        ...bound,
        entryId,
        concept: withConcept ? args.concept : null,
        definition: withDefinition ? args.definition_html : null,
        expectedDigest: args.expected_digest,
      };
    }
    const bound = base(["page_id", "content", "expected_version", "expected_digest"]);
    const pageId = id(args.page_id);
    const expectedVersion = typeof args.expected_version === "number" && Number.isSafeInteger(args.expected_version)
      && args.expected_version >= 0 && args.expected_version <= 1_000_000_000 ? String(args.expected_version) : "";
    if (!bound || !pageId || !expectedVersion || !DIGEST.test(String(args.expected_digest || ""))) return null;
    if (typeof args.content !== "string" || !args.content.trim() || args.content.length > MAX_CONTENT
      || CONTROL_OUTSIDE_TEXT.test(args.content)) return null;
    return { ...bound, pageId, content: args.content, expectedVersion, expectedDigest: args.expected_digest };
  };
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sameRoute = (actual, expected) => {
    let received;
    try { received = new URL(actual); } catch { return false; }
    return received.origin === expected.origin && received.pathname === expected.pathname
      && received.search === expected.search && !received.hash && !received.username && !received.password;
  };
  const boundedText = async (response, endpoint, context) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext()) || !response.body
      || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return "limit";
        }
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } catch {
      try { await reader.cancel(); } catch {}
      return null;
    }
  };
  const readDocument = async (context, endpoint, accept, type) => {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: accept },
      });
    } catch { return { error: "target_unavailable" }; }
    const text = await boundedText(response, endpoint, context);
    if (text === "limit") return { limited: true, status: response.status };
    if (typeof text !== "string" || typeof globalThis.DOMParser !== "function") {
      return { error: "target_unavailable", status: response.status };
    }
    try {
      const parsed = new DOMParser().parseFromString(text, type);
      if (parsed.querySelector("parsererror")) return { error: "response_invalid", status: response.status };
      return { status: response.status, document: parsed };
    } catch { return { error: "response_invalid", status: response.status }; }
  };
  // Moodle's own AJAX entry point. It serves only the external functions that
  // a db/services.php registers with 'ajax' => true.
  const ajax = async (context, method, methodArgs) => {
    const endpoint = urlFor(context, AJAX_PATH, { sesskey: context.sesskey, info: method });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: method, args: methodArgs }]),
      });
    } catch { return { error: "service_unavailable" }; }
    const raw = await boundedText(response, endpoint, context);
    if (raw === "limit") return { limited: true, status: response.status };
    if (typeof raw !== "string") return { error: "service_unavailable", status: response.status };
    let payload;
    try { payload = JSON.parse(raw); } catch { return { error: "response_invalid", status: response.status }; }
    if (!Array.isArray(payload) || payload.length !== 1 || !object(payload[0]) || payload[0].index !== 0) {
      return { error: "response_invalid", status: response.status };
    }
    if (payload[0].error || payload[0].exception) return { error: "service_refused", status: response.status };
    if (!("data" in payload[0])) return { error: "response_invalid", status: response.status };
    let data;
    try { data = typeof payload[0].data === "string" ? JSON.parse(payload[0].data) : payload[0].data; }
    catch { return { error: "response_invalid", status: response.status }; }
    return object(data) ? { data, status: response.status } : { error: "response_invalid", status: response.status };
  };
  // Moodle's own draft-area listing.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/repository/draftfiles_ajax.php
  const draftListing = async (context, itemId) => {
    const endpoint = urlFor(context, DRAFT_FILES_PATH, { action: "list" });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, itemid: itemId, filepath: "/" }),
      });
    } catch { return null; }
    const raw = await boundedText(response, endpoint, context);
    if (typeof raw !== "string") return null;
    try {
      const payload = JSON.parse(raw);
      return object(payload) ? payload : null;
    } catch { return null; }
  };
  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const collected = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      collected.push([name, value]);
    }
    return collected;
  };
  const one = (entries, name) => {
    const values = entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    return values.length === 1 ? values[0] : null;
  };
  const boundBody = (parsed, courseId, moduleId, module) => {
    const bodyClass = String(parsed.body?.className || "");
    return [`course-${courseId}`, `cmid-${moduleId}`, `cm-type-${module}`]
      .every((entry) => new RegExp(`(?:^|\\s)${entry}(?:\\s|$)`).test(bodyClass));
  };
  const postForms = (parsed, endpoint, expectedAction) => [...parsed.querySelectorAll("form")].filter((form) => {
    if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
    try {
      const action = new URL(form.getAttribute("action") || endpoint.href, endpoint);
      return action.origin === expectedAction.origin && action.pathname === expectedAction.pathname && !action.hash
        && !action.username && !action.password
        && (action.search === "" || action.search === expectedAction.search);
    } catch { return false; }
  });
  /**
   * The exact activity binding. `course/modedit.php` is the one native form
   * that states, in one place, the course, the course module, the module type,
   * the instance the module points at, and whether learners can see it.
   */
  const bindModule = async (context, courseId, moduleId) => {
    const endpoint = urlFor(context, MODEDIT_PATH, { update: moduleId, return: "0" });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited || page.error) return page;
    const forms = postForms(page.document, endpoint, endpoint);
    if (forms.length !== 1) return { error: "target_unavailable", status: page.status };
    const entries = entriesFor(forms[0]);
    if (!entries) return { error: "target_unavailable", status: page.status };
    const instanceId = id(one(entries, "instance"));
    const visible = one(entries, "visible");
    const name = one(entries, "name");
    if (one(entries, "course") !== courseId || one(entries, "coursemodule") !== moduleId || one(entries, "update") !== moduleId
      || one(entries, "modulename") !== definition.module || !instanceId || (visible !== "0" && visible !== "1")
      || !validText(name, 1_333)) {
      return { error: "target_unavailable", status: page.status };
    }
    const approval = one(entries, "defaultapproval");
    return {
      instanceId,
      name,
      visible: visible === "1",
      // Moodle sets a saved entry back to approved only when the Glossary
      // approves by default or the person holds mod/glossary:approve.
      defaultApproval: approval === "1" ? true : approval === "0" ? false : null,
      status: page.status,
    };
  };
  const boundedValue = (value, limit) => typeof value === "string" && value.length <= limit ? value : null;
  const childText = (node, name, limit) => {
    const matches = [...node.querySelectorAll(name)].filter((match) => match.parentNode === node);
    return matches.length === 1 ? boundedValue(String(matches[0].textContent ?? ""), limit) : null;
  };
  /**
   * Moodle's own XML export of this Glossary. It is the only browser route in
   * Moodle 5.2.2 that lists entries without recording a view, and it carries
   * no entry ID and no entry that is waiting for approval.
   */
  const glossaryExport = async (context, moduleId) => {
    const pageEndpoint = urlFor(context, GLOSSARY_EXPORT_PATH, { id: moduleId });
    const page = await readDocument(context, pageEndpoint, "text/html", "text/html");
    if (page.limited || page.error) return page;
    const actions = [...page.document.querySelectorAll("form[action]")].map((form) => {
      try { return new URL(form.getAttribute("action") || "", pageEndpoint); } catch { return null; }
    }).filter((action) => action && action.origin === context.origin
      && action.pathname.startsWith(`${context.basePath}${PLUGINFILE_PATH}`) && !action.username && !action.password);
    if (actions.length !== 1) return { error: "export_unavailable", status: page.status };
    const fileEndpoint = actions[0];
    fileEndpoint.hash = "";
    const file = await readDocument(context, fileEndpoint, "application/xml", "application/xml");
    if (file.limited || file.error) return file.error === "target_unavailable" ? { error: "export_unavailable", status: file.status } : file;
    const roots = [...file.document.querySelectorAll("GLOSSARY > INFO > ENTRIES")];
    if (roots.length > 1) return { error: "response_invalid", status: file.status };
    const nodes = roots.length === 1 ? [...roots[0].querySelectorAll("ENTRY")] : [];
    if (nodes.length > MAX_ENTRIES) return { limited: true, status: file.status };
    const rows = [];
    for (const node of nodes) {
      const concept = childText(node, "CONCEPT", MAX_CONCEPT);
      const entryDefinition = childText(node, "DEFINITION", MAX_DEFINITION);
      const teacherEntry = childText(node, "TEACHERENTRY", 8);
      if (!concept || entryDefinition === null || (teacherEntry !== "0" && teacherEntry !== "1")) {
        return { error: "response_invalid", status: file.status };
      }
      const aliasNodes = [...node.querySelectorAll("ALIASES > ALIAS > NAME")];
      const categoryNodes = [...node.querySelectorAll("CATEGORIES > CATEGORY > NAME")];
      if (aliasNodes.length > MAX_ALIASES || categoryNodes.length > MAX_CATEGORIES) return { limited: true, status: file.status };
      const aliases = aliasNodes.map((alias) => boundedValue(String(alias.textContent ?? ""), MAX_CONCEPT));
      const categories = categoryNodes.map((category) => boundedValue(String(category.textContent ?? ""), MAX_CONCEPT));
      if (aliases.some((alias) => alias === null) || categories.some((category) => category === null)) {
        return { error: "response_invalid", status: file.status };
      }
      rows.push({
        position: rows.length + 1,
        concept,
        definition: entryDefinition,
        teacher_entry: teacherEntry === "1",
        aliases,
        categories,
        file_count: node.querySelectorAll("ENTRYFILES > FILE, ATTACHMENTFILES > FILE").length,
      });
    }
    return { entries: rows, status: file.status };
  };
  // The entry form carries the three linking controls either as checkboxes,
  // which submit nothing when they are clear, or as hidden 0/1 controls when
  // the Glossary itself does not link its entries.
  const formFlag = (entries, name) => {
    const value = one(entries, name);
    return value === null ? false : value !== "0";
  };
  /**
   * The native Glossary entry form, which is both the exact read of one entry
   * and the exact target of a write.
   */
  const glossaryEntryForm = async (context, courseId, moduleId, entryId) => {
    const endpoint = urlFor(context, GLOSSARY_EDIT_PATH, entryId ? { cmid: moduleId, id: entryId } : { cmid: moduleId });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited || page.error) return page;
    if (!boundBody(page.document, courseId, moduleId, "glossary")) return { error: "target_unavailable", status: page.status };
    const forms = postForms(page.document, endpoint, endpoint);
    if (forms.length !== 1) return { error: "form_invalid", status: page.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "form_invalid", status: page.status };
    if (one(entries, "sesskey") !== context.sesskey) return { error: "form_session_mismatch", status: page.status };
    // A new entry carries no ID of its own; edit.php sets $entry->id to null.
    const formEntryId = one(entries, "id");
    if (one(entries, "cmid") !== moduleId || (entryId ? formEntryId !== entryId : formEntryId !== "" && formEntryId !== "0")) {
      return { error: "form_invalid", status: page.status };
    }
    const concept = one(entries, "concept");
    const entryDefinition = one(entries, "definition_editor[text]");
    const format = one(entries, "definition_editor[format]");
    const aliases = one(entries, "aliases");
    if (concept === null || entryDefinition === null || aliases === null || format === null) {
      return { error: "form_invalid", status: page.status };
    }
    if (entries.some(([name, value]) => !TRANSIENT_FIELD.test(name) && value === context.sesskey)) {
      return { error: "form_invalid", status: page.status };
    }
    const submits = [...form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]')]
      .filter((element) => !element.disabled && element.name === "submitbutton"
        && typeof element.value === "string" && element.value.length > 0 && element.value.length <= 500);
    if (submits.length !== 1) return { error: "form_invalid", status: page.status };
    const attachmentItem = one(entries, "attachment_filemanager");
    return {
      endpoint,
      form,
      entries,
      submit: submits[0],
      concept,
      definition: entryDefinition,
      definitionFormat: format,
      aliases,
      linking: {
        used_for_linking: formFlag(entries, "usedynalink"),
        case_sensitive: formFlag(entries, "casesensitive"),
        full_match: formFlag(entries, "fullmatch"),
      },
      attachmentItem: attachmentItem && ID.test(attachmentItem) ? attachmentItem : "",
      status: page.status,
    };
  };
  /**
   * Morrow reviews no file here, so every draft attachment area on the form
   * has to be proven empty before a write.
   */
  const attachmentAreaEmpty = async (context, itemId) => {
    if (!itemId) return "unverified";
    const listing = await draftListing(context, itemId);
    if (!listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)) return "unverified";
    return listing.filecount === 0 && listing.list.length === 0 ? "empty" : "present";
  };
  /** The saved approval state of one entry, and the Glossary it belongs to. */
  const glossaryEntryState = async (context, instanceId, entryId) => {
    const result = await ajax(context, ENTRY_STATE_METHOD, { id: Number(entryId) });
    if (result.limited || result.error) return result;
    const entry = result.data.entry;
    if (!object(entry) || id(entry.id) !== entryId || id(entry.glossaryid) !== instanceId || typeof entry.approved !== "boolean") {
      return { error: "entry_state_unreadable", status: result.status };
    }
    return { approved: entry.approved, status: result.status };
  };
  /**
   * Every page of this Wiki's current subwiki. `wiki_search_title` matches
   * every title against an empty search, and the rendered result names each
   * page through its own view link.
   */
  const wikiPages = async (context, courseId, moduleId) => {
    const endpoint = urlFor(context, WIKI_SEARCH_PATH, { courseid: courseId, cmid: moduleId, searchstring: "" });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited || page.error) return page;
    if (!boundBody(page.document, courseId, moduleId, "wiki")) return { error: "target_unavailable", status: page.status };
    const viewPath = `${context.basePath}${WIKI_VIEW_PATH}`;
    const rows = [];
    const seen = new Set();
    for (const anchor of page.document.querySelectorAll("th a[href], td a[href]")) {
      let target;
      try { target = new URL(anchor.getAttribute("href") || "", endpoint); } catch { continue; }
      if (target.origin !== context.origin || target.pathname !== viewPath) continue;
      const pageId = id(target.searchParams.get("pageid") || "");
      const cell = anchor.closest("th, td");
      if (!pageId || !cell || seen.has(pageId)) return { error: "response_invalid", status: page.status };
      seen.add(pageId);
      const label = cell.cloneNode(true);
      for (const link of [...label.querySelectorAll("a")]) link.remove();
      // The cell holds the page title and, in brackets, the link Moodle
      // renders next to it.
      const title = String(label.textContent ?? "").replace(/\s*\(\s*\)\s*$/, "").trim();
      if (!validText(title, MAX_TITLE)) return { error: "response_invalid", status: page.status };
      rows.push({ page_id: Number(pageId), title });
      if (rows.length > MAX_PAGES) return { limited: true, status: page.status };
    }
    return { pages: rows, status: page.status };
  };
  /**
   * The native Wiki page editor. It carries the page's exact version, refuses
   * to render its form when another person holds Moodle's editing lock, and is
   * the exact target of a page write.
   */
  const wikiEditForm = async (context, courseId, moduleId, pageId) => {
    const endpoint = urlFor(context, WIKI_EDIT_PATH, { pageid: pageId });
    const page = await readDocument(context, endpoint, "text/html", "text/html");
    if (page.limited || page.error) return page;
    if (!boundBody(page.document, courseId, moduleId, "wiki")) return { error: "target_unavailable", status: page.status };
    // When wiki_set_lock refuses, page_wiki_edit prints the locked notice and
    // the override form instead of the editor.
    const overrides = [...page.document.querySelectorAll("form[action]")].filter((form) => {
      try {
        const action = new URL(form.getAttribute("action") || "", endpoint);
        return action.origin === context.origin && action.pathname === `${context.basePath}${WIKI_OVERRIDE_LOCKS_PATH}`;
      } catch { return false; }
    });
    if (overrides.length) return { error: "page_locked", status: page.status };
    const forms = postForms(page.document, endpoint, endpoint);
    if (forms.length !== 1) return { error: "page_edit_unavailable", status: page.status };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "form_invalid", status: page.status };
    if (one(entries, "sesskey") !== context.sesskey) return { error: "form_session_mismatch", status: page.status };
    const version = one(entries, "version");
    const format = one(entries, "contentformat");
    if (typeof version !== "string" || !VERSION.test(version) || !validText(format, 40)) {
      return { error: "form_invalid", status: page.status };
    }
    const contentField = format === "html" ? "newcontent_editor[text]" : "newcontent";
    const content = one(entries, contentField);
    if (content === null || content.length > MAX_CONTENT) return { error: "form_invalid", status: page.status };
    if (entries.some(([name, value]) => !TRANSIENT_FIELD.test(name) && value === context.sesskey)) {
      return { error: "form_invalid", status: page.status };
    }
    // The three edit buttons share one name; only the save button carries the
    // value edit.php compares against get_string('save', 'wiki').
    const submits = [...form.querySelectorAll('input[type="submit"][name="editoption"], button[type="submit"][name="editoption"]')]
      .filter((element) => !element.disabled && element.id === "save"
        && typeof element.value === "string" && element.value.length > 0 && element.value.length <= 500);
    if (submits.length !== 1) return { error: "form_invalid", status: page.status };
    return { endpoint, form, entries, submit: submits[0], version, contentFormat: format, contentField, content, status: page.status };
  };
  const dispatch = async (context, endpoint, body) => {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body,
      });
    } catch { return { unconfirmed: true }; }
    if (!sameContext(context, currentContext())) return { unconfirmed: true, status: response.status };
    // Chromium reports a manual same-origin POST redirect as opaqueredirect and
    // does not follow it. The fixed native endpoint and the readback below are
    // the confirmation; Morrow never opens the route Moodle names next.
    if (response.type === "opaqueredirect") return { sent: true };
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", endpoint); } catch { redirect = null; }
      if (!redirect || redirect.origin !== context.origin || !redirect.pathname.startsWith(`${context.basePath}/`)) {
        return { unconfirmed: true, status: response.status };
      }
      return { sent: true, status: response.status };
    }
    return { unconfirmed: true, status: response.status };
  };
  const bodyWith = (entries, replacements, submit) => {
    const body = new URLSearchParams();
    for (const [name, value] of entries) {
      body.append(name, Object.hasOwn(replacements, name) ? replacements[name] : value);
    }
    body.append(submit.name, submit.value);
    return body;
  };
  const targetsFor = (activityName, childLabel, childName) => [
    { field: "module_id", label: definition.module === "glossary" ? "Glossary" : "Wiki", name: activityName },
    ...(childName ? [{ field: childLabel === "Entry" ? "entry_id" : "page_id", label: childLabel, name: childName }] : []),
  ];
  const proofFor = (extra) => ({
    exact_module_binding: MODULE_BINDING,
    required_capability: definition.capability,
    learner_identity: "never_returned",
    ...extra,
  });

  let writeAttempted = false;
  try {
    const context = currentContext();
    const operation = input.operation;
    if (input?.mode !== "execute" || !context) return failure("session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("execution_expired");
    if (operation.provider !== PROVIDER || operation.toolName !== definition.toolName || operation.readOnly !== definition.readOnly) {
      return failure("operation_refused");
    }
    if (!bindingValid(context, input.binding)) return failure("binding_mismatch");
    if (input.privateAttachment !== undefined || input.privateConversation !== undefined) return failure("attachment_refused");
    const args = argumentsFor(input.arguments, context.anchorCourseId);
    if (!args) return failure("arguments_invalid");
    const approved = () => Date.now() < input.expiresAt && sameContext(context, currentContext());
    const relay = (result, fallback) => result.limited ? incomplete() : failure(result.error || fallback, result.status);

    const bound = await bindModule(context, args.courseId, args.moduleId);
    if (bound.limited || bound.error) return relay(bound, "target_unavailable");
    const base = {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(args.courseId),
      module_id: Number(args.moduleId),
      ...(definition.module === "glossary" ? { glossary_id: Number(bound.instanceId) } : { wiki_id: Number(bound.instanceId) }),
      activity_name: bound.name,
      visible: bound.visible,
    };

    if (definition.kind === "glossary_entries" || definition.kind === "glossary_entry_create") {
      const listed = await glossaryExport(context, args.moduleId);
      if (listed.limited || listed.error) return relay(listed, "export_unavailable");
      const listing = (rows) => ({
        ...base,
        entry_count: rows.length,
        entries: rows,
        // glossary_generate_export_file writes approved entries only and no
        // entry ID, so this list cannot name an entry for a later write.
        listed_entries: "approved_only",
        entry_ids_listed: false,
      });
      if (definition.kind === "glossary_entries") {
        return {
          ok: true,
          sent: false,
          complete: true,
          status: listed.status,
          data: { ...listing(listed.entries), proof: proofFor({ method: "mod_glossary_export_xml", native_route: GLOSSARY_EXPORT_PATH, entry_limit: MAX_ENTRIES }) },
          targets: targetsFor(bound.name, "Entry", ""),
          snapshot_digest: await digest(listing(listed.entries)),
        };
      }
      if (await digest(listing(listed.entries)) !== args.expectedDigest) return failure("expected_digest_mismatch", listed.status);
      // A saved entry is visible to every learner who can see the Glossary, and
      // Morrow has no route that removes it.
      if (bound.visible && args.learnerVisibilityConfirmed !== true) return failure("learner_visibility_unconfirmed", listed.status);
      // Moodle approves a new entry only when the Glossary approves by default
      // or the person holds mod/glossary:approve, and its export omits every
      // entry that is not approved. Morrow will not create what it cannot read
      // back, and it cannot see that capability from the browser.
      if (bound.defaultApproval !== true) return failure("default_approval_required", listed.status);
      if (FILE_REFERENCE.test(args.definition)) return failure("definition_refused", listed.status);
      if (listed.entries.some((entry) => entry.concept === args.concept)) return failure("concept_exists", listed.status);
      if (listed.entries.length >= MAX_ENTRIES) return incomplete();

      const form = await glossaryEntryForm(context, args.courseId, args.moduleId, "");
      if (form.limited || form.error) return relay(form, "form_invalid");
      if (form.definitionFormat !== "1") return failure("definition_format_unsupported", form.status);
      const attachments = await attachmentAreaEmpty(context, form.attachmentItem);
      if (attachments === "unverified") return failure("attachment_area_unverified", form.status);
      if (attachments === "present") return failure("attachment_area_refused", form.status);
      if (!approved()) return failure("context_changed", form.status);

      writeAttempted = true;
      const sent = await dispatch(context, form.endpoint, bodyWith(form.entries, {
        concept: args.concept, "definition_editor[text]": args.definition,
      }, form.submit));
      if (sent.unconfirmed) return unconfirmedWrite("write_unconfirmed", sent.status);
      const after = await glossaryExport(context, args.moduleId);
      if (after.limited || after.error) return unconfirmedWrite("readback_unconfirmed", sent.status);
      const created = after.entries.filter((entry) => entry.concept === args.concept);
      const retained = after.entries.filter((entry) => entry.concept !== args.concept);
      if (created.length !== 1 || retained.length !== listed.entries.length
        || stable(retained.map((entry, index) => ({ ...entry, position: index + 1 })))
          !== stable(listed.entries.map((entry, index) => ({ ...entry, position: index + 1 })))) {
        return mismatchWrite("readback_mismatch", sent.status);
      }
      if (created[0].definition !== args.definition || created[0].file_count !== 0) return mismatchWrite("readback_mismatch", sent.status);
      return {
        ok: true,
        sent: true,
        ...(Number.isInteger(sent.status) ? { status: sent.status } : {}),
        data: {
          ...listing(after.entries),
          created_concept: args.concept,
          proof: proofFor({
            method: "mod_glossary_entry_form",
            native_route: GLOSSARY_EDIT_PATH,
            dispatch_count: 1,
            readback: "mod_glossary_export_xml",
            // The export names no entry ID, so a later change to this entry
            // needs the ID from the entry's own Edit link in Moodle.
            created_entry_id: "not_returned",
            approval_state: "approved_by_default",
            learner_visible: bound.visible,
          }),
        },
        targets: targetsFor(bound.name, "Entry", args.concept),
        snapshot_digest: await digest(listing(after.entries)),
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      };
    }

    if (definition.kind === "glossary_entry" || definition.kind === "glossary_entry_update") {
      const form = await glossaryEntryForm(context, args.courseId, args.moduleId, args.entryId);
      if (form.limited || form.error) return relay(form, "form_invalid");
      const state = await glossaryEntryState(context, bound.instanceId, args.entryId);
      if (state.limited || state.error) return relay(state, "entry_state_unreadable");
      const attachments = await attachmentAreaEmpty(context, form.attachmentItem);
      if (attachments === "unverified") return failure("attachment_area_unverified", form.status);
      const entryOf = (source, approvedState) => ({
        ...base,
        entry_id: Number(args.entryId),
        concept: source.concept,
        definition: source.definition,
        definition_format: source.definitionFormat,
        aliases: source.aliases.split("\n").map((alias) => alias.trim()).filter(Boolean),
        approved: approvedState,
        has_attachment: attachments === "present",
        ...source.linking,
      });
      const before = entryOf(form, state.approved);
      const beforeDigest = await digest(before);
      if (definition.kind === "glossary_entry") {
        return {
          ok: true,
          sent: false,
          complete: true,
          status: form.status,
          data: { ...before, proof: proofFor({ method: `mod_glossary_entry_form+${ENTRY_STATE_METHOD}`, native_route: GLOSSARY_EDIT_PATH }) },
          targets: targetsFor(bound.name, "Entry", form.concept),
          snapshot_digest: beforeDigest,
        };
      }
      if (beforeDigest !== args.expectedDigest) return failure("expected_digest_mismatch", form.status);
      if (attachments === "present") return failure("attachment_area_refused", form.status);
      if (form.definitionFormat !== "1") return failure("definition_format_unsupported", form.status);
      // Morrow reviews no file, so it neither writes a file reference nor
      // replaces a definition whose files it would leave behind.
      if (FILE_REFERENCE.test(form.definition) || (args.definition !== null && FILE_REFERENCE.test(args.definition))) {
        return failure("definition_refused", form.status);
      }
      const concept = args.concept === null ? form.concept : args.concept;
      const entryDefinition = args.definition === null ? form.definition : args.definition;
      if (concept === form.concept && entryDefinition === form.definition) return failure("change_absent", form.status);
      if (!approved()) return failure("context_changed", form.status);

      writeAttempted = true;
      const sent = await dispatch(context, form.endpoint, bodyWith(form.entries, {
        concept, "definition_editor[text]": entryDefinition,
      }, form.submit));
      if (sent.unconfirmed) return unconfirmedWrite("write_unconfirmed", sent.status);
      const saved = await glossaryEntryForm(context, args.courseId, args.moduleId, args.entryId);
      if (saved.limited || saved.error) return unconfirmedWrite("readback_unconfirmed", sent.status);
      const savedState = await glossaryEntryState(context, bound.instanceId, args.entryId);
      if (savedState.limited || savedState.error) return unconfirmedWrite("readback_unconfirmed", sent.status);
      const after = entryOf(saved, savedState.approved);
      const expected = { ...before, concept, definition: entryDefinition, approved: savedState.approved };
      if (stable(after) !== stable(expected)) return mismatchWrite("readback_mismatch", sent.status);
      return {
        ok: true,
        sent: true,
        ...(Number.isInteger(sent.status) ? { status: sent.status } : {}),
        data: {
          ...after,
          approved_before: state.approved,
          proof: proofFor({
            method: "mod_glossary_entry_form",
            native_route: GLOSSARY_EDIT_PATH,
            dispatch_count: 1,
            readback: `mod_glossary_entry_form+${ENTRY_STATE_METHOD}`,
            // glossary_edit_entry clears the approval on every save and sets it
            // again only for a Glossary that approves by default or a person
            // who holds mod/glossary:approve.
            approval_state: state.approved === after.approved ? "unchanged" : "changed_by_moodle",
            learner_visible: bound.visible,
          }),
        },
        targets: targetsFor(bound.name, "Entry", concept),
        snapshot_digest: await digest(after),
        verification: { schema: "morrow.browser-verification.v1", status: "verified" },
      };
    }

    const listed = await wikiPages(context, args.courseId, args.moduleId);
    if (listed.limited || listed.error) return relay(listed, "target_unavailable");
    if (definition.kind === "wiki_pages") {
      const data = { ...base, page_count: listed.pages.length, pages: listed.pages };
      return {
        ok: true,
        sent: false,
        complete: true,
        status: listed.status,
        data: { ...data, proof: proofFor({ method: "mod_wiki_search_titles", native_route: WIKI_SEARCH_PATH, page_limit: MAX_PAGES, scope: "current_subwiki" }) },
        targets: targetsFor(bound.name, "Page", ""),
        snapshot_digest: await digest(data),
      };
    }

    const named = listed.pages.filter((entry) => String(entry.page_id) === args.pageId);
    if (named.length !== 1) return failure("page_unavailable", listed.status);
    const form = await wikiEditForm(context, args.courseId, args.moduleId, args.pageId);
    if (form.limited || form.error) return relay(form, "page_edit_unavailable");
    const pageOf = (source) => ({
      ...base,
      page_id: Number(args.pageId),
      title: named[0].title,
      version: Number(source.version),
      content_format: source.contentFormat,
      content: source.content,
    });
    const before = pageOf(form);
    const beforeDigest = await digest(before);
    if (definition.kind === "wiki_page") {
      return {
        ok: true,
        sent: false,
        complete: true,
        status: form.status,
        data: {
          ...before,
          proof: proofFor({
            method: "mod_wiki_edit_form",
            native_route: WIKI_EDIT_PATH,
            // page_wiki_edit takes Moodle's own editing lock, which expires 30
            // seconds after it is taken.
            editing_lock: "taken_for_30_seconds",
          }),
        },
        targets: targetsFor(bound.name, "Page", named[0].title),
        snapshot_digest: beforeDigest,
      };
    }
    if (beforeDigest !== args.expectedDigest) return failure("expected_digest_mismatch", form.status);
    // page_wiki_save saves whatever version the form sends, so Morrow binds the
    // version itself and requires the exact one the approving person reviewed.
    if (form.version !== args.expectedVersion) return failure("version_mismatch", form.status);
    if (FILE_REFERENCE.test(form.content) || FILE_REFERENCE.test(args.content)) return failure("content_refused", form.status);
    if (args.content === form.content) return failure("change_absent", form.status);
    if (!approved()) return failure("context_changed", form.status);

    writeAttempted = true;
    const sent = await dispatch(context, form.endpoint, bodyWith(form.entries, { [form.contentField]: args.content }, form.submit));
    if (sent.unconfirmed) return unconfirmedWrite("write_unconfirmed", sent.status);
    const saved = await wikiEditForm(context, args.courseId, args.moduleId, args.pageId);
    if (saved.limited || saved.error) return unconfirmedWrite("readback_unconfirmed", sent.status);
    const after = pageOf(saved);
    if (stable(after) !== stable({ ...before, version: Number(args.expectedVersion) + 1, content: args.content })) {
      return mismatchWrite("readback_mismatch", sent.status);
    }
    return {
      ok: true,
      sent: true,
      ...(Number.isInteger(sent.status) ? { status: sent.status } : {}),
      data: {
        ...after,
        previous_version: Number(args.expectedVersion),
        proof: proofFor({
          method: "mod_wiki_edit_form",
          native_route: WIKI_EDIT_PATH,
          dispatch_count: 1,
          readback: "mod_wiki_edit_form",
          bound_version: Number(args.expectedVersion),
          editing_lock: "taken_for_30_seconds",
          // Moodle keeps the previous version in the page history. Morrow has
          // no route that restores it.
          previous_version_kept_by: "moodle_page_history",
          learner_visible: bound.visible,
        }),
      },
      targets: targetsFor(bound.name, "Page", named[0].title),
      snapshot_digest: await digest(after),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (writeAttempted) return unconfirmedWrite("write_unconfirmed");
    const message = String(error?.message || error);
    return message.startsWith("moodle_") ? { ok: false, sent: false, error: message } : failure("execution_failed");
  }
}
