export async function executeMoodleInPage(input) {
  try { input = JSON.parse(input); } catch { return { ok: false, sent: false, error: "moodle_arguments_invalid" }; }
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 100;
  const PROVIDER = "moodle";
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value) : /^[1-9][0-9]*$/.test(String(value || "")) ? String(value) : "";
  const sectionNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  const error = (code, extra = {}) => ({ ok: false, sent: false, error: code, ...extra });
  const definitions = Object.freeze({
    "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1": { toolName: "moodle_list_my_courses", readOnly: true, kind: "list-courses" },
    "moodle.form.course.edit.read.v1": { toolName: "moodle_get_course", readOnly: true, kind: "course-form-read" },
    "moodle.ajax.core_courseformat_get_state.v1": { toolName: "moodle_get_contents", readOnly: true, kind: "structure" },
    "moodle.ajax.core_courseformat_get_state.assignments.v1": { toolName: "moodle_list_assignments", readOnly: true, kind: "assignments" },
    "moodle.ajax.core_courseformat_get_state.quizzes.v1": { toolName: "moodle_list_quizzes", readOnly: true, kind: "quizzes" },
    "moodle.form.mod.quiz.edit.read.v1": { toolName: "moodle_list_quiz_questions", readOnly: true, kind: "quiz-questions-read" },
    "moodle.form.question.bank.editquestion.read.v1": { toolName: "moodle_get_quiz_question", readOnly: true, kind: "quiz-question-read" },
    "moodle.form.course.edit.summary.read.v1": { toolName: "moodle_get_course_summary", readOnly: true, kind: "course-form-read" },
    "moodle.form.course.editsection.read.v1": { toolName: "moodle_get_section", readOnly: true, kind: "section-form-read" },
    "moodle.form.course.modedit.page.read.v1": { toolName: "moodle_get_page", readOnly: true, kind: "page-form-read" },
    "moodle.form.course.modedit.resource.files.read.v1": { toolName: "moodle_get_resource_files", readOnly: true, kind: "resource-files-read" },
    "moodle.form.course.modedit.page.create.read.v1": { toolName: "moodle_get_page_creation_form", readOnly: true, kind: "page-create-form-read" },
    "moodle.form.course.modedit.assign.read.v1": { toolName: "moodle_get_assignment", readOnly: true, kind: "assignment-form-read" },
    "moodle.form.course.modedit.quiz.read.v1": { toolName: "moodle_get_quiz", readOnly: true, kind: "quiz-form-read" },
    "moodle.form.course.modedit.assign.create.read.v1": { toolName: "moodle_get_assignment_creation_form", readOnly: true, kind: "assignment-create-form-read" },
    "moodle.form.course.modedit.quiz.create.read.v1": { toolName: "moodle_get_quiz_creation_form", readOnly: true, kind: "quiz-create-form-read" },
    "moodle.form.course.edit.summary.write.v1": { toolName: "moodle_update_course_summary", readOnly: false, kind: "course-form-write" },
    "moodle.form.course.editsection.write.v1": { toolName: "moodle_update_section", readOnly: false, kind: "section-form-write" },
    "moodle.form.course.modedit.page.write.v1": { toolName: "moodle_update_page", readOnly: false, kind: "page-form-write" },
    "moodle.form.course.modedit.page.create.write.v1": { toolName: "moodle_create_page", readOnly: false, kind: "page-create-form-write" },
    "moodle.form.course.modedit.assign.write.v1": { toolName: "moodle_update_assignment", readOnly: false, kind: "assignment-form-write" },
    "moodle.form.course.modedit.quiz.write.v1": { toolName: "moodle_update_quiz", readOnly: false, kind: "quiz-form-write" },
    "moodle.form.course.modedit.assign.create.write.v1": { toolName: "moodle_create_assignment", readOnly: false, kind: "assignment-create-form-write" },
    "moodle.form.course.modedit.quiz.create.write.v1": { toolName: "moodle_create_quiz", readOnly: false, kind: "quiz-create-form-write" },
    "moodle.form.course.edit.visibility.write.v1": { toolName: "moodle_show_course", readOnly: false, kind: "course-show" },
    "moodle.form.course.edit.visibility.hide.v1": { toolName: "moodle_hide_course", readOnly: false, kind: "course-hide" },
    "moodle.ajax.core_courseformat_update_course.section_show.v1": { toolName: "moodle_show_section", readOnly: false, kind: "section-show" },
    "moodle.ajax.core_courseformat_update_course.section_hide.v1": { toolName: "moodle_hide_section", readOnly: false, kind: "section-hide" },
    "moodle.ajax.core_courseformat_update_course.cm_show.v1": { toolName: "moodle_show_activity", readOnly: false, kind: "activity-show" },
    "moodle.ajax.core_courseformat_update_course.cm_hide.v1": { toolName: "moodle_hide_activity", readOnly: false, kind: "activity-hide" },
    "moodle.ajax.core_courseformat_update_course.cm_move.v1": { toolName: "moodle_move_activity", readOnly: false, kind: "activity-move" },
  });
  const creationSpec = Object.freeze({
    page: { module: "page", type: "page-create", body: "page[text]", dataBody: "content", dates: [] },
    assign: { module: "assign", type: "assignment-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "available_from", field: "allowsubmissionsfromdate" }, { argument: "due_date", field: "duedate" }, { argument: "cutoff_at", field: "cutoffdate" }, { argument: "grading_due_at", field: "gradingduedate" }] },
    quiz: { module: "quiz", type: "quiz-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "open_at", field: "timeopen" }, { argument: "close_at", field: "timeclose" }], requiresSebOff: true },
  });
  const creationModule = (kind) => kind.startsWith("page-create") ? "page" : kind.startsWith("assignment-create") ? "assign" : kind.startsWith("quiz-create") ? "quiz" : "";
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, depth + 1));
    if (!isObject(value)) return typeof value === "string" ? redact(value.slice(0, MAX_BYTES)) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (transientField(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle) throw new Error("digest unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!isObject(cfg) || typeof cfg.wwwroot !== "string" || !cfg.wwwroot || typeof cfg.sesskey !== "string" || !cfg.sesskey) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let parsed;
    try { parsed = new URL(cfg.wwwroot); } catch { return null; }
    if (parsed.protocol !== "https:" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = parsed.pathname.replace(/\/$/, "");
    if (currentOrigin !== parsed.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const cfgCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (cfgCourse && bodyCourse && cfgCourse !== bodyCourse) return null;
    const courseId = cfgCourse || bodyCourse || "";
    const courseNames = new Set();
    const addCourseName = (value) => { const name = String(value || "").trim().replace(/\s+/g, " "); if (name && name.length <= 500) courseNames.add(name); };
    if (courseId) {
      const coursePath = `${basePath}/course/view.php`;
      if (currentPath === coursePath && new URL(globalThis.location.href).searchParams.get("id") === courseId) {
        addCourseName(globalThis.document?.querySelector?.("h1")?.textContent);
      } else {
        for (const anchor of globalThis.document?.querySelectorAll?.("#page-navbar .breadcrumb a[href]") || []) {
          let href;
          try { href = new URL(anchor.getAttribute("href"), parsed.href); } catch { continue; }
          if (href.origin === parsed.origin && href.pathname === coursePath && href.searchParams.get("id") === courseId) addCourseName(anchor.textContent);
        }
      }
    }
    const courseName = courseNames.size === 1 ? [...courseNames][0] : "";
    return {
      profile: {
        provider: PROVIDER,
        origin: parsed.origin,
        siteUrl: parsed.href,
        principalId,
        ...(courseId ? { courseId } : {}),
        ...(courseName && courseName.length <= 500 ? { courseName } : {}),
      },
      sesskey: cfg.sesskey,
      basePath,
    };
  };
  const sameContext = (left, right) => left?.profile?.origin === right?.profile?.origin
    && left?.profile?.siteUrl === right?.profile?.siteUrl
    && left?.profile?.principalId === right?.profile?.principalId
    && (left?.profile?.courseId || "") === (right?.profile?.courseId || "")
    && left?.sesskey === right?.sesskey;
  const urlFor = (context, path, params = {}) => {
    const root = new URL(context.profile.siteUrl);
    root.pathname = `${context.basePath}${path}` || path;
    root.search = new URLSearchParams(params).toString();
    root.hash = "";
    return root.toString();
  };
  const validateBinding = (context, binding) => {
    if (!isObject(binding) || binding.origin !== context.profile.origin || binding.siteUrl !== context.profile.siteUrl
      || String(binding.principalId || "") !== context.profile.principalId) return "moodle_binding_mismatch";
    if (binding.courseId !== undefined) {
      const boundCourse = id(binding.courseId);
      if (!boundCourse || context.profile.courseId !== boundCourse) return "moodle_course_mismatch";
    }
    return "";
  };
  const expectedOperation = (operation) => {
    if (!isObject(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    if (!definition || operation.toolName !== definition.toolName || operation.provider !== PROVIDER || operation.readOnly !== definition.readOnly) return null;
    return definition;
  };
  const courseArgument = (argumentsValue, binding, context) => {
    const courseId = id(argumentsValue.course_id);
    if (!courseId || (binding.courseId !== undefined && courseId !== id(binding.courseId))
      || (context.profile.courseId && courseId !== context.profile.courseId)) return "";
    return courseId;
  };
  const validString = (value, maximum) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000");
  const validDate = (value) => {
    if (!isObject(value) || Object.keys(value).length !== 5 || !["year", "month", "day", "hour", "minute"].every((key) => Number.isSafeInteger(value[key]))) return false;
    const { year, month, day, hour, minute } = value;
    if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const validNullableDate = (value) => value === null || validDate(value);
  const compareDate = (left, right) => Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) - Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
  const creationDatesValid = (module, value) => {
    const spec = creationSpec[module];
    if (!spec || !spec.dates.every(({ argument }) => validNullableDate(value[argument]))) return false;
    if (module === "assign") {
      const { available_from: availableFrom, due_date: dueDate, cutoff_at: cutoffAt, grading_due_at: gradingDueAt } = value;
      return (!availableFrom || !dueDate || compareDate(dueDate, availableFrom) > 0)
        && (!cutoffAt || !dueDate || compareDate(cutoffAt, dueDate) >= 0)
        && (!cutoffAt || !availableFrom || compareDate(cutoffAt, availableFrom) >= 0)
        && (!gradingDueAt || !availableFrom || compareDate(gradingDueAt, availableFrom) >= 0)
        && (!gradingDueAt || !dueDate || compareDate(gradingDueAt, dueDate) >= 0);
    }
    return module !== "quiz" || !value.open_at || !value.close_at || compareDate(value.close_at, value.open_at) >= 0;
  };
  const validDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const withoutMorrow = (value) => {
    if (!isObject(value)) return null;
    const result = { ...value };
    delete result._morrow;
    return result;
  };
  const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
  const validateArguments = (definition, raw, binding, context) => {
    const value = withoutMorrow(raw);
    if (!value) return { error: "moodle_arguments_invalid" };
    const courseKinds = new Set(["course", "structure", "assignments", "quizzes", "quiz-questions-read", "quiz-question-read", "course-form-read", "section-form-read", "page-form-read", "resource-files-read", "page-create-form-read", "assignment-form-read", "quiz-form-read", "assignment-create-form-read", "quiz-create-form-read", "course-form-write", "section-form-write", "page-form-write", "page-create-form-write", "assignment-form-write", "quiz-form-write", "assignment-create-form-write", "quiz-create-form-write", "course-show", "course-hide", "section-show", "section-hide", "activity-show", "activity-hide", "activity-move"]);
    if (definition.kind === "list-courses") {
      if (!only(value, ["limit"]) || (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_ITEMS))) return { error: "moodle_arguments_invalid" };
      return { value: { limit: value.limit || 50 } };
    }
    if (courseKinds.has(definition.kind)) {
      const courseId = courseArgument(value, binding, context);
      if (!courseId) return { error: "moodle_course_mismatch" };
      value.course_id = courseId;
    }
    const moduleKinds = new Set(["quiz-questions-read", "quiz-question-read", "page-form-read", "resource-files-read", "assignment-form-read", "quiz-form-read", "page-form-write", "assignment-form-write", "quiz-form-write", "activity-show", "activity-hide", "activity-move"]);
    const sectionKinds = new Set(["section-form-read", "section-form-write", "page-create-form-read", "page-create-form-write", "assignment-create-form-read", "assignment-create-form-write", "quiz-create-form-read", "quiz-create-form-write", "section-show", "section-hide"]);
    if (moduleKinds.has(definition.kind)) {
      if (!id(value.module_id)) return { error: "moodle_arguments_invalid" };
      value.module_id = id(value.module_id);
    }
    if (sectionKinds.has(definition.kind)) {
      if (!id(value.section_id)) return { error: "moodle_arguments_invalid" };
      value.section_id = id(value.section_id);
    }
    if (definition.kind === "quiz-question-read") {
      if (!id(value.slot_id) || !only(value, ["course_id", "module_id", "slot_id"])) return { error: "moodle_arguments_invalid" };
      value.slot_id = id(value.slot_id);
      return { value };
    }
    const reads = new Set(["course", "structure", "assignments", "quizzes", "quiz-questions-read", "course-form-read", "section-form-read", "page-form-read", "resource-files-read", "page-create-form-read", "assignment-form-read", "quiz-form-read", "assignment-create-form-read", "quiz-create-form-read"]);
    if (reads.has(definition.kind)) {
      const allowed = creationModule(definition.kind) || definition.kind.startsWith("section") ? ["course_id", "section_id"]
        : (definition.kind.startsWith("page") || definition.kind.startsWith("resource") || definition.kind.startsWith("assignment") || definition.kind.startsWith("quiz")) ? ["course_id", "module_id"]
          : ["course_id"];
      if (!only(value, allowed)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    const visibility = new Set(["course-show", "course-hide", "section-show", "section-hide", "activity-show", "activity-hide"]);
    if (visibility.has(definition.kind)) {
      const allowed = definition.kind.startsWith("course") ? ["course_id", "expected_digest"] : definition.kind.startsWith("section") ? ["course_id", "section_id", "expected_digest"] : ["course_id", "module_id", "expected_digest"];
      if (!only(value, allowed) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "activity-move") {
      if (!id(value.target_section_id) || !only(value, ["course_id", "module_id", "target_section_id", "expected_digest"]) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      value.target_section_id = id(value.target_section_id);
      return { value };
    }
    if (!validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
    if (definition.kind === "course-form-write") {
      if (!only(value, ["course_id", "summary", "expected_digest"]) || !validString(value.summary, 40000)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "section-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "summary", "expected_digest"])
        || (value.name === undefined && value.summary === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.summary !== undefined && !validString(value.summary, 40000))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "page-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "content", "expected_digest"])
        || (value.name === undefined && value.content === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.content !== undefined && !validString(value.content, 40000))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "page-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "content", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.content, 40000) || !value.content) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "assignment-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "available_from", "due_date", "cutoff_at", "grading_due_at", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || !creationDatesValid("assign", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "quiz-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "open_at", "close_at", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || !creationDatesValid("quiz", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "assignment-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "due_date", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.due_date === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.instructions !== undefined && !validString(value.instructions, 40000))
        || (value.due_date !== undefined && !validNullableDate(value.due_date))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "quiz-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "open_at", "close_at", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.open_at === undefined && value.close_at === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.instructions !== undefined && !validString(value.instructions, 40000))
        || (value.open_at !== undefined && !validNullableDate(value.open_at)) || (value.close_at !== undefined && !validNullableDate(value.close_at))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    return { error: "moodle_arguments_invalid" };
  };
  const readText = async (response) => {
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_BYTES) throw new Error("too large");
    const reader = response.body?.getReader?.();
    if (!reader) {
      if (!response.body) return "";
      throw new Error("stream unavailable");
    }
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        total += chunk.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new Error("too large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  };
  const draftItemId = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : "";
  const readDraftListing = async (context, itemId) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/repository/draftfiles_ajax.php", { action: "list" }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, itemid: itemId, filepath: "/" }),
      });
    } catch {
      return null;
    }
    let text;
    try { text = await readText(response); } catch { return null; }
    if (!response.ok) return null;
    let payload;
    try { payload = JSON.parse(text); } catch { return null; }
    return isObject(payload) ? payload : null;
  };
  const inspectFileManagers = async (context, form, formData) => {
    const managers = [];
    const seen = new Set();
    for (const input of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(input.getAttribute("name") || "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const itemId = draftItemId(formData.get(name));
      const listing = itemId ? await readDraftListing(context, itemId) : null;
      const state = !listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)
        ? "unverified" : listing.filecount === 0 && listing.list.length === 0 ? "empty" : "nonempty";
      managers.push({ name, state, listing });
    }
    return managers;
  };
  const ajax = async (context, methodName, args, write = false) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: methodName }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: methodName, args }]),
      });
    } catch {
      return { ok: false, sent: write, outcomeUnknown: write, error: "moodle_ajax_request_failed" };
    }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: write, status: response.status, outcomeUnknown: write, error: "moodle_ajax_response_invalid" }; }
    let payload;
    try { payload = JSON.parse(text); } catch { return { ok: false, sent: write, status: response.status, outcomeUnknown: write, error: "moodle_ajax_response_invalid" }; }
    const entry = Array.isArray(payload) && payload.length === 1 && isObject(payload[0]) ? payload[0] : null;
    if (!response.ok || !entry || entry.error || entry.exception) return { ok: false, sent: write, status: response.status, outcomeUnknown: write, error: "moodle_ajax_failed" };
    return { ok: true, sent: true, status: response.status, data: sanitize(entry.data) };
  };
  const state = async (context, courseId) => {
    const response = await ajax(context, "core_courseformat_get_state", { courseid: Number(courseId) });
    if (!response.ok || typeof response.data !== "string") return { ok: false, sent: false, status: response.status, error: response.error || "moodle_state_invalid" };
    let value;
    try { value = JSON.parse(response.data); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_state_invalid" }; }
    if (!isObject(value) || !isObject(value.course) || id(value.course.id) !== courseId || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { ok: false, sent: false, status: response.status, error: "moodle_state_invalid" };
    return { ok: true, sent: true, status: response.status, data: sanitize(value) };
  };
  const contentData = (value) => ({
    course: sanitize(value.course),
    sections: value.section.map((entry) => sanitize(entry)).slice(0, 10_000),
    activities: value.cm.map((entry) => sanitize(entry)).slice(0, 10_000),
  });
  const stateRead = async (context, courseId, filter = "") => {
    const result = await state(context, courseId);
    if (!result.ok) return result;
    let data = contentData(result.data);
    if (filter) data = { course: data.course, activities: data.activities.filter((entry) => entry.module === filter) };
    return { ...result, data, snapshot_digest: await digest(data), targets: [courseTarget(context, result.data.course.fullname || result.data.course.name)] };
  };
  const selectedSection = async (context, courseId, sectionId) => {
    const current = await state(context, courseId);
    if (!current.ok) return current;
    const section = current.data.section.find((entry) => id(entry?.id) === sectionId);
    if (!section || !sectionNumber(section.number)) return { ok: false, sent: false, status: current.status, error: "moodle_section_target_invalid" };
    return { ok: true, sent: true, status: current.status, section };
  };
  const formDescriptor = (context, kind, args) => {
    const courseId = args.course_id;
    if (kind.startsWith("course")) return {
      type: "course", expectedPath: "/course/edit.php", endpoint: urlFor(context, "/course/edit.php", { id: courseId }), expected: { id: courseId }, required: ["summary_editor[text]", "visible"], courseId,
    };
    if (kind.startsWith("section")) return {
      type: "section", expectedPath: "/course/editsection.php", endpoint: urlFor(context, "/course/editsection.php", { id: args.section_id }), expected: { id: args.section_id, course: courseId }, required: ["name", "summary_editor[text]"], courseId, sectionId: args.section_id,
    };
    const creationModuleName = creationModule(kind);
    if (creationModuleName) {
      const spec = creationSpec[creationModuleName];
      return {
        type: spec.type, module: spec.module, creation: true, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { add: spec.module, course: courseId, sectionid: args.section_id, return: 0 }), expected: { course: courseId, add: spec.module, modulename: spec.module, section: args.section_number, return: "0" }, required: ["course", "add", "modulename", "section", "return", "name", spec.body, "visible", ...spec.dates.map(({ field }) => `${field}[enabled]`)], courseId, sectionId: args.section_id, sectionNumber: args.section_number, sectionName: args.section_name,
      };
    }
    if (kind === "resource-files-read") return {
      type: "resource", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: "resource" }, required: ["name", "files"], courseId, moduleId: args.module_id, strictIdentity: true, finalRoute: { update: args.module_id, return: "0" },
    };
    const module = kind.startsWith("page") ? "page" : kind.startsWith("assignment") ? "assign" : "quiz";
    const required = module === "page" ? ["name", "page[text]"] : module === "assign" ? ["name", "introeditor[text]", "duedate[enabled]"] : ["name", "introeditor[text]", "timeopen[enabled]", "timeclose[enabled]"];
    return {
      type: module, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: module }, required, courseId, moduleId: args.module_id,
    };
  };
  const valuesFromForm = (formData, form, fileManagers = []) => {
    const fileManagerStates = new Map(fileManagers.map(({ name, state }) => [name, state]));
    const values = {};
    for (const [name, value] of formData.entries()) {
      const fileManagerState = fileManagerStates.get(name);
      if (fileManagerState) {
        if (values[name] === undefined) values[name] = { filemanager: { state: fileManagerState } };
        continue;
      }
      if (transientField(name)) continue;
      if (typeof File !== "undefined" && value instanceof File) {
        if (value.size > 0) throw new Error("file edit refused");
        continue;
      }
      if (typeof value !== "string") throw new Error("form invalid");
      const safeValue = redact(value);
      if (values[name] === undefined) values[name] = safeValue;
      else if (Array.isArray(values[name])) values[name].push(safeValue);
      else values[name] = [values[name], safeValue];
    }
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      if (control.checked) continue;
      values[control.name] = "0";
      const prefix = control.name.slice(0, -"[enabled]".length);
      for (const component of ["year", "month", "day", "hour", "minute"]) delete values[`${prefix}[${component}]`];
    }
    return values;
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
  const dateFromForm = (values, name) => {
    if (one(values, `${name}[enabled]`) !== "1") return null;
    const date = {
      year: Number(one(values, `${name}[year]`)), month: Number(one(values, `${name}[month]`)), day: Number(one(values, `${name}[day]`)), hour: Number(one(values, `${name}[hour]`)), minute: Number(one(values, `${name}[minute]`)),
    };
    return validDate(date) ? date : null;
  };
  const formDataFor = (descriptor, values) => {
    if (descriptor.type === "course") return { course_id: Number(descriptor.courseId), fullname: one(values, "fullname"), shortname: one(values, "shortname"), summary: one(values, "summary_editor[text]"), summary_format: Number(one(values, "summary_editor[format]")), visible: one(values, "visible") === "1" };
    if (descriptor.type === "section") return { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), summary: one(values, "summary_editor[text]"), summary_format: Number(one(values, "summary_editor[format]")) };
    if (descriptor.creation) {
      const spec = creationSpec[descriptor.module];
      const data = { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), [spec.dataBody]: one(values, spec.body), [`${spec.dataBody}_format`]: Number(one(values, spec.body.replace("[text]", "[format]"))), visible: one(values, "visible") === "1" };
      for (const { argument, field } of spec.dates) data[argument] = dateFromForm(values, field);
      return data;
    }
    if (descriptor.type === "page") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), content: one(values, "page[text]"), content_format: Number(one(values, "page[format]")) };
    if (descriptor.type === "resource") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name") };
    if (descriptor.type === "assign") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), available_from: dateFromForm(values, "allowsubmissionsfromdate"), due_date: dateFromForm(values, "duedate"), cutoff_at: dateFromForm(values, "cutoffdate"), grading_due_at: dateFromForm(values, "gradingduedate") };
    return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), open_at: dateFromForm(values, "timeopen"), close_at: dateFromForm(values, "timeclose") };
  };
  const loadForm = async (context, descriptor) => {
    let response;
    try { response = await fetch(descriptor.endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return { ok: false, sent: false, error: "moodle_form_read_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    if (!response.ok || typeof DOMParser === "undefined" || typeof FormData === "undefined" || (descriptor.finalRoute && !finalRouteMatches(response.url, descriptor.endpoint, descriptor.finalRoute))) return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    const forms = Array.from(documentValue.querySelectorAll("form")).filter((form) => {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const candidate = new FormData(form);
        return Object.entries(descriptor.expected).every(([name, expected]) => (!descriptor.strictIdentity || candidate.getAll(name).length === 1) && String(candidate.get(name) || "") === String(expected));
      } catch { return false; }
    });
    if (forms.length !== 1) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    const form = forms[0];
    let action;
    try { action = new URL(form.getAttribute("action") || descriptor.endpoint, descriptor.endpoint); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" }; }
    const expectedEndpoint = new URL(descriptor.endpoint);
    if (action.origin !== expectedEndpoint.origin || action.pathname !== expectedEndpoint.pathname) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    const submitName = descriptor.type === "course" ? "saveanddisplay" : "submitbutton";
    const submitControl = Array.from(form.querySelectorAll('input[type="submit"]')).find((control) => control.name === submitName && !control.disabled && typeof control.value === "string" && control.value);
    let formData;
    let values;
    let fileManagers;
    try {
      formData = new FormData(form);
      fileManagers = await inspectFileManagers(context, form, formData);
      values = valuesFromForm(formData, form, fileManagers);
    } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    if (descriptor.required.some((name) => !Object.hasOwn(values, name))) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    return { ok: true, sent: true, status: response.status, action: action.toString(), formData, values, fileManagers, submit: submitControl ? { name: submitName, value: submitControl.value } : null, data: formDataFor(descriptor, values), snapshot_digest: await digest(values), descriptor };
  };
  const protectedDigest = (values, names) => {
    const copy = { ...values };
    for (const name of names) delete copy[name];
    return digest(copy);
  };
  const setField = (formData, name, value) => { formData.delete(name); formData.append(name, String(value)); };
  const dateFieldNames = (name) => [`${name}[enabled]`, `${name}[year]`, `${name}[month]`, `${name}[day]`, `${name}[hour]`, `${name}[minute]`];
  const setDate = (formData, name, value) => {
    if (value === null) {
      formData.delete(`${name}[enabled]`);
      return;
    }
    setField(formData, `${name}[enabled]`, 1);
    for (const [key, item] of Object.entries(value)) setField(formData, `${name}[${key}]`, item);
  };
  const isSameFormValidation = (text, form) => {
    if (typeof DOMParser === "undefined") return false;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return false; }
    const actionUrl = new URL(form.action);
    return Array.from(documentValue.querySelectorAll("form")).some((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const action = new URL(candidate.getAttribute("action") || form.action, form.action);
        if (action.origin !== actionUrl.origin || action.pathname !== actionUrl.pathname) return false;
        const values = new FormData(candidate);
        return Object.entries(form.descriptor.expected).every(([name, expected]) => String(values.get(name) || "") === String(expected));
      } catch { return false; }
    });
  };
  const postForm = async (form) => {
    if (!form.submit) return { ok: false, sent: false, error: "moodle_form_submit_missing" };
    if (form.fileManagers.some(({ state }) => state === "nonempty")) return { ok: false, sent: false, error: "moodle_filemanager_nonempty" };
    if (form.fileManagers.some(({ state }) => state !== "empty")) return { ok: false, sent: false, error: "moodle_filemanager_unverified" };
    const params = new URLSearchParams();
    try {
      for (const [name, value] of form.formData.entries()) {
        if (typeof File !== "undefined" && value instanceof File) {
          if (value.size > 0) return { ok: false, sent: false, error: "moodle_file_edit_refused" };
          continue;
        }
        if (typeof value !== "string") return { ok: false, sent: false, error: "moodle_form_invalid" };
        params.append(name, value);
      }
      params.set(form.submit.name, form.submit.value);
    } catch { return { ok: false, sent: false, error: "moodle_form_invalid" }; }
    let response;
    try {
      response = await fetch(form.action, { method: "POST", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: params });
    } catch { return { ok: false, sent: true, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_write_response_unknown" }, error: "moodle_write_response_unknown" }; }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: true, status: response.status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_write_response_unknown" }, error: "moodle_write_response_unknown" }; }
    if (!response.ok) return { ok: false, sent: true, status: response.status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_write_failed" }, error: "moodle_form_write_failed" };
    let finalUrl;
    let actionUrl;
    try { finalUrl = new URL(response.url || form.action); actionUrl = new URL(form.action); } catch { return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_write_not_redirected" }, error: "moodle_form_write_not_redirected" }; }
    if (!response.redirected) {
      if (finalUrl.origin === actionUrl.origin && finalUrl.pathname === actionUrl.pathname && isSameFormValidation(text, form)) {
        return { ok: false, sent: true, status: response.status, outcomeUnknown: false, verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" }, error: "moodle_form_validation_failed" };
      }
      return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_write_not_redirected" }, error: "moodle_form_write_not_redirected" };
    }
    if (finalUrl.origin !== actionUrl.origin || finalUrl.pathname === actionUrl.pathname) {
      return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_redirect_refused" }, error: "moodle_form_redirect_refused" };
    }
    return { ok: true, sent: true, status: response.status, redirectUrl: finalUrl.toString() };
  };
  const courseTarget = (context, name = "") => ({ field: "course_id", label: "Course", name: String(name || context.profile.courseName || "Moodle course") });
  const sectionTarget = (section) => ({ field: "section_id", label: "Section", name: String(section?.title || section?.rawtitle || "Selected course section") });
  const formTargets = (context, descriptor, data) => {
    const course = courseTarget(context, data.fullname);
    if (descriptor.type === "section") return [course, { field: "section_id", label: "Section", name: String(data.name || descriptor.sectionId) }];
    if (descriptor.creation) return [course, { field: "section_id", label: "Section", name: String(descriptor.sectionName || "Selected course section") }];
    if (["page", "assign", "quiz"].includes(descriptor.type)) return [course, { field: "module_id", label: "Activity", name: String(data.name || descriptor.moduleId) }];
    return [course];
  };
  const finalRouteMatches = (actualValue, endpoint, required) => {
    let actual;
    let expected;
    try { actual = new URL(actualValue || endpoint); expected = new URL(endpoint); } catch { return false; }
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && [...actual.searchParams.keys()].length === Object.keys(required).length
      && Object.entries(required).every(([name, value]) => actual.searchParams.getAll(name).length === 1 && actual.searchParams.get(name) === String(value));
  };
  const loadQuizDocument = async (context, path, params, failure) => {
    const endpoint = urlFor(context, path, params);
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return error(failure); }
    let text;
    try { text = await readText(response); } catch { return { ...error(failure), status: response.status }; }
    if (!response.ok || typeof DOMParser === "undefined" || !finalRouteMatches(response.url, endpoint, params)) return { ...error(failure), status: response.status };
    try { return { ok: true, sent: true, status: response.status, document: new DOMParser().parseFromString(text, "text/html") }; } catch { return { ...error(failure), status: response.status }; }
  };
  const quizTargets = (context, course, quiz) => [courseTarget(context, course.fullname || course.name), { field: "module_id", label: "Quiz", name: String(quiz.name || quiz.id) }];
  const quizBinding = async (context, args) => {
    const current = await state(context, args.course_id);
    if (!current.ok) return current;
    const quiz = current.data.cm.find((entry) => id(entry?.id) === args.module_id && entry?.module === "quiz");
    if (!quiz) return error("moodle_quiz_target_invalid");
    return { ok: true, sent: true, status: current.status, course: current.data.course, quiz };
  };
  const resourceBinding = async (context, args) => {
    const current = await state(context, args.course_id);
    if (!current.ok) return current;
    const matches = current.data.cm.filter((entry) => id(entry?.id) === args.module_id);
    if (matches.length !== 1 || matches[0]?.module !== "resource") return error("moodle_resource_target_invalid");
    const name = nativeText(matches[0].name, 1333);
    if (!name) return error("moodle_resource_target_invalid");
    return { ok: true, sent: true, status: current.status, course: current.data.course, resource: matches[0], name };
  };
  const nativeText = (value, maximum = MAX_BYTES) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000") ? value : null;
  const validResourceFilename = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && value === value.trim()
    && value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value);
  const resourceFilesFromListing = (payload) => {
    if (!isObject(payload) || !Number.isSafeInteger(payload.filecount) || payload.filecount < 0 || payload.filecount > MAX_ITEMS || !Array.isArray(payload.list)
      || payload.list.length !== payload.filecount || !isObject(payload.tree) || !Array.isArray(payload.tree.children) || payload.tree.children.length !== 0) return null;
    const filenames = new Set();
    const files = [];
    for (const entry of payload.list) {
      const sortOrder = typeof entry?.sortorder === "string" && /^(0|[1-9][0-9]*)$/.test(entry.sortorder) ? Number(entry.sortorder) : entry?.sortorder;
      if (!isObject(entry) || entry.filepath !== "/" || (entry.type !== "file" && entry.type !== "zip") || !validResourceFilename(entry.filename)
        || filenames.has(entry.filename) || !Number.isSafeInteger(sortOrder) || sortOrder < 0) return null;
      const label = nativeText(entry.mimetype, 1333);
      if (!label || !label.trim()) return null;
      const size = entry.size === null ? 0 : entry.size;
      if (!Number.isSafeInteger(size) || size < 0) return null;
      filenames.add(entry.filename);
      files.push({ filename: entry.filename, relative_path: entry.filename, size_bytes: size, media_type_label: label, main_file: sortOrder === 1 });
    }
    if (files.length > 0 && files.filter((file) => file.main_file).length !== 1) return null;
    return files.sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
  };
  const getResourceFiles = async (context, inputValue, args) => {
    const bound = await resourceBinding(context, args);
    if (!bound.ok) return bound;
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const form = await loadForm(rechecked, formDescriptor(rechecked, "resource-files-read", args));
    if (!form.ok) return form;
    const name = oneFormValue(form.formData, "name", 1333);
    const draftId = oneFormValue(form.formData, "files", 32);
    const filesManager = form.fileManagers.length === 1 && form.fileManagers[0]?.name === "files" ? form.fileManagers[0] : null;
    if (!name || name !== bound.name || !draftItemId(draftId) || !filesManager || form.formData.getAll("files").length !== 1) return error("moodle_resource_files_target_invalid");
    const listing = filesManager.listing;
    const files = resourceFilesFromListing(listing);
    if (!files) return error("moodle_resource_files_listing_refused");
    const data = {
      course_id: Number(args.course_id),
      module_id: Number(args.module_id),
      name: bound.name,
      files,
      provenance: { source: "native_resource_settings_form", private_draft_copy_prepared: true, form_submitted: false, root_folder_only: true },
    };
    return { ok: true, sent: true, status: form.status, data, targets: [courseTarget(rechecked, bound.course.fullname || bound.course.name), { field: "module_id", label: "Resource", name: bound.name }], snapshot_digest: await digest(data) };
  };
  const slotName = (node) => String(node.querySelector(".instancename")?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 1333);
  const parseQuizSlots = (context, documentValue, moduleId) => {
    const roots = Array.from(documentValue.querySelectorAll('ul.slots[role="presentation"]'));
    if (roots.length !== 1) return null;
    const sections = Array.from(roots[0].children).filter((node) => node.matches?.('li.section.main[id^="section-"]'));
    if (!sections.length) return null;
    const slotLists = sections.map((section) => Array.from(section.querySelectorAll("ul.section.img-text")));
    if (slotLists.some((lists) => lists.length !== 1)) return null;
    const nodes = slotLists.flatMap((lists) => Array.from(lists[0].querySelectorAll(':scope > li.slot[id^="slot-"]')));
    const quizEndpoint = urlFor(context, "/mod/quiz/edit.php", { cmid: moduleId });
    const seen = new Set();
    const slots = [];
    for (const node of nodes.slice(0, MAX_ITEMS)) {
      const slotId = id(String(node.getAttribute("id") || "").slice("slot-".length));
      const qtypeClass = Array.from(node.classList).find((name) => name.startsWith("qtype_"));
      const qtype = qtypeClass && /^[a-z][a-z0-9_]*$/.test(qtypeClass.slice("qtype_".length)) ? qtypeClass.slice("qtype_".length) : "";
      if (!slotId || !qtype || seen.has(slotId)) return null;
      seen.add(slotId);
      const random = node.classList.contains("random") || qtype === "random";
      let version = null;
      if (!random) {
        const selects = Array.from(node.querySelectorAll(`select.version-selection[data-slot-id="${slotId}"]`));
        if (selects.length !== 1) return null;
        const selected = Array.from(selects[0].querySelectorAll("option[selected]")).filter((option) => id(option.getAttribute("value")) || option.getAttribute("value") === "0");
        if (selected.length !== 1) return null;
        const value = selected[0].getAttribute("value");
        version = value === "0" ? { mode: "latest" } : id(value) ? { mode: "pinned", number: Number(id(value)) } : null;
        if (!version) return null;
      }
      let questionId = "";
      let malformedLink = false;
      const questionLinks = [];
      for (const anchor of node.querySelectorAll("a[href]")) {
        let href;
        try { href = new URL(anchor.getAttribute("href"), quizEndpoint); } catch { continue; }
        const expectedPath = `${context.basePath}/question/bank/editquestion/question.php`;
        if (href.origin !== context.profile.origin || href.pathname !== expectedPath) continue;
        const candidateId = id(href.searchParams.get("id"));
        if (href.searchParams.getAll("id").length !== 1 || href.searchParams.getAll("cmid").length !== 1 || !candidateId || href.searchParams.get("cmid") !== moduleId) questionLinks.push({ invalid: true });
        else questionLinks.push({ questionId: candidateId });
      }
      if (questionLinks.length > 1 || questionLinks.some((entry) => entry.invalid)) malformedLink = true;
      if (malformedLink) return null;
      if (questionLinks.length === 1) questionId = questionLinks[0].questionId;
      const supported = qtype === "multichoice" || qtype === "essay";
      const reason = random ? "random_slot" : !supported ? "unsupported_type" : !questionId ? "not_editable" : "";
      slots.push({
        slot_id: Number(slotId), position: slots.length + 1, qtype, status: "not_exposed", ...(version ? { version } : {}),
        ...(questionId ? { question_id: Number(questionId) } : {}), ...(slotName(node) ? { name: slotName(node) } : {}), inspectable: !reason, ...(reason ? { reason } : {}), _questionId: questionId,
      });
    }
    return { slots, truncated: nodes.length > MAX_ITEMS };
  };
  const listQuizQuestions = async (context, inputValue, args) => {
    const bound = await quizBinding(context, args);
    if (!bound.ok) return bound;
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const page = await loadQuizDocument(rechecked, "/mod/quiz/edit.php", { cmid: args.module_id }, "moodle_quiz_questions_read_failed");
    if (!page.ok) return page;
    const parsed = parseQuizSlots(rechecked, page.document, args.module_id);
    if (!parsed) return { ...error("moodle_quiz_questions_target_invalid"), status: page.status };
    const questions = parsed.slots.map(({ _questionId, ...slot }) => slot);
    const data = sanitize({ course_id: Number(args.course_id), module_id: Number(args.module_id), questions, truncated: parsed.truncated });
    return { ok: true, sent: true, status: page.status, data, targets: quizTargets(rechecked, bound.course, bound.quiz), snapshot_digest: await digest(data), slots: parsed.slots };
  };
  const oneFormValue = (formData, name, maximum = MAX_BYTES) => {
    const values = formData.getAll(name);
    const value = values.length === 1 ? nativeText(values[0], maximum) : null;
    return value === null ? null : value;
  };
  const nativeBoolean = (form, formData, name) => {
    const controls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === name);
    const checkboxes = controls.filter((control) => String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (checkboxes.length === 1 && controls.every((control) => control === checkboxes[0] || String(control.getAttribute("type") || "").toLowerCase() === "hidden")) return Boolean(checkboxes[0].checked);
    if (checkboxes.length > 0) return null;
    const value = oneFormValue(formData, name, 1);
    return value === "0" ? false : value === "1" ? true : null;
  };
  const hasDraftReference = (context, value) => String(value).includes("draftfile.php/");
  const richValue = (context, formData, name) => {
    const value = oneFormValue(formData, name);
    return value === null || hasDraftReference(context, value) ? null : value;
  };
  const questionCommonData = (context, formData) => {
    const name = oneFormValue(formData, "name", 1333);
    const questionText = richValue(context, formData, "questiontext[text]");
    const questionTextFormat = oneFormValue(formData, "questiontext[format]", 32);
    const status = oneFormValue(formData, "status", 32);
    const defaultMark = oneFormValue(formData, "defaultmark", 64);
    const generalFeedback = richValue(context, formData, "generalfeedback[text]");
    const generalFeedbackFormat = oneFormValue(formData, "generalfeedback[format]", 32);
    const idNumber = oneFormValue(formData, "idnumber", 255);
    if ([name, questionText, questionTextFormat, defaultMark, generalFeedback, generalFeedbackFormat, idNumber].some((value) => value === null)
      || !["ready", "draft", "hidden"].includes(status || "")) return null;
    return { name, question_text: questionText, question_text_format: questionTextFormat, status, default_mark: defaultMark, general_feedback: generalFeedback, general_feedback_format: generalFeedbackFormat, id_number: idNumber };
  };
  const multipleChoiceData = (context, form, formData) => {
    const single = nativeBoolean(form, formData, "single");
    const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
    const answerNumbering = oneFormValue(formData, "answernumbering", 64);
    const showStandardInstruction = nativeBoolean(form, formData, "showstandardinstruction");
    if (single === null || shuffleAnswers === null || !answerNumbering || showStandardInstruction === null) return null;
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^answer\[([0-9]+)\]\[(?:text|format)\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!indexes.length) return null;
    const choices = [];
    for (const index of indexes) {
      const text = richValue(context, formData, `answer[${index}][text]`);
      const format = oneFormValue(formData, `answer[${index}][format]`, 32);
      const fraction = oneFormValue(formData, `fraction[${index}]`, 64);
      const feedback = richValue(context, formData, `feedback[${index}][text]`);
      const feedbackFormat = oneFormValue(formData, `feedback[${index}][format]`, 32);
      if ([text, format, fraction, feedback, feedbackFormat].some((value) => value === null)) return null;
      if (text === "" && feedback === "" && /^0(?:[.,]0+)?$/.test(fraction)) continue;
      choices.push({ text, format, fraction, feedback, feedback_format: feedbackFormat });
    }
    return { single, shuffle_answers: shuffleAnswers, answer_numbering: answerNumbering, show_standard_instruction: showStandardInstruction, choices: choices.slice(0, MAX_ITEMS), choices_truncated: choices.length > MAX_ITEMS };
  };
  const essayData = (context, form, formData) => {
    const responseFormat = oneFormValue(formData, "responseformat", 64);
    const responseRequired = nativeBoolean(form, formData, "responserequired");
    const responseFieldLines = oneFormValue(formData, "responsefieldlines", 32);
    const wordLimit = (prefix) => {
      const enabled = formData.getAll(`${prefix}enabled`);
      if (enabled.length === 0) return "";
      return enabled.length === 1 && enabled[0] === "1" ? oneFormValue(formData, `${prefix}limit`, 32) : null;
    };
    const minWordLimit = wordLimit("minword");
    const maxWordLimit = wordLimit("maxword");
    const responseTemplate = richValue(context, formData, "responsetemplate[text]");
    const responseTemplateFormat = oneFormValue(formData, "responsetemplate[format]", 32);
    const graderInfo = richValue(context, formData, "graderinfo[text]");
    const graderInfoFormat = oneFormValue(formData, "graderinfo[format]", 32);
    if (!responseFormat || responseRequired === null || !responseFieldLines || minWordLimit === null || maxWordLimit === null
      || responseTemplate === null || !responseTemplateFormat || graderInfo === null || !graderInfoFormat) return null;
    return { response_format: responseFormat, response_required: responseRequired, response_field_lines: responseFieldLines, min_word_limit: minWordLimit || null, max_word_limit: maxWordLimit || null, response_template: responseTemplate, response_template_format: responseTemplateFormat, grader_info: graderInfo, grader_info_format: graderInfoFormat };
  };
  const getQuizQuestion = async (context, inputValue, args) => {
    const listed = await listQuizQuestions(context, inputValue, args);
    if (!listed.ok) return listed;
    const slot = listed.slots.find((entry) => entry.slot_id === Number(args.slot_id));
    if (!slot) return error(listed.data.truncated ? "moodle_quiz_slot_not_listed" : "moodle_quiz_slot_not_found");
    if (slot.reason === "random_slot") return error("moodle_quiz_random_slot_uninspectable");
    if (slot.reason === "unsupported_type") return error("moodle_question_type_unsupported");
    if (!slot.inspectable || !slot._questionId) return error("moodle_question_not_editable");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const page = await loadQuizDocument(rechecked, "/question/bank/editquestion/question.php", { id: slot._questionId, cmid: args.module_id }, "moodle_question_read_failed");
    if (!page.ok) return page;
    const endpoint = urlFor(rechecked, "/question/bank/editquestion/question.php", { id: slot._questionId, cmid: args.module_id });
    const forms = Array.from(page.document.querySelectorAll("form")).filter((form) => {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint, endpoint);
        const data = new FormData(form);
        return action.origin === rechecked.profile.origin && action.pathname === new URL(endpoint).pathname
          && oneFormValue(data, "id", 32) === slot._questionId && oneFormValue(data, "cmid", 32) === args.module_id
          && oneFormValue(data, "courseid", 32) === args.course_id;
      } catch { return false; }
    });
    if (forms.length !== 1) return { ...error("moodle_question_target_invalid"), status: page.status };
    let formData;
    try { formData = new FormData(forms[0]); } catch { return { ...error("moodle_question_target_invalid"), status: page.status }; }
    const qtype = oneFormValue(formData, "qtype", 64);
    if (qtype !== slot.qtype || !["multichoice", "essay"].includes(qtype || "")) return { ...error("moodle_question_target_invalid"), status: page.status };
    const common = questionCommonData(rechecked, formData);
    const details = qtype === "multichoice" ? multipleChoiceData(rechecked, forms[0], formData) : essayData(rechecked, forms[0], formData);
    if (!common || !details) return { ...error("moodle_question_content_refused"), status: page.status };
    const data = sanitize({ course_id: Number(args.course_id), module_id: Number(args.module_id), slot_id: Number(args.slot_id), question_id: Number(slot._questionId), version: slot.version, qtype, ...common, details });
    return { ok: true, sent: true, status: page.status, data, targets: listed.targets, snapshot_digest: await digest(data) };
  };
  const formChanges = (kind, args, formData) => {
    const names = [];
    if (kind === "course-form-write") { setField(formData, "summary_editor[text]", args.summary); names.push("summary_editor[text]"); }
    if (kind === "section-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.summary !== undefined) { setField(formData, "summary_editor[text]", args.summary); names.push("summary_editor[text]"); }
    }
    if (kind === "page-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.content !== undefined) { setField(formData, "page[text]", args.content); names.push("page[text]"); }
    }
    const creationModuleName = creationModule(kind);
    if (creationModuleName) {
      const spec = creationSpec[creationModuleName];
      setField(formData, "name", args.name);
      setField(formData, spec.body, args[spec.dataBody]);
      setField(formData, "visible", 0);
      formData.delete("coursecontentnotification");
      names.push("name", spec.body, "visible");
      for (const { argument, field } of spec.dates) {
        setDate(formData, field, args[argument]);
        names.push(...dateFieldNames(field));
      }
    }
    if (kind === "assignment-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.due_date !== undefined) { setDate(formData, "duedate", args.due_date); names.push(...dateFieldNames("duedate")); }
    }
    if (kind === "quiz-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.open_at !== undefined) { setDate(formData, "timeopen", args.open_at); names.push(...dateFieldNames("timeopen")); }
      if (args.close_at !== undefined) { setDate(formData, "timeclose", args.close_at); names.push(...dateFieldNames("timeclose")); }
    }
    if (kind === "course-show" || kind === "course-hide") { setField(formData, "visible", kind === "course-show" ? 1 : 0); names.push("visible"); }
    return names;
  };
  const expectedFormData = (kind, args, data) => {
    if (kind === "course-form-write") return data.summary === args.summary;
    if (kind === "section-form-write") return (args.name === undefined || data.name === args.name) && (args.summary === undefined || data.summary === args.summary);
    if (kind === "page-form-write") return (args.name === undefined || data.name === args.name) && (args.content === undefined || data.content === args.content);
    if (kind === "assignment-form-write") return (args.name === undefined || data.name === args.name) && (args.instructions === undefined || data.instructions === args.instructions) && (args.due_date === undefined || stable(data.due_date) === stable(args.due_date));
    if (kind === "quiz-form-write") return (args.name === undefined || data.name === args.name) && (args.instructions === undefined || data.instructions === args.instructions) && (args.open_at === undefined || stable(data.open_at) === stable(args.open_at)) && (args.close_at === undefined || stable(data.close_at) === stable(args.close_at));
    if (kind === "course-show") return data.visible === true;
    return data.visible === false;
  };
  const runFormWrite = async (context, inputValue, definition, args) => {
    const descriptor = formDescriptor(context, definition.kind, args);
    const before = await loadForm(context, descriptor);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const names = formChanges(definition.kind, args, before.formData);
    if (!names.length) return error("moodle_arguments_invalid");
    const protectedNames = descriptor.type === "page" ? [...names, "revision"] : names;
    const beforeProtected = await protectedDigest(before.values, protectedNames);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const posted = await postForm(before);
    if (!posted.ok) return posted;
    const after = await loadForm(rechecked, descriptor);
    if (!after.ok) return { ok: false, sent: true, status: posted.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const revisionMatches = descriptor.type !== "page" || Number(after.values.revision) === Number(before.values.revision) + 1;
    const matches = revisionMatches && expectedFormData(definition.kind, args, after.data) && beforeProtected === await protectedDigest(after.values, protectedNames);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: after.data, targets: formTargets(context, descriptor, after.data), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const loadCreationForm = async (context, args, kind) => {
    const selected = await selectedSection(context, args.course_id, args.section_id);
    if (!selected.ok) return selected;
    const descriptor = formDescriptor(context, kind, {
      ...args,
      section_number: sectionNumber(selected.section.number),
      section_name: sectionTarget(selected.section).name,
    });
    const form = await loadForm(context, descriptor);
    return form.ok ? { ...form, section: selected.section } : form;
  };
  const createdModuleId = (context, module, redirectUrl) => {
    try {
      const redirect = new URL(redirectUrl);
      const expected = new URL(urlFor(context, `/mod/${module}/view.php`));
      return redirect.origin === expected.origin && redirect.pathname === expected.pathname ? id(redirect.searchParams.get("id")) : "";
    } catch {
      return "";
    }
  };
  const creationDefaultsMatch = (beforeValues, afterValues, names) => {
    const ignored = new Set([...names, "coursecontentnotification", "add", "update", "coursemodule", "instance", "revision", "return", "sr", "beforemod", "showonly"]);
    const emptyFeedback = (values) => Object.hasOwn(values, "feedbacktext[0][text]")
      && Object.entries(values).filter(([name]) => /^feedbacktext\[\d+\]\[text\]$|^feedbackboundaries\[\d+\]$/.test(name)).every(([, value]) => value === "");
    const emptyQuizFeedback = one(beforeValues, "modulename") === "quiz"
      && ["0", "1"].includes(one(beforeValues, "boundary_repeats")) && ["0", "1"].includes(one(afterValues, "boundary_repeats"))
      && emptyFeedback(beforeValues) && emptyFeedback(afterValues);
    return Object.entries(beforeValues).every(([name, value]) => {
      // Moodle saves an empty new passing grade as zero, then formats it for the edit form.
      if (name === "gradepass" && value === "" && typeof afterValues[name] === "string" && /^0(?:[.,]0+)?$/.test(afterValues[name])) return true;
      // Empty Quiz feedback placeholders can collapse to one row on the first save.
      if (emptyQuizFeedback && /^(?:boundary_repeats|feedbacktext\[\d+\]\[(?:text|format)\]|feedbackboundaries\[\d+\])$/.test(name)) return true;
      return ignored.has(name) || (Object.hasOwn(afterValues, name) && stable(value) === stable(afterValues[name]));
    });
  };
  const unconfirmedCreate = (status, reason) => ({ ok: false, sent: true, status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason }, error: reason });
  const runCreation = async (context, inputValue, definition, args) => {
    const module = creationModule(definition.kind);
    const spec = creationSpec[module];
    const before = await loadCreationForm(context, args, definition.kind);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    if (spec.requiresSebOff && one(before.values, "seb_requiresafeexambrowser") !== "0") return error("moodle_quiz_seb_create_refused");
    const names = formChanges(definition.kind, args, before.formData);
    if (!names.length) return error("moodle_arguments_invalid");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const currentSection = await selectedSection(rechecked, args.course_id, args.section_id);
    if (!currentSection.ok || sectionNumber(currentSection.section.number) !== before.descriptor.sectionNumber) return error("moodle_section_target_invalid");
    const posted = await postForm(before);
    if (!posted.ok) return posted;
    const moduleId = createdModuleId(rechecked, spec.module, posted.redirectUrl);
    if (!moduleId) return unconfirmedCreate(posted.status, `moodle_${spec.module}_create_redirect_unconfirmed`);
    const readKind = spec.module === "page" ? "page-form-read" : spec.module === "assign" ? "assignment-form-read" : "quiz-form-read";
    const after = await loadForm(rechecked, formDescriptor(rechecked, readKind, { course_id: args.course_id, module_id: moduleId }));
    if (!after.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    const afterState = await state(rechecked, args.course_id);
    if (!afterState.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    const activity = afterState.data.cm.find((entry) => id(entry?.id) === moduleId);
    const data = { ...after.data, section_id: Number(args.section_id), visible: one(after.values, "visible") === "1" };
    const matches = data.name === args.name && data[spec.dataBody] === args[spec.dataBody] && spec.dates.every(({ argument }) => stable(data[argument]) === stable(args[argument])) && data.visible === false
      && one(after.values, "section") === one(before.values, "section")
      && creationDefaultsMatch(before.values, after.values, names)
      && isObject(activity) && activity.module === spec.module && id(activity.sectionid) === args.section_id && activity.visible === false;
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data, targets: [courseTarget(rechecked), sectionTarget(before.section)], snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const stateProtectedDigest = async (stateValue, collection, targetId, sectionChildIds = []) => {
    const copy = JSON.parse(JSON.stringify(stateValue));
    const target = Array.isArray(copy[collection]) ? copy[collection].find((entry) => id(entry?.id) === targetId) : null;
    if (target) {
      delete target.visible;
      // Moodle derives these activity fields from the visibility changed by this action.
      if (collection === "cm") for (const name of ["accessvisible", "hascmrestrictions", "stealth"]) delete target[name];
      if (collection === "section") delete target.hasrestrictions;
    }
    if (collection === "section") {
      const childIds = new Set(sectionChildIds);
      for (const child of copy.cm || []) {
        if (childIds.has(id(child?.id))) for (const name of ["visible", "accessvisible", "hascmrestrictions", "allowstealth"]) delete child[name];
      }
    }
    return digest(contentData(copy));
  };
  const oneEntry = (entries, targetId) => {
    const matches = Array.isArray(entries) ? entries.filter((entry) => id(entry?.id) === targetId) : [];
    return matches.length === 1 ? matches[0] : null;
  };
  const ordinaryVisibleSection = (entry) => Boolean(entry) && (entry.component === null || entry.component === "")
    && entry.visible === true && entry.hasrestrictions === false && sectionNumber(entry.number) !== "";
  const cmlistWithOne = (entry, moduleId) => {
    if (!Array.isArray(entry?.cmlist) || entry.cmlist.some((cmId) => !id(cmId)) || new Set(entry.cmlist.map(id)).size !== entry.cmlist.length) return null;
    const matches = entry.cmlist.filter((cmId) => id(cmId) === moduleId);
    return matches.length === 1 ? matches[0] : null;
  };
  const sectionMembershipMatches = (data, section) => {
    if (!Array.isArray(section?.cmlist) || section.cmlist.some((cmId) => !id(cmId)) || new Set(section.cmlist.map(id)).size !== section.cmlist.length) return false;
    const sectionId = id(section.id);
    const direct = data.cm.filter((entry) => id(entry?.sectionid) === sectionId).map((entry) => id(entry?.id));
    return direct.length === section.cmlist.length && direct.every((cmId) => cmId && section.cmlist.some((listed) => id(listed) === cmId));
  };
  const canonicalMoveState = (value) => {
    if (!isObject(value) || !Array.isArray(value.cm)) return null;
    const seen = new Set();
    for (const entry of value.cm) {
      const entryId = id(entry?.id);
      if (!entryId || seen.has(entryId)) return null;
      seen.add(entryId);
    }
    const copy = JSON.parse(JSON.stringify(value));
    copy.cm.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    return copy;
  };
  const moveContract = (data, moduleId, targetSectionId) => {
    const activity = oneEntry(data.cm, moduleId);
    const source = activity ? oneEntry(data.section, id(activity.sectionid)) : null;
    const destination = oneEntry(data.section, targetSectionId);
    const movedMember = cmlistWithOne(source, moduleId);
    if (!activity || !source || !destination || id(source.id) === targetSectionId || !ordinaryVisibleSection(source) || !ordinaryVisibleSection(destination)
      || !["page", "assign", "quiz"].includes(activity.module) || activity.visible !== true || activity.stealth !== false
      || activity.hasdelegatedsection !== false || activity.uservisible !== true || activity.accessvisible !== true || activity.hascmrestrictions !== false
      || movedMember === null || !sectionMembershipMatches(data, source) || !sectionMembershipMatches(data, destination) || destination.cmlist.some((cmId) => id(cmId) === moduleId)) return null;
    return { activity, source, destination, movedMember };
  };
  const expectedMoveState = (data, moduleId, targetSectionId) => {
    const contract = moveContract(data, moduleId, targetSectionId);
    if (!contract) return null;
    const copy = JSON.parse(JSON.stringify(data));
    const activity = oneEntry(copy.cm, moduleId);
    const source = oneEntry(copy.section, id(contract.source.id));
    const destination = oneEntry(copy.section, targetSectionId);
    if (!activity || !source || !destination) return null;
    activity.sectionid = contract.destination.id;
    activity.sectionnumber = contract.destination.number;
    source.cmlist = source.cmlist.filter((cmId) => id(cmId) !== moduleId);
    destination.cmlist = [...destination.cmlist, contract.movedMember];
    return canonicalMoveState(copy);
  };
  const runMoveActivity = async (context, inputValue, args) => {
    const before = await state(context, args.course_id);
    if (!before.ok) return before;
    const beforeData = contentData(before.data);
    if (await digest(beforeData) !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const contract = moveContract(before.data, args.module_id, args.target_section_id);
    const expected = expectedMoveState(before.data, args.module_id, args.target_section_id);
    if (!contract || !expected) return error("moodle_move_precondition_refused");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const update = await ajax(rechecked, "core_courseformat_update_course", {
      action: "cm_move", courseid: Number(args.course_id), ids: [Number(args.module_id)], targetsectionid: Number(args.target_section_id), targetcmid: null,
    }, true);
    if (!update.ok) return update;
    const after = await state(rechecked, args.course_id);
    if (!after.ok) return { ok: false, sent: true, status: update.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const actual = canonicalMoveState(after.data);
    const matches = Boolean(actual) && stable(expected) === stable(actual);
    const data = contentData(after.data);
    return {
      ok: matches,
      sent: true,
      status: after.status,
      data,
      targets: [
        courseTarget(rechecked, after.data.course.fullname || after.data.course.name),
        { field: "module_id", label: "Activity", name: String(contract.activity.name || args.module_id) },
        { field: "target_section_id", label: "Destination section", name: String(contract.destination.title || contract.destination.rawtitle || args.target_section_id) },
      ],
      snapshot_digest: await digest(data),
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) },
      ...(matches ? {} : { error: "moodle_write_not_verified" }),
    };
  };
  const runVisibility = async (context, inputValue, definition, args) => {
    if (definition.kind === "course-show" || definition.kind === "course-hide") return runFormWrite(context, inputValue, definition, args);
    const collection = definition.kind.startsWith("section") ? "section" : "cm";
    const targetId = collection === "section" ? args.section_id : args.module_id;
    const before = await state(context, args.course_id);
    if (!before.ok) return before;
    const beforeData = contentData(before.data);
    const beforeDigest = await digest(beforeData);
    if (beforeDigest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const target = before.data[collection].find((entry) => id(entry?.id) === targetId);
    if (!target) return error("moodle_target_mismatch");
    if (collection === "cm" && target.hasdelegatedsection) return error("moodle_delegated_visibility_refused");
    const sectionChildren = collection === "section" ? before.data.cm.filter((entry) => id(entry?.sectionid) === targetId) : [];
    if (collection === "section" && (target.component || sectionChildren.some((entry) => entry?.hasdelegatedsection))) return error("moodle_delegated_visibility_refused");
    const sectionChildIds = sectionChildren.map((entry) => id(entry?.id));
    const protectedBefore = await stateProtectedDigest(before.data, collection, targetId, sectionChildIds);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const action = definition.kind.endsWith("show") ? `${collection === "section" ? "section" : "cm"}_show` : `${collection === "section" ? "section" : "cm"}_hide`;
    const update = await ajax(rechecked, "core_courseformat_update_course", { action, courseid: Number(args.course_id), ids: [Number(targetId)], targetsectionid: null, targetcmid: null }, true);
    if (!update.ok) return update;
    const after = await state(context, args.course_id);
    if (!after.ok) return { ok: false, sent: true, status: update.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const afterTarget = after.data[collection].find((entry) => id(entry?.id) === targetId);
    const expectedVisible = definition.kind.endsWith("show");
    const section = collection === "cm" ? after.data.section.find((entry) => id(entry?.id) === id(afterTarget?.sectionid)) : null;
    const afterSectionChildren = collection === "section" ? after.data.cm.filter((entry) => id(entry?.sectionid) === targetId) : [];
    const sectionChildrenMatch = collection !== "section" || (sectionChildren.length === afterSectionChildren.length
      && sectionChildren.every((entry) => afterSectionChildren.some((afterEntry) => id(afterEntry?.id) === id(entry?.id)))
      && afterSectionChildren.every((entry) => typeof entry?.visible === "boolean" && typeof entry?.accessvisible === "boolean"
        && typeof entry?.hascmrestrictions === "boolean" && typeof entry?.allowstealth === "boolean" && typeof entry?.stealth === "boolean"
        && (expectedVisible || entry.visible === false)
        && (entry.visible || (!entry.accessvisible && !entry.hascmrestrictions))));
    const derivedMatches = collection !== "cm" || (Boolean(section)
      && typeof afterTarget?.accessvisible === "boolean" && typeof afterTarget?.hascmrestrictions === "boolean"
      && afterTarget?.stealth === (expectedVisible && section.visible === false)
      && (expectedVisible || (afterTarget?.accessvisible === false && afterTarget?.hascmrestrictions === false)));
    const sectionMatches = collection !== "section" || (typeof afterTarget?.hasrestrictions === "boolean" && (expectedVisible || afterTarget.hasrestrictions === false));
    const matches = Boolean(afterTarget) && afterTarget.visible === expectedVisible && derivedMatches && sectionMatches && sectionChildrenMatch
      && protectedBefore === await stateProtectedDigest(after.data, collection, targetId, sectionChildIds);
    const data = contentData(after.data);
    return { ok: matches, sent: true, status: after.status, data, targets: [courseTarget(rechecked, after.data.course.fullname || after.data.course.name), { field: collection === "section" ? "section_id" : "module_id", label: collection === "section" ? "Section" : "Activity", name: targetId }], snapshot_digest: await digest(data), verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) }, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };

  const context = currentContext();
  if (input?.mode === "probe") return context ? { ok: true, profile: context.profile } : error("moodle_session_unavailable");
  if (input?.mode !== "execute" || !context) return error("moodle_session_unavailable");
  if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return error("moodle_execution_expired");
  const definition = expectedOperation(input.operation);
  if (!definition) return error("moodle_operation_refused");
  const bindingError = validateBinding(context, input.binding);
  if (bindingError) return error(bindingError);
  const checked = validateArguments(definition, input.arguments, input.binding, context);
  if (checked.error) return error(checked.error);
  const args = checked.value;
  try {
    if (definition.kind === "list-courses") {
      const response = await ajax(context, "core_course_get_enrolled_courses_by_timeline_classification", { classification: "allincludinghidden", limit: args.limit, offset: 0, sort: null, customfieldname: null, customfieldvalue: null, searchvalue: null, requiredfields: [] });
      if (!response.ok || !isObject(response.data) || !Array.isArray(response.data.courses)) return error(response.error || "moodle_courses_invalid", { status: response.status });
      const data = { courses: sanitize(response.data.courses.slice(0, args.limit)), truncated: response.data.courses.length >= args.limit };
      return { ok: true, sent: true, status: response.status, data, snapshot_digest: await digest(data) };
    }
    if (definition.kind === "structure" || definition.kind === "assignments" || definition.kind === "quizzes") return stateRead(context, args.course_id, definition.kind === "assignments" ? "assign" : definition.kind === "quizzes" ? "quiz" : "");
    if (definition.kind === "quiz-questions-read") {
      const result = await listQuizQuestions(context, input, args);
      if (!result.ok) return result;
      const { slots, ...output } = result;
      return output;
    }
    if (definition.kind === "quiz-question-read") return getQuizQuestion(context, input, args);
    if (definition.kind === "resource-files-read") return getResourceFiles(context, input, args);
    if (creationModule(definition.kind) && definition.kind.endsWith("form-read")) {
      const form = await loadCreationForm(context, args, definition.kind);
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: formTargets(context, form.descriptor, form.data), snapshot_digest: form.snapshot_digest };
    }
    if (definition.kind.endsWith("form-read")) {
      const form = await loadForm(context, formDescriptor(context, definition.kind, args));
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: formTargets(context, form.descriptor, form.data), snapshot_digest: form.snapshot_digest };
    }
    if (creationModule(definition.kind) && definition.kind.endsWith("form-write")) return runCreation(context, input, definition, args);
    if (definition.kind.includes("form-write") || definition.kind === "course-show" || definition.kind === "course-hide") return runFormWrite(context, input, definition, args);
    if (definition.kind === "activity-move") return runMoveActivity(context, input, args);
    return runVisibility(context, input, definition, args);
  } catch {
    return error("moodle_execution_failed");
  }
}
