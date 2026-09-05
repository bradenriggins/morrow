export async function executeMoodleInPage(input) {
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 100;
  const PROVIDER = "moodle";
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value) : /^[1-9][0-9]*$/.test(String(value || "")) ? String(value) : "";
  const error = (code, extra = {}) => ({ ok: false, sent: false, error: code, ...extra });
  const definitions = Object.freeze({
    "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1": { toolName: "moodle_list_my_courses", readOnly: true, kind: "list-courses" },
    "moodle.form.course.edit.read.v1": { toolName: "moodle_get_course", readOnly: true, kind: "course-form-read" },
    "moodle.ajax.core_courseformat_get_state.v1": { toolName: "moodle_get_contents", readOnly: true, kind: "structure" },
    "moodle.ajax.core_courseformat_get_state.assignments.v1": { toolName: "moodle_list_assignments", readOnly: true, kind: "assignments" },
    "moodle.ajax.core_courseformat_get_state.quizzes.v1": { toolName: "moodle_list_quizzes", readOnly: true, kind: "quizzes" },
    "moodle.form.course.edit.summary.read.v1": { toolName: "moodle_get_course_summary", readOnly: true, kind: "course-form-read" },
    "moodle.form.course.editsection.read.v1": { toolName: "moodle_get_section", readOnly: true, kind: "section-form-read" },
    "moodle.form.course.modedit.page.read.v1": { toolName: "moodle_get_page", readOnly: true, kind: "page-form-read" },
    "moodle.form.course.modedit.assign.read.v1": { toolName: "moodle_get_assignment", readOnly: true, kind: "assignment-form-read" },
    "moodle.form.course.modedit.quiz.read.v1": { toolName: "moodle_get_quiz", readOnly: true, kind: "quiz-form-read" },
    "moodle.form.course.edit.summary.write.v1": { toolName: "moodle_update_course_summary", readOnly: false, kind: "course-form-write" },
    "moodle.form.course.editsection.write.v1": { toolName: "moodle_update_section", readOnly: false, kind: "section-form-write" },
    "moodle.form.course.modedit.page.write.v1": { toolName: "moodle_update_page", readOnly: false, kind: "page-form-write" },
    "moodle.form.course.modedit.assign.write.v1": { toolName: "moodle_update_assignment", readOnly: false, kind: "assignment-form-write" },
    "moodle.form.course.modedit.quiz.write.v1": { toolName: "moodle_update_quiz", readOnly: false, kind: "quiz-form-write" },
    "moodle.form.course.edit.visibility.write.v1": { toolName: "moodle_show_course", readOnly: false, kind: "course-show" },
    "moodle.form.course.edit.visibility.hide.v1": { toolName: "moodle_hide_course", readOnly: false, kind: "course-hide" },
    "moodle.ajax.core_courseformat_update_course.section_show.v1": { toolName: "moodle_show_section", readOnly: false, kind: "section-show" },
    "moodle.ajax.core_courseformat_update_course.section_hide.v1": { toolName: "moodle_hide_section", readOnly: false, kind: "section-hide" },
    "moodle.ajax.core_courseformat_update_course.cm_show.v1": { toolName: "moodle_show_activity", readOnly: false, kind: "activity-show" },
    "moodle.ajax.core_courseformat_update_course.cm_hide.v1": { toolName: "moodle_hide_activity", readOnly: false, kind: "activity-hide" },
  });
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
    const courseName = String(globalThis.document?.querySelector?.("h1")?.textContent || "").trim().replace(/\s+/g, " ");
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
    const courseKinds = new Set(["course", "structure", "assignments", "quizzes", "course-form-read", "section-form-read", "page-form-read", "assignment-form-read", "quiz-form-read", "course-form-write", "section-form-write", "page-form-write", "assignment-form-write", "quiz-form-write", "course-show", "course-hide", "section-show", "section-hide", "activity-show", "activity-hide"]);
    if (definition.kind === "list-courses") {
      if (!only(value, ["limit"]) || (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_ITEMS))) return { error: "moodle_arguments_invalid" };
      return { value: { limit: value.limit || 50 } };
    }
    if (courseKinds.has(definition.kind)) {
      const courseId = courseArgument(value, binding, context);
      if (!courseId) return { error: "moodle_course_mismatch" };
      value.course_id = courseId;
    }
    const moduleKinds = new Set(["page-form-read", "assignment-form-read", "quiz-form-read", "page-form-write", "assignment-form-write", "quiz-form-write", "activity-show", "activity-hide"]);
    const sectionKinds = new Set(["section-form-read", "section-form-write", "section-show", "section-hide"]);
    if (moduleKinds.has(definition.kind)) {
      if (!id(value.module_id)) return { error: "moodle_arguments_invalid" };
      value.module_id = id(value.module_id);
    }
    if (sectionKinds.has(definition.kind)) {
      if (!id(value.section_id)) return { error: "moodle_arguments_invalid" };
      value.section_id = id(value.section_id);
    }
    const reads = new Set(["course", "structure", "assignments", "quizzes", "course-form-read", "section-form-read", "page-form-read", "assignment-form-read", "quiz-form-read"]);
    if (reads.has(definition.kind)) {
      const allowed = definition.kind.startsWith("section") ? ["course_id", "section_id"]
        : (definition.kind.startsWith("page") || definition.kind.startsWith("assignment") || definition.kind.startsWith("quiz")) ? ["course_id", "module_id"]
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
    if (definition.kind === "assignment-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "due_date", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.due_date === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.instructions !== undefined && !validString(value.instructions, 40000))
        || (value.due_date !== undefined && !validDate(value.due_date))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "quiz-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "open_at", "close_at", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.open_at === undefined && value.close_at === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.instructions !== undefined && !validString(value.instructions, 40000))
        || (value.open_at !== undefined && !validDate(value.open_at)) || (value.close_at !== undefined && !validDate(value.close_at))) return { error: "moodle_arguments_invalid" };
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
  const formDescriptor = (context, kind, args) => {
    const courseId = args.course_id;
    if (kind.startsWith("course")) return {
      type: "course", expectedPath: "/course/edit.php", endpoint: urlFor(context, "/course/edit.php", { id: courseId }), expected: { id: courseId }, required: ["summary_editor[text]", "visible"], courseId,
    };
    if (kind.startsWith("section")) return {
      type: "section", expectedPath: "/course/editsection.php", endpoint: urlFor(context, "/course/editsection.php", { id: args.section_id }), expected: { id: args.section_id, course: courseId }, required: ["name", "summary_editor[text]"], courseId, sectionId: args.section_id,
    };
    const module = kind.startsWith("page") ? "page" : kind.startsWith("assignment") ? "assign" : "quiz";
    const required = module === "page" ? ["name", "page[text]"] : module === "assign" ? ["name", "introeditor[text]", "duedate[enabled]"] : ["name", "introeditor[text]", "timeopen[enabled]", "timeclose[enabled]"];
    return {
      type: module, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: module }, required, courseId, moduleId: args.module_id,
    };
  };
  const valuesFromForm = (formData, form) => {
    const values = {};
    for (const [name, value] of formData.entries()) {
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
    if (descriptor.type === "page") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), content: one(values, "page[text]"), content_format: Number(one(values, "page[format]")) };
    if (descriptor.type === "assign") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), due_date: dateFromForm(values, "duedate") };
    return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), open_at: dateFromForm(values, "timeopen"), close_at: dateFromForm(values, "timeclose") };
  };
  const loadForm = async (context, descriptor) => {
    let response;
    try { response = await fetch(descriptor.endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return { ok: false, sent: false, error: "moodle_form_read_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    if (!response.ok || typeof DOMParser === "undefined" || typeof FormData === "undefined") return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    const forms = Array.from(documentValue.querySelectorAll("form")).filter((form) => {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const candidate = new FormData(form);
        return Object.entries(descriptor.expected).every(([name, expected]) => String(candidate.get(name) || "") === String(expected));
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
    try { formData = new FormData(form); values = valuesFromForm(formData, form); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    if (descriptor.required.some((name) => !Object.hasOwn(values, name))) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    return { ok: true, sent: true, status: response.status, action: action.toString(), formData, values, submit: submitControl ? { name: submitName, value: submitControl.value } : null, data: formDataFor(descriptor, values), snapshot_digest: await digest(values), descriptor };
  };
  const protectedDigest = (values, names) => {
    const copy = { ...values };
    for (const name of names) delete copy[name];
    return digest(copy);
  };
  const setField = (formData, name, value) => { formData.delete(name); formData.append(name, String(value)); };
  const setDate = (formData, name, value) => {
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
    return { ok: true, sent: true, status: response.status };
  };
  const courseTarget = (context, name = "") => ({ field: "course_id", label: "Course", name: String(name || context.profile.courseName || "Moodle course") });
  const formTargets = (context, descriptor, data) => {
    const course = courseTarget(context, data.fullname);
    if (descriptor.type === "section") return [course, { field: "section_id", label: "Section", name: String(data.name || descriptor.sectionId) }];
    if (["page", "assign", "quiz"].includes(descriptor.type)) return [course, { field: "module_id", label: "Activity", name: String(data.name || descriptor.moduleId) }];
    return [course];
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
    if (kind === "assignment-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.due_date !== undefined) { setDate(formData, "duedate", args.due_date); names.push("duedate[enabled]", "duedate[year]", "duedate[month]", "duedate[day]", "duedate[hour]", "duedate[minute]"); }
    }
    if (kind === "quiz-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.open_at !== undefined) { setDate(formData, "timeopen", args.open_at); names.push("timeopen[enabled]", "timeopen[year]", "timeopen[month]", "timeopen[day]", "timeopen[hour]", "timeopen[minute]"); }
      if (args.close_at !== undefined) { setDate(formData, "timeclose", args.close_at); names.push("timeclose[enabled]", "timeclose[year]", "timeclose[month]", "timeclose[day]", "timeclose[hour]", "timeclose[minute]"); }
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
  const stateProtectedDigest = async (stateValue, collection, targetId) => {
    const copy = JSON.parse(JSON.stringify(stateValue));
    const target = Array.isArray(copy[collection]) ? copy[collection].find((entry) => id(entry?.id) === targetId) : null;
    if (target) delete target.visible;
    return digest(contentData(copy));
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
    const protectedBefore = await stateProtectedDigest(before.data, collection, targetId);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const action = definition.kind.endsWith("show") ? `${collection === "section" ? "section" : "cm"}_show` : `${collection === "section" ? "section" : "cm"}_hide`;
    const update = await ajax(rechecked, "core_courseformat_update_course", { action, courseid: Number(args.course_id), ids: [Number(targetId)], targetsectionid: null, targetcmid: null }, true);
    if (!update.ok) return update;
    const after = await state(context, args.course_id);
    if (!after.ok) return { ok: false, sent: true, status: update.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const afterTarget = after.data[collection].find((entry) => id(entry?.id) === targetId);
    const expectedVisible = definition.kind.endsWith("show");
    const matches = Boolean(afterTarget) && Boolean(afterTarget.visible) === expectedVisible && protectedBefore === await stateProtectedDigest(after.data, collection, targetId);
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
    if (definition.kind.endsWith("form-read")) {
      const form = await loadForm(context, formDescriptor(context, definition.kind, args));
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: formTargets(context, form.descriptor, form.data), snapshot_digest: form.snapshot_digest };
    }
    if (definition.kind.includes("form-write") || definition.kind === "course-show" || definition.kind === "course-hide") return runFormWrite(context, input, definition, args);
    return runVisibility(context, input, definition, args);
  } catch {
    return error("moodle_execution_failed");
  }
}
