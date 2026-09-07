/**
 * Reads the page and question graph of one exact Moodle Lesson.
 *
 * A Lesson is a directed graph. Each page carries a type, a title and one jump
 * per stored answer, and a jump is either another page in the same Lesson or
 * one of Moodle's named targets. An instructor cannot review a Lesson without
 * that graph, so both readers resolve every jump to a page ID or to a named
 * target and refuse a value they cannot name.
 *
 * Two native routes are used and nothing else.
 *
 * 1. /mod/lesson/edit.php?id=<cmid> lists the pages in order. Moodle walks the
 *    stored prevpageid/nextpageid chain and renders one element per page whose
 *    HTML id is `lesson-<pageid>`, in both its collapsed and its full view.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/renderer.php
 *    No `mode` parameter is sent. edit.php reads
 *    `optional_param('mode', get_user_preferences('lesson_view', 'collapsed'))`
 *    and calls set_user_preference only when the requested mode differs from
 *    the stored one, so omitting the parameter leaves the signed-in user's
 *    stored view preference untouched.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/edit.php
 * 2. /mod/lesson/editpage.php?id=<cmid>&pageid=<pageid>&edit=1 renders the
 *    native editing form for one page. Its hidden qtype field carries the exact
 *    page type, and its jumpto[i] and score[i] controls carry the exact stored
 *    jump and score for each answer slot.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/editpage.php
 *
 * /mod/lesson/view.php is never opened. That route starts or continues a
 * Lesson attempt and records learner progress; the two authoring routes above
 * record none.
 *
 * Required capability: mod/lesson:manage at the module context, which Moodle
 * requires to open edit.php, and mod/lesson:edit, which Moodle requires to open
 * editpage.php and which edit.php also requires before it renders any page
 * editing link. Neither reader can run without both.
 *
 * Limits stated in every result:
 * - Morrow reads Moodle's ten core Lesson page types. A Lesson holding any
 *   other page type is refused with an exact reason and no partial graph.
 * - A slot counts as a stored answer when the page type has no answer control
 *   for it, as the Essay page has, or when its answer control holds text. This
 *   mirrors lesson_page::get_jumps, which reads the stored answers and falls
 *   back to the page's own next page when a page has none. Every Moodle page
 *   type that has an answer control makes its first answer required, so a page
 *   that yields no stored answer is refused rather than reported as a page with
 *   no jump.
 * - moodle_list_lesson_pages returns the graph and no page content.
 * - moodle_get_lesson_page refuses a page whose contents, answer or response
 *   text carries a draft-file reference or embedded media, the same refusal the
 *   Quiz question reader applies.
 *
 * Neither reader has run on a signed-in Moodle site.
 */

/**
 * Lists every page of one Lesson in stored order with its type, title and
 * resolved jumps. It returns no page content.
 */
export async function executeMoodleLessonPageListInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.lesson.pages.read.v1";
  const TOOL = "moodle_list_lesson_pages";
  const SCHEMA = "morrow.moodle-lesson-page-list.v1";
  const ERROR = "moodle_lesson_pages";
  const LIST_PATH = "/mod/lesson/edit.php";
  const PAGE_PATH = "/mod/lesson/editpage.php";
  const MODULE_PATH = "/course/modedit.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 100;
  const MAX_ANSWERS = 40;
  const MAX_TITLE = 255;
  const MAX_RICH_TEXT = 40_000;
  // mod/lesson/pagetypes/*.php, Moodle v5.2.2.
  const PAGE_TYPES = { 1: "shortanswer", 2: "truefalse", 3: "multichoice", 5: "matching", 8: "numerical", 10: "essay", 20: "branchtable", 21: "endofbranch", 30: "cluster", 31: "endofcluster" };
  const PAGE_KINDS = { shortanswer: "question", truefalse: "question", multichoice: "question", matching: "question", numerical: "question", essay: "question", branchtable: "content", endofbranch: "structure", cluster: "structure", endofcluster: "structure" };
  // mod/lesson/locallib.php, Moodle v5.2.2. A positive jumpto value is a page ID.
  const JUMP_NAMES = { 0: "this_page", "-1": "next_page", "-9": "end_of_lesson", "-40": "previous_page", "-50": "unseen_branch_page", "-60": "random_page", "-70": "random_branch", "-80": "cluster_jump" };
  const ID = /^[1-9][0-9]{0,18}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text_ = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text_) ? text_ : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const plain = (value, maximum) => (typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);
  const fail = (error) => ({ ok: false, sent: false, error: `${ERROR}_${error}` });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${ERROR}_incomplete` });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) return fail("context_invalid");
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER
    || operation.readOnly !== true || !object(args) || Object.keys(args).length !== 2
    || id(args.course_id) !== courseId || !id(args.module_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("arguments_invalid");
  const moduleId = id(args.module_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query = {}) => {
    const result = new URL(site.href);
    result.pathname = `${basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const sameRoute = (actual, expected) => {
    try {
      const received = new URL(actual);
      return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
        && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response, endpoint) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext() || !response.body
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
  const nativeDocument = async (path, query) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "context_changed" };
    const endpoint = url(path, query);
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "request_failed" }; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return { limit: true };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "response_unavailable" };
    try { return { document: new DOMParser().parseFromString(html, "text/html"), endpoint }; }
    catch { return { error: "response_invalid" }; }
  };
  const controlsNamed = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const oneFormValue = (formData, name, maximum) => {
    const values = formData.getAll(name);
    return values.length === 1 && typeof values[0] === "string" && values[0].length <= maximum ? values[0] : null;
  };
  const hidden = (form, name) => {
    const controls = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return controls.length === 1 ? controls[0].value : "";
  };
  const lessonInstance = async () => {
    const page = await nativeDocument(MODULE_PATH, { update: moduleId, return: "0" });
    if (page.error || page.limit || !page.document) return page.limit ? { limit: true } : { error: page.error || "target_unavailable" };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || page.endpoint.href, page.endpoint);
        const exactAction = action.origin === page.endpoint.origin && action.pathname === page.endpoint.pathname && !action.hash
          && !action.username && !action.password && (action.search === "" || action.search === page.endpoint.search);
        return exactAction && hidden(form, "course") === courseId && hidden(form, "coursemodule") === moduleId
          && hidden(form, "update") === moduleId && hidden(form, "modulename") === "lesson" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    const instance = forms.length === 1 ? id(hidden(forms[0], "instance")) : "";
    return instance ? { instance } : { error: "target_unavailable" };
  };
  const pageOrder = async () => {
    const page = await nativeDocument(LIST_PATH, { id: moduleId });
    if (page.error || page.limit || !page.document) return page.limit ? { limit: true } : { error: page.error || "unavailable" };
    const editing = [...page.document.querySelectorAll("a[href]")].some((anchor) => {
      try {
        const href = new URL(anchor.getAttribute("href"), page.endpoint);
        return href.origin === site.origin && href.pathname === `${basePath}${PAGE_PATH}` && href.searchParams.get("id") === moduleId;
      } catch { return false; }
    });
    if (!editing) return { error: "unavailable" };
    const ordered = [];
    for (const element of page.document.querySelectorAll('a[id^="lesson-"]')) {
      const pageId = id(String(element.getAttribute("id") || "").slice("lesson-".length));
      if (!pageId) return { error: "list_invalid" };
      if (ordered.includes(pageId)) return { error: "list_invalid" };
      ordered.push(pageId);
      if (ordered.length > MAX_PAGES) return { limit: true };
    }
    return { ordered };
  };
  const jumpTarget = (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(raw)) return null;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) return null;
    if (numeric > 0) return { target: "page", page_id: numeric };
    const named = JUMP_NAMES[String(numeric)];
    return named ? { target: named } : null;
  };
  const jumpValue = (form, index) => {
    const controls = controlsNamed(form, `jumpto[${index}]`);
    if (controls.length !== 1) return null;
    const control = controls[0];
    if (control.tagName === "SELECT") {
      const selected = [...control.querySelectorAll("option[selected]")];
      return selected.length === 1 ? selected[0].getAttribute("value") : null;
    }
    return control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "hidden"
      ? control.getAttribute("value") : null;
  };
  const answerPresence = (form, formData, index) => {
    const editor = controlsNamed(form, `answer_editor[${index}][text]`);
    const single = controlsNamed(form, `answer_editor[${index}]`);
    if (!editor.length && !single.length) return { control: "none" };
    if (editor.length === 1 && !single.length) {
      const value = oneFormValue(formData, `answer_editor[${index}][text]`, MAX_RICH_TEXT);
      return value === null ? null : { control: "editor", value };
    }
    if (single.length === 1 && !editor.length) {
      const value = oneFormValue(formData, `answer_editor[${index}]`, MAX_RICH_TEXT);
      return value === null ? null : { control: "text", value };
    }
    return null;
  };
  const pageGraph = async (pageId) => {
    const page = await nativeDocument(PAGE_PATH, { id: moduleId, pageid: pageId, edit: "1" });
    if (page.error || page.limit || !page.document) return page.limit ? { limit: true } : { error: page.error || "page_unavailable" };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || page.endpoint.href, page.endpoint);
        if (action.origin !== page.endpoint.origin || action.pathname !== page.endpoint.pathname
          || action.hash || action.username || action.password) return false;
        const actionModule = action.searchParams.get("id");
        const actionPage = action.searchParams.get("pageid");
        if ((actionModule !== null && actionModule !== moduleId) || (actionPage !== null && actionPage !== pageId)) return false;
      } catch { return false; }
      return hidden(form, "id") === moduleId && hidden(form, "pageid") === pageId
        && hidden(form, "edit") === "1" && Boolean(text(hidden(form, "sesskey")));
    });
    if (forms.length !== 1) return { error: "page_unavailable" };
    const form = forms[0];
    const formData = new FormData(form);
    const typeId = Number(oneFormValue(formData, "qtype", 8));
    const pageType = Number.isSafeInteger(typeId) ? PAGE_TYPES[typeId] : undefined;
    if (!pageType) return { error: "page_type_unsupported" };
    const title = plain(oneFormValue(formData, "title", MAX_TITLE), MAX_TITLE);
    if (!title) return { error: "page_invalid" };
    const indexes = [...new Set([...formData.keys()].map((key) => key.match(/^jumpto\[([0-9]{1,3})\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!indexes.length) return { error: "page_jump_missing" };
    if (indexes.length > MAX_ANSWERS) return { limit: true };
    const jumps = [];
    for (const index of indexes) {
      const presence = answerPresence(form, formData, index);
      if (!presence) return { error: "page_invalid" };
      if (presence.control !== "none" && !presence.value.trim()) continue;
      const jump = jumpTarget(jumpValue(form, index));
      if (!jump) return { error: "page_jump_unsupported" };
      jumps.push({ index, ...jump });
    }
    if (!jumps.length) return { error: "page_answers_missing" };
    return { page: { page_id: Number(pageId), title, page_type: pageType, page_type_id: typeId, page_kind: PAGE_KINDS[pageType], jumps } };
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return "";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const instance = await lessonInstance();
  if (instance.limit) return incomplete();
  if (!instance.instance) return fail(instance.error || "target_unavailable");
  const order = await pageOrder();
  if (order.limit) return incomplete();
  if (!order.ordered) return fail(order.error || "unavailable");
  const known = new Set(order.ordered.map(Number));
  const pages = [];
  for (const pageId of order.ordered) {
    const graph = await pageGraph(pageId);
    if (graph.limit) return incomplete();
    if (!graph.page) return fail(graph.error || "page_unavailable");
    const targets = graph.page.jumps.filter((jump) => jump.target === "page").map((jump) => jump.page_id);
    if (targets.some((target) => !known.has(target))) return fail("jump_target_unknown");
    pages.push({ ...graph.page, position: pages.length + 1, branch_target_page_ids: [...new Set(targets)].sort((left, right) => left - right) });
  }
  if (!sameContext() || Date.now() > input.expiresAt) return fail("context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    lesson_id: Number(instance.instance),
    page_count: pages.length,
    pages: pages.map((page) => ({
      page_id: page.page_id, position: page.position, title: page.title,
      page_type: page.page_type, page_type_id: page.page_type_id, page_kind: page.page_kind,
      jumps: page.jumps, branch_target_page_ids: page.branch_target_page_ids,
    })),
    proof: {
      list_source: "mod_lesson_edit_page",
      page_source: "mod_lesson_editpage_form",
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/lesson:manage",
      page_form_capability: "mod/lesson:edit",
      jump_source: "editpage_form_stored_answers",
      learner_progress: "not_recorded",
      page_content: "not_returned",
      view_route: "never_opened",
      page_limit: MAX_PAGES,
      answer_limit: MAX_ANSWERS,
      page_request_count: pages.length,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}

/**
 * Reads one exact Lesson page with its contents and, for a question page, its
 * answers, responses, scores and jumps. It refuses a page whose rich text
 * carries a draft-file reference or embedded media.
 */
export async function executeMoodleLessonPageInPage(rawInput) {
  const PROVIDER = "moodle";
  const OPERATION = "moodle.form.lesson.page.read.v1";
  const TOOL = "moodle_get_lesson_page";
  const SCHEMA = "morrow.moodle-lesson-page.v1";
  const ERROR = "moodle_lesson_page";
  const LIST_PATH = "/mod/lesson/edit.php";
  const PAGE_PATH = "/mod/lesson/editpage.php";
  const MODULE_PATH = "/course/modedit.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 100;
  const MAX_ANSWERS = 40;
  const MAX_TITLE = 255;
  const MAX_RICH_TEXT = 40_000;
  const PAGE_TYPES = { 1: "shortanswer", 2: "truefalse", 3: "multichoice", 5: "matching", 8: "numerical", 10: "essay", 20: "branchtable", 21: "endofbranch", 30: "cluster", 31: "endofcluster" };
  const PAGE_KINDS = { shortanswer: "question", truefalse: "question", multichoice: "question", matching: "question", numerical: "question", essay: "question", branchtable: "content", endofbranch: "structure", cluster: "structure", endofcluster: "structure" };
  const JUMP_NAMES = { 0: "this_page", "-1": "next_page", "-9": "end_of_lesson", "-40": "previous_page", "-50": "unseen_branch_page", "-60": "random_page", "-70": "random_branch", "-80": "cluster_jump" };
  const ID = /^[1-9][0-9]{0,18}$/;
  const SCORE = /^-?(?:0|[1-9][0-9]{0,6})$/;
  const FORMAT = /^[0-9]{1,3}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text_ = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text_) ? text_ : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const plain = (value, maximum) => (typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);
  const fail = (error) => ({ ok: false, sent: false, error: `${ERROR}_${error}` });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${ERROR}_incomplete` });
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const cfg = globalThis.M?.cfg;
  if (!object(input) || !object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) return fail("context_invalid");
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId) return fail("context_invalid");
  const operation = input.operation;
  const args = input.arguments;
  const binding = input.binding;
  if (!object(operation) || operation.key !== OPERATION || operation.toolName !== TOOL || operation.provider !== PROVIDER
    || operation.readOnly !== true || !object(args) || Object.keys(args).length !== 3
    || id(args.course_id) !== courseId || !id(args.module_id) || !id(args.page_id)
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("arguments_invalid");
  const moduleId = id(args.module_id);
  const requestedPageId = id(args.page_id);
  const sameContext = () => globalThis.M?.cfg?.sesskey === cfg.sesskey && id(globalThis.M?.cfg?.userId) === principalId
    && (id(globalThis.M?.cfg?.courseId) || bodyCourse) === courseId;
  const url = (path, query = {}) => {
    const result = new URL(site.href);
    result.pathname = `${basePath}${path}`;
    result.search = new URLSearchParams(query).toString();
    result.hash = "";
    return result;
  };
  const sameRoute = (actual, expected) => {
    try {
      const received = new URL(actual);
      return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
        && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response, endpoint) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || !sameRoute(response.url, endpoint) || !sameContext() || !response.body
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
  const nativeDocument = async (path, query) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return { error: "context_changed" };
    const endpoint = url(path, query);
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "request_failed" }; }
    const html = await boundedText(response, endpoint);
    if (html === "limit") return { limit: true };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "response_unavailable" };
    try { return { document: new DOMParser().parseFromString(html, "text/html"), endpoint }; }
    catch { return { error: "response_invalid" }; }
  };
  const controlsNamed = (form, name) => [...form.querySelectorAll("[name]")].filter((control) => control.getAttribute("name") === name);
  const oneFormValue = (formData, name, maximum) => {
    const values = formData.getAll(name);
    return values.length === 1 && typeof values[0] === "string" && values[0].length <= maximum ? values[0] : null;
  };
  const hidden = (form, name) => {
    const controls = [...form.querySelectorAll(`input[type="hidden"][name="${name}"]`)];
    return controls.length === 1 ? controls[0].value : "";
  };
  // The refusal the Quiz question reader applies to every rich-text field it
  // returns. connector/extension/src/moodle-executor.js hasEmbeddedFile.
  const hasEmbeddedFile = (value) => /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i.test(String(value));
  const lessonInstance = async () => {
    const page = await nativeDocument(MODULE_PATH, { update: moduleId, return: "0" });
    if (page.error || page.limit || !page.document) return page.limit ? { limit: true } : { error: page.error || "target_unavailable" };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || page.endpoint.href, page.endpoint);
        const exactAction = action.origin === page.endpoint.origin && action.pathname === page.endpoint.pathname && !action.hash
          && !action.username && !action.password && (action.search === "" || action.search === page.endpoint.search);
        return exactAction && hidden(form, "course") === courseId && hidden(form, "coursemodule") === moduleId
          && hidden(form, "update") === moduleId && hidden(form, "modulename") === "lesson" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    const instance = forms.length === 1 ? id(hidden(forms[0], "instance")) : "";
    return instance ? { instance } : { error: "target_unavailable" };
  };
  const pageOrder = async () => {
    const page = await nativeDocument(LIST_PATH, { id: moduleId });
    if (page.error || page.limit || !page.document) return page.limit ? { limit: true } : { error: page.error || "list_unavailable" };
    const editing = [...page.document.querySelectorAll("a[href]")].some((anchor) => {
      try {
        const href = new URL(anchor.getAttribute("href"), page.endpoint);
        return href.origin === site.origin && href.pathname === `${basePath}${PAGE_PATH}` && href.searchParams.get("id") === moduleId;
      } catch { return false; }
    });
    if (!editing) return { error: "list_unavailable" };
    const ordered = [];
    for (const element of page.document.querySelectorAll('a[id^="lesson-"]')) {
      const pageId = id(String(element.getAttribute("id") || "").slice("lesson-".length));
      if (!pageId || ordered.includes(pageId)) return { error: "list_invalid" };
      ordered.push(pageId);
      if (ordered.length > MAX_PAGES) return { limit: true };
    }
    return { ordered };
  };
  const jumpTarget = (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(raw)) return null;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) return null;
    if (numeric > 0) return { target: "page", page_id: numeric };
    const named = JUMP_NAMES[String(numeric)];
    return named ? { target: named } : null;
  };
  const jumpValue = (form, index) => {
    const controls = controlsNamed(form, `jumpto[${index}]`);
    if (controls.length !== 1) return null;
    const control = controls[0];
    if (control.tagName === "SELECT") {
      const selected = [...control.querySelectorAll("option[selected]")];
      return selected.length === 1 ? selected[0].getAttribute("value") : null;
    }
    return control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "hidden"
      ? control.getAttribute("value") : null;
  };
  const richValue = (formData, name) => {
    const value = oneFormValue(formData, name, MAX_RICH_TEXT);
    if (value === null) return { error: "page_invalid" };
    return hasEmbeddedFile(value) ? { error: "file_reference_unsupported" } : { value };
  };
  const answerFields = (form, formData, index) => {
    const editor = controlsNamed(form, `answer_editor[${index}][text]`);
    const single = controlsNamed(form, `answer_editor[${index}]`);
    if (!editor.length && !single.length) return { control: "none", text: null, format: null };
    if (editor.length === 1 && !single.length) {
      const value = richValue(formData, `answer_editor[${index}][text]`);
      if (value.error) return { error: value.error };
      const format = oneFormValue(formData, `answer_editor[${index}][format]`, 8);
      return format !== null && FORMAT.test(format) ? { control: "editor", text: value.value, format } : { error: "page_invalid" };
    }
    if (single.length === 1 && !editor.length) {
      const value = richValue(formData, `answer_editor[${index}]`);
      return value.error ? { error: value.error } : { control: "text", text: value.value, format: null };
    }
    return { error: "page_invalid" };
  };
  const responseFields = (formData, form, index) => {
    if (!controlsNamed(form, `response_editor[${index}][text]`).length) return { text: null, format: null };
    const value = richValue(formData, `response_editor[${index}][text]`);
    if (value.error) return { error: value.error };
    const format = oneFormValue(formData, `response_editor[${index}][format]`, 8);
    return format !== null && FORMAT.test(format) ? { text: value.value, format } : { error: "page_invalid" };
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return "";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const instance = await lessonInstance();
  if (instance.limit) return incomplete();
  if (!instance.instance) return fail(instance.error || "target_unavailable");
  const order = await pageOrder();
  if (order.limit) return incomplete();
  if (!order.ordered) return fail(order.error || "list_unavailable");
  const position = order.ordered.indexOf(requestedPageId) + 1;
  if (!position) return fail("not_in_lesson");
  const known = new Set(order.ordered.map(Number));
  const document_ = await nativeDocument(PAGE_PATH, { id: moduleId, pageid: requestedPageId, edit: "1" });
  if (document_.limit) return incomplete();
  if (!document_.document) return fail(document_.error || "unavailable");
  const forms = [...document_.document.querySelectorAll("form")].filter((form) => {
    if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
    try {
      const action = new URL(form.getAttribute("action") || document_.endpoint.href, document_.endpoint);
      if (action.origin !== document_.endpoint.origin || action.pathname !== document_.endpoint.pathname
        || action.hash || action.username || action.password) return false;
      const actionModule = action.searchParams.get("id");
      const actionPage = action.searchParams.get("pageid");
      if ((actionModule !== null && actionModule !== moduleId) || (actionPage !== null && actionPage !== requestedPageId)) return false;
    } catch { return false; }
    return hidden(form, "id") === moduleId && hidden(form, "pageid") === requestedPageId
      && hidden(form, "edit") === "1" && Boolean(text(hidden(form, "sesskey")));
  });
  if (forms.length !== 1) return fail("unavailable");
  const form = forms[0];
  const formData = new FormData(form);
  const typeId = Number(oneFormValue(formData, "qtype", 8));
  const pageType = Number.isSafeInteger(typeId) ? PAGE_TYPES[typeId] : undefined;
  if (!pageType) return fail("type_unsupported");
  const title = plain(oneFormValue(formData, "title", MAX_TITLE), MAX_TITLE);
  if (!title) return fail("invalid");
  const contents = richValue(formData, "contents_editor[text]");
  if (contents.error) return fail(contents.error);
  const contentsFormat = oneFormValue(formData, "contents_editor[format]", 8);
  if (contentsFormat === null || !FORMAT.test(contentsFormat)) return fail("invalid");
  const indexes = [...new Set([...formData.keys()].map((key) => key.match(/^jumpto\[([0-9]{1,3})\]$/)?.[1]).filter(Boolean))]
    .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
  if (!indexes.length) return fail("jump_missing");
  if (indexes.length > MAX_ANSWERS) return incomplete();
  const answers = [];
  for (const index of indexes) {
    const answer = answerFields(form, formData, index);
    if (answer.error) return fail(answer.error);
    if (answer.control !== "none" && !answer.text.trim()) continue;
    const response = responseFields(formData, form, index);
    if (response.error) return fail(response.error);
    const jump = jumpTarget(jumpValue(form, index));
    if (!jump) return fail("jump_unsupported");
    if (jump.target === "page" && !known.has(jump.page_id)) return fail("jump_target_unknown");
    const score = controlsNamed(form, `score[${index}]`).length ? oneFormValue(formData, `score[${index}]`, 16) : null;
    if (score !== null && !SCORE.test(score.trim())) return fail("invalid");
    answers.push({
      index,
      answer_text: answer.text,
      answer_format: answer.format,
      response_text: response.text,
      response_format: response.format,
      score: score === null ? null : score.trim(),
      jump,
    });
  }
  if (!answers.length) return fail("answers_missing");
  if (!sameContext() || Date.now() > input.expiresAt) return fail("context_changed");
  const data = {
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    lesson_id: Number(instance.instance),
    page_id: Number(requestedPageId),
    position,
    page_count: order.ordered.length,
    title,
    page_type: pageType,
    page_type_id: typeId,
    page_kind: PAGE_KINDS[pageType],
    contents_text: contents.value,
    contents_format: contentsFormat,
    answer_count: answers.length,
    answers,
    proof: {
      list_source: "mod_lesson_edit_page",
      page_source: "mod_lesson_editpage_form",
      exact_module_binding: "course_modedit_form",
      required_capability: "mod/lesson:manage",
      page_form_capability: "mod/lesson:edit",
      jump_source: "editpage_form_stored_answers",
      learner_progress: "not_recorded",
      file_bearing_text: "refused",
      view_route: "never_opened",
      page_limit: MAX_PAGES,
      answer_limit: MAX_ANSWERS,
    },
  };
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
