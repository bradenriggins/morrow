/**
 * Phase two of the dedicated hidden Question bank isolation route: create one
 * new question in the fresh Qbank category, and separately add that one entry
 * to one approved Quiz.
 *
 * These are two more separate approved effects, each with its own review read,
 * its own single native dispatch and its own authoritative readback. They run
 * only after phase one (connector/extension/src/moodle-qbank-executor.js) has
 * created the hidden `mod_qbank` activity and realized its default category,
 * because both take that module, that category and that question context as
 * approved arguments.
 *
 * The general Question bank hold in connector/extension/src/moodle-executor.js
 * stays in force. `moodle_create_quiz_*_question` and
 * `moodle_update_quiz_*_question` still refuse before any native request, and
 * this file adds no update path: a saved entry is never edited, cloned or
 * moved here, and the native Quiz reference this route creates is
 * `version = NULL`, so every later edit to the new entry stays held.
 *
 * Effect 3 uses the bank's own native creation chain, starting from the
 * add-question control on the approved bank page.
 * `/question/edit.php?cat=<category>,<context>&cmid=<module>` is the address
 * `question_edit_url()` returns for that module, and its add-question control
 * is how `moodle/question:add` at the bank context is visible to a browser.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/editquestion/classes/plugin_feature.php#L57-L70
 * That control is a form to `/question/bank/editquestion/addquestion.php` that
 * carries the category, the module and the return address, and one question
 * type choice. Following it lands on the native question controller, which
 * requires `moodle/question:add` in the category context and saves one new
 * question.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/editquestion/question.php#L109-L185
 * https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/editquestion/question.php#L254-L304
 *
 * Effect 4 uses the native Quiz edit action
 * `/mod/quiz/edit.php?cmid=<quiz>&addquestion=<question>&sesskey=<key>`, which
 * requires `mod/quiz:manage` to open the page and `moodle/question:use` for the
 * question, and appends one slot with a direct reference to that entry.
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/edit.php#L98-L107
 * https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/locallib.php#L1742-L1895
 *
 * Four rules keep this route honest and are enforced in code, not in a comment.
 *
 * 1. Impact scope. Both effects re-derive the course's complete Question bank
 *    impact scope first, with the same rules and the same recognised filter set
 *    as `moodle_get_question_bank_impact_scope`, and refuse unless it is
 *    complete. A stored random filter with `jointype = NONE` compiles to a
 *    `NOT IN` category test that a fresh category can satisfy, so it has its
 *    own refusal.
 *    https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/managecategories/classes/category_condition.php#L145-L167
 * 2. New entry only. The creation form must be a creation form: no question id,
 *    no copy parameter, and a return address on the bank page with no
 *    `appendqnumstring`, which is what would make the native chain add a Quiz
 *    slot in the same request. The readback requires exactly one bank entry
 *    that the bank page did not list before the dispatch.
 * 3. Empty files and empty tags. The form must declare no file manager, no file
 *    picker and no file input; every draft area it carries must belong to a
 *    rich-text editor of this form whose text is empty, except the native
 *    text-only Multichoice combined-feedback defaults, which are preserved;
 *    no tag may be selected, and no approved text may carry a file reference
 *    or embedded media.
 * 4. Two effects, never one. Effect 3 refuses a return address that names a
 *    Quiz, and effect 4 takes an entry that already exists. Neither one can
 *    perform the other.
 *
 * No route here opens a Quiz view, attempt, review or report page, so none of
 * them records learner state, and no result carries a session key, a draft item
 * id or any learner identity.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleQbankQuestionInPage(rawInput) {
  const requestSignal = (expiresAt) => AbortSignal.timeout(Math.max(1, Math.min(2_147_483_647,
    Number.isSafeInteger(expiresAt) ? expiresAt - Date.now() : 30_000)));
  const PROVIDER = "moodle";
  const QUESTION_SCHEMA = "morrow.moodle-qbank-question.v1";
  const SLOT_SCHEMA = "morrow.moodle-qbank-quiz-slot.v1";
  const MODULE = "qbank";
  const QUIZ_MODULE = "quiz";
  const STATE_METHOD = "core_courseformat_get_state";
  const BANK_PAGE_PATH = "/question/edit.php";
  const ADD_QUESTION_PATH = "/question/bank/editquestion/addquestion.php";
  const QUESTION_PATH = "/question/bank/editquestion/question.php";
  const QUIZ_EDIT_PATH = "/mod/quiz/edit.php";
  const SUPPORTED_TYPES = ["multichoice", "shortanswer", "truefalse"];
  const READY_STATUS = "ready";
  // Only the core category condition is recognised, exactly as
  // moodle-question-impact-read.js recognises it. Any other stored filter key
  // keeps the scope incomplete, which refuses both effects.
  const RECOGNISED_FILTER_KEYS = ["category"];
  // question/classes/local/bank/condition.php: NONE excludes, ANY is OR, ALL is AND.
  const JOINTYPE_NAMES = { 0: "none", 1: "any", 2: "all" };
  const FILTER_CONDITION_FIELDS = ["filter", "jointype", "questionscontextid", "qpage", "qperpage"];
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 400;
  const MAX_FORM_BYTES = 256 * 1024;
  const MAX_VALUE_BYTES = 32 * 1024;
  const MAX_CATEGORY_OPTIONS = 500;
  const MAX_ACTIVITIES = 10_000;
  const MAX_QUIZZES = 50;
  const MAX_SLOTS_PER_QUIZ = 100;
  const MAX_FILTERS_PER_SLOT = 20;
  const MAX_FILTER_VALUES = 50;
  const MAX_BANK_ENTRIES = 200;
  const MAX_ANSWERS = 10;
  const MAX_NAME_LENGTH = 1_333;
  const MAX_TEXT_LENGTH = 8_192;
  const MAX_ANSWER_LENGTH = 255;
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const FRACTION = /^-?(?:0|1)(?:\.[0-9]{1,7})?$/;
  const FILTER_KEY = /^[a-z][a-z0-9_]{0,63}$/;
  const FILTER_VALUE = /^[A-Za-z0-9_,.:@-]{1,64}$/;
  const CATEGORY_FIELD = /^([1-9][0-9]{0,18}),([1-9][0-9]{0,18})$/;
  const TRANSIENT_FIELD = /(?:sesskey|statekey|csrf|token|secret|password|authorization|cookie)/i;
  const DRAFT_ITEM_FIELD = /^(.+)\[itemid\]$/;
  const ANSWER_TEXT_FIELD = /^answer\[([0-9]{1,2})\](?:\[text\])?$/;
  const answerField = (index, qtype) => qtype === "shortanswer" ? `answer[${index}]` : `answer[${index}][text]`;
  const COMBINED_FEEDBACK = ["correctfeedback", "partiallycorrectfeedback", "incorrectfeedback"];
  const CONTROL = /[\u0000-\u001f\u007f]/;
  // A question body may hold line breaks. Nothing else outside printable text.
  const BODY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
  const FILE_REFERENCE = /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i;
  const definitions = Object.freeze({
    "moodle.form.question.bank.editquestion.create.read.v1": { toolName: "moodle_get_qbank_question_creation_form", readOnly: true, kind: "question-form" },
    "moodle.form.question.bank.editquestion.create.write.v1": { toolName: "moodle_create_qbank_question", readOnly: false, kind: "question-create" },
    "moodle.form.mod.quiz.qbank_question.add.read.v1": { toolName: "moodle_get_qbank_quiz_slot_plan", readOnly: true, kind: "slot-plan" },
    "moodle.form.mod.quiz.qbank_question.add.write.v1": { toolName: "moodle_add_qbank_question_to_quiz", readOnly: false, kind: "slot-add" },
  });

  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmedWrite = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  // The dispatch landed and Morrow read what it produced, so the outcome is
  // known: the effect happened and Morrow refuses to carry the route further.
  const appliedButRefused = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: false,
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: error },
    error,
  });
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const validText = (value, maximum = MAX_NAME_LENGTH) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !CONTROL.test(value);
  const bodyText = (value, maximum, minimum = 0) => typeof value === "string" && value.length >= minimum && value.length <= maximum
    && value === value.trim() && !BODY_CONTROL.test(value) && !FILE_REFERENCE.test(value);
  const collapsed = (value, maximum = MAX_NAME_LENGTH) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !CONTROL.test(text) ? text : "";
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_qbank_question_digest_unavailable");
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
    && id(binding.principalId) === context.principalId && Boolean(id(binding.courseId));
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName
      && operation.readOnly === definition.readOnly ? definition : null;
  };
  const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const trueFalseArguments = (args) => {
    if (typeof args.correct_answer !== "boolean") return null;
    if (!bodyText(args.true_feedback, MAX_TEXT_LENGTH) || !bodyText(args.false_feedback, MAX_TEXT_LENGTH)) return null;
    return { content: { correct_answer: args.correct_answer, true_feedback: args.true_feedback, false_feedback: args.false_feedback } };
  };
  const answerArguments = (args) => {
    const multipleChoice = args.qtype === "multichoice";
    if (typeof args[multipleChoice ? "single" : "case_sensitive"] !== "boolean") return null;
    if (!Array.isArray(args.answers) || args.answers.length < (multipleChoice ? 2 : 1) || args.answers.length > MAX_ANSWERS) return null;
    const answers = [];
    for (const answer of args.answers) {
      if (!exactKeys(answer, ["text", "fraction", "feedback"])) return null;
      if (!(multipleChoice ? bodyText(answer.text, MAX_TEXT_LENGTH, 1) : validText(answer.text, MAX_ANSWER_LENGTH))
        || FILE_REFERENCE.test(answer.text) || !bodyText(answer.feedback, MAX_TEXT_LENGTH)) return null;
      if (typeof answer.fraction !== "string" || !FRACTION.test(answer.fraction) || Number(answer.fraction) < -1 || Number(answer.fraction) > 1) return null;
      answers.push({ text: answer.text, fraction: answer.fraction, feedback: answer.feedback });
    }
    // Validate the native grading rule before dispatch.
    if (multipleChoice && !args.single) {
      const positiveTotal = answers.reduce((sum, answer) => sum + Math.max(0, Number(answer.fraction)), 0);
      // Native multichoice validation rounds the positive fractions to two decimals.
      if (Math.round(positiveTotal * 100) !== 100) return null;
    } else if (!answers.some((answer) => Number(answer.fraction) === 1)) return null;
    if (new Set(answers.map((answer) => answer.text)).size !== answers.length) return null;
    return { content: { ...(multipleChoice ? { single: args.single } : { case_sensitive: args.case_sensitive }), answers } };
  };
  const argumentsFor = (definition, args, binding) => {
    const courseId = id(binding?.courseId);
    if (!courseId || !object(args) || id(args.course_id) !== courseId) return null;
    const base = {
      courseId,
      moduleId: id(args.module_id),
      categoryId: id(args.category_id),
      bankContextId: id(args.question_bank_context_id),
    };
    if (!base.moduleId || !base.categoryId || !base.bankContextId) return null;
    const shared = ["course_id", "module_id", "category_id", "question_bank_context_id"];
    if (definition.kind === "question-form" || definition.kind === "question-create") {
      const qtype = typeof args.qtype === "string" && SUPPORTED_TYPES.includes(args.qtype) ? args.qtype : "";
      if (!qtype) return null;
      if (definition.kind === "question-form") return exactKeys(args, [...shared, "qtype"]) ? { ...base, qtype } : null;
      const byType = qtype === "truefalse" ? ["correct_answer", "true_feedback", "false_feedback"]
        : [qtype === "multichoice" ? "single" : "case_sensitive", "answers"];
      if (!exactKeys(args, [...shared, "qtype", "name", "question_text", ...byType, "expected_digest"])) return null;
      if (!DIGEST.test(String(args.expected_digest || ""))) return null;
      // A name that is not already whitespace-collapsed could never equal the
      // name Moodle saves, so the readback would refuse it after the dispatch.
      if (!validText(args.name, MAX_NAME_LENGTH) || collapsed(args.name, MAX_NAME_LENGTH) !== args.name) return null;
      if (!bodyText(args.question_text, MAX_TEXT_LENGTH, 1)) return null;
      const typed = qtype === "truefalse" ? trueFalseArguments(args) : answerArguments(args);
      return typed ? { ...base, qtype, name: args.name, questionText: args.question_text, ...typed, expectedDigest: args.expected_digest } : null;
    }
    const questionId = id(args.question_id);
    const quizModuleId = id(args.quiz_module_id);
    if (!questionId || !quizModuleId) return null;
    const slotKeys = [...shared, "question_id", "quiz_module_id"];
    if (definition.kind === "slot-plan") return exactKeys(args, slotKeys) ? { ...base, questionId, quizModuleId } : null;
    if (!exactKeys(args, [...slotKeys, "expected_digest"]) || !DIGEST.test(String(args.expected_digest || ""))) return null;
    return { ...base, questionId, quizModuleId, expectedDigest: args.expected_digest };
  };
  const urlFor = (context, path, params) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url;
  };
  const sortedEntries = (entries) => [...entries].sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  const sameRoute = (value, expected) => {
    let received;
    try { received = new URL(value); } catch { return false; }
    if (received.origin !== expected.origin || received.pathname !== expected.pathname
      || received.hash || received.username || received.password) return false;
    return stable(sortedEntries([...received.searchParams.entries()])) === stable(sortedEntries([...expected.searchParams.entries()]));
  };
  const cancelBody = (body) => {
    try {
      const canceled = body?.cancel?.();
      if (canceled && typeof canceled.catch === "function") canceled.catch(() => {});
    } catch {}
  };
  const boundedText = async (response) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!COUNT.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
      cancelBody(response?.body);
      return null;
    }
    const reader = response?.body?.getReader?.();
    if (!reader || typeof globalThis.TextDecoder !== "function") return null;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const remaining = Number.isFinite(input?.expiresAt) ? input.expiresAt - Date.now() : Infinity;
        if (remaining <= 0) throw new Error("moodle_execution_expired");
        let timeout;
        const next = Number.isFinite(remaining)
          ? await Promise.race([
              reader.read(),
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("moodle_execution_expired")), remaining); }),
            ]).finally(() => clearTimeout(timeout))
          : await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || (size += next.value.byteLength) > MAX_RESPONSE_BYTES) {
          cancelBody(reader);
          return null;
        }
        text += decoder.decode(next.value, { stream: true });
      }
      return text + decoder.decode();
    } catch {
      cancelBody(reader);
      return null;
    }
  };
  const parseDocument = async (response) => {
    const html = await boundedText(response);
    if (html === null || typeof globalThis.DOMParser !== "function") return null;
    try { return new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
  };
  const readPage = async (context, endpoint, error) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" }, signal: requestSignal(input?.expiresAt) });
    } catch { return { error }; }
    if (!response.ok || !sameRoute(response.url, endpoint) || !sameContext(context, currentContext())) return { error, status: response.status };
    const documentValue = await parseDocument(response);
    return documentValue ? { status: response.status, document: documentValue } : { error, status: response.status };
  };
  const followPage = async (context, endpoint, error) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html" }, signal: requestSignal(input?.expiresAt) });
    } catch { return { error }; }
    if (!response.ok || !sameContext(context, currentContext())) return { error, status: response.status };
    let landed;
    try { landed = new URL(response.url); } catch { return { error, status: response.status }; }
    const documentValue = await parseDocument(response);
    return documentValue ? { status: response.status, landed, document: documentValue } : { error, status: response.status };
  };
  const courseState = async (context, courseId) => {
    const endpoint = urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: STATE_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: STATE_METHOD, args: { courseid: Number(courseId) } }]),
        signal: requestSignal(input?.expiresAt),
      });
    } catch { return { error: "moodle_qbank_question_course_state_unavailable" }; }
    if (!response.ok || !sameContext(context, currentContext())) return { error: "moodle_qbank_question_course_state_unavailable", status: response.status };
    const raw = await boundedText(response);
    if (raw === null) return { error: "moodle_qbank_question_course_state_unavailable", status: response.status };
    let value;
    try {
      const payload = JSON.parse(raw);
      const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
      if (!entry || entry.error || entry.exception || !("data" in entry)) return { error: "moodle_qbank_question_course_state_unavailable", status: response.status };
      value = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
    } catch { return { error: "moodle_qbank_question_course_state_unavailable", status: response.status }; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.cm) || value.cm.length > MAX_ACTIVITIES) {
      return { error: "moodle_qbank_question_course_state_unavailable", status: response.status };
    }
    return { status: response.status, course: value.course, activities: value.cm };
  };
  const courseTarget = (state) => ({ field: "course_id", label: "Course", name: collapsed(state.course?.fullname || state.course?.name) || "Moodle course" });
  const moduleOf = (state, moduleId, moduleName, requireHidden) => {
    const matches = state.activities.filter((entry) => object(entry) && id(entry.id) === moduleId);
    if (matches.length !== 1 || String(matches[0].module || "") !== moduleName) return null;
    const name = collapsed(matches[0].name);
    if (!name || (requireHidden && matches[0].visible !== false)) return null;
    return { id: moduleId, name };
  };

  // --- Question bank impact scope, with the rules of moodle_get_question_bank_impact_scope ---

  const slotNodes = (documentValue) => {
    const roots = [...documentValue.querySelectorAll("ul.slots")];
    if (roots.length !== 1) return null;
    const sections = [...roots[0].children].filter((node) => node.matches?.('li.section.main[id^="section-"]'));
    if (!sections.length) return null;
    const lists = sections.map((section) => [...section.querySelectorAll("ul.section.img-text")]);
    if (lists.some((entry) => entry.length !== 1)) return null;
    return lists.flatMap((entry) => [...entry[0].querySelectorAll(':scope > li.slot[id^="slot-"]')]);
  };
  const questionLinkId = (node, context, moduleId) => {
    const found = [];
    for (const anchor of node.querySelectorAll("a[href]")) {
      let href;
      try { href = new URL(anchor.getAttribute("href"), urlFor(context, QUIZ_EDIT_PATH, { cmid: moduleId })); } catch { continue; }
      if (href.origin !== context.origin || href.pathname !== `${context.basePath}${QUESTION_PATH}`) continue;
      const candidate = id(href.searchParams.get("id"));
      if (href.searchParams.getAll("id").length !== 1 || !candidate || href.searchParams.get("cmid") !== moduleId) return "";
      found.push(candidate);
    }
    return found.length === 1 ? found[0] : "";
  };
  const slotVersionMode = (node, slotId) => {
    const selects = [...node.querySelectorAll(`select.version-selection[data-slot-id="${slotId}"]`)];
    if (selects.length !== 1) return "";
    const selected = [...selects[0].querySelectorAll("option[selected]")];
    if (selected.length !== 1) return "";
    const value = selected[0].getAttribute("value");
    return value === "0" ? "latest" : id(value) ? "pinned" : "";
  };
  const parseFilterCondition = (raw) => {
    let condition;
    try { condition = JSON.parse(raw); } catch { return null; }
    if (!object(condition) || Object.keys(condition).some((key) => !FILTER_CONDITION_FIELDS.includes(key))) return null;
    if (!object(condition.filter)) return null;
    const entries = Object.entries(condition.filter);
    if (!entries.length || entries.length > MAX_FILTERS_PER_SLOT) return null;
    const jointype = Number.isSafeInteger(condition.jointype) ? condition.jointype : 2;
    if (!(jointype in JOINTYPE_NAMES)) return null;
    const filters = [];
    for (const [key, value] of entries) {
      if (!FILTER_KEY.test(key) || !object(value)) return null;
      if (Object.keys(value).some((field) => !["jointype", "values", "filteroptions"].includes(field))) return null;
      if (!Number.isSafeInteger(value.jointype) || !(value.jointype in JOINTYPE_NAMES)) return null;
      if (!Array.isArray(value.values) || value.values.length > MAX_FILTER_VALUES) return null;
      const values = value.values.map((entry) => (Number.isSafeInteger(entry) ? String(entry) : entry));
      if (values.some((entry) => typeof entry !== "string" || !FILTER_VALUE.test(entry))) return null;
      if (value.filteroptions !== undefined && (key !== "category" || !object(value.filteroptions)
        || Object.keys(value.filteroptions).length !== 1 || typeof value.filteroptions.includesubcategories !== "boolean")) return null;
      filters.push({ key, jointype: value.jointype, recognised: RECOGNISED_FILTER_KEYS.includes(key) });
    }
    const contextId = condition.questionscontextid === undefined ? "" : id(condition.questionscontextid);
    if (condition.questionscontextid !== undefined && !contextId) return null;
    return { jointype, filters, contextId };
  };
  /** One Quiz's complete stored slot list, with every reason it is not complete. */
  const quizSlots = async (context, moduleId) => {
    const endpoint = urlFor(context, QUIZ_EDIT_PATH, { cmid: moduleId });
    const page = await readPage(context, endpoint, "moodle_qbank_question_quiz_unavailable");
    if (page.error) return page;
    const nodes = slotNodes(page.document);
    if (!nodes) return { error: "moodle_qbank_question_quiz_unavailable", status: page.status };
    if (nodes.length > MAX_SLOTS_PER_QUIZ) return { status: page.status, slots: [], reasons: ["slot_list_truncated"] };
    const slots = [];
    const reasons = [];
    const seen = new Set();
    for (const node of nodes) {
      const slotId = id(String(node.getAttribute("id") || "").slice("slot-".length));
      if (!slotId || seen.has(slotId)) return { error: "moodle_qbank_question_quiz_unavailable", status: page.status };
      seen.add(slotId);
      const position = slots.length + 1;
      if (node.classList.contains("random") || node.classList.contains("qtype_random")) {
        const carriers = [...node.querySelectorAll("[data-filtercondition]")];
        const holder = node.hasAttribute("data-filtercondition") ? node : carriers.length === 1 ? carriers[0] : null;
        const parsed = holder && !(node.hasAttribute("data-filtercondition") && carriers.length > 0)
          ? parseFilterCondition(String(holder.getAttribute("data-filtercondition") || "")) : null;
        if (!parsed) {
          reasons.push("random_filter_condition_not_exposed");
          slots.push({ slot_id: Number(slotId), position, reference: "random", resolved: false });
          continue;
        }
        const attributeContext = id(String(holder.getAttribute("data-questionscontextid") || ""));
        if (attributeContext && parsed.contextId && attributeContext !== parsed.contextId) reasons.push("random_filter_condition_malformed");
        if (!(attributeContext || parsed.contextId)) reasons.push("random_context_not_exposed");
        if (parsed.jointype === 0 || parsed.filters.some((filter) => filter.jointype === 0)) reasons.push("filter_jointype_none");
        if (parsed.filters.some((filter) => !filter.recognised)) reasons.push("filter_class_unrecognised");
        slots.push({ slot_id: Number(slotId), position, reference: "random", resolved: true });
        continue;
      }
      const questionId = questionLinkId(node, context, moduleId);
      const versionMode = questionId ? slotVersionMode(node, slotId) : "";
      if (!questionId || !versionMode) {
        reasons.push("slot_reference_unresolved");
        slots.push({ slot_id: Number(slotId), position, reference: "direct", resolved: false });
        continue;
      }
      slots.push({ slot_id: Number(slotId), position, reference: "direct", resolved: true, question_id: Number(questionId), version_mode: versionMode });
    }
    return { status: page.status, slots, reasons };
  };
  /**
   * Re-derives the course's Question bank impact scope before every effect. A
   * `jointype = NONE` filter has its own refusal because a fresh category can
   * satisfy an excluding category test, which is the exact hazard this route
   * exists to avoid.
   */
  const impactScope = async (context, state) => {
    const quizzes = state.activities
      .filter((entry) => object(entry) && String(entry.module || "") === QUIZ_MODULE)
      .map((entry) => id(entry.id))
      .filter(Boolean)
      .sort((left, right) => Number(left) - Number(right));
    if (quizzes.length !== state.activities.filter((entry) => object(entry) && String(entry.module || "") === QUIZ_MODULE).length) {
      return { error: "moodle_qbank_question_course_state_unavailable" };
    }
    if (quizzes.length > MAX_QUIZZES) return { error: "moodle_qbank_question_impact_scope_incomplete" };
    const reasons = new Set();
    const bySlotOwner = new Map();
    let slotCount = 0;
    let directCount = 0;
    let randomCount = 0;
    for (const moduleId of quizzes) {
      const read = await quizSlots(context, moduleId);
      if (read.error) return { error: read.error, status: read.status };
      for (const entry of read.reasons) reasons.add(entry);
      bySlotOwner.set(moduleId, read.slots);
      slotCount += read.slots.length;
      directCount += read.slots.filter((slot) => slot.reference === "direct").length;
      randomCount += read.slots.filter((slot) => slot.reference === "random").length;
    }
    if (reasons.has("filter_jointype_none")) return { error: "moodle_qbank_question_random_filter_none" };
    if (reasons.size) return { error: "moodle_qbank_question_impact_scope_incomplete" };
    return {
      quizzes: bySlotOwner,
      summary: {
        status: "complete",
        quiz_count: quizzes.length,
        slot_count: slotCount,
        direct_reference_count: directCount,
        random_reference_count: randomCount,
        recognised_filter_keys: RECOGNISED_FILTER_KEYS,
        scope: "approved_course_only",
        condition_class_resolution: "not_exposed",
      },
    };
  };

  // --- The approved bank page and its native creation chain ---

  const entriesFor = (form) => {
    let values;
    try { values = [...new FormData(form).entries()]; } catch { return null; }
    if (values.length > MAX_FORM_ENTRIES) return null;
    let size = 0;
    const entries = [];
    for (const [name, value] of values) {
      if (typeof name !== "string" || name.length < 1 || name.length > 255 || typeof value !== "string" || value.length > MAX_VALUE_BYTES) return null;
      size += name.length + value.length;
      if (size > MAX_FORM_BYTES) return null;
      entries.push([name, value]);
    }
    return entries;
  };
  const bankEndpoint = (context, args) => urlFor(context, BANK_PAGE_PATH, { cat: `${args.categoryId},${args.bankContextId}`, cmid: args.moduleId });
  /** Every bank entry the approved bank page lists, by its own native edit link. */
  const bankEntryIds = (documentValue, context, moduleId) => {
    const found = new Set();
    for (const anchor of documentValue.querySelectorAll("a[href]")) {
      let href;
      try { href = new URL(anchor.getAttribute("href"), urlFor(context, BANK_PAGE_PATH, { cmid: moduleId })); } catch { continue; }
      if (href.origin !== context.origin || href.pathname !== `${context.basePath}${QUESTION_PATH}`) continue;
      const candidate = id(href.searchParams.get("id"));
      if (href.searchParams.getAll("id").length !== 1 || !candidate || href.searchParams.get("cmid") !== moduleId) return null;
      found.add(candidate);
    }
    return found.size > MAX_BANK_ENTRIES ? null : found;
  };
  /**
   * The bank page's own add-question control. Its presence is how
   * `moodle/question:add` at the bank context is visible to a browser, and its
   * hidden fields are the only source of the chooser parameters Morrow sends.
   */
  const bankControl = (documentValue, context, args, qtype) => {
    const controls = [...documentValue.querySelectorAll("div.createnewquestion")];
    if (controls.length !== 1) return { error: "moodle_qbank_question_add_absent" };
    const forms = [...controls[0].querySelectorAll("form")].filter((form) => {
      if (!["", "get"].includes(String(form.getAttribute("method") || "").toLowerCase())) return false;
      let action;
      try { action = new URL(form.getAttribute("action") || "", context.siteUrl); } catch { return false; }
      return action.origin === context.origin && action.pathname === `${context.basePath}${ADD_QUESTION_PATH}` && !action.search;
    });
    if (forms.length !== 1 || !controls[0].querySelector("#qtypechoicecontainer")) return { error: "moodle_qbank_question_add_absent" };
    const entries = entriesFor(forms[0]);
    if (!entries) return { error: "moodle_qbank_question_add_absent" };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    if (stable(byName("category")) !== stable([args.categoryId]) || stable(byName("cmid")) !== stable([args.moduleId])) {
      return { error: "moodle_qbank_question_add_absent" };
    }
    const chosen = [...forms[0].querySelectorAll('[name="qtype"]')].filter((control) => String(control.getAttribute("value") || "") === qtype);
    if (chosen.length !== 1) return { error: "moodle_qbank_question_type_unavailable" };
    // `appendqnumstring` with a Quiz return address is what makes this native
    // chain add a Quiz slot in the same request. Effect 3 must not do that.
    const appendix = byName("appendqnumstring");
    if (appendix.length > 1 || (appendix.length === 1 && appendix[0] !== "")) return { error: "moodle_qbank_question_route_not_bank_scoped" };
    const returnUrl = byName("returnurl");
    if (returnUrl.length !== 1) return { error: "moodle_qbank_question_route_not_bank_scoped" };
    let returnTarget;
    try { returnTarget = new URL(returnUrl[0], context.siteUrl); } catch { return { error: "moodle_qbank_question_route_not_bank_scoped" }; }
    if (returnTarget.origin !== context.origin || returnTarget.pathname !== `${context.basePath}${BANK_PAGE_PATH}`) {
      return { error: "moodle_qbank_question_route_not_bank_scoped" };
    }
    const params = new URLSearchParams();
    for (const [name, value] of entries) {
      if (params.has(name)) return { error: "moodle_qbank_question_add_absent" };
      if (value === context.sesskey || TRANSIENT_FIELD.test(name)) return { error: "moodle_qbank_question_add_absent" };
      params.set(name, value);
    }
    params.set("qtype", qtype);
    const selects = [...documentValue.querySelectorAll('[data-filterregion="filtertypedata"] select[data-field-name="category"]')];
    if (selects.length !== 1) return { error: "moodle_qbank_category_context_not_exposed" };
    const options = [...selects[0].querySelectorAll("option")];
    if (!options.length || options.length > MAX_CATEGORY_OPTIONS) return { error: "moodle_qbank_category_context_not_exposed" };
    const headings = options.filter((option) => String(option.getAttribute("value") || "") === "");
    const values = options.filter((option) => !headings.includes(option)).map((option) => String(option.getAttribute("value") || ""));
    if (headings.length !== 1 || values.some((value) => !id(value)) || new Set(values).size !== values.length || !values.includes(args.categoryId)) {
      return { error: "moodle_qbank_category_not_isolated" };
    }
    return { params, returnUrl: returnUrl[0], categoryOptionCount: values.length, contextGroups: headings.length };
  };
  /**
   * The native question form must be a creation form for the approved bank
   * category, with no file area, no selected tag and no rich text of its own.
   */
  const questionFormState = (documentValue, context, endpoint, args, qtype) => {
    const forms = [...documentValue.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      const action = form.getAttribute("action");
      if (!action) return false;
      try {
        const nativeAction = new URL(action, endpoint);
        return nativeAction.origin === endpoint.origin && nativeAction.pathname === endpoint.pathname
          && !nativeAction.search && !nativeAction.hash && !nativeAction.username && !nativeAction.password;
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_qbank_question_form_invalid" };
    const form = forms[0];
    const entries = entriesFor(form);
    if (!entries) return { error: "moodle_qbank_question_form_invalid" };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    const one = (name, expected) => {
      const values = byName(name);
      return values.length === 1 && (expected === undefined || values[0] === expected);
    };
    if (!one("sesskey", context.sesskey)) return { error: "moodle_form_session_mismatch" };
    if (!one("qtype", qtype)) return { error: "moodle_qbank_question_form_invalid" };
    if (!one("category", `${args.categoryId},${args.bankContextId}`)) return { error: "moodle_qbank_question_category_mismatch" };
    if (!one("cmid", args.moduleId) || !one("courseid", args.courseId)) return { error: "moodle_qbank_question_form_invalid" };
    // An id or a copy control means the controller is editing or cloning a
    // saved entry. This route creates a new one and nothing else.
    const existing = byName("id");
    if (existing.length > 1 || (existing.length === 1 && !["", "0"].includes(existing[0]))) return { error: "moodle_qbank_question_entry_exists" };
    if (byName("makecopy").length) return { error: "moodle_qbank_question_entry_exists" };
    if (byName("appendqnumstring").some((value) => value !== "")) return { error: "moodle_qbank_question_route_not_bank_scoped" };
    if (!one("status", READY_STATUS)) return { error: "moodle_qbank_question_status_unexpected" };
    if (!one("name") || !one("questiontext[text]") || !one("questiontext[format]") || !one("defaultmark")
      || !one("generalfeedback[text]") || !one("generalfeedback[format]")) return { error: "moodle_qbank_question_form_invalid" };
    if (form.querySelector('[data-fieldtype="filemanager"], [data-fieldtype="filepicker"], input[type="file"]')) {
      return { error: "moodle_qbank_question_file_area_unexpected" };
    }
    // A draft area is allowed only when it belongs to a rich-text editor of
    // this form, and that editor must be empty, so no saved file can travel.
    for (const [name] of entries) {
      const match = DRAFT_ITEM_FIELD.exec(name);
      if (!match) continue;
      const text = byName(`${match[1]}[text]`);
      const nativeDefault = qtype === "multichoice" && COMBINED_FEEDBACK.includes(match[1]);
      if (text.length !== 1 || (nativeDefault ? !bodyText(text[0], MAX_TEXT_LENGTH) : text[0] !== "")) {
        return { error: "moodle_qbank_question_file_area_unexpected" };
      }
    }
    if (entries.some(([name]) => name === "tags[]" || name === "coursetags[]")) return { error: "moodle_qbank_question_tags_unexpected" };
    const typed = qtype === "truefalse" ? trueFalseControls(form, entries, byName) : answerControls(form, entries, byName, qtype);
    if (typed.error) return typed;
    const submits = [...form.querySelectorAll('input[type="submit"][name="submitbutton"], button[type="submit"][name="submitbutton"]')]
      .filter((element) => !element.disabled && typeof element.value === "string" && element.value.length <= 500);
    if (submits.length !== 1) return { error: "moodle_qbank_question_form_invalid" };
    const overridden = new Set(typed.overriddenFields);
    const protectedEntries = entries.filter(([name]) => !overridden.has(name) && !TRANSIENT_FIELD.test(name));
    if (protectedEntries.some(([, value]) => value === context.sesskey)) return { error: "moodle_qbank_question_form_invalid" };
    return {
      entries,
      action: new URL(form.getAttribute("action"), endpoint).href,
      nativeSesskey: context.sesskey,
      submit: { name: submits[0].name, value: submits[0].value },
      questionTextFormat: byName("questiontext[format]")[0],
      generalFeedbackFormat: byName("generalfeedback[format]")[0],
      defaultMark: byName("defaultmark")[0],
      controls: typed.controls,
      overriddenFields: typed.overriddenFields,
      protectedFields: [...new Set(protectedEntries.map(([name]) => name))].sort(),
      protectedEntries: protectedEntries.filter(([name]) => !DRAFT_ITEM_FIELD.test(name)),
    };
  };
  const optionValues = (form, name) => {
    const selects = [...form.querySelectorAll("select")].filter((select) => select.getAttribute("name") === name && !select.disabled);
    if (selects.length !== 1) return null;
    const values = [...selects[0].querySelectorAll("option")].filter((option) => !option.disabled).map((option) => String(option.getAttribute("value") || ""));
    return values.length && new Set(values).size === values.length ? values : null;
  };
  const trueFalseControls = (form, entries, byName) => {
    const correct = optionValues(form, "correctanswer");
    if (!correct || correct.length !== 2 || !correct.includes("0") || !correct.includes("1")) return { error: "moodle_qbank_question_form_invalid" };
    if (byName("feedbacktrue[text]").length !== 1 || byName("feedbackfalse[text]").length !== 1
      || byName("feedbacktrue[format]").length !== 1 || byName("feedbackfalse[format]").length !== 1) {
      return { error: "moodle_qbank_question_form_invalid" };
    }
    return {
      controls: { correct_answer_options: correct },
      overriddenFields: ["name", "questiontext[text]", "correctanswer", "feedbacktrue[text]", "feedbackfalse[text]"],
    };
  };
  // Core Short answer uses answer[index]; Multichoice uses an answer editor.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/question/type/edit_question_form.php#L592-L615
  // https://github.com/moodle/moodle/blob/v5.2.2/public/question/type/multichoice/edit_multichoice_form.php#L39-L83
  const answerControls = (form, entries, byName, qtype) => {
    const typeField = qtype === "multichoice" ? "single" : "usecase";
    const choices = optionValues(form, typeField);
    if (!choices || choices.length !== 2 || !choices.includes("0") || !choices.includes("1")
      || byName(typeField).length !== 1) return { error: "moodle_qbank_question_form_invalid" };
    if (qtype === "multichoice") {
      if (!optionValues(form, "answernumbering") || !optionValues(form, "showstandardinstruction")
        || !byName("shuffleanswers").length || byName("shuffleanswers").some((value) => !["0", "1"].includes(value))
        || COMBINED_FEEDBACK.some((field) => byName(`${field}[text]`).length !== 1 || byName(`${field}[format]`).length !== 1)) {
        return { error: "moodle_qbank_question_form_invalid" };
      }
    }
    const indexes = [...new Set(entries.map(([name]) => ANSWER_TEXT_FIELD.exec(name)?.[1]).filter(Boolean))].map(Number).sort((left, right) => left - right);
    if (!indexes.length || indexes.length > MAX_ANSWERS || indexes.some((entry, index) => entry !== index)) return { error: "moodle_qbank_question_form_invalid" };
    let fractionOptions = null;
    for (const index of indexes) {
      if (byName(answerField(index, qtype)).length !== 1 || (qtype === "multichoice" && byName(`answer[${index}][format]`).length !== 1)
        || byName(`feedback[${index}][text]`).length !== 1
        || byName(`feedback[${index}][format]`).length !== 1) return { error: "moodle_qbank_question_form_invalid" };
      if (byName(answerField(index, qtype))[0] !== "" || byName(`feedback[${index}][text]`)[0] !== ""
        || byName(`fraction[${index}]`).length !== 1 || Number(byName(`fraction[${index}]`)[0]) !== 0) {
        return { error: "moodle_qbank_question_form_invalid" };
      }
      const options = optionValues(form, `fraction[${index}]`);
      if (!options || options.some((value) => !FRACTION.test(value) || Number(value) < -1 || Number(value) > 1)) return { error: "moodle_qbank_question_form_invalid" };
      // One approved fraction list only, so the approver sees one choice set.
      if (fractionOptions && stable(options) !== stable(fractionOptions)) return { error: "moodle_qbank_question_form_invalid" };
      fractionOptions = options;
    }
    const overridden = ["name", "questiontext[text]", typeField];
    for (const index of indexes) overridden.push(answerField(index, qtype), `fraction[${index}]`, `feedback[${index}][text]`);
    return { controls: { answer_row_count: indexes.length, fraction_options: fractionOptions,
      ...(qtype === "multichoice" ? { single_options: choices } : {}) }, overriddenFields: overridden };
  };
  const questionProof = () => ({
    method: "native_question_bank_creation_chain",
    route: QUESTION_PATH,
    entry_route: BANK_PAGE_PATH,
    chooser_route: ADD_QUESTION_PATH,
    required_capability: "moodle/question:add",
    capability_source: "bank_page_add_question_control",
    scope: "one_new_entry_in_the_approved_qbank_category",
    file_policy: "empty",
    tag_policy: "empty",
    existing_entry_policy: "never_cloned_moved_or_updated",
    question_bank_update_eligibility: "held",
  });
  const creationFormData = (args, control, form, scope) => ({
    schema: QUESTION_SCHEMA,
    provider: PROVIDER,
    course_id: Number(args.courseId),
    module_id: Number(args.moduleId),
    category_id: Number(args.categoryId),
    question_bank_context_id: Number(args.bankContextId),
    qtype: args.qtype,
    question_status: READY_STATUS,
    question_text_format: form.questionTextFormat,
    general_feedback_format: form.generalFeedbackFormat,
    default_mark: form.defaultMark,
    ...form.controls,
    category_contexts_listed: control.contextGroups,
    category_option_count: control.categoryOptionCount,
    question_add_capability: "present",
    file_areas_empty: true,
    tags_empty: true,
    impact_scope: scope.summary,
    protected_setting_names: form.protectedFields,
    proof: questionProof(),
  });
  const readCreationForm = async (context, args) => {
    const state = await courseState(context, args.courseId);
    if (state.error) return failure(state.error, state.status);
    const module = moduleOf(state, args.moduleId, MODULE, true);
    if (!module) return failure("moodle_qbank_module_target_invalid", state.status);
    const scope = await impactScope(context, state);
    if (scope.error) return failure(scope.error, scope.status ?? state.status);
    const bankPage = await readPage(context, bankEndpoint(context, args), "moodle_qbank_question_bank_page_unavailable");
    if (bankPage.error) return failure(bankPage.error, bankPage.status);
    const entries = bankEntryIds(bankPage.document, context, args.moduleId);
    if (!entries) return failure("moodle_qbank_question_bank_page_unavailable", bankPage.status);
    const control = bankControl(bankPage.document, context, args, args.qtype);
    if (control.error) return failure(control.error, bankPage.status);
    const chooser = urlFor(context, ADD_QUESTION_PATH, control.params);
    const landedPage = await followPage(context, chooser, "moodle_qbank_question_form_unavailable");
    if (landedPage.error) return failure(landedPage.error, landedPage.status);
    const landed = landedPage.landed;
    if (landed.origin !== context.origin || landed.pathname !== `${context.basePath}${QUESTION_PATH}`
      || landed.searchParams.get("qtype") !== args.qtype || landed.searchParams.get("cmid") !== args.moduleId
      || landed.searchParams.get("category") !== args.categoryId
      || landed.searchParams.has("id") || landed.searchParams.has("makecopy")) {
      return failure("moodle_qbank_question_entry_exists", landedPage.status);
    }
    const form = questionFormState(landedPage.document, context, landed, args, args.qtype);
    if (form.error) return failure(form.error, landedPage.status);
    const data = { ...creationFormData(args, control, form, scope), protected_settings_digest: await digest(form.protectedEntries) };
    return {
      ok: true, sent: true, status: landedPage.status, data,
      targets: [courseTarget(state), { field: "module_id", label: "Question bank", name: module.name }],
      snapshot_digest: await digest(data), form, entries, action: landed.href,
    };
  };
  const creationBody = (form, args) => {
    const overrides = new Map([["name", args.name], ["questiontext[text]", args.questionText]]);
    if (args.qtype === "truefalse") {
      overrides.set("correctanswer", args.content.correct_answer ? "1" : "0");
      overrides.set("feedbacktrue[text]", args.content.true_feedback);
      overrides.set("feedbackfalse[text]", args.content.false_feedback);
    } else {
      overrides.set(args.qtype === "multichoice" ? "single" : "usecase", (args.qtype === "multichoice" ? args.content.single : args.content.case_sensitive) ? "1" : "0");
      args.content.answers.forEach((answer, index) => {
        overrides.set(answerField(index, args.qtype), answer.text);
        overrides.set(`fraction[${index}]`, answer.fraction);
        overrides.set(`feedback[${index}][text]`, answer.feedback);
      });
    }
    const body = new URLSearchParams();
    for (const [field, value] of form.entries) body.append(field, overrides.has(field) ? overrides.get(field) : value);
    body.append(form.submit.name, form.submit.value);
    return body;
  };
  const contentWritable = (form, args) => {
    if (args.qtype === "truefalse") return true;
    const { answer_row_count: rows, fraction_options: options } = form.controls;
    return args.content.answers.length <= rows && args.content.answers.every((answer) => options.includes(answer.fraction));
  };
  const postCreation = async (context, form, args) => {
    const preflight = currentContext();
    if (!sameContext(context, preflight) || form.nativeSesskey !== preflight?.sesskey) return { error: "moodle_form_session_mismatch", notSent: true };
    let response;
    try {
      dispatched = true;
      response = await fetch(form.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "follow",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: creationBody(form, args),
        signal: requestSignal(input?.expiresAt),
      });
    } catch { return { error: "moodle_qbank_question_create_unconfirmed" }; }
    if (!response.ok || !sameContext(context, currentContext())) return { error: "moodle_qbank_question_create_unconfirmed", status: response.status };
    let landed;
    try { landed = new URL(response.url); } catch { return { error: "moodle_qbank_question_create_unconfirmed", status: response.status }; }
    // The native form answers its own validation failure by re-rendering
    // itself, which saved nothing.
    if (landed.pathname === `${context.basePath}${QUESTION_PATH}`) return { error: "moodle_form_validation_failed", status: response.status, validation: true };
    if (landed.origin !== context.origin || landed.pathname !== `${context.basePath}${BANK_PAGE_PATH}`) {
      return { error: "moodle_qbank_question_create_unconfirmed", status: response.status };
    }
    return { status: response.status };
  };
  const preservedSettings = (entries, qtype, answerCount) => {
    const fields = new Set(["defaultmark", "questiontext[format]", "generalfeedback[text]", "generalfeedback[format]", "penalty"]);
    if (qtype === "truefalse") {
      fields.add("feedbacktrue[format]");
      fields.add("feedbackfalse[format]");
    } else {
      for (let index = 0; index < answerCount; index += 1) {
        fields.add(`feedback[${index}][format]`);
        if (qtype === "multichoice") fields.add(`answer[${index}][format]`);
      }
    }
    if (qtype === "multichoice") {
      for (const field of ["shuffleanswers", "answernumbering", "showstandardinstruction", ...COMBINED_FEEDBACK.flatMap((field) => [`${field}[text]`, `${field}[format]`])]) fields.add(field);
    }
    const result = {};
    for (const [name, value] of entries) {
      if (!fields.has(name)) continue;
      // PHP's checkbox group takes its last successful control. Moodle also
      // removes trailing zeroes from stored grade values when it renders them.
      result[name] = ["defaultmark", "penalty"].includes(name) ? String(Number(value)) : value;
    }
    return result;
  };
  const savedQuestion = async (context, args, questionId) => {
    const endpoint = urlFor(context, QUESTION_PATH, { id: questionId, cmid: args.moduleId });
    const page = await readPage(context, endpoint, "moodle_qbank_question_saved_entry_unavailable");
    if (page.error) return page;
    const forms = [...page.document.querySelectorAll("form")].filter((form) => {
      if (String(form.getAttribute("method") || "").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || "", endpoint);
        return action.origin === endpoint.origin && action.pathname === endpoint.pathname && !action.search;
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_qbank_question_saved_entry_unavailable", status: page.status };
    const entries = entriesFor(forms[0]);
    if (!entries) return { error: "moodle_qbank_question_saved_entry_unavailable", status: page.status };
    const byName = (name) => entries.filter(([entryName]) => entryName === name).map(([, value]) => value);
    const value = (name) => (byName(name).length === 1 ? byName(name)[0] : null);
    const category = value("category");
    const parsed = category ? CATEGORY_FIELD.exec(category) : null;
    if (!parsed || value("id") !== questionId || value("cmid") !== args.moduleId || value("courseid") !== args.courseId) {
      return { error: "moodle_qbank_question_saved_entry_unavailable", status: page.status };
    }
    const qtype = value("qtype");
    const name = value("name");
    const questionText = value("questiontext[text]");
    const status = value("status");
    if (!SUPPORTED_TYPES.includes(qtype) || name === null || !bodyText(questionText, MAX_TEXT_LENGTH, 1) || !status
      || entries.some(([field]) => ["tags[]", "coursetags[]"].includes(field))
      || forms[0].querySelector('[data-fieldtype="filemanager"], [data-fieldtype="filepicker"], input[type="file"]')) {
      return { error: "moodle_qbank_question_saved_entry_unavailable", status: page.status };
    }
    const modeField = qtype === "truefalse" ? "correctanswer" : qtype === "multichoice" ? "single" : "usecase";
    if (!["0", "1"].includes(value(modeField))) return { error: "moodle_qbank_question_saved_entry_unavailable", status: page.status };
    const detail = qtype === "truefalse"
      ? {
        correct_answer: value("correctanswer") === "1",
        true_feedback: value("feedbacktrue[text]"),
        false_feedback: value("feedbackfalse[text]"),
      }
      : {
        ...(qtype === "multichoice" ? { single: value("single") === "1" } : { case_sensitive: value("usecase") === "1" }),
        answers: [...new Set(entries.map(([entryName]) => ANSWER_TEXT_FIELD.exec(entryName)?.[1]).filter(Boolean))]
          .map(Number).sort((left, right) => left - right)
          .map((index) => ({ text: value(answerField(index, qtype)), fraction: value(`fraction[${index}]`), feedback: value(`feedback[${index}][text]`) }))
          .filter((answer) => answer.text !== ""),
      };
    const validContent = qtype === "truefalse" ? trueFalseArguments(detail) : answerArguments({ qtype, ...detail });
    if (!validContent) return { error: "moodle_qbank_question_saved_entry_unavailable", status: page.status };
    return {
      status: page.status,
      settings: preservedSettings(entries, qtype, detail.answers?.length || 0),
      entry: {
        question_id: Number(questionId),
        name: collapsed(name, MAX_NAME_LENGTH),
        question_text: questionText,
        qtype,
        version_status: status,
        category_id: Number(parsed[1]),
        question_bank_context_id: Number(parsed[2]),
        ...detail,
      },
    };
  };
  const savedMatchesApproval = (entry, args) => {
    if (entry.qtype !== args.qtype || entry.name !== args.name || entry.question_text !== args.questionText
      || entry.version_status !== READY_STATUS || entry.category_id !== Number(args.categoryId)
      || entry.question_bank_context_id !== Number(args.bankContextId)) return false;
    if (args.qtype === "truefalse") {
      return entry.correct_answer === args.content.correct_answer && entry.true_feedback === args.content.true_feedback
        && entry.false_feedback === args.content.false_feedback;
    }
    const approved = args.content.answers.map((answer) => ({ text: answer.text, fraction: answer.fraction, feedback: answer.feedback }));
    const modeMatches = args.qtype === "multichoice" ? entry.single === args.content.single : entry.case_sensitive === args.content.case_sensitive;
    const normalized = (answers) => answers.map((answer) => ({ ...answer, fraction: Number(answer.fraction) }));
    return modeMatches && stable(normalized(entry.answers)) === stable(normalized(approved));
  };
  const runCreation = async (context, args) => {
    const before = await readCreationForm(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    if (!contentWritable(before.form, args)) return failure("moodle_qbank_question_content_unwritable", before.status);
    const refreshed = await readCreationForm(context, args);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.action !== before.action) {
      return failure("moodle_expected_digest_mismatch", refreshed.status);
    }
    if (!contentWritable(refreshed.form, args)) return failure("moodle_qbank_question_content_unwritable", refreshed.status);
    const posted = await postCreation(context, refreshed.form, args);
    if (posted.error) {
      if (posted.notSent === true) return failure(posted.error, refreshed.status);
      if (posted.validation === true) return appliedButRefused(posted.error, posted.status);
      return unconfirmedWrite(posted.error, posted.status);
    }
    const bankPage = await readPage(context, bankEndpoint(context, args), "moodle_qbank_question_create_not_verified");
    if (bankPage.error) return unconfirmedWrite("moodle_qbank_question_create_not_verified", posted.status);
    const after = bankEntryIds(bankPage.document, context, args.moduleId);
    if (!after) return unconfirmedWrite("moodle_qbank_question_create_not_verified", posted.status);
    const added = [...after].filter((entry) => !refreshed.entries.has(entry));
    if (added.length !== 1 || refreshed.entries.size + 1 !== after.size) {
      return unconfirmedWrite("moodle_qbank_question_create_not_verified", posted.status);
    }
    const saved = await savedQuestion(context, args, added[0]);
    if (saved.error || !savedMatchesApproval(saved.entry, args)
      || stable(saved.settings) !== stable(preservedSettings(refreshed.form.entries, args.qtype, args.content.answers?.length || 0))) {
      return unconfirmedWrite("moodle_qbank_question_create_not_verified", posted.status);
    }
    const data = {
      schema: QUESTION_SCHEMA,
      provider: PROVIDER,
      course_id: Number(args.courseId),
      module_id: Number(args.moduleId),
      ...saved.entry,
      created: true,
      quiz_slots_added: 0,
      later_updates: "held",
      impact_scope: refreshed.data.impact_scope,
      proof: questionProof(),
    };
    return {
      ok: true, sent: true, status: posted.status, data,
      targets: refreshed.targets, snapshot_digest: await digest(data),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  // --- One new Quiz slot for the approved entry ---

  const slotProof = () => ({
    method: "native_quiz_add_question_action",
    route: QUIZ_EDIT_PATH,
    required_capabilities: ["mod/quiz:manage", "moodle/question:use"],
    capability_source: "native_quiz_edit_page_and_action_result",
    scope: "one_new_slot_at_the_end_of_the_approved_quiz",
    slot_reference: "direct_entry_reference",
    slot_version: "latest",
    existing_slots: "unchanged",
    question_bank_update_eligibility: "held",
  });
  const readSlotPlan = async (context, args) => {
    const state = await courseState(context, args.courseId);
    if (state.error) return failure(state.error, state.status);
    const module = moduleOf(state, args.moduleId, MODULE, true);
    const quiz = moduleOf(state, args.quizModuleId, QUIZ_MODULE, false);
    if (!module) return failure("moodle_qbank_module_target_invalid", state.status);
    if (!quiz) return failure("moodle_qbank_question_quiz_target_invalid", state.status);
    const scope = await impactScope(context, state);
    if (scope.error) return failure(scope.error, scope.status ?? state.status);
    const slots = scope.quizzes.get(args.quizModuleId);
    if (!slots) return failure("moodle_qbank_question_quiz_target_invalid", state.status);
    const saved = await savedQuestion(context, args, args.questionId);
    if (saved.error) return failure(saved.error, saved.status);
    const entry = saved.entry;
    if (entry.category_id !== Number(args.categoryId) || entry.question_bank_context_id !== Number(args.bankContextId)) {
      return failure("moodle_qbank_question_category_mismatch", saved.status);
    }
    if (!SUPPORTED_TYPES.includes(entry.qtype)) return failure("moodle_qbank_question_type_unavailable", saved.status);
    if (entry.version_status !== READY_STATUS) return failure("moodle_qbank_question_status_unexpected", saved.status);
    if (slots.some((slot) => slot.question_id === Number(args.questionId))) return failure("moodle_qbank_question_already_in_quiz", saved.status);
    const data = {
      schema: SLOT_SCHEMA,
      provider: PROVIDER,
      course_id: Number(args.courseId),
      quiz_module_id: Number(args.quizModuleId),
      module_id: Number(args.moduleId),
      category_id: Number(args.categoryId),
      question_bank_context_id: Number(args.bankContextId),
      question_id: Number(args.questionId),
      question_name: entry.name,
      question_digest: await digest({ entry, settings: saved.settings }),
      qtype: entry.qtype,
      question_status: entry.version_status,
      quiz_slot_count: slots.length,
      quiz_slots: slots,
      question_in_quiz: false,
      impact_scope: scope.summary,
      proof: slotProof(),
    };
    return {
      ok: true, sent: true, status: saved.status, data,
      targets: [courseTarget(state), { field: "quiz_module_id", label: "Quiz", name: quiz.name }],
      snapshot_digest: await digest(data), slots,
    };
  };
  const runSlotAddition = async (context, args) => {
    const before = await readSlotPlan(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const refreshed = await readSlotPlan(context, args);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", refreshed.status);
    const preflight = currentContext();
    if (!sameContext(context, preflight)) return failure("moodle_form_session_mismatch", refreshed.status);
    const endpoint = urlFor(context, QUIZ_EDIT_PATH, { cmid: args.quizModuleId, addquestion: args.questionId, sesskey: context.sesskey });
    let response;
    try {
      dispatched = true;
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html" }, signal: requestSignal(input?.expiresAt) });
    } catch { return unconfirmedWrite("moodle_qbank_quiz_slot_unconfirmed"); }
    if (!response.ok || !sameContext(context, currentContext())) return unconfirmedWrite("moodle_qbank_quiz_slot_unconfirmed", response.status);
    let landed;
    try { landed = new URL(response.url); } catch { return unconfirmedWrite("moodle_qbank_quiz_slot_unconfirmed", response.status); }
    if (landed.origin !== context.origin || landed.pathname !== `${context.basePath}${QUIZ_EDIT_PATH}`
      || landed.searchParams.get("cmid") !== args.quizModuleId) {
      return unconfirmedWrite("moodle_qbank_quiz_slot_unconfirmed", response.status);
    }
    const after = await quizSlots(context, args.quizModuleId);
    if (after.error || after.reasons.length) return unconfirmedWrite("moodle_qbank_quiz_slot_not_verified", response.status);
    const previous = refreshed.slots;
    const added = after.slots.length === previous.length + 1
      && stable(after.slots.slice(0, previous.length)) === stable(previous) ? after.slots[after.slots.length - 1] : null;
    if (!added || added.reference !== "direct" || added.question_id !== Number(args.questionId) || added.version_mode !== "latest") {
      return unconfirmedWrite("moodle_qbank_quiz_slot_not_verified", response.status);
    }
    const saved = await savedQuestion(context, args, args.questionId);
    if (saved.error || await digest({ entry: saved.entry, settings: saved.settings }) !== refreshed.data.question_digest) {
      return unconfirmedWrite("moodle_qbank_quiz_slot_not_verified", response.status);
    }
    const data = {
      ...refreshed.data,
      quiz_slot_count: after.slots.length,
      quiz_slots: after.slots,
      question_in_quiz: true,
      added_slot_id: added.slot_id,
      added_slot_position: added.position,
      later_updates: "held",
    };
    return {
      ok: true, sent: true, status: response.status, data,
      targets: refreshed.targets, snapshot_digest: await digest(data),
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  let dispatched = false;
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const args = argumentsFor(definition, input.arguments, input.binding);
    if (!args) return failure("moodle_qbank_question_arguments_invalid");
    if (definition.kind === "question-form") {
      const read = await readCreationForm(context, args);
      return read.ok ? { ok: true, sent: true, status: read.status, data: read.data, targets: read.targets, snapshot_digest: read.snapshot_digest } : read;
    }
    if (definition.kind === "slot-plan") {
      const read = await readSlotPlan(context, args);
      return read.ok ? { ok: true, sent: true, status: read.status, data: read.data, targets: read.targets, snapshot_digest: read.snapshot_digest } : read;
    }
    return definition.kind === "question-create" ? await runCreation(context, args) : await runSlotAddition(context, args);
  } catch (error) {
    if (dispatched) return unconfirmedWrite("moodle_qbank_question_write_unconfirmed");
    return failure(String(error?.message || error).startsWith("moodle_") ? String(error.message) : "moodle_qbank_question_execution_failed");
  }
}
