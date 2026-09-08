(() => {
  if (globalThis.__morrowCanvasConnectorInstalled) return;
  globalThis.__morrowCanvasConnectorInstalled = true;

  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PAGES = 50;
  // Total Canvas pages one resumed list sequence may read across every bounded call.
  const MAX_RESUMED_PAGES = 500;
  const MAX_DISCOVERED_COURSES = 100;

  function currentCanvasCourseId() {
    const match = location.pathname.match(/(?:^|\/)courses\/([1-9][0-9]*)(?:\/|$)/);
    if (!match) throw new Error("canvas_course_context_missing");
    return match[1];
  }

  function pageId(value) {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return null;
    return /^[1-9][0-9]{0,18}$/.test(String(value)) ? String(value) : null;
  }

  async function bodyDigest(body) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function pageJson(url) {
    const response = await fetch(url, { credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json+canvas-string-ids" } });
    if (!response.ok) throw new Error("page_check_unavailable");
    return JSON.parse(await readBounded(response));
  }

  function courseId(value) {
    return pageId(value);
  }

  function courseSummary(value) {
    const id = courseId(value?.id);
    const name = typeof value?.name === "string" ? value.name.trim().slice(0, 300) : "";
    return id && name ? { id, name } : null;
  }

  async function courseJson(id) {
    const exactId = courseId(id);
    if (!exactId) throw new Error("canvas_course_id_invalid");
    const response = await fetch(new URL(`/api/v1/courses/${exactId}`, location.origin), {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_course_http_${response.status}`);
    const course = JSON.parse(await readBounded(response));
    if (courseId(course?.id) !== exactId) throw new Error("canvas_course_mismatch");
    return course;
  }

  function discoveryPage(value) {
    if (value === undefined) return 1;
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }

  function discoveryNextPage(value, currentPage) {
    if (!value) return null;
    const url = new URL(value);
    if (url.origin !== location.origin || url.pathname !== "/api/v1/courses") throw new Error("canvas_courses_next_invalid");
    const allowed = new Set(["enrollment_state", "per_page", "page"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
      || url.searchParams.getAll("enrollment_state").length !== 1 || url.searchParams.get("enrollment_state") !== "active"
      || url.searchParams.getAll("per_page").length !== 1 || url.searchParams.get("per_page") !== String(MAX_DISCOVERED_COURSES)
      || url.searchParams.getAll("page").length !== 1) throw new Error("canvas_courses_next_invalid");
    const rawPage = url.searchParams.get("page");
    if (!/^[1-9][0-9]*$/.test(rawPage || "")) throw new Error("canvas_courses_next_invalid");
    const page = discoveryPage(Number(rawPage));
    if (!page || page !== currentPage + 1) throw new Error("canvas_courses_next_invalid");
    return page;
  }

  async function listCourses(pageValue) {
    const page = discoveryPage(pageValue);
    if (!page) throw new Error("canvas_courses_page_invalid");
    const url = new URL(`/api/v1/courses?enrollment_state=active&per_page=${MAX_DISCOVERED_COURSES}&page=${page}`, location.origin);
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_courses_http_${response.status}`);
    const courses = JSON.parse(await readBounded(response));
    if (!Array.isArray(courses) || courses.length > MAX_DISCOVERED_COURSES) throw new Error("canvas_courses_invalid");
    const nextPage = discoveryNextPage(nextLink(response.headers.get("Link"), location.origin, url.pathname), page);
    return { courses: courses.map(courseSummary).filter(Boolean), complete: nextPage === null, nextPage };
  }

  async function checkedCourse(id) {
    const [profile, course] = await Promise.all([canvasProfile(), courseJson(id)]);
    const summary = courseSummary(course);
    if (!summary) throw new Error("canvas_course_invalid");
    return { profile, course: summary };
  }

  function pageTextChange(body, find, replacement) {
    const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    if (typeof body !== "string" || typeof find !== "string" || !find || typeof replacement !== "string" || find === replacement) throw new Error("page_text_invalid");
    const anchor = escape(find);
    const start = body.indexOf(anchor);
    if (start < 0 || body.indexOf(anchor, start + 1) !== -1) throw new Error("page_text_not_unique");
    const end = start + anchor.length;
    for (const entity of body.matchAll(/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);?/g)) {
      const entityStart = entity.index;
      const entityEnd = entityStart + entity[0].length;
      if ((entityStart < start && start < entityEnd) || (entityStart < end && end < entityEnd)) throw new Error("page_text_inside_entity");
    }
    const tags = /<!--[\s\S]*?-->|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g;
    let blocked = false;
    for (const match of body.matchAll(tags)) {
      const at = match.index;
      if (at >= end) break;
      if (at + match[0].length > start) throw new Error("page_text_inside_markup");
      if (/^<(script|style|iframe|object|embed|textarea|title)\b/i.test(match[0])) blocked = true;
      if (/^<\/(script|style|iframe|object|embed|textarea|title)\s*>/i.test(match[0])) blocked = false;
    }
    if (blocked) throw new Error("page_text_inside_embedded_content");
    return body.slice(0, start) + escape(replacement) + body.slice(end);
  }

  function pageFieldsMatch(page, fields) {
    return fields && typeof fields === "object" && !Array.isArray(fields)
      && Object.keys(fields).length === 6
      && typeof fields.url === "string" && typeof fields.title === "string" && typeof fields.published === "boolean"
      && typeof fields.front_page === "boolean" && typeof fields.editing_roles === "string"
      && (typeof fields.publish_at === "string" || fields.publish_at === null)
      && ["url", "title", "published", "front_page", "editing_roles", "publish_at"].every((field) => Object.hasOwn(fields, field) && page[field] === fields[field]);
  }

  function contentImages(fragment) {
    return [...fragment.querySelectorAll("img")].filter((image) => !image.closest("svg, math"));
  }

  function contentFragment(body) {
    const template = document.createElement("template");
    template.innerHTML = body;
    return template.content;
  }

  function escapeAlt(value) {
    return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  async function contentImageAltChange(body, guard) {
    if (!Number.isSafeInteger(guard.image_index) || guard.image_index < 1 || !Number.isSafeInteger(guard.image_start)
      || !Number.isSafeInteger(guard.image_end) || guard.image_start < 0 || guard.image_end < guard.image_start || guard.image_end >= body.length
      || typeof guard.image_tag_sha256 !== "string" || typeof guard.image_src_sha256 !== "string"
      || typeof guard.alt_text !== "string" || guard.alt_text.length > 500 || typeof guard.decorative !== "boolean"
      || (guard.decorative ? guard.alt_text !== "" : guard.alt_text.trim().length === 0)) throw new Error("page_image_alt_guard_invalid");
    const rawTag = body.slice(guard.image_start, guard.image_end + 1);
    if (!rawTag.startsWith("<") || !rawTag.endsWith(">") || await bodyDigest(rawTag) !== guard.image_tag_sha256) {
      throw new Error("page_image_alt_source_changed");
    }
    const rawFragment = contentFragment(rawTag);
    const rawImage = rawFragment.firstElementChild;
    if (rawFragment.childElementCount !== 1 || !(rawImage instanceof HTMLImageElement) || rawImage.hasAttribute("alt")) {
      throw new Error("page_image_alt_source_ambiguous");
    }
    const before = contentFragment(body);
    const beforeImages = contentImages(before);
    const selected = beforeImages[guard.image_index - 1];
    const source = selected?.getAttribute("src");
    if (!(selected instanceof HTMLImageElement) || !source || await bodyDigest(source) !== guard.image_src_sha256
      || selected.outerHTML !== rawImage.outerHTML || rawImage.getAttribute("src") !== source) {
      throw new Error("page_image_alt_target_changed");
    }
    const suffix = rawTag.endsWith("/>") ? "/>" : ">";
    const next = body.slice(0, guard.image_start) + rawTag.slice(0, -suffix.length) + ` alt="${escapeAlt(guard.alt_text)}"${suffix}` + body.slice(guard.image_end + 1);
    const after = contentFragment(next);
    const afterImages = contentImages(after);
    const changed = afterImages[guard.image_index - 1];
    if (!(changed instanceof HTMLImageElement) || afterImages.length !== beforeImages.length || changed.getAttribute("alt") !== guard.alt_text
      || changed.getAttribute("src") !== source) throw new Error("page_image_alt_dom_mismatch");
    const comparable = after.cloneNode(true);
    const comparableImage = contentImages(comparable)[guard.image_index - 1];
    if (!(comparableImage instanceof HTMLImageElement)) throw new Error("page_image_alt_dom_mismatch");
    comparableImage.removeAttribute("alt");
    if (!before.isEqualNode(comparable)) throw new Error("page_image_alt_dom_mismatch");
    return next;
  }

  function validPageGuard(guard) {
    const common = guard && typeof guard === "object" && !Array.isArray(guard) && pageId(guard.page_id)
      && pageId(guard.revision_id) && typeof guard.body_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.body_sha256)
      && pageFieldsMatch(guard.fields, guard.fields);
    if (!common) return false;
    if (guard.kind === "text") return typeof guard.find_text === "string" && guard.find_text.length > 0 && guard.find_text.length <= 10000
      && typeof guard.replace_text === "string" && guard.replace_text.length <= 10000
      && Object.keys(guard).every((key) => ["kind", "page_id", "revision_id", "body_sha256", "fields", "find_text", "replace_text"].includes(key));
    return guard.kind === "image_alt" && typeof guard.image_index === "number" && typeof guard.image_start === "number"
      && typeof guard.image_end === "number" && typeof guard.image_tag_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_tag_sha256)
      && typeof guard.image_src_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_src_sha256)
      && typeof guard.alt_text === "string" && typeof guard.decorative === "boolean"
      && (guard.decorative ? guard.alt_text === "" : guard.alt_text.trim().length > 0)
      && Object.keys(guard).every((key) => ["kind", "page_id", "revision_id", "body_sha256", "fields", "image_index", "image_start", "image_end", "image_tag_sha256", "image_src_sha256", "alt_text", "decorative"].includes(key));
  }

  async function checkPageSource(operation, args, url, expectedCourseId) {
    const guard = args.morrow_page_guard;
    if (operation.toolName !== "canvas_update_create_page_courses" || String(args.course_id) !== expectedCourseId
      || !validPageGuard(guard) || Object.keys(args).some((key) => key.startsWith("wiki_page_"))) throw new Error("page_check_invalid");
    const [page, revision] = await Promise.all([pageJson(url), pageJson(`${url.href}/revisions/latest`)]);
    if (pageId(page.page_id) !== guard.page_id || typeof page.body !== "string"
      || page.editor === "block_editor" || page.block_editor_attributes != null
      || await bodyDigest(page.body) !== guard.body_sha256
      || pageId(revision.revision_id) !== guard.revision_id || revision.latest !== true
      || revision.body !== page.body || revision.url !== page.url || revision.title !== page.title
      || !pageFieldsMatch(page, guard.fields)) {
      throw new Error("page_changed: This page changed or could not be checked. No change was sent. Create a new review from the current page.");
    }
    return guard.kind === "text"
      ? pageTextChange(page.body, guard.find_text, guard.replace_text)
      : await contentImageAltChange(page.body, guard);
  }

  async function verifyPageChange(args, url) {
    const guard = args.morrow_page_guard;
    const base = { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: "lossless-page-revision", priorRevisionId: guard.revision_id };
    try {
      const [page, revision, history] = await Promise.all([pageJson(url), pageJson(`${url.href}/revisions/latest`), pageJson(`${url.href}/revisions?per_page=2`)]);
      const latestId = pageId(revision.revision_id);
      const exactHistory = Array.isArray(history) && history.length === 2
        && history.every((row) => row && pageId(row.revision_id))
        && new Set(history.map((row) => pageId(row.revision_id))).size === 2
        && history.some((row) => pageId(row.revision_id) === guard.revision_id)
        && history.some((row) => pageId(row.revision_id) === latestId && row.latest === true);
      const samePage = pageId(page.page_id) === guard.page_id && page.body === args.wiki_page_body
        && revision.body === args.wiki_page_body && revision.url === guard.fields.url && revision.title === guard.fields.title
        && pageFieldsMatch(page, guard.fields);
      if (!latestId || !exactHistory || latestId === guard.revision_id || revision.latest !== true || !samePage) return { ...base, reason: "page_or_revision_chain_did_not_match" };
      if (guard.kind === "image_alt") {
        const image = contentImages(contentFragment(page.body))[guard.image_index - 1];
        if (!(image instanceof HTMLImageElement) || image.getAttribute("alt") !== guard.alt_text || await bodyDigest(String(image.getAttribute("src") || "")) !== guard.image_src_sha256) {
          return { ...base, reason: "saved_image_alt_reaudit_did_not_match" };
        }
        return { ...base, status: "verified", createdRevisionId: latestId, evidence: "full_page_preserved_and_selected_image_alt_reaudited" };
      }
      return { ...base, status: "verified", createdRevisionId: latestId, evidence: "full_page_preserved_and_one_new_revision" };
    } catch {
      return { ...base, reason: "page_readback_incomplete" };
    }
  }

  function validImageAltGuard(guard, allowed) {
    return Number.isSafeInteger(guard.image_index) && guard.image_index >= 1
      && Number.isSafeInteger(guard.image_start) && guard.image_start >= 0
      && Number.isSafeInteger(guard.image_end) && guard.image_end >= guard.image_start
      && typeof guard.image_tag_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_tag_sha256)
      && typeof guard.image_src_sha256 === "string" && /^[0-9a-f]{64}$/.test(guard.image_src_sha256)
      && typeof guard.alt_text === "string" && guard.alt_text.length <= 500
      && typeof guard.decorative === "boolean" && (guard.decorative ? guard.alt_text === "" : guard.alt_text.trim().length > 0)
      && Object.keys(guard).every((key) => allowed.includes(key));
  }

  function canvasContentTarget(guard) {
    if (guard.kind === "assignment_image_alt") {
      return {
        toolName: "canvas_edit_assignment",
        operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment",
        idField: "id",
        guardIdField: "assignment_id",
        contentField: "description",
        requestField: "assignment_description",
      };
    }
    if (guard.kind === "discussion_image_alt") {
      return {
        toolName: "canvas_update_topic_courses",
        operationKey: "PUT /v1/courses/{course_id}/discussion_topics/{topic_id}#update_topic_courses",
        idField: "topic_id",
        guardIdField: "topic_id",
        contentField: "message",
        requestField: "message",
      };
    }
    if (guard.kind === "classic_quiz_description_image_alt") {
      return {
        toolName: "canvas_edit_quiz",
        operationKey: "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz",
        idField: "id",
        guardIdField: "quiz_id",
        contentField: "description",
        requestField: "quiz_description",
      };
    }
    if (guard.kind === "classic_quiz_question_image_alt") {
      return {
        toolName: "canvas_update_existing_quiz_question",
        operationKey: "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question",
        idField: "id",
        guardIdField: "question_id",
        quizIdField: "quiz_id",
        guardQuizIdField: "quiz_id",
        contentKind: "classic_quiz_question",
        selectorField: "classic_quiz_answer",
      };
    }
    if (guard.kind === "new_quiz_item_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        contentField: "entry.item_body",
        requestField: "item_entry_item_body",
        contentKind: "new_quiz_item_body",
      };
    }
    if (guard.kind === "new_quiz_choice_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        requestField: "item_entry_interaction_data",
        contentKind: "new_quiz_choice",
        selectorField: "choice_id",
      };
    }
    if (guard.kind === "new_quiz_answer_feedback_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        requestField: "item_entry_answer_feedback",
        contentKind: "new_quiz_answer_feedback",
        selectorField: "choice_id",
      };
    }
    if (guard.kind === "new_quiz_feedback_image_alt") {
      return {
        toolName: "canvas_update_quiz_item",
        operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item",
        idField: "item_id",
        guardIdField: "item_id",
        quizIdField: "assignment_id",
        guardQuizIdField: "assignment_id",
        requestField: "item_entry_feedback_" + guard.feedback_type,
        contentKind: "new_quiz_feedback",
        selectorField: "feedback_type",
      };
    }
    return null;
  }

  function legacyPageGuardFromCanvasContent(guard) {
    if (guard?.kind !== "page_text" && guard?.kind !== "page_image_alt") return null;
    const { course_id: _courseId, ...pageGuard } = guard;
    return { ...pageGuard, kind: guard.kind === "page_text" ? "text" : "image_alt" };
  }

  function validCanvasContentPageGuard(guard) {
    if (!guard || typeof guard !== "object" || Array.isArray(guard) || !courseId(guard.course_id)
      || typeof guard.body_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.body_sha256)) return false;
    const pageGuard = legacyPageGuardFromCanvasContent(guard);
    return Boolean(pageGuard && validPageGuard(pageGuard));
  }

  function validCanvasContentGuard(guard) {
    if (validCanvasContentPageGuard(guard)) return true;
    if (!guard || typeof guard !== "object" || Array.isArray(guard)
      || typeof guard.kind !== "string" || !courseId(guard.course_id)
      || typeof guard.body_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.body_sha256)
      || typeof guard.protected_state_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(guard.protected_state_sha256)) return false;
    const target = canvasContentTarget(guard);
    const idFields = target?.guardQuizIdField ? [target.guardQuizIdField, target.guardIdField] : target ? [target.guardIdField] : [];
    const selectorValid = target?.selectorField === "choice_id"
      ? typeof guard.choice_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(guard.choice_id)
      : target?.selectorField === "feedback_type"
        ? ["correct", "incorrect", "neutral"].includes(guard.feedback_type)
        : target?.selectorField === "classic_quiz_answer"
          ? validClassicQuizAnswerSelector(guard)
          : !target?.selectorField;
    const selectorFields = target?.selectorField === "classic_quiz_answer" ? CLASSIC_QUIZ_ANSWER_SELECTOR_FIELDS
      : target?.selectorField ? [target.selectorField] : [];
    return Boolean(target && selectorValid && idFields.every((field) => pageId(guard[field]))
      && validImageAltGuard(guard, ["kind", "course_id", ...idFields, ...selectorFields, "body_sha256", "protected_state_sha256", "image_index", "image_start", "image_end", "image_tag_sha256", "image_src_sha256", "alt_text", "decorative"]));
  }

  function newQuizEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.entry_type !== "Item"
      || !value.entry || typeof value.entry !== "object" || Array.isArray(value.entry)) throw new Error("canvas_content_target_changed");
    return value.entry;
  }

  function directNewQuizChoices(entry, choiceId) {
    const interaction = entry.interaction_data;
    if (!["choice", "multi-answer", "ordering"].includes(entry.interaction_type_slug)
      || !interaction || typeof interaction !== "object" || Array.isArray(interaction) || !Array.isArray(interaction.choices)
      || !interaction.choices.length || interaction.choices.some((choice) => !choice || typeof choice !== "object" || Array.isArray(choice)
        || typeof choice.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(choice.id) || typeof choice.item_body !== "string")) {
      throw new Error("canvas_content_target_changed");
    }
    const ids = interaction.choices.map((choice) => choice.id);
    if (new Set(ids).size !== ids.length) throw new Error("canvas_content_target_changed");
    const selected = interaction.choices.find((choice) => choice.id === choiceId);
    if (!selected) throw new Error("canvas_content_target_changed");
    return { interaction, selected };
  }

  // A Classic Quiz question repair names one answer field or none: the image is
  // in the question text, or in exactly one field of exactly one answer.
  const CLASSIC_QUIZ_ANSWER_SELECTOR_FIELDS = ["answer_id", "answer_field"];
  const CLASSIC_QUIZ_ANSWER_SELECTOR_HTML_FIELDS = ["answer_text", "answer_html"];

  function validClassicQuizAnswerSelector(guard) {
    if (!Object.hasOwn(guard, "answer_id") && !Object.hasOwn(guard, "answer_field")) return true;
    return Boolean(pageId(guard.answer_id)) && CLASSIC_QUIZ_ANSWER_SELECTOR_HTML_FIELDS.includes(guard.answer_field);
  }

  function classicQuizAnswerSelected(guard) {
    return Object.hasOwn(guard, "answer_id");
  }

  // Canvas rebuilds a Classic Quiz question from the whole request through
  // AssessmentQuestion.parse_question, so a field this write leaves out is
  // rebuilt from a default rather than preserved. Every field below is read
  // fresh and sent back unchanged, and a question whose fresh read cannot
  // supply one of them is refused instead of rebuilt. That round trip is
  // live-unverified: no connected Canvas tenant has proved it.
  const CLASSIC_QUIZ_QUESTION_TEXT_FIELDS = ["question_name", "question_text", "correct_comments", "incorrect_comments", "neutral_comments"];
  // Canvas derives these from the request. The write has no parameter for them,
  // and the protected-state digest still covers them.
  const CLASSIC_QUIZ_QUESTION_DERIVED_FIELDS = ["id", "quiz_id", "quiz_group_id", "assessment_question_id", "correct_comments_html", "incorrect_comments_html", "neutral_comments_html"];
  const CLASSIC_QUIZ_QUESTION_TYPES = ["multiple_choice_question", "true_false_question", "multiple_answers_question", "short_answer_question", "essay_question"];
  const CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES = ["essay_question"];
  const CLASSIC_QUIZ_ANSWER_DERIVED_FIELDS = ["answer_comment_html"];
  const MAX_CLASSIC_QUIZ_ANSWERS = 100;

  // A field name Canvas returned is untrusted text, so a refusal repeats it
  // only when it is a plain identifier and says "an unexpected field" otherwise.
  function reportableFieldName(name) {
    return /^[A-Za-z0-9_]{1,60}$/.test(String(name)) ? String(name) : "an unexpected field";
  }

  function classicQuizPoints(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ? value : null;
  }

  function classicQuizQuestionAnswers(value) {
    const answers = value.answers;
    if (CLASSIC_QUIZ_ANSWERLESS_QUESTION_TYPES.includes(value.question_type)) {
      if (answers !== undefined && (!Array.isArray(answers) || answers.length > 0)) {
        throw new Error("classic_quiz_question_unmodelled_state: Canvas returned answers for this essay question, and this repair cannot send them back. No change was sent.");
      }
      return [];
    }
    if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_CLASSIC_QUIZ_ANSWERS) {
      throw new Error("classic_quiz_question_incomplete: Canvas did not return the answers for this question, and Morrow will not rebuild a question without them. No change was sent.");
    }
    const seen = new Set();
    return answers.map((answer) => {
      if (!plainObject(answer)) {
        throw new Error("classic_quiz_question_incomplete: Canvas did not return one of this question's answers as a record, and Morrow will not rebuild a question without it. No change was sent.");
      }
      const unmodelled = Object.keys(answer).find((field) => !CLASSIC_QUIZ_ANSWER_FIELDS.includes(field) && !CLASSIC_QUIZ_ANSWER_DERIVED_FIELDS.includes(field));
      if (unmodelled) {
        throw new Error(`classic_quiz_question_unmodelled_state: Canvas returned ${reportableFieldName(unmodelled)} on an answer of this question, and this repair cannot send it back. No change was sent.`);
      }
      const id = pageId(answer.id);
      if (!id || seen.has(id)) {
        throw new Error("classic_quiz_question_incomplete: Canvas did not return one exact identifier for every answer of this question, and Morrow will not rebuild a question without them. No change was sent.");
      }
      seen.add(id);
      if (typeof answer.answer_text !== "string" || !Number.isInteger(answer.answer_weight) || answer.answer_weight < 0 || answer.answer_weight > 100) {
        throw new Error("classic_quiz_question_incomplete: Canvas did not return answer_text and answer_weight for every answer of this question, and Morrow will not rebuild a question without them. No change was sent.");
      }
      const rebuilt = { id, answer_text: answer.answer_text, answer_weight: answer.answer_weight };
      for (const field of ["answer_comments", "answer_html", "text_after_answers"]) {
        if (!Object.hasOwn(answer, field)) continue;
        if (typeof answer[field] !== "string") {
          throw new Error(`classic_quiz_question_incomplete: Canvas returned ${field} on an answer of this question in a form Morrow cannot send back. No change was sent.`);
        }
        rebuilt[field] = answer[field];
      }
      return rebuilt;
    });
  }

  /** The complete Classic Quiz question payload rebuilt from one fresh read, or a refusal that names what stopped it. */
  function classicQuizQuestion(value, guard) {
    if (!plainObject(value) || pageId(value.quiz_id) !== guard.quiz_id) throw new Error("canvas_content_target_changed");
    if (value.quiz_group_id !== undefined && value.quiz_group_id !== null) {
      throw new Error("classic_quiz_question_group_linked: This question belongs to a question group, so Canvas can rebuild it from a question bank and a change here could reach other quizzes. No change was sent.");
    }
    if (!CLASSIC_QUIZ_QUESTION_TYPES.includes(value.question_type)) {
      throw new Error("classic_quiz_question_type_unsupported: Morrow repairs images only in multiple choice, true or false, multiple answers, short answer, and essay Classic Quiz questions. No change was sent.");
    }
    const unmodelled = Object.keys(value).find((field) => !CLASSIC_QUIZ_QUESTION_TEXT_FIELDS.includes(field)
      && !CLASSIC_QUIZ_QUESTION_DERIVED_FIELDS.includes(field)
      && !["question_type", "points_possible", "position", "text_after_answers", "answers"].includes(field));
    if (unmodelled) {
      throw new Error(`classic_quiz_question_unmodelled_state: Canvas returned ${reportableFieldName(unmodelled)} for this question, and this repair cannot send it back. No change was sent.`);
    }
    for (const field of CLASSIC_QUIZ_QUESTION_TEXT_FIELDS) {
      if (typeof value[field] !== "string") {
        throw new Error(`classic_quiz_question_incomplete: Canvas did not return ${field} for this question, and Morrow will not rebuild a question without it. No change was sent.`);
      }
    }
    const points = classicQuizPoints(value.points_possible);
    if (points === null) {
      throw new Error("classic_quiz_question_incomplete: Canvas did not return points_possible for this question, and Morrow will not rebuild a question without it. No change was sent.");
    }
    if (!Number.isSafeInteger(value.position) || value.position < 1) {
      throw new Error("classic_quiz_question_incomplete: Canvas did not return position for this question, and Morrow will not rebuild a question without it. No change was sent.");
    }
    if (Object.hasOwn(value, "text_after_answers") && typeof value.text_after_answers !== "string") {
      throw new Error("classic_quiz_question_incomplete: Canvas returned text_after_answers for this question in a form Morrow cannot send back. No change was sent.");
    }
    const answers = classicQuizQuestionAnswers(value);
    if (classicQuizAnswerSelected(guard) && answers.filter((answer) => answer.id === guard.answer_id).length !== 1) {
      throw new Error("classic_quiz_question_answer_unavailable: The selected answer is no longer one exact answer of this question. No change was sent.");
    }
    return { points, answers };
  }

  function classicQuizQuestionBody(value, guard) {
    const { answers } = classicQuizQuestion(value, guard);
    if (!classicQuizAnswerSelected(guard)) return value.question_text;
    const selected = answers.find((answer) => answer.id === guard.answer_id);
    if (typeof selected[guard.answer_field] !== "string") {
      throw new Error("classic_quiz_question_answer_unavailable: Canvas did not return the selected answer field of this question. No change was sent.");
    }
    return selected[guard.answer_field];
  }

  function contentBody(value, target, guard) {
    if (target.contentKind === "classic_quiz_question") return classicQuizQuestionBody(value, guard);
    if (target.contentKind === "new_quiz_item_body") return newQuizEntry(value).item_body;
    if (target.contentKind === "new_quiz_choice") return directNewQuizChoices(newQuizEntry(value), guard.choice_id).selected.item_body;
    if (target.contentKind === "new_quiz_answer_feedback") {
      const entry = newQuizEntry(value);
      if (entry.interaction_type_slug !== "choice") throw new Error("canvas_content_target_changed");
      directNewQuizChoices(entry, guard.choice_id);
      if (!entry.answer_feedback || typeof entry.answer_feedback !== "object" || Array.isArray(entry.answer_feedback)
        || Object.entries(entry.answer_feedback).some(([id, content]) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id) || typeof content !== "string")
        || typeof entry.answer_feedback[guard.choice_id] !== "string") throw new Error("canvas_content_target_changed");
      return entry.answer_feedback[guard.choice_id];
    }
    if (target.contentKind === "new_quiz_feedback") {
      const feedback = newQuizEntry(value).feedback;
      if (!feedback || typeof feedback !== "object" || Array.isArray(feedback) || typeof feedback[guard.feedback_type] !== "string") throw new Error("canvas_content_target_changed");
      return feedback[guard.feedback_type];
    }
    return value?.[target.contentField];
  }

  function contentWriteArguments(before, target, guard, body) {
    if (target.contentKind === "classic_quiz_question") {
      const { points, answers } = classicQuizQuestion(before, guard);
      const selected = classicQuizAnswerSelected(guard);
      const rebuilt = selected
        ? answers.map((answer) => answer.id === guard.answer_id ? { ...answer, [guard.answer_field]: body } : answer)
        : answers;
      return {
        question_question_name: before.question_name,
        question_question_text: selected ? before.question_text : body,
        question_question_type: before.question_type,
        question_points_possible: points,
        question_position: String(before.position),
        question_correct_comments: before.correct_comments,
        question_incorrect_comments: before.incorrect_comments,
        question_neutral_comments: before.neutral_comments,
        ...(typeof before.text_after_answers === "string" ? { question_text_after_answers: before.text_after_answers } : {}),
        ...(rebuilt.length ? { question_answers: rebuilt } : {}),
      };
    }
    if (target.contentKind === "new_quiz_choice") {
      const { interaction } = directNewQuizChoices(newQuizEntry(before), guard.choice_id);
      return { item_entry_interaction_data: {
        ...interaction,
        choices: interaction.choices.map((choice) => choice.id === guard.choice_id ? { ...choice, item_body: body } : choice),
      } };
    }
    if (target.contentKind === "new_quiz_answer_feedback") {
      const entry = newQuizEntry(before);
      if (!entry.answer_feedback || typeof entry.answer_feedback !== "object" || Array.isArray(entry.answer_feedback)) throw new Error("canvas_content_target_changed");
      return { item_entry_answer_feedback: { ...entry.answer_feedback, [guard.choice_id]: body } };
    }
    return { [target.requestField]: body };
  }

  function requestedContentBody(args, target, guard) {
    if (target.contentKind === "classic_quiz_question") {
      if (!classicQuizAnswerSelected(guard)) return typeof args.question_question_text === "string" ? args.question_question_text : null;
      const answers = Array.isArray(args.question_answers) ? args.question_answers : [];
      const selected = answers.filter((answer) => plainObject(answer) && answer.id === guard.answer_id);
      return selected.length === 1 && typeof selected[0][guard.answer_field] === "string" ? selected[0][guard.answer_field] : null;
    }
    if (target.contentKind === "new_quiz_choice") {
      const interaction = args.item_entry_interaction_data;
      if (!interaction || typeof interaction !== "object" || Array.isArray(interaction) || !Array.isArray(interaction.choices)) return null;
      const selected = interaction.choices.find((choice) => choice && typeof choice === "object" && !Array.isArray(choice) && choice.id === guard.choice_id);
      return typeof selected?.item_body === "string" ? selected.item_body : null;
    }
    if (target.contentKind === "new_quiz_answer_feedback") {
      const feedback = args.item_entry_answer_feedback;
      return feedback && typeof feedback === "object" && !Array.isArray(feedback) && typeof feedback[guard.choice_id] === "string" ? feedback[guard.choice_id] : null;
    }
    return typeof args[target.requestField] === "string" ? args[target.requestField] : null;
  }

  async function protectedContentState(value, target, expectedCourseId, expectedItemId, guard) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || pageId(value.id) !== expectedItemId || (Object.hasOwn(value, "course_id") && courseId(value.course_id) !== expectedCourseId)
      || typeof contentBody(value, target, guard) !== "string") throw new Error("canvas_content_target_changed");
    const protectedFields = structuredClone(value);
    if (target.contentKind === "classic_quiz_question") {
      if (!classicQuizAnswerSelected(guard)) delete protectedFields.question_text;
      else {
        const answer = Array.isArray(protectedFields.answers)
          ? protectedFields.answers.filter((candidate) => plainObject(candidate) && pageId(candidate.id) === guard.answer_id)
          : [];
        if (answer.length !== 1) throw new Error("canvas_content_target_changed");
        delete answer[0][guard.answer_field];
      }
    } else if (target.contentKind?.startsWith("new_quiz_")) {
      const entry = newQuizEntry(protectedFields);
      delete entry.updated_at;
      if (target.contentKind === "new_quiz_item_body") delete entry.item_body;
      else if (target.contentKind === "new_quiz_choice") {
        const { selected } = directNewQuizChoices(entry, guard.choice_id);
        delete selected.item_body;
      } else if (target.contentKind === "new_quiz_answer_feedback") {
        if (!entry.answer_feedback || typeof entry.answer_feedback !== "object" || Array.isArray(entry.answer_feedback)) throw new Error("canvas_content_target_changed");
        delete entry.answer_feedback[guard.choice_id];
      } else if (target.contentKind === "new_quiz_feedback") {
        if (!entry.feedback || typeof entry.feedback !== "object" || Array.isArray(entry.feedback)) throw new Error("canvas_content_target_changed");
        delete entry.feedback[guard.feedback_type];
      }
    } else delete protectedFields[target.contentField];
    delete protectedFields.updated_at;
    return await bodyDigest(stable(protectedFields));
  }

  async function checkCanvasContentSource(operation, args, url, expectedCourseId) {
    const guard = args.morrow_canvas_content_guard;
    if (!validCanvasContentGuard(guard) || guard.course_id !== expectedCourseId) throw new Error("canvas_content_guard_invalid");
    if (validCanvasContentPageGuard(guard)) {
      const pageGuard = legacyPageGuardFromCanvasContent(guard);
      if (operation.toolName !== "canvas_update_create_page_courses" || operation.key !== "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses"
        || !pageGuard || !Object.keys(args).every((key) => ["course_id", "url_or_id", "morrow_canvas_content_guard"].includes(key))) {
        throw new Error("canvas_content_check_invalid");
      }
      return {
        target: { requestField: "wiki_page_body", pageGuard },
        writeArguments: { wiki_page_body: await checkPageSource(operation, { ...args, morrow_page_guard: pageGuard }, url, expectedCourseId) },
      };
    }
    const target = canvasContentTarget(guard);
    const idFields = target?.quizIdField ? [target.quizIdField, target.idField] : target ? [target.idField] : [];
    const guardIdFields = target?.guardQuizIdField ? [target.guardQuizIdField, target.guardIdField] : target ? [target.guardIdField] : [];
    if (!target || operation.toolName !== target.toolName || operation.key !== target.operationKey
      || String(args.course_id) !== expectedCourseId || !idFields.every((field, index) => String(args[field]) === guard[guardIdFields[index]])
      || !Object.keys(args).every((key) => ["course_id", ...idFields, "morrow_canvas_content_guard"].includes(key))) {
      throw new Error("canvas_content_check_invalid");
    }
    const before = await pageJson(url);
    const itemId = guard[target.guardIdField];
    const body = contentBody(before, target, guard);
    if (typeof body !== "string" || await bodyDigest(body) !== guard.body_sha256
      || await protectedContentState(before, target, expectedCourseId, itemId, guard) !== guard.protected_state_sha256) {
      throw new Error("canvas_content_changed: This Canvas content changed or could not be checked. No change was sent. Create a new review from the current content.");
    }
    const nextBody = await contentImageAltChange(body, guard);
    return { target, writeArguments: contentWriteArguments(before, target, guard, nextBody) };
  }

  async function verifyCanvasContentChange(args, url, expectedCourseId) {
    const guard = args.morrow_canvas_content_guard;
    if (validCanvasContentPageGuard(guard)) {
      const pageGuard = legacyPageGuardFromCanvasContent(guard);
      return await verifyPageChange({ ...args, morrow_page_guard: pageGuard }, url);
    }
    const target = validCanvasContentGuard(guard) ? canvasContentTarget(guard) : null;
    const base = { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: "lossless-canvas-content" };
    if (!target) return { ...base, reason: "canvas_content_guard_missing" };
    try {
      const after = await pageJson(url);
      const itemId = guard[target.guardIdField];
      const body = contentBody(after, target, guard);
      if (typeof body !== "string" || body !== requestedContentBody(args, target, guard)
        || await protectedContentState(after, target, expectedCourseId, itemId, guard) !== guard.protected_state_sha256) {
        return { ...base, status: "mismatch", reason: "saved_canvas_content_did_not_preserve_target_state" };
      }
      const image = contentImages(contentFragment(body))[guard.image_index - 1];
      if (!(image instanceof HTMLImageElement) || image.getAttribute("alt") !== guard.alt_text
        || await bodyDigest(String(image.getAttribute("src") || "")) !== guard.image_src_sha256) {
        return { ...base, status: "mismatch", reason: "saved_canvas_content_image_alt_reaudit_did_not_match" };
      }
      return { ...base, status: "verified", evidence: "full_canvas_content_preserved_and_selected_image_alt_reaudited" };
    } catch {
      return { ...base, reason: "canvas_content_readback_incomplete" };
    }
  }

  async function readBounded(response) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("canvas_response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  function parsePayload(text, contentType) {
    if (!text) return null;
    if (/application\/(?:json|problem\+json)|text\/json/i.test(contentType || "")) {
      return JSON.parse(text);
    }
    return { text: text.slice(0, MAX_RESPONSE_BYTES) };
  }

  // Canvas answers a list read with a Link header. Only a link on this origin and
  // on the exact path Morrow requested is followed, so a redirected or foreign
  // next link refuses the read instead of silently reading somewhere else. Real
  // Canvas Link header shapes are live-unverified, so a Canvas deployment that
  // paginates onto a different path would stop here rather than be followed.
  function linkHeaderUrls(value, origin, pathname, requested) {
    const links = new Map();
    const raw = String(value || "");
    if (!raw.trim()) return links;
    for (const part of raw.split(",")) {
      const match = /^\s*<([^>]+)>;\s*rel="?([a-z]+)"?\s*$/i.exec(part);
      if (!match) throw new Error("canvas_pagination_header_refused");
      const relation = match[2].toLowerCase();
      const url = new URL(match[1]);
      if (url.origin !== origin || url.pathname !== pathname) {
        if (relation === "next") throw new Error("canvas_pagination_origin_refused");
        continue;
      }
      if (relation === "next" && requested && !sameRequestParameters(url, requested)) {
        throw new Error("canvas_pagination_parameters_refused");
      }
      if (links.has(relation)) throw new Error("canvas_pagination_header_refused");
      links.set(relation, url);
    }
    return links;
  }

  function nextLink(value, origin, pathname) {
    return linkHeaderUrls(value, origin, pathname).get("next")?.href || null;
  }

  function paginationPage(url) {
    const raw = url ? url.searchParams.get("page") : null;
    return /^[1-9][0-9]{0,8}$/.test(raw || "") ? Number(raw) : null;
  }

  // Canvas sends rel="last" with numeric pagination and omits it for bookmark
  // cursors, so the exact unread page count is available only in the numeric
  // case. null means "not stated by Canvas", never zero. Live-unverified.
  function unreadPageCount(links) {
    const next = paginationPage(links.get("next"));
    const last = paginationPage(links.get("last"));
    return next !== null && last !== null && last >= next ? last - next + 1 : null;
  }

  // A later page must preserve every query that defined the first page. Canvas
  // may add one bounded per_page value and one page cursor. It may not remove a
  // filter, change a value, repeat a control, or add a new query that widens the
  // read.
  function sameRequestParameters(resumed, requested) {
    const requestedNames = new Set(requested.searchParams.keys());
    const resumedNames = new Set(resumed.searchParams.keys());
    for (const name of requestedNames) {
      if (name === "page" || name === "per_page") continue;
      const expected = requested.searchParams.getAll(name);
      const observed = resumed.searchParams.getAll(name);
      if (observed.length !== expected.length || expected.some((value, index) => observed[index] !== value)) return false;
    }
    for (const name of resumedNames) if (name !== "page" && name !== "per_page" && !requestedNames.has(name)) return false;
    const pages = resumed.searchParams.getAll("page");
    if (pages.length !== 1 || pages[0].length < 1 || pages[0].length > 1_024) return false;
    const expectedPerPage = requested.searchParams.getAll("per_page");
    const observedPerPage = resumed.searchParams.getAll("per_page");
    if (expectedPerPage.length > 0) {
      if (observedPerPage.length !== expectedPerPage.length
        || expectedPerPage.some((value, index) => observedPerPage[index] !== value)) return false;
    } else if (observedPerPage.length > 1
      || (observedPerPage.length === 1 && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(observedPerPage[0]))) return false;
    return true;
  }

  function encodeResumeToken(href, pagesRead) {
    return btoa(JSON.stringify({ v: 1, p: pagesRead, u: href })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  // The token is opaque to every caller: it is only ever decoded here, and it is
  // accepted only when it names this origin, the exact path of the request the
  // caller just made, and a page count inside the resumed-sequence cap.
  function decodeResumeToken(value, requested) {
    if (typeof value !== "string" || value.length < 8 || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("canvas_pagination_resume_refused");
    }
    let decoded;
    try {
      decoded = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
    } catch {
      throw new Error("canvas_pagination_resume_refused");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded.v !== 1
      || !Number.isSafeInteger(decoded.p) || decoded.p < 1 || decoded.p >= MAX_RESUMED_PAGES
      || typeof decoded.u !== "string") {
      throw new Error("canvas_pagination_resume_refused");
    }
    let url;
    try {
      url = new URL(decoded.u);
    } catch {
      throw new Error("canvas_pagination_resume_refused");
    }
    if (url.protocol !== location.protocol || url.origin !== location.origin
      || url.pathname !== requested.pathname || url.hash !== "" || !sameRequestParameters(url, requested)) {
      throw new Error("canvas_pagination_resume_refused");
    }
    return { href: url.href, pagesRead: decoded.p };
  }

  function listResumeRequest(args, isRead) {
    const value = args.morrow_list_resume;
    if (value === undefined) return null;
    if (!isRead || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => key !== "next_page")) {
      throw new Error("canvas_pagination_resume_refused");
    }
    return value;
  }

  function appendValue(target, name, value) {
    if (Array.isArray(value)) {
      for (const entry of value) target.append(name, typeof entry === "object" ? JSON.stringify(entry) : String(entry));
      return;
    }
    target.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }

  function wirePath(name) {
    return String(name || "").match(/[^\[\]]+/g) || [];
  }

  function assignJsonValue(target, name, value) {
    const path = wirePath(name);
    if (path.length === 0) throw new TypeError("canvas_body_parameter_invalid");
    let current = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const part = path[index];
      if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
      current = current[part];
    }
    current[path[path.length - 1]] = value;
  }

  // The two New Quizzes write rules, copied from
  // src/new-quiz-write-contract.js because Chrome injects this file as a
  // classic script with no module scope.
  // scripts/test/canvas-new-quiz-write-contract.test.mjs executes both copies
  // and fails if one of them disagrees with that file.
  //
  // Every POST and PATCH on /api/quiz/v1 sends a JSON body, not only the two
  // item routes: New Quizzes is a separate service from the Canvas Rails API,
  // and the harvested client sends JSON for all of them. Both encodings are
  // live-unverified against a Morrow-connected tenant.
  function usesJsonBody(operation) {
    return operation?.family === "new-quizzes"
      && typeof operation.path === "string" && operation.path.startsWith("/quiz/v1/")
      && ["POST", "PATCH"].includes(operation.method);
  }

  const NEW_QUIZ_SETTINGS_MERGE_GROUPS = ["filters", "multiple_attempts", "result_view_settings"];
  const NEW_QUIZ_SETTINGS_WIRE_PREFIX = "quiz[quiz_settings]";
  const NEW_QUIZ_SETTINGS_OPERATION_KEY = "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}#update_single_quiz";

  function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function mergeQuizSettings(current, requested) {
    const base = plainObject(current) ? current : {};
    const change = plainObject(requested) ? requested : {};
    const merged = { ...base, ...change };
    const preserved = [];
    for (const key of Object.keys(base)) {
      const grouped = NEW_QUIZ_SETTINGS_MERGE_GROUPS.includes(key) && plainObject(base[key]);
      if (grouped && plainObject(change[key])) {
        merged[key] = { ...base[key], ...change[key] };
        for (const leaf of Object.keys(base[key])) {
          if (!Object.hasOwn(change[key], leaf)) preserved.push(`${key}.${leaf}`);
        }
      } else if (Object.hasOwn(change, key)) {
        // The caller replaced the whole value, group or not, so nothing here was kept.
      } else if (grouped) {
        for (const leaf of Object.keys(base[key])) preserved.push(`${key}.${leaf}`);
      } else {
        preserved.push(key);
      }
    }
    return { merged, preserved: preserved.sort() };
  }

  // The settings leaves this request actually carries, rebuilt as the nested
  // object the New Quizzes service expects. null means the change touches no
  // setting, so the title, instructions, dates and points of a quiz can still
  // be changed without reading its settings first.
  function requestedQuizSettings(operation, args) {
    const requested = {};
    let present = false;
    for (const parameter of operation.parameters || []) {
      const wireName = String(parameter.wireName || "");
      if (parameter.location !== "form" || !wireName.startsWith(NEW_QUIZ_SETTINGS_WIRE_PREFIX)) continue;
      const value = args[parameter.inputName];
      if (value === undefined) continue;
      present = true;
      assignJsonValue(requested, wireName.slice(NEW_QUIZ_SETTINGS_WIRE_PREFIX.length), value);
    }
    return present ? requested : null;
  }

  function validNewQuizSettingsGuard(guard) {
    return plainObject(guard) && Object.keys(guard).length === 1
      && typeof guard.current_quiz_settings_sha256 === "string"
      && /^[0-9a-f]{64}$/.test(guard.current_quiz_settings_sha256);
  }

  // A partial quiz_settings PATCH can replace the whole block, so changing one
  // setting can delete every setting nobody asked about. The merge is the
  // safety property, not an advisory step: a quiz Morrow cannot read is a
  // refusal, never a warning, and the request is not sent.
  async function checkNewQuizSettingsSource(operation, args, url) {
    const guard = args.morrow_new_quiz_settings_guard;
    const settings = operation.key === NEW_QUIZ_SETTINGS_OPERATION_KEY ? requestedQuizSettings(operation, args) : null;
    if (!settings) {
      if (guard !== undefined) {
        throw new Error("new_quiz_settings_guard_refused: This change does not alter New Quiz settings, so it must not carry a settings guard. No change was sent.");
      }
      return null;
    }
    if (!validNewQuizSettingsGuard(guard)) {
      throw new Error("new_quiz_settings_guard_required: This New Quiz settings change needs the current settings from a fresh read of this quiz. No change was sent.");
    }
    let before;
    try {
      before = await pageJson(url);
    } catch {
      throw new Error("new_quiz_settings_read_failed: Morrow could not read this quiz before changing its settings. No change was sent.");
    }
    const quizId = pageId(args.assignment_id);
    if (!quizId || !plainObject(before) || pageId(before.id) !== quizId || !plainObject(before.quiz_settings)
      || (before.course_id !== undefined && pageId(before.course_id) !== pageId(args.course_id))) {
      throw new Error("new_quiz_settings_target_changed: This quiz does not report the settings Morrow has to preserve. No change was sent.");
    }
    if (await bodyDigest(stable(before.quiz_settings)) !== guard.current_quiz_settings_sha256) {
      throw new Error("new_quiz_settings_stale: These New Quiz settings changed in Canvas after they were read. No change was sent. Read the settings again and make a new change.");
    }
    return mergeQuizSettings(before.quiz_settings, settings);
  }

  async function verifyNewQuizSettingsChange(args, url, expectedSettings) {
    const base = { schema: "morrow.browser-verification.v1", strategy: "new-quiz-settings" };
    let saved;
    try {
      saved = await pageJson(url);
    } catch {
      return { ...base, status: "unconfirmed", reason: "new_quiz_settings_readback_unavailable" };
    }
    if (!plainObject(saved) || pageId(saved.id) !== pageId(args.assignment_id)
      || (saved.course_id !== undefined && pageId(saved.course_id) !== pageId(args.course_id))) {
      return { ...base, status: "mismatch", reason: "new_quiz_settings_readback_target_changed" };
    }
    if (!plainObject(saved.quiz_settings)) {
      return { ...base, status: "unconfirmed", reason: "new_quiz_settings_readback_missing" };
    }
    if (stable(saved.quiz_settings) !== stable(expectedSettings)) {
      return { ...base, status: "mismatch", reason: "new_quiz_settings_readback_mismatch" };
    }
    return { ...base, status: "verified", evidence: "complete_settings_reread_after_write" };
  }

  // The New Quiz item id rule, copied from src/new-quiz-item-guard.js because
  // Chrome injects this file as a classic script with no module scope.
  // scripts/test/canvas-new-quiz-item-guard.test.mjs executes both copies and
  // fails if one of them disagrees with that file.
  //
  // In-place updates retain every interaction id. Morrow has not verified
  // how structural edits merge on a live tenant, so structural changes use
  // separate reviewed delete and create operations.
  const NEW_QUIZ_INTERACTION_ID_GROUPS = ["choices", "questions", "blanks", "entries"];
  const NEW_QUIZ_ITEM_OPERATION_KEY = "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item";

  function newQuizMemberId(member) {
    if (!plainObject(member)) return null;
    if (typeof member.id === "number" && Number.isSafeInteger(member.id)) return String(member.id);
    return typeof member.id === "string" && member.id.trim() !== "" && member.id.length <= 200 ? member.id : null;
  }

  function newQuizInteractionIds(item) {
    const entry = plainObject(item) ? item.entry : null;
    const interaction = plainObject(entry) ? entry.interaction_data : null;
    const ids = {};
    if (!plainObject(interaction)) return ids;
    for (const group of NEW_QUIZ_INTERACTION_ID_GROUPS) {
      if (Array.isArray(interaction[group])) ids[group] = interaction[group].map(newQuizMemberId);
    }
    return ids;
  }

  function newQuizIdsPreserved(before, after) {
    const left = newQuizInteractionIds(before);
    const right = newQuizInteractionIds(after);
    for (const group of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const leftIds = left[group];
      const rightIds = right[group];
      if (!leftIds || !rightIds) return false;
      if (leftIds.includes(null) || rightIds.includes(null)) return false;
      const leftSet = new Set(leftIds);
      const rightSet = new Set(rightIds);
      if (leftSet.size !== leftIds.length || rightSet.size !== rightIds.length) return false;
      if (leftSet.size !== rightSet.size || [...leftSet].some((id) => !rightSet.has(id))) return false;
    }
    return true;
  }

  // Every in-place change to a New Quiz item's answer structure is checked
  // against the item Canvas holds now, whether a content guard prepared it or
  // not. A change to `scoring_data` takes the same read because that block is
  // the answer key, and it names the very ids this check protects.
  async function checkNewQuizItemIds(operation, args, url) {
    if (operation.key !== NEW_QUIZ_ITEM_OPERATION_KEY
      || (args.item_entry_interaction_data === undefined && args.item_entry_scoring_data === undefined)) return false;
    let before;
    try {
      before = await pageJson(url);
    } catch {
      throw new Error("new_quiz_item_read_failed: Morrow could not read this quiz question before changing it. No change was sent.");
    }
    const itemId = pageId(args.item_id);
    if (!itemId || !plainObject(before) || pageId(before.id) !== itemId || before.entry_type !== "Item" || !plainObject(before.entry)) {
      throw new Error("new_quiz_item_target_changed: This quiz question does not report the answer structure Morrow has to preserve. No change was sent.");
    }
    const after = args.item_entry_interaction_data === undefined
      ? before
      : { entry: { ...before.entry, interaction_data: args.item_entry_interaction_data } };
    if (!newQuizIdsPreserved(before, after)) {
      throw new Error("new_quiz_interaction_ids_changed: This change would give the answers in this quiz question new ids, and New Quizzes would keep the old ones as blank answers. No change was sent. Delete this question and add the replacement instead.");
    }
    return true;
  }

  function bulkAssignmentDatesBody(operation, args) {
    if (operation.toolName !== "canvas_bulk_update_assignment_dates"
      || operation.key !== "PUT /v1/courses/{course_id}/assignments/bulk_update#bulk_update_assignment_dates") return undefined;
    const dates = args.assignment_dates;
    if (!Array.isArray(dates) || dates.length < 1 || dates.length > 100) {
      throw new TypeError("canvas_bulk_assignment_dates_invalid");
    }
    const assignmentIds = new Set();
    for (const assignment of dates) {
      const assignmentId = pageId(assignment?.id);
      if (!assignmentId || assignmentIds.has(assignmentId) || !Array.isArray(assignment.all_dates)
        || assignment.all_dates.length < 1 || assignment.all_dates.length > 200) {
        throw new TypeError("canvas_bulk_assignment_dates_invalid");
      }
      assignmentIds.add(assignmentId);
      const selectors = new Set();
      for (const date of assignment.all_dates) {
        if (!date || typeof date !== "object" || Array.isArray(date)
          || Object.keys(date).some((key) => !["id", "base", "due_at", "unlock_at", "lock_at"].includes(key))) {
          throw new TypeError("canvas_bulk_assignment_dates_invalid");
        }
        const overrideId = pageId(date.id);
        if ((date.base === true) === Boolean(overrideId)) throw new TypeError("canvas_bulk_assignment_dates_invalid");
        const selector = date.base === true ? "base" : `override:${overrideId}`;
        if (selectors.has(selector)) throw new TypeError("canvas_bulk_assignment_dates_invalid");
        selectors.add(selector);
        const fields = ["due_at", "unlock_at", "lock_at"].filter((field) => Object.hasOwn(date, field));
        if (fields.length === 0 || fields.some((field) => date[field] !== null
          && (typeof date[field] !== "string" || date[field] !== date[field].trim() || !Number.isFinite(Date.parse(date[field]))))) {
          throw new TypeError("canvas_bulk_assignment_dates_invalid");
        }
      }
    }
    return dates;
  }

  // The Canvas Classic Quiz question routes are form-encoded, and Canvas reads the
  // answer array as indexed form fields, so one answer becomes
  // question[answers][0][answer_text] and its siblings. The catalog schema in
  // scripts/generate-canvas-api-catalog.mjs bounds the same fields.
  const CLASSIC_QUIZ_ANSWER_OPERATIONS = new Set([
    "POST /v1/courses/{course_id}/quizzes/{quiz_id}/questions#create_single_quiz_question",
    "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question",
  ]);
  const CLASSIC_QUIZ_ANSWER_FIELDS = ["id", "answer_text", "answer_weight", "answer_comments", "answer_html", "text_after_answers"];

  function classicQuizAnswerEntries(operation, parameter, value) {
    if (!CLASSIC_QUIZ_ANSWER_OPERATIONS.has(operation.key) || parameter.location !== "form"
      || parameter.wireName !== "question[answers]") return undefined;
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new TypeError("canvas_classic_quiz_answers_invalid");
    const entries = [];
    value.forEach((answer, index) => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)
        || Object.keys(answer).some((key) => !CLASSIC_QUIZ_ANSWER_FIELDS.includes(key))
        || typeof answer.answer_text !== "string"
        || !Number.isInteger(answer.answer_weight) || answer.answer_weight < 0 || answer.answer_weight > 100
        || (Object.hasOwn(answer, "id") && !pageId(answer.id))) {
        throw new TypeError("canvas_classic_quiz_answers_invalid");
      }
      for (const field of CLASSIC_QUIZ_ANSWER_FIELDS) {
        if (!Object.hasOwn(answer, field)) continue;
        const text = field === "answer_weight" ? String(answer.answer_weight)
          : field === "id" ? pageId(answer.id)
          : answer[field];
        if (typeof text !== "string" || text.length > 16_384) throw new TypeError("canvas_classic_quiz_answers_invalid");
        entries.push([{ ...parameter, wireName: `question[answers][${index}][${field}]`, schema: { type: "string" } }, text]);
      }
    });
    return entries;
  }

  function decodeFile(value) {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.base64 !== "string") {
      throw new TypeError("file parameters require name and base64");
    }
    const binary = atob(value.base64);
    if (binary.length > 20 * 1024 * 1024) throw new RangeError("file parameter exceeds 20 MiB");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new File([bytes], value.name, { type: typeof value.type === "string" ? value.type : "application/octet-stream" });
  }

  function requestParts(operation, args) {
    if (operation.toolName === "canvas_create_module_item") {
      const type = args.module_item_type;
      const required = type === "Page" ? ["module_item_page_url"]
        : type === "SubHeader" ? []
        : type === "ExternalUrl" ? ["module_item_external_url"]
        : type === "ExternalTool" ? ["module_item_content_id", "module_item_external_url"]
        : ["module_item_content_id"];
      for (const name of required) {
        if (args[name] === undefined || args[name] === null || args[name] === "") throw new TypeError(`${name} is required`);
      }
    }
    let path = operation.path;
    const query = new URLSearchParams();
    const body = [];
    for (const parameter of operation.parameters) {
      const value = args[parameter.inputName];
      const preserveGuardedEmptyPageBody = operation.toolName === "canvas_update_create_page_courses"
        && Boolean(args.morrow_page_guard || args.morrow_canvas_content_guard) && parameter.inputName === "wiki_page_body";
      const preserveNewQuizValue = usesJsonBody(operation) && operation.path.startsWith("/quiz/v1/")
        && parameter.location === "form";
      if (value === undefined || (value === null && !preserveNewQuizValue)
        || (value === "" && !preserveGuardedEmptyPageBody && !preserveNewQuizValue)) {
        if (parameter.required) throw new TypeError(`${parameter.inputName} is required`);
        continue;
      }
      if (parameter.location === "path") {
        path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
      } else if (parameter.location === "query") {
        appendValue(query, parameter.wireName, value);
      } else {
        const answers = classicQuizAnswerEntries(operation, parameter, value);
        if (answers) body.push(...answers);
        else body.push([parameter, value]);
      }
    }
    if (/\{[^}]+\}/.test(path) || path.includes("://") || path.split("/").includes("..")) {
      throw new TypeError("canvas_operation_path_refused");
    }
    const url = new URL(`/api${path}`, location.origin);
    for (const [name, value] of query) url.searchParams.append(name, value);
    return { url, body };
  }

  function courseScope(operation, url) {
    const target = operation?.morrowCourseTarget;
    if (!target || target.kind !== "course_path" || !["course_id", "id"].includes(target.argument)) return null;
    const match = url.pathname.match(/\/courses\/([1-9][0-9]*)(?:\/|$)/);
    if (!match) throw new Error("canvas_course_target_invalid");
    return match[1];
  }

  // The one course-ownership rule from generated/canvas-semantic-target.js, applied here to the
  // exact request this page is about to send. It is written out rather than imported because Chrome
  // injects this file as a classic script with no module scope. Both limits match
  // CANVAS_SEMANTIC_RESOLUTION_MAX_AGE_MS and its clock tolerance in that module.
  const SEMANTIC_RESOLUTION_MAX_AGE_MS = 60_000;
  const SEMANTIC_RESOLUTION_CLOCK_TOLERANCE_MS = 1_000;

  function checkSemanticTargetScope(operation, url, args, exactCourseId) {
    const target = operation?.morrowCourseTarget?.kind === "semantic_course_object"
      ? operation.morrowCourseTarget.target
      : null;
    if (!target) return false;
    const named = (name) => {
      const value = args?.[name];
      return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
    };
    const accepted = new Set((operation.parameters || []).map((parameter) => parameter.inputName));
    // The inputs Morrow will not send at all, and the ones it sends only with one value: a second
    // place for the object, a repeat or series that reaches events this request cannot read back,
    // and the instruction that keeps a file Canvas would otherwise replace.
    const inputRefused = () => (target.refusedParameters || []).some((name) => named(name))
      || (target.seriesParameters || []).some((name) => named(name))
      || Object.entries(target.requiredInputs || {})
        .some(([name, value]) => accepted.has(name) && String(args?.[name] ?? "") !== value);
    // The same context rule as generated/canvas-semantic-target.js, written out because Chrome
    // injects this file as a classic script with no module scope. Canvas names a calendar with a
    // context code, and one object can carry a list of them: Morrow sends a change only to the
    // selected course's own calendar, and never to an object that serves several courses at once.
    const contextValue = target.courseCodeParameter && named(target.courseCodeParameter)
      ? args[target.courseCodeParameter]
      : undefined;
    if (Array.isArray(contextValue) && contextValue.length > 1) throw new Error("multi_context_object_not_supported");
    if (contextValue !== undefined
      && (Array.isArray(contextValue) ? contextValue[0] : contextValue) !== `course_${exactCourseId}`) {
      throw new Error("canvas_semantic_target_course_mismatch");
    }
    // A route that creates the object names no object to read first: the context code is the whole
    // binding, and the change is read back afterwards through the new object's own route.
    if (target.createsObject) {
      if (contextValue === undefined) throw new Error("canvas_semantic_target_course_mismatch");
      if (inputRefused()) throw new Error("canvas_semantic_target_input_refused");
      return true;
    }
    const proof = operation.morrowSemanticResolution;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new Error("canvas_semantic_target_course_mismatch");
    const objectId = pageId(proof.objectId);
    const wireName = (operation.parameters || [])
      .find((parameter) => parameter.inputName === target.objectParameter && parameter.location === "path")?.wireName;
    // The route names the proved object and then whatever this change is about inside it, so the
    // part of the address up to and including that object has to be the object that was read.
    const placeholder = wireName ? `{${wireName}}` : "";
    const objectEnd = placeholder ? operation.path.indexOf(placeholder) + placeholder.length : -1;
    const provedPath = objectEnd > 0
      ? `/api${operation.path.slice(0, objectEnd).replace(placeholder, encodeURIComponent(objectId))}`
      : "";
    if (!objectId || !provedPath || proof.resolverTool !== target.resolverRead
      || courseId(proof.courseId) !== exactCourseId
      || typeof proof.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(proof.snapshotDigest)
      || (url.pathname !== provedPath && !url.pathname.startsWith(`${provedPath}/`))) {
      throw new Error("canvas_semantic_target_course_mismatch");
    }
    // Where the change lands is part of the change: the reading has to name that exact destination,
    // and name none when the change names none. Both are read from this request's own arguments.
    const destination = target.destinationParameter && named(target.destinationParameter)
      ? pageId(args[target.destinationParameter])
      : "";
    if ((destination || "") !== (pageId(proof.destinationId) || "")) throw new Error("canvas_semantic_target_course_mismatch");
    if (inputRefused()) throw new Error("canvas_semantic_target_input_refused");
    const resolvedAt = Date.parse(String(proof.resolvedAt));
    const now = Date.now();
    if (!Number.isFinite(resolvedAt) || resolvedAt > now + SEMANTIC_RESOLUTION_CLOCK_TOLERANCE_MS
      || now - resolvedAt > SEMANTIC_RESOLUTION_MAX_AGE_MS) {
      throw new Error("canvas_semantic_target_resolution_stale");
    }
    return true;
  }

  function checkCourseScope(operation, url, args, expectedCourseId) {
    const exactId = courseId(expectedCourseId);
    if (!exactId) throw new Error("canvas_course_binding_missing");
    const targetId = courseScope(operation, url);
    if (targetId && targetId !== exactId) throw new Error("canvas_course_target_mismatch");
    if (checkSemanticTargetScope(operation, url, args, exactId)) return exactId;
    if (!targetId && operation.method !== "GET") throw new Error("canvas_course_scope_required");
    return exactId;
  }

  function sameInstant(left, right) {
    if (left === right) return true;
    const leftTime = Date.parse(String(left));
    const rightTime = Date.parse(String(right));
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  }

  function isoInstant(value) {
    if (typeof value !== "string" || value !== value.trim()) return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number.isFinite(Date.parse(value))
      ? value
      : null;
  }

  function assignmentDueDateChange(operation, args) {
    if (operation.toolName !== "canvas_edit_assignment"
      || operation.key !== "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment") return null;
    if (!Object.hasOwn(args, "assignment_due_at") || !Object.keys(args).every((key) => ["course_id", "id", "assignment_due_at"].includes(key))) return null;
    const id = pageId(args.id);
    const dueAt = isoInstant(args.assignment_due_at);
    if (!id || !dueAt) throw new Error("assignment_due_date_invalid");
    return { id, dueAt };
  }

  function assignmentDueDateState(value, expectedCourseId, expectedId) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || pageId(value.id) !== expectedId || courseId(value.course_id) !== expectedCourseId) {
      throw new Error("assignment_due_date_target_changed");
    }
    const protectedFields = { ...value };
    delete protectedFields.due_at;
    delete protectedFields.updated_at;
    return stable(protectedFields);
  }

  async function checkAssignmentDueDateSource(operation, args, url, expectedCourseId) {
    const change = assignmentDueDateChange(operation, args);
    if (!change) return null;
    const before = await pageJson(url);
    return { ...change, protectedState: assignmentDueDateState(before, expectedCourseId, change.id) };
  }

  async function verifyAssignmentDueDateChange(change, url, expectedCourseId) {
    const base = { schema: "morrow.browser-verification.v1", status: "unconfirmed", strategy: "assignment-due-date" };
    try {
      const after = await pageJson(url);
      if (assignmentDueDateState(after, expectedCourseId, change.id) !== change.protectedState) {
        return { ...base, status: "mismatch", reason: "assignment_fields_changed" };
      }
      if (!sameInstant(after.due_at, change.dueAt)) return { ...base, status: "mismatch", reason: "assignment_due_date_did_not_match" };
      return { ...base, status: "verified", evidence: "fresh_assignment_readback_preserves_other_fields" };
    } catch {
      return { ...base, reason: "assignment_readback_incomplete" };
    }
  }

  async function canvasProfile(includeCourseName = false) {
    const currentCourseId = currentCanvasCourseId();
    const response = await fetch(new URL("/api/v1/users/self/profile", location.origin), {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids" },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error(`canvas_profile_http_${response.status}`);
    const profile = JSON.parse(await readBounded(response));
    const id = String(profile?.id || "").trim();
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error("canvas_profile_id_invalid");
    let courseName;
    if (includeCourseName) {
      courseName = String((await courseJson(currentCourseId)).name || "").trim().slice(0, 300);
    }
    return { id, name: String(profile?.name || profile?.short_name || "Canvas user").slice(0, 200), origin: location.origin, courseId: currentCourseId, ...(courseName ? { courseName } : {}) };
  }

  async function executeCanvas(operation, args, expectedPrincipalId, expiresAt, expectedCourseId) {
    const profile = await canvasProfile();
    if (profile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
    let { url, body } = requestParts(operation, args);
    const exactCourseId = checkCourseScope(operation, url, args, expectedCourseId);
    await courseJson(exactCourseId);
    const assignmentDueDate = await checkAssignmentDueDateSource(operation, args, url, exactCourseId);
    let canvasContentChange = null;
    if (assignmentDueDate) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    if (args.morrow_page_guard) {
      args = { ...args, wiki_page_body: await checkPageSource(operation, args, url, exactCourseId) };
      ({ url, body } = requestParts(operation, args));
      checkCourseScope(operation, url, args, exactCourseId);
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    if (args.morrow_canvas_content_guard) {
      canvasContentChange = await checkCanvasContentSource(operation, args, url, exactCourseId);
      args = { ...args, ...canvasContentChange.writeArguments };
      ({ url, body } = requestParts(operation, args));
      checkCourseScope(operation, url, args, exactCourseId);
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    if (await checkNewQuizItemIds(operation, args, url)) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    const newQuizSettings = await checkNewQuizSettingsSource(operation, args, url);
    if (newQuizSettings) {
      const currentProfile = await canvasProfile();
      if (currentProfile.id !== expectedPrincipalId) throw new Error("canvas_principal_changed");
      await courseJson(exactCourseId);
    }
    const isRead = operation.method === "GET";
    const headers = new Headers({ Accept: "application/json+canvas-string-ids" });
    const options = { method: operation.method, credentials: "include", headers, cache: "no-store", redirect: "error" };
    if (!isRead) {
      const csrfCookie = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("_csrf_token="));
      const csrf = csrfCookie ? decodeURIComponent(csrfCookie.slice("_csrf_token=".length)) : "";
      if (!csrf) throw new Error("canvas_csrf_context_missing");
      headers.set("X-CSRF-Token", csrf);
      headers.set("X-Requested-With", "XMLHttpRequest");
      const bulkDates = bulkAssignmentDatesBody(operation, args);
      const containsFile = body.some(([parameter]) => String(parameter.schema?.format || "") === "binary");
      if (bulkDates !== undefined) {
        headers.set("Content-Type", "application/json;charset=UTF-8");
        options.body = JSON.stringify(bulkDates);
      } else if (containsFile) {
        const form = new FormData();
        for (const [parameter, value] of body) {
          if (String(parameter.schema?.format || "") === "binary") form.append(parameter.wireName, decodeFile(value));
          else appendValue(form, parameter.wireName, value);
        }
        options.body = form;
      } else if (body.length > 0 && usesJsonBody(operation)) {
        const json = {};
        for (const [parameter, value] of body) assignJsonValue(json, parameter.wireName, value);
        // The complete merged block replaces the leaves the caller supplied, so
        // a partial quiz_settings PATCH is never sent.
        if (newQuizSettings) json.quiz = { ...json.quiz, quiz_settings: newQuizSettings.merged };
        headers.set("Content-Type", "application/json;charset=UTF-8");
        options.body = JSON.stringify(json);
      } else if (body.length > 0) {
        const encoded = new URLSearchParams();
        for (const [parameter, value] of body) appendValue(encoded, parameter.wireName, value);
        headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        options.body = encoded.toString();
      }
    }
    const listResume = listResumeRequest(args, isRead);
    const resumed = listResume && listResume.next_page !== undefined ? decodeResumeToken(listResume.next_page, url) : null;
    const pagesBefore = resumed ? resumed.pagesRead : 0;
    const maxPages = Math.max(1, Math.min(Number(args.morrow_max_pages || 25), MAX_PAGES, MAX_RESUMED_PAGES - pagesBefore));
    if (!isRead && (!Number.isFinite(expiresAt) || Date.now() >= expiresAt)) throw new Error("canvas_request_expired_before_send");
    const pages = [];
    let next = resumed ? resumed.href : url.href;
    let links = new Map();
    let lastResponse = null;
    for (let page = 0; next && page < maxPages; page += 1) {
      let response;
      let payload;
      try {
        for (let attempt = 0; attempt < (isRead ? 3 : 1); attempt += 1) {
          response = await fetch(next, options);
          if (response.status !== 429 || !isRead || attempt === 2) break;
          const seconds = Math.min(30, Math.max(1, Number(response.headers.get("Retry-After") || 1)));
          await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
        }
        payload = parsePayload(await readBounded(response), response.headers.get("Content-Type"));
      } catch {
        return { ok: false, sent: true, outcomeUnknown: !isRead, error: isRead ? "canvas_read_failed" : "canvas_write_response_unknown" };
      }
      lastResponse = response;
      if (!response.ok) {
        // The one Canvas write-outcome rule, copied from
        // src/canvas-write-outcome.js because Chrome injects this file as a
        // classic script with no module scope. A read has no effect to be
        // uncertain about, so its shape does not change.
        const outcomeUnknown = !(
          Number.isInteger(response.status) && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
        );
        return { ok: false, sent: true, status: response.status, ...(isRead ? {} : { outcomeUnknown }), error: payload, requestUrl: url.pathname };
      }
      pages.push(payload);
      links = isRead ? linkHeaderUrls(response.headers.get("Link"), location.origin, url.pathname, url) : new Map();
      next = isRead ? links.get("next")?.href || null : null;
    }
    const pagesRead = pagesBefore + pages.length;
    const data = pages.length === 1 ? pages[0] : pages.flatMap((page) => Array.isArray(page) ? page : [page]);
    const pageRead = isRead && /^\/api\/v1\/courses\/[1-9][0-9]*\/pages\/[^/]+$/.test(url.pathname) && typeof data?.body === "string";
    return {
      ok: true,
      sent: true,
      status: lastResponse?.status || 0,
      data,
      ...(pageRead ? { pageBodySha256: await bodyDigest(data.body) } : {}),
      // Every settings change reports the keys it carried over from the quiz's
      // current settings, so the person reads what was kept rather than trusting it.
      ...(newQuizSettings ? {
        newQuizSettingsPreserved: newQuizSettings.preserved,
        verification: await verifyNewQuizSettingsChange(args, url, newQuizSettings.merged),
      } : {}),
      ...(args.morrow_page_guard ? { verification: await verifyPageChange(args, url) } : {}),
      ...(canvasContentChange ? { verification: await verifyCanvasContentChange(args, url, exactCourseId) } : {}),
      ...(assignmentDueDate ? { verification: await verifyAssignmentDueDateChange(assignmentDueDate, url, exactCourseId) } : {}),
      pageCount: pages.length,
      truncated: Boolean(next),
      // The resume envelope is returned only to a caller that asked to continue
      // this list. morrow_next_page is opaque and is only ever read back here.
      ...(listResume ? {
        morrow_pages_read: pagesRead,
        ...(next ? { morrow_unread_pages: unreadPageCount(links) } : {}),
        ...(next && pagesRead < MAX_RESUMED_PAGES ? { morrow_next_page: encodeResumeToken(next, pagesRead) } : {}),
      } : {}),
      requestCost: lastResponse?.headers.get("X-Request-Cost") || null,
      rateLimitRemaining: lastResponse?.headers.get("X-Rate-Limit-Remaining") || null,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "morrow_canvas_probe") {
      canvasProfile(true).then((profile) => sendResponse({ ok: true, profile }), (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === "morrow_canvas_execute") {
      if (message.privateAttachment !== undefined) {
        sendResponse({ ok: false, sent: false, error: "canvas_private_attachment_refused" });
        return false;
      }
      executeCanvas(message.operation, message.arguments || {}, message.principalId, message.expiresAt, message.courseId)
        .then((result) => sendResponse(result), (error) => sendResponse({ ok: false, sent: false, error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === "morrow_canvas_list_courses") {
      Promise.all([canvasProfile(), listCourses(message.page)])
        .then(([profile, result]) => sendResponse({ ok: true, profile, ...result }), (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    if (message?.type === "morrow_canvas_check_course") {
      checkedCourse(message.courseId)
        .then((result) => sendResponse({ ok: true, ...result }), (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    return false;
  });
})();
