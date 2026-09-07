/**
 * Authors the pages of one approved Moodle Lesson: add a page, rewrite one,
 * move one to an exact place in the page order, or delete one.
 *
 * A Lesson is a directed graph, so a change to one page can change where other
 * pages send a learner. These four operations therefore never act on one page
 * in isolation. Each of them reads the complete page graph first, in exactly
 * the projection `moodle_list_lesson_pages` returns, requires the digest of the
 * graph the person reviewed, states every page whose jump destination the
 * change moves, sends one POST, then reads the complete graph again and
 * requires exactly the approved graph back.
 *
 * The native routes are the two the Lesson editing screen itself uses, and no
 * others.
 *
 * 1. `/mod/lesson/editpage.php` renders and saves one page's own editing form.
 *    A create sends `pageid=<page to insert after>` with `qtype`, an update
 *    sends `pageid=<page>` with `edit=1`, and the POST is the native form's own
 *    controls with only the approved fields changed.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/editpage.php
 * 2. `/mod/lesson/lesson.php` performs the move and the deletion, with the
 *    actions `moveit` and `delete`. Moodle renders the move as a link and the
 *    deletion as a POST confirmation button; `required_param` reads POST before
 *    GET and `require_sesskey` accepts the key from either, so Morrow sends the
 *    same parameters the native controls carry as one POST and never as a
 *    state-changing address.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/lesson.php
 *
 * `/mod/lesson/view.php` is never opened. That route starts or continues a
 * Lesson attempt and records learner progress; these routes record none.
 *
 * Required capability: `mod/lesson:edit` at the module context, which Moodle
 * requires for both routes, and `mod/lesson:manage`, which it requires to open
 * the page list these operations read.
 *
 * Seven facts shape these operations, and each one is stated in the catalog
 * text and in the result.
 *
 * 1. Morrow authors a Content page (`branchtable`) and the three simple
 *    question pages: True/false, Short answer and Multichoice. Every other page
 *    type stays readable and untouched. A Lesson that holds a page type Morrow
 *    cannot read is refused with no request sent.
 * 2. Moodle inserts a new page immediately after the page named as
 *    `after_page_id`, and `0` means the start of the Lesson.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/locallib.php
 * 3. An update rewrites the whole page: its title, its contents and its
 *    complete answer list. Moodle deletes a stored answer whose text is
 *    cleared, so the saved answers are exactly the approved ones.
 * 4. A stored jump is a page ID or one of Moodle's named targets. Morrow
 *    resolves `this page`, `next page`, `previous page` and `end of lesson`
 *    against the stored page order, so it can state exactly where each jump
 *    lands before and after the change. It cannot resolve `unseen page in
 *    branch`, `random page in branch`, `random branch` or `cluster jump`,
 *    because Moodle chooses those from the learner's own progress. A Lesson
 *    holding one of them is refused with no request sent.
 * 5. Every page whose jump destination the change moves must be named in
 *    `expected_jump_changes`, and Morrow refuses unless the named set is
 *    exactly the set it computed from the graph it just read.
 * 6. Deleting a page does not repair a jump that pointed at it. Moodle repairs
 *    only the page chain, so every stored jump to the deleted page is left
 *    pointing at a page that no longer exists. `moodle_delete_lesson_page`
 *    names every one of those pages and refuses unless
 *    `expected_invalid_jumps` states exactly the same set.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/locallib.php
 * 7. While a Lesson holds a jump to a page that no longer exists,
 *    `moodle_list_lesson_pages` refuses to read it. The result of the deletion
 *    that left it carries the graph and its digest, so the repair that
 *    retargets those jumps can be approved from that result.
 *
 * A page whose contents, answer or response text carries a draft-file
 * reference or embedded media is not authored: the create and the update refuse
 * it, before and after the write, exactly as the Lesson page reader does,
 * because Morrow rewrites that text and cannot carry a file with it.
 *
 * A lost response, a saved graph that is not the approved one, and a saved page
 * whose text is not the approved text are all `applied_or_unknown`. Nothing is
 * ever sent twice.
 *
 * No signed-in Moodle site has run any of these four operations.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleLessonPageWriteInPage(rawInput) {
  const PROVIDER = "moodle";
  const SCHEMA = "morrow.moodle-lesson-page-list.v1";
  const LIST_PATH = "/mod/lesson/edit.php";
  const PAGE_PATH = "/mod/lesson/editpage.php";
  const ACTION_PATH = "/mod/lesson/lesson.php";
  const MODULE_PATH = "/course/modedit.php";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 100;
  const MAX_ANSWERS = 40;
  const MAX_TITLE = 255;
  const MAX_RICH_TEXT = 40_000;
  const MAX_SCORE = 1_000;
  // mod/lesson/pagetypes/*.php, Moodle v5.2.2.
  const PAGE_TYPES = { 1: "shortanswer", 2: "truefalse", 3: "multichoice", 5: "matching", 8: "numerical", 10: "essay", 20: "branchtable", 21: "endofbranch", 30: "cluster", 31: "endofcluster" };
  const PAGE_KINDS = { shortanswer: "question", truefalse: "question", multichoice: "question", matching: "question", numerical: "question", essay: "question", branchtable: "content", endofbranch: "structure", cluster: "structure", endofcluster: "structure" };
  // mod/lesson/locallib.php, Moodle v5.2.2. A positive jumpto value is a page ID.
  const JUMP_NAMES = { 0: "this_page", "-1": "next_page", "-9": "end_of_lesson", "-40": "previous_page", "-50": "unseen_branch_page", "-60": "random_page", "-70": "random_branch", "-80": "cluster_jump" };
  const JUMP_VALUES = { this_page: "0", next_page: "-1", end_of_lesson: "-9", previous_page: "-40" };
  // The four targets Moodle chooses from a learner's own progress. Morrow
  // cannot state where they land, so it never authors a Lesson holding one.
  const DYNAMIC_JUMPS = new Set(["unseen_branch_page", "random_page", "random_branch", "cluster_jump"]);
  // The page types Morrow authors, named as an instructor reads them, with the
  // qtype value Moodle's own add-page control sends.
  const AUTHORED_TYPES = { content: 20, truefalse: 2, shortanswer: 1, multichoice: 3 };
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const FORMAT = /^[0-9]{1,3}$/;
  const definitions = Object.freeze({
    "moodle.form.lesson.page.create.v1": { toolName: "moodle_create_lesson_page", readOnly: false, kind: "create" },
    "moodle.form.lesson.page.update.v1": { toolName: "moodle_update_lesson_page", readOnly: false, kind: "update" },
    "moodle.form.lesson.page.move.v1": { toolName: "moodle_move_lesson_page", readOnly: false, kind: "move" },
    "moodle.form.lesson.page.delete.v1": { toolName: "moodle_delete_lesson_page", readOnly: false, kind: "delete" },
  });
  // What Moodle removes with one Lesson page.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/mod/lesson/locallib.php
  const PAGE_REMOVALS = Object.freeze([
    "The page, its title and its contents, with every file stored in those contents",
    "Every answer and response of the page, with their files, and every jump those answers carried",
    "Every learner attempt at this page, and the branch record of every learner who passed through it",
    "Its place in the page order. Moodle joins the page before it to the page after it",
  ]);

  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status, extra = {}) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    ...extra,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const id = (value) => {
    const text_ = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text_) ? text_ : "";
  };
  const text = (value, maximum = 1_024) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
  const plain = (value, maximum) => (typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);
  // Rich text keeps the tab, line feed and carriage return an editor stores.
  const richText = (value, maximum) => typeof value === "string" && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const collapsed = (value, maximum = MAX_TITLE) => {
    const result = String(value ?? "").replace(/\s+/g, " ").trim();
    return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/.test(result) ? result : "";
  };
  // Rich text that carries a file cannot be rewritten without losing the file.
  // connector/extension/src/moodle-lesson-read.js hasEmbeddedFile.
  const hasEmbeddedFile = (value) => /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i.test(String(value));
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_lesson_page_write_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !text(cfg.sesskey)) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let site;
    try { site = new URL(cfg.wwwroot); } catch { return null; }
    if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password) return null;
    const basePath = site.pathname.replace(/\/$/, "");
    const currentPath = String(globalThis.location?.pathname || "");
    if (site.origin !== String(globalThis.location?.origin || "") || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const configured = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (configured && bodyCourse && bodyCourse !== configured) return null;
    const anchorCourseId = configured || bodyCourse;
    if (!anchorCourseId) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId, sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const boundContext = (context) => Boolean(context) && object(input?.binding) && input.binding.origin === context.origin
    && input.binding.siteUrl === context.siteUrl && id(input.binding.principalId) === context.principalId
    && id(input.binding.courseId) === context.anchorCourseId;
  const live = () => Number.isSafeInteger(input?.expiresAt) && Date.now() < input.expiresAt;
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sameRoute = (value, expected) => {
    let received;
    try { received = new URL(value); } catch { return false; }
    return received.origin === expected.origin && received.pathname === expected.pathname && received.search === expected.search
      && !received.hash && !received.username && !received.password;
  };
  const boundedText = async (response, endpoint, context, exactRoute = true) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
    if (!response?.ok || (exactRoute && !sameRoute(response.url, endpoint)) || !sameContext(context, currentContext())
      || !response.body || typeof response.body.getReader !== "function" || typeof globalThis.TextDecoder !== "function") return null;
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
  const nativeDocument = async (context, path, query) => {
    if (!live() || !sameContext(context, currentContext())) return { error: "moodle_execution_expired" };
    const endpoint = urlFor(context, path, query);
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_lesson_page_write_source_unavailable" }; }
    const html = await boundedText(response, endpoint, context);
    if (html === "limit") return { error: "moodle_lesson_page_write_source_too_large", status: response.status };
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return { error: "moodle_lesson_page_write_source_unavailable", status: response.status };
    try { return { document: new DOMParser().parseFromString(html, "text/html"), endpoint, status: response.status }; }
    catch { return { error: "moodle_lesson_page_write_source_unavailable", status: response.status }; }
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
  const jumpTarget = (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(raw)) return null;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) return null;
    if (numeric > 0) return { target: "page", page_id: numeric };
    const named = JUMP_NAMES[String(numeric)];
    return named ? { target: named } : null;
  };
  const jumpControl = (form, index) => {
    const controls = controlsNamed(form, `jumpto[${index}]`);
    return controls.length === 1 ? controls[0] : null;
  };
  const jumpValue = (form, index) => {
    const control = jumpControl(form, index);
    if (!control) return null;
    if (control.tagName === "SELECT") {
      const selected = [...control.querySelectorAll("option[selected]")];
      return selected.length === 1 ? selected[0].getAttribute("value") : null;
    }
    return control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "hidden"
      ? control.getAttribute("value") : null;
  };
  const jumpSlots = (form, formData) => [...new Set([...formData.keys()].map((key) => key.match(/^jumpto\[([0-9]{1,3})\]$/)?.[1]).filter(Boolean))]
    .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
  /**
   * The jumps of the slots a page form renders with no answer control, such as
   * the Short answer page's all-other-answers jump. Morrow never changes them;
   * it plans them exactly as the form renders them.
   */
  const extraJumpsOf = (form) => {
    let formData;
    try { formData = new FormData(form); } catch { return { error: "moodle_lesson_page_write_page_unavailable" }; }
    const slots = jumpSlots(form, formData);
    if (!slots.length) return { error: "moodle_lesson_page_write_page_jump_missing" };
    if (slots.length > MAX_ANSWERS) return { error: "moodle_lesson_page_write_page_too_large" };
    const extra = [];
    for (const index of slots) {
      const control = answerControl(form, index);
      if (!control) return { error: "moodle_lesson_page_write_page_invalid" };
      if (control.control !== "none") continue;
      const jump = jumpTarget(jumpValue(form, index));
      if (!jump) return { error: "moodle_lesson_page_write_page_jump_unsupported" };
      if (DYNAMIC_JUMPS.has(jump.target)) return { error: "moodle_lesson_page_write_dynamic_jump_refused" };
      extra.push({ index, ...jump });
    }
    return { extra };
  };
  const answerControl = (form, index) => {
    const editor = controlsNamed(form, `answer_editor[${index}][text]`);
    const single = controlsNamed(form, `answer_editor[${index}]`);
    if (editor.length === 1 && !single.length) return { control: "editor", field: `answer_editor[${index}][text]`, format: `answer_editor[${index}][format]` };
    if (single.length === 1 && !editor.length) return { control: "text", field: `answer_editor[${index}]`, format: null };
    if (!editor.length && !single.length) return { control: "none", field: null, format: null };
    return null;
  };

  /**
   * One Lesson page's editing form, with everything the graph projection and
   * the saved-text comparison need. This is the only place a page is read.
   */
  const pageForm = async (context, moduleId, pageId) => {
    const page = await nativeDocument(context, PAGE_PATH, { id: moduleId, pageid: pageId, edit: "1" });
    if (page.error) return { error: page.error, status: page.status };
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
    if (forms.length !== 1) return { error: "moodle_lesson_page_write_page_unavailable", status: page.status };
    const parsed = readForm(forms[0], pageId, page.status);
    return parsed.error ? parsed : { ...parsed, form: forms[0], endpoint: page.endpoint, status: page.status };
  };

  /**
   * The graph projection of one page form, and its saved text beside it. The
   * projection is field for field the one moodle_list_lesson_pages returns, so
   * the digest a person reviewed is the digest compared here.
   */
  const readForm = (form, pageId, status) => {
    let formData;
    try { formData = new FormData(form); } catch { return { error: "moodle_lesson_page_write_page_unavailable", status }; }
    const typeId = Number(oneFormValue(formData, "qtype", 8));
    const pageType = Number.isSafeInteger(typeId) ? PAGE_TYPES[typeId] : undefined;
    if (!pageType) return { error: "moodle_lesson_page_write_page_type_unsupported", status };
    const title = plain(oneFormValue(formData, "title", MAX_TITLE), MAX_TITLE);
    if (!title) return { error: "moodle_lesson_page_write_page_invalid", status };
    const contents = oneFormValue(formData, "contents_editor[text]", MAX_RICH_TEXT);
    const contentsFormat = oneFormValue(formData, "contents_editor[format]", 8);
    if (contents === null || contentsFormat === null || !FORMAT.test(contentsFormat)) return { error: "moodle_lesson_page_write_page_invalid", status };
    const indexes = [...new Set([...formData.keys()].map((key) => key.match(/^jumpto\[([0-9]{1,3})\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!indexes.length) return { error: "moodle_lesson_page_write_page_jump_missing", status };
    if (indexes.length > MAX_ANSWERS) return { error: "moodle_lesson_page_write_page_too_large", status };
    const jumps = [];
    const answers = [];
    for (const index of indexes) {
      const control = answerControl(form, index);
      if (!control) return { error: "moodle_lesson_page_write_page_invalid", status };
      const value = control.control === "none" ? null : oneFormValue(formData, control.field, MAX_RICH_TEXT);
      if (control.control !== "none" && value === null) return { error: "moodle_lesson_page_write_page_invalid", status };
      if (control.control !== "none" && !value.trim()) continue;
      const jump = jumpTarget(jumpValue(form, index));
      if (!jump) return { error: "moodle_lesson_page_write_page_jump_unsupported", status };
      if (DYNAMIC_JUMPS.has(jump.target)) return { error: "moodle_lesson_page_write_dynamic_jump_refused", status };
      jumps.push({ index, ...jump });
      const responseText = controlsNamed(form, `response_editor[${index}][text]`).length
        ? oneFormValue(formData, `response_editor[${index}][text]`, MAX_RICH_TEXT) : null;
      const score = controlsNamed(form, `score[${index}]`).length ? oneFormValue(formData, `score[${index}]`, 16) : null;
      answers.push({ index, answer_text: value, response_text: responseText, score: score === null ? null : score.trim(), jump });
    }
    if (!jumps.length) return { error: "moodle_lesson_page_write_page_answers_missing", status };
    const targets = jumps.filter((jump) => jump.target === "page").map((jump) => jump.page_id);
    return {
      page: {
        page_id: Number(pageId), title, page_type: pageType, page_type_id: typeId, page_kind: PAGE_KINDS[pageType],
        jumps, branch_target_page_ids: [...new Set(targets)].sort((left, right) => left - right),
      },
      detail: { contents_text: contents, contents_format: contentsFormat, answers },
    };
  };

  const lessonBinding = async (context, moduleId) => {
    const page = await nativeDocument(context, MODULE_PATH, { update: moduleId, return: "0" });
    if (page.error) return { error: page.error, status: page.status };
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || page.endpoint.href, page.endpoint);
        const exactAction = action.origin === page.endpoint.origin && action.pathname === page.endpoint.pathname && !action.hash
          && !action.username && !action.password && (action.search === "" || action.search === page.endpoint.search);
        return exactAction && hidden(form, "course") === context.anchorCourseId && hidden(form, "coursemodule") === moduleId
          && hidden(form, "update") === moduleId && hidden(form, "modulename") === "lesson" && Boolean(id(hidden(form, "instance")));
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_lesson_page_write_target_unavailable", status: page.status };
    const name = [...forms[0].querySelectorAll('input[name="name"]')];
    return {
      instance: id(hidden(forms[0], "instance")),
      name: name.length === 1 ? collapsed(name[0].getAttribute("value"), 1_333) : "",
      status: page.status,
    };
  };

  /**
   * The stored page order, and the native action controls Moodle renders for
   * each page. A move or a deletion is bound to the control for that exact
   * page, so a page Moodle does not offer the action for is never acted on.
   */
  const pageOrder = async (context, moduleId) => {
    const page = await nativeDocument(context, LIST_PATH, { id: moduleId });
    if (page.error) return { error: page.error, status: page.status };
    const actions = { edit: new Set(), move: new Set(), delete: new Set() };
    for (const anchor of page.document.querySelectorAll("a[href]")) {
      let href;
      try { href = new URL(anchor.getAttribute("href"), page.endpoint); } catch { continue; }
      if (href.origin !== context.origin || href.searchParams.get("id") !== moduleId) continue;
      const target = id(href.searchParams.get("pageid"));
      if (!target) continue;
      if (href.pathname === `${context.basePath}${PAGE_PATH}` && href.searchParams.get("edit") === "1") actions.edit.add(target);
      if (href.pathname !== `${context.basePath}${ACTION_PATH}`) continue;
      if (href.searchParams.get("action") === "move") actions.move.add(target);
      if (href.searchParams.get("action") === "confirmdelete") actions.delete.add(target);
    }
    if (!actions.edit.size) return { error: "moodle_lesson_page_write_list_unavailable", status: page.status };
    const ordered = [];
    for (const element of page.document.querySelectorAll('a[id^="lesson-"]')) {
      const pageId = id(String(element.getAttribute("id") || "").slice("lesson-".length));
      if (!pageId || ordered.includes(pageId)) return { error: "moodle_lesson_page_write_list_invalid", status: page.status };
      ordered.push(pageId);
      if (ordered.length > MAX_PAGES) return { error: "moodle_lesson_page_write_lesson_too_large", status: page.status };
    }
    if (!ordered.length) return { error: "moodle_lesson_page_write_list_invalid", status: page.status };
    return { ordered, actions, status: page.status };
  };

  /**
   * The complete page graph, in the projection and digest of
   * moodle_list_lesson_pages, with each page's saved text kept beside it for
   * the comparison a create or an update needs.
   */
  const readGraph = async (context, moduleId, instance) => {
    const order = await pageOrder(context, moduleId);
    if (order.error) return order;
    const pages = [];
    const details = new Map();
    for (const pageId of order.ordered) {
      const read = await pageForm(context, moduleId, pageId);
      if (read.error) return { error: read.error, status: read.status };
      pages.push({ ...read.page, position: pages.length + 1 });
      details.set(pageId, read.detail);
    }
    const data = {
      schema: SCHEMA,
      provider: PROVIDER,
      course_id: Number(context.anchorCourseId),
      module_id: Number(moduleId),
      lesson_id: Number(instance),
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
    return { ordered: order.ordered, actions: order.actions, data, details, status: order.status, snapshotDigest: await digest(data) };
  };

  /**
   * Where one jump lands, read from a page order Morrow has seen. A jump to a
   * page the Lesson no longer holds is `invalid`, which is the state a deletion
   * can leave behind and which is reported on its own.
   */
  const destination = (pages, order, page, jump) => {
    const index = order.indexOf(String(page.page_id));
    if (jump.target === "page") return pages.has(String(jump.page_id)) ? `page:${jump.page_id}` : "invalid";
    if (jump.target === "this_page") return `page:${page.page_id}`;
    if (jump.target === "next_page") return index + 1 < order.length ? `page:${order[index + 1]}` : "end_of_lesson";
    if (jump.target === "previous_page") return index > 0 ? `page:${order[index - 1]}` : "no_previous_page";
    return "end_of_lesson";
  };
  const graphOf = (pages) => ({ order: pages.map((page) => String(page.page_id)), byId: new Map(pages.map((page) => [String(page.page_id), page])) });

  /**
   * Every page that keeps its own stored jumps but whose learner now arrives
   * somewhere else. A jump that points at the page being deleted is left out
   * here and reported as an invalid jump instead.
   */
  const jumpChanges = (before, after, deletedId) => {
    const source = graphOf(before);
    const result = graphOf(after);
    const changed = [];
    for (const [pageId, page] of source.byId) {
      const saved = result.byId.get(pageId);
      if (!saved) continue;
      const moved = page.jumps.some((jump, position) => {
        if (deletedId && jump.target === "page" && String(jump.page_id) === deletedId) return false;
        const next = saved.jumps[position];
        if (!next || next.index !== jump.index) return true;
        return destination(source.byId, source.order, page, jump) !== destination(result.byId, result.order, saved, next);
      });
      if (moved || page.jumps.length !== saved.jumps.length) changed.push(page);
    }
    return changed;
  };
  const invalidJumps = (pages, deletedId) => pages
    .filter((page) => String(page.page_id) !== deletedId && page.jumps.some((jump) => jump.target === "page" && String(jump.page_id) === deletedId));
  const pageIds = (pages) => [...new Set(pages.map((page) => Number(page.page_id)))].sort((left, right) => left - right);
  const sameIds = (left, right) => stable(left) === stable(right);
  const named = (pages) => pages.map((page) => ({ page_id: Number(page.page_id), title: page.title }));

  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const requestedJump = (value) => {
    if (!object(value) || typeof value.target !== "string") return null;
    if (value.target === "page") {
      if (!exactKeys(value, ["target", "page_id"]) || !id(value.page_id)) return null;
      return { target: "page", page_id: Number(value.page_id) };
    }
    if (!exactKeys(value, ["target"]) || !Object.hasOwn(JUMP_VALUES, value.target)) return null;
    return { target: value.target };
  };
  const requestedAnswers = (value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ANSWERS) return null;
    const answers = [];
    for (const entry of value) {
      if (!exactKeys(entry, ["answer", "response", "score", "jump"])) return null;
      if (!richText(entry.answer, MAX_RICH_TEXT) || !entry.answer.trim()) return null;
      const answer = entry.answer;
      if (entry.response !== null && !richText(entry.response, MAX_RICH_TEXT)) return null;
      if (entry.score !== null && !(Number.isSafeInteger(entry.score) && Math.abs(entry.score) <= MAX_SCORE)) return null;
      const jump = requestedJump(entry.jump);
      if (!jump) return null;
      answers.push({ answer, response: entry.response, score: entry.score, jump });
    }
    return answers;
  };
  const requestedIds = (value) => {
    if (!Array.isArray(value) || value.length > MAX_PAGES) return null;
    const ids = value.map((entry) => id(entry));
    if (ids.some((entry) => !entry) || new Set(ids).size !== ids.length) return null;
    return ids.map(Number).sort((left, right) => left - right);
  };
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId) return null;
    const fields = definition.kind === "create"
      ? ["course_id", "module_id", "after_page_id", "page_type", "title", "contents", "answers", "expected_jump_changes", "expected_digest"]
      : definition.kind === "update"
        ? ["course_id", "module_id", "page_id", "title", "contents", "answers", "expected_jump_changes", "expected_digest"]
        : definition.kind === "move"
          ? ["course_id", "module_id", "page_id", "after_page_id", "expected_jump_changes", "expected_digest"]
          : ["course_id", "module_id", "page_id", "expected_jump_changes", "expected_invalid_jumps", "expected_digest"];
    if (!exactKeys(args, fields) || id(args.course_id) !== courseId || !id(args.module_id)
      || !DIGEST.test(String(args.expected_digest || ""))) return null;
    const jumpChangeIds = requestedIds(args.expected_jump_changes);
    if (!jumpChangeIds) return null;
    const base = { courseId, moduleId: id(args.module_id), expectedDigest: args.expected_digest, jumpChangeIds };
    if (definition.kind !== "create" && !id(args.page_id)) return null;
    if (definition.kind === "delete") {
      const invalid = requestedIds(args.expected_invalid_jumps);
      return invalid ? { ...base, pageId: id(args.page_id), invalidIds: invalid } : null;
    }
    if (definition.kind === "move") {
      const after = Number.isSafeInteger(args.after_page_id) && args.after_page_id >= 0 ? String(args.after_page_id) : "";
      if (!after || (after !== "0" && !id(after))) return null;
      return { ...base, pageId: id(args.page_id), afterPageId: after };
    }
    // Moodle stores a page title as plain text, so a title carrying markup
    // would be saved as something other than the approved words.
    const title = collapsed(args.title, MAX_TITLE);
    const answers = requestedAnswers(args.answers);
    if (!title || title.includes("<") || !richText(args.contents, MAX_RICH_TEXT) || !args.contents.trim() || !answers) return null;
    const contents = args.contents;
    if (definition.kind === "update") return { ...base, pageId: id(args.page_id), title, contents, answers };
    if (!Object.hasOwn(AUTHORED_TYPES, String(args.page_type || ""))) return null;
    const after = Number.isSafeInteger(args.after_page_id) && args.after_page_id >= 0 ? String(args.after_page_id) : "";
    if (!after || (after !== "0" && !id(after))) return null;
    return { ...base, afterPageId: after, pageType: String(args.page_type), title, contents, answers };
  };

  /**
   * The graph the change must produce, bound to the graph just read. A created
   * page carries a placeholder ID, because Moodle assigns it; every other field
   * of every page is planned before anything is sent.
   */
  const plan = (definition, graph, args, extraJumps, typeId) => {
    const pages = graph.data.pages;
    const order = graph.ordered;
    const positioned = (list) => list.map((page, index) => ({ ...page, position: index + 1 }));
    const page = args.pageId ? pages.find((entry) => String(entry.page_id) === args.pageId) : null;
    if (args.pageId && !page) return { error: "moodle_lesson_page_write_page_not_in_lesson" };
    if (definition.kind === "create" || definition.kind === "update") {
      if (hasEmbeddedFile(args.contents) || args.answers.some((answer) => hasEmbeddedFile(answer.answer) || (answer.response !== null && hasEmbeddedFile(answer.response)))) {
        return { error: "moodle_lesson_page_write_file_reference_unsupported" };
      }
      if (typeId === AUTHORED_TYPES.truefalse && args.answers.length !== 2) return { error: "moodle_lesson_page_write_answer_count_invalid" };
      // Moodle renders a jump for a slot that has no answer control of its own,
      // such as the Short answer page's all-other-answers jump. Morrow leaves
      // that slot exactly as the form renders it, and plans it as part of the
      // page so the readback compares the whole page.
      const jumps = [...args.answers.map((answer, index) => ({ index, ...answer.jump })), ...extraJumps]
        .sort((left, right) => left.index - right.index);
      const known = new Set(order.map(Number));
      if (jumps.some((jump) => jump.target === "page" && !known.has(jump.page_id))) return { error: "moodle_lesson_page_write_jump_target_unknown" };
      const targets = jumps.filter((jump) => jump.target === "page").map((jump) => jump.page_id);
      const written = {
        page_id: definition.kind === "create" ? 0 : page.page_id,
        position: 0,
        title: args.title,
        page_type: PAGE_TYPES[typeId],
        page_type_id: typeId,
        page_kind: PAGE_KINDS[PAGE_TYPES[typeId]],
        jumps,
        branch_target_page_ids: [...new Set(targets)].sort((left, right) => left - right),
      };
      if (definition.kind === "update") {
        const expected = positioned(pages.map((entry) => (String(entry.page_id) === args.pageId ? written : entry)));
        return { expected, written, excludeId: args.pageId, deletedId: "" };
      }
      if (args.afterPageId !== "0" && !order.includes(args.afterPageId)) return { error: "moodle_lesson_page_write_after_page_not_in_lesson" };
      if (order.length >= MAX_PAGES) return { error: "moodle_lesson_page_write_lesson_too_large" };
      const at = args.afterPageId === "0" ? 0 : order.indexOf(args.afterPageId) + 1;
      const expected = positioned([...pages.slice(0, at), written, ...pages.slice(at)]);
      return { expected, written, excludeId: "", deletedId: "", insertAt: at };
    }
    if (definition.kind === "move") {
      if (!graph.actions.move.has(args.pageId)) return { error: "moodle_lesson_page_write_move_control_missing" };
      if (args.afterPageId === args.pageId) return { error: "moodle_lesson_page_write_position_invalid" };
      if (args.afterPageId !== "0" && !order.includes(args.afterPageId)) return { error: "moodle_lesson_page_write_after_page_not_in_lesson" };
      const remaining = pages.filter((entry) => String(entry.page_id) !== args.pageId);
      const at = args.afterPageId === "0" ? 0 : remaining.findIndex((entry) => String(entry.page_id) === args.afterPageId) + 1;
      const expected = positioned([...remaining.slice(0, at), page, ...remaining.slice(at)]);
      if (stable(expected.map((entry) => entry.page_id)) === stable(pages.map((entry) => entry.page_id))) {
        return { error: "moodle_lesson_page_write_position_unchanged" };
      }
      return { expected, written: page, excludeId: "", deletedId: "" };
    }
    if (!graph.actions.delete.has(args.pageId)) return { error: "moodle_lesson_page_write_delete_control_missing" };
    if (pages.length === 1) return { error: "moodle_lesson_page_write_last_page_refused" };
    const expected = positioned(pages.filter((entry) => String(entry.page_id) !== args.pageId));
    return { expected, written: page, excludeId: "", deletedId: args.pageId };
  };

  /**
   * The complete graph the write must produce, and, for a create or an update,
   * the saved title, contents and answers of the page it wrote.
   */
  const verify = (definition, planned, before, after, args) => {
    if (definition.kind === "create") {
      const added = after.ordered.filter((pageId) => !before.ordered.includes(pageId));
      if (added.length !== 1) return null;
      const createdId = added[0];
      if (after.ordered[planned.insertAt] !== createdId) return null;
      const expected = planned.expected.map((entry) => (entry.page_id === 0 ? { ...entry, page_id: Number(createdId) } : entry));
      if (stable(expected) !== stable(after.data.pages)) return null;
      return savedText(planned, after.details.get(createdId), args) ? { pageId: createdId } : null;
    }
    if (stable(planned.expected) !== stable(after.data.pages)) return null;
    if (definition.kind !== "update") return { pageId: args.pageId || "" };
    return savedText(planned, after.details.get(args.pageId), args) ? { pageId: args.pageId } : null;
  };

  /**
   * The page Moodle saved must hold exactly the approved text: the contents,
   * and for every approved answer its text, its response and its score.
   */
  const savedText = (planned, detail, args) => {
    if (!detail || detail.contents_text !== args.contents || hasEmbeddedFile(detail.contents_text)) return false;
    // The slots this change wrote. A slot the page form renders with no answer
    // control of its own carries no text to compare, and its jump is already
    // compared with the rest of the graph.
    const written = detail.answers.filter((saved) => saved.index < args.answers.length);
    if (written.length !== args.answers.length) return false;
    if (detail.answers.some((saved) => saved.index >= args.answers.length && saved.answer_text !== null)) return false;
    return args.answers.every((answer, index) => {
      const saved = written[index];
      if (!saved || saved.index !== index || saved.answer_text !== answer.answer) return false;
      if (hasEmbeddedFile(saved.answer_text) || (saved.response_text !== null && hasEmbeddedFile(saved.response_text))) return false;
      if (answer.response !== null && saved.response_text !== answer.response) return false;
      return answer.score === null || saved.score === String(answer.score);
    });
  };

  const dispatched = { sent: false };
  /**
   * The one POST of a create or an update: the native page form's own controls,
   * with only the approved fields changed.
   */
  const postPageForm = async (context, read, args) => {
    const form = read.form;
    const submits = [...form.querySelectorAll('input[type="submit"]')].filter((control) => control.getAttribute("name") === "submitbutton" && typeof control.value === "string" && control.value);
    if (submits.length !== 1) return { error: "moodle_lesson_page_write_form_control_missing", status: read.status };
    const params = new URLSearchParams();
    let formData;
    try { formData = new FormData(form); } catch { return { error: "moodle_lesson_page_write_page_unavailable", status: read.status }; }
    for (const [name, value] of formData.entries()) {
      if (typeof File !== "undefined" && value instanceof File) {
        if (value.size > 0) return { error: "moodle_lesson_page_write_file_control_refused", status: read.status };
        continue;
      }
      if (typeof value !== "string") return { error: "moodle_lesson_page_write_page_unavailable", status: read.status };
      params.append(name, value);
    }
    const slots = jumpSlots(form, formData).filter((index) => answerControl(form, index)?.control !== "none");
    if (args.answers.length > slots.length || slots.slice(0, args.answers.length).some((slot, index) => slot !== index)) {
      return { error: "moodle_lesson_page_write_answer_slots_missing", status: read.status };
    }
    params.set("title", args.title);
    params.set("contents_editor[text]", args.contents);
    for (const index of slots) {
      const control = answerControl(form, index);
      if (!control || control.control === "none") return { error: "moodle_lesson_page_write_page_unavailable", status: read.status };
      const answer = args.answers[index];
      if (!answer) {
        params.set(control.field, "");
        continue;
      }
      // A plain text answer control is PARAM_TEXT and one line, so Moodle
      // would store something other than the approved words for markup or a
      // line break. That is refused before anything is sent.
      if (control.control === "text" && /[<\r\n]/.test(answer.answer)) return { error: "moodle_lesson_page_write_answer_not_plain_text", status: read.status };
      params.set(control.field, answer.answer);
      const jump = jumpControl(form, index);
      const value = answer.jump.target === "page" ? String(answer.jump.page_id) : JUMP_VALUES[answer.jump.target];
      if (!jump || jump.tagName !== "SELECT"
        || ![...jump.querySelectorAll("option")].some((option) => option.getAttribute("value") === value)) {
        return { error: "moodle_lesson_page_write_jump_not_offered", status: read.status };
      }
      params.set(`jumpto[${index}]`, value);
      if (answer.response !== null) {
        if (!controlsNamed(form, `response_editor[${index}][text]`).length) return { error: "moodle_lesson_page_write_response_unsupported", status: read.status };
        params.set(`response_editor[${index}][text]`, answer.response);
      }
      if (answer.score !== null) {
        if (!controlsNamed(form, `score[${index}]`).length) return { error: "moodle_lesson_page_write_score_unsupported", status: read.status };
        params.set(`score[${index}]`, String(answer.score));
      }
    }
    params.delete("cancel");
    params.set(submits[0].getAttribute("name"), submits[0].value);
    let action;
    try { action = new URL(form.getAttribute("action") || read.endpoint.href, read.endpoint); } catch { return { error: "moodle_lesson_page_write_page_unavailable", status: read.status }; }
    return send(context, action, params);
  };

  /**
   * The one POST of a move or a deletion: the parameters Moodle's own control
   * for that exact page carries, sent to /mod/lesson/lesson.php.
   */
  const postPageAction = async (context, action, moduleId, pageId, after) => {
    const params = new URLSearchParams({ id: moduleId, action, pageid: pageId, sesskey: context.sesskey });
    if (action === "moveit") params.set("after", after);
    return send(context, urlFor(context, ACTION_PATH, {}), params);
  };

  const send = async (context, endpoint, params) => {
    if (!live() || !sameContext(context, currentContext())) return { error: "moodle_execution_expired" };
    let response;
    try {
      dispatched.sent = true;
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: params,
      });
    } catch { return { unconfirmed: "moodle_lesson_page_write_unconfirmed" }; }
    const body = await boundedText(response, endpoint, context, false);
    if (typeof body !== "string") return { unconfirmed: "moodle_lesson_page_write_unconfirmed", status: response.status };
    // Moodle redirects to the page list after it saves, and re-renders the form
    // when it refuses. The readback decides the outcome; this only separates a
    // refusal Morrow can prove from one it cannot.
    return { status: response.status, redirected: response.redirected === true };
  };

  const proofFor = (definition, planned, changed, invalid) => ({
    method: definition.kind === "create" || definition.kind === "update" ? "native_lesson_page_form" : "native_lesson_page_action",
    list_route: LIST_PATH,
    page_route: PAGE_PATH,
    write_route: definition.kind === "create" || definition.kind === "update" ? PAGE_PATH : ACTION_PATH,
    required_capability: "mod/lesson:edit",
    page_list_capability: "mod/lesson:manage",
    scope: "one_page_in_the_approved_lesson",
    view_route: "never_opened",
    learner_progress: "not_recorded",
    dispatch_count: 1,
    jump_target_changes: named(changed),
    ...(definition.kind === "delete"
      ? {
        reversible_by_morrow: false,
        removes: PAGE_REMOVALS,
        invalid_jump_targets: named(invalid),
        page_list_readback: invalid.length ? "blocked_by_invalid_jumps" : "available",
      }
      : {}),
  });

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!live()) return failure("moodle_execution_expired");
    const definition = object(input.operation) && typeof input.operation.key === "string" ? definitions[input.operation.key] : null;
    if (!definition || input.operation.provider !== PROVIDER || input.operation.toolName !== definition.toolName
      || input.operation.readOnly !== definition.readOnly) return failure("moodle_operation_refused");
    if (!boundContext(context)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_lesson_page_write_arguments_invalid");

    const target = await lessonBinding(context, args.moduleId);
    if (target.error) return failure(target.error, target.status);
    const before = await readGraph(context, args.moduleId, target.instance);
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);

    // The page form is bound before anything is planned, so the plan carries
    // the exact page type Moodle renders and every jump slot the form holds
    // that this change does not write.
    let read = null;
    let extraJumps = [];
    let typeId = 0;
    if (definition.kind === "create" || definition.kind === "update") {
      const reviewedPage = definition.kind === "update"
        ? before.data.pages.find((entry) => String(entry.page_id) === args.pageId) : null;
      if (definition.kind === "update") {
        if (!reviewedPage) return failure("moodle_lesson_page_write_page_not_in_lesson", before.status);
        typeId = reviewedPage.page_type_id;
      } else {
        typeId = AUTHORED_TYPES[args.pageType];
      }
      if (!Object.values(AUTHORED_TYPES).includes(typeId)) return failure("moodle_lesson_page_write_page_type_not_authored", before.status);
      if (definition.kind === "create") {
        const form = await nativeDocument(context, PAGE_PATH, { id: args.moduleId, pageid: args.afterPageId, qtype: String(typeId) });
        if (form.error) return failure(form.error, form.status);
        const forms = [...form.document.querySelectorAll("form")].filter((entry) => {
          if (String(entry.getAttribute("method") || "").toLowerCase() !== "post") return false;
          return hidden(entry, "id") === args.moduleId && hidden(entry, "pageid") === args.afterPageId
            && hidden(entry, "qtype") === String(typeId) && Boolean(text(hidden(entry, "sesskey")));
        });
        if (forms.length !== 1) return failure("moodle_lesson_page_write_add_form_unavailable", form.status);
        read = { form: forms[0], endpoint: form.endpoint, status: form.status };
      } else {
        const page = await pageForm(context, args.moduleId, args.pageId);
        if (page.error) return failure(page.error, page.status);
        if (page.page.page_type_id !== typeId) return failure("moodle_lesson_page_write_page_type_changed", page.status);
        // The page form must still hold the page the reviewed graph holds. Its
        // place in the Lesson comes from the page order, not from this form.
        const { position: _position, ...reviewed } = reviewedPage;
        if (stable(page.page) !== stable(reviewed)) return failure("moodle_expected_digest_mismatch", page.status);
        const current = before.details.get(args.pageId);
        if (hasEmbeddedFile(current.contents_text) || current.answers.some((answer) => hasEmbeddedFile(answer.answer_text)
          || (answer.response_text !== null && hasEmbeddedFile(answer.response_text)))) {
          return failure("moodle_lesson_page_write_file_reference_unsupported", page.status);
        }
        read = page;
      }
      const slots = extraJumpsOf(read.form);
      if (slots.error) return failure(slots.error, read.status);
      extraJumps = slots.extra;
    }
    const planned = plan(definition, before, args, extraJumps, typeId);
    if (planned.error) return failure(planned.error, before.status);

    // Every page whose learner now arrives somewhere else, and every page left
    // pointing at a page that will not exist, must be exactly the set the
    // person approved. Nothing is sent when they differ.
    const changed = jumpChanges(before.data.pages, planned.expected, planned.deletedId)
      .filter((page) => String(page.page_id) !== planned.excludeId);
    if (!sameIds(pageIds(changed), args.jumpChangeIds)) {
      return failure("moodle_lesson_page_write_jump_changes_not_approved", before.status);
    }
    const invalid = definition.kind === "delete" ? invalidJumps(before.data.pages, planned.deletedId) : [];
    if (definition.kind === "delete" && !sameIds(pageIds(invalid), args.invalidIds)) {
      return failure("moodle_lesson_page_write_invalid_jumps_not_approved", before.status);
    }

    // The page order is read once more immediately before the change, and the
    // change is bound to that reading.
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || !boundContext(rechecked)) return failure("moodle_binding_mismatch");
    const fresh = await pageOrder(rechecked, args.moduleId);
    if (fresh.error) return failure(fresh.error, fresh.status);
    if (stable(fresh.ordered) !== stable(before.ordered)) return failure("moodle_expected_digest_mismatch", fresh.status);

    let write;
    if (definition.kind === "create") {
      write = await postPageForm(rechecked, read, args);
    } else if (definition.kind === "update") {
      if (!fresh.actions.edit.has(args.pageId)) return failure("moodle_lesson_page_write_edit_control_missing", fresh.status);
      write = await postPageForm(rechecked, read, args);
    } else if (definition.kind === "move") {
      if (!fresh.actions.move.has(args.pageId)) return failure("moodle_lesson_page_write_move_control_missing", fresh.status);
      write = await postPageAction(rechecked, "moveit", args.moduleId, args.pageId, args.afterPageId);
    } else {
      if (!fresh.actions.delete.has(args.pageId)) return failure("moodle_lesson_page_write_delete_control_missing", fresh.status);
      write = await postPageAction(rechecked, "delete", args.moduleId, args.pageId, "");
    }
    if (write.error) return dispatched.sent ? unconfirmedWrite(write.error, write.status) : failure(write.error, write.status);
    if (write.unconfirmed) return unconfirmedWrite(write.unconfirmed, write.status);

    const after = await readGraph(rechecked, args.moduleId, target.instance);
    if (after.error) return unconfirmedWrite("moodle_lesson_page_write_readback_unconfirmed", write.status);
    const saved = verify(definition, planned, before, after, args);
    const page = saved ? after.data.pages.find((entry) => String(entry.page_id) === saved.pageId) : null;
    const result = {
      status: after.status,
      data: after.data,
      targets: [
        { field: "module_id", label: "Lesson", name: target.name || `Lesson ${args.moduleId}` },
        { field: "page_id", label: "Page", name: page?.title || planned.written.title },
        ...(definition.kind === "create" || definition.kind === "move"
          ? [{ field: "after_page_id", label: "After page", name: args.afterPageId === "0" ? "The start of the Lesson" : before.data.pages.find((entry) => String(entry.page_id) === args.afterPageId)?.title || `Page ${args.afterPageId}` }]
          : []),
      ],
      snapshot_digest: after.snapshotDigest,
      proof: proofFor(definition, planned, changed, invalid),
    };
    if (!saved) {
      // Nothing changed and Moodle did not redirect: it refused the form, and
      // that is a proved outcome rather than an uncertain one.
      if (!write.redirected && stable(after.data) === stable(before.data)) {
        return {
          ok: false, sent: true, status: after.status, outcomeUnknown: false, ...result,
          verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_lesson_page_write_not_saved" },
          error: "moodle_lesson_page_write_not_saved",
        };
      }
      return unconfirmedWrite("moodle_lesson_page_write_not_verified", write.status, result);
    }
    return {
      ok: true,
      sent: true,
      ...result,
      ...(definition.kind === "create" ? { page: { page_id: Number(saved.pageId), position: page.position, title: page.title, page_type: page.page_type } } : {}),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  } catch (error) {
    if (dispatched.sent) return unconfirmedWrite("moodle_lesson_page_write_unconfirmed");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_lesson_page_write_execution_failed");
  }
}
