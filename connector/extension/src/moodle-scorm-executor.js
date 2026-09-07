/**
 * Edits the bounded settings of one existing local Moodle SCORM activity and can
 * replace its package with one reviewed ZIP.
 *
 * Both operations read the exact native `course/modedit.php` SCORM form, refuse any
 * package type other than a local package and any automatic update frequency,
 * preserve every control outside the stated scope through a protected digest, send
 * one native POST with Save and return to course, and read the saved form back.
 * Neither operation opens `/mod/scorm/view.php`, `player.php`, or `report.php`.
 *
 * Native source: https://github.com/moodle/moodle/blob/v5.2.2/public/mod/scorm/mod_form.php
 * and https://github.com/moodle/moodle/blob/v5.2.2/public/mod/scorm/lib.php.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every dependency
 * inside the function body.
 */
export async function executeMoodleScormInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_PACKAGE_BYTES = 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_VALUE_BYTES = 64 * 1024;
  const ID = /^[1-9][0-9]{0,18}$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const SELECT_SETTINGS = ["popup", "skipview", "displaycoursestructure", "hidebrowse", "maxattempt", "whatgrade", "grademethod"];
  const DATE_SETTINGS = [["open_at", "timeopen"], ["close_at", "timeclose"]];
  const DATE_PARTS = ["year", "month", "day", "hour", "minute"];
  const PACKAGE_FIELD = "packagefile";
  const definitions = Object.freeze({
    "moodle.form.course.modedit.scorm.write.v1": { toolName: "moodle_update_scorm", readOnly: false, kind: "settings" },
    "moodle.form.course.modedit.scorm.package.replace.write.v1": { toolName: "moodle_replace_scorm_package", readOnly: false, kind: "package" },
  });
  const parseInput = () => {
    if (typeof rawInput !== "string") return rawInput;
    try { return JSON.parse(rawInput); } catch { return null; }
  };
  const input = parseInput();
  let writeAttempted = false;
  const failure = (error, status) => ({ ok: false, sent: false, ...(Number.isInteger(status) ? { status } : {}), error });
  const unconfirmed = (error, status) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    outcomeUnknown: true,
    verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: error },
    error,
  });
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const validString = (value, maximum) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000");
  const validSelectValue = (value) => validString(value, 64) && Boolean(value);
  const hasEmbeddedFile = (value) => /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i.test(String(value));
  const validDate = (value) => {
    if (!object(value) || Object.keys(value).length !== 5 || !DATE_PARTS.every((key) => Number.isSafeInteger(value[key]))) return false;
    const { year, month, day, hour, minute } = value;
    if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const compareDate = (left, right) => Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) - Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
  const validFilename = (value) => typeof value === "string" && value.length >= 5 && value.length <= 255 && value === value.trim()
    && !/[\\/\u0000-\u001f]/.test(value) && value !== "." && value !== ".." && /\.zip$/i.test(value);
  // The digest inputs below must stay identical to the `moodle_get_scorm` read in
  // moodle-executor.js, so that its snapshot digest is the expected digest here.
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_scorm_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const bytesDigest = async (bytes) => {
    if (!globalThis.crypto?.subtle) throw new Error("moodle_scorm_digest_unavailable");
    const value = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!object(cfg) || typeof cfg.wwwroot !== "string" || !validString(cfg.sesskey, 1024) || !cfg.sesskey) return null;
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
    if (configuredCourse && bodyCourse && configuredCourse !== bodyCourse) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId: configuredCourse || bodyCourse || "", sesskey: cfg.sesskey };
  };
  const sameContext = (left, right) => left?.origin === right?.origin && left?.siteUrl === right?.siteUrl
    && left?.basePath === right?.basePath && left?.principalId === right?.principalId
    && left?.anchorCourseId === right?.anchorCourseId && left?.sesskey === right?.sesskey;
  const bindingValid = (context, binding) => object(binding) && binding.origin === context.origin && binding.siteUrl === context.siteUrl
    && String(binding.principalId || "") === context.principalId && Boolean(id(binding.courseId));
  const urlFor = (context, path, params = {}) => {
    const url = new URL(context.siteUrl);
    url.pathname = `${context.basePath}${path}`;
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return url.toString();
  };
  const expectedOperation = (operation) => {
    if (!object(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    return definition && operation.provider === PROVIDER && operation.toolName === definition.toolName
      && operation.readOnly === definition.readOnly ? definition : null;
  };
  const exactKeys = (value, required, optional = []) => object(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const settingsArguments = (value, courseId) => {
    const optional = ["name", "instructions", ...SELECT_SETTINGS, ...DATE_SETTINGS.map(([argument]) => argument)];
    if (!exactKeys(value, ["course_id", "module_id", "expected_digest"], optional)) return null;
    if (id(value.course_id) !== courseId || !id(value.module_id) || !DIGEST.test(String(value.expected_digest || ""))) return null;
    if (!optional.some((key) => Object.hasOwn(value, key))) return null;
    if (Object.hasOwn(value, "name") && (!validString(value.name, 1333) || !value.name.trim())) return null;
    if (Object.hasOwn(value, "instructions") && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions))) return null;
    if (SELECT_SETTINGS.some((key) => Object.hasOwn(value, key) && !validSelectValue(value[key]))) return null;
    for (const [argument] of DATE_SETTINGS) {
      if (Object.hasOwn(value, argument) && value[argument] !== null && !validDate(value[argument])) return null;
    }
    if (value.open_at && value.close_at && compareDate(value.close_at, value.open_at) < 0) return null;
    return { courseId, moduleId: id(value.module_id), expectedDigest: value.expected_digest, settings: value };
  };
  const packageArguments = (value, courseId) => {
    if (!exactKeys(value, ["course_id", "module_id", "filename", "size_bytes", "sha256", "expected_digest"])) return null;
    if (id(value.course_id) !== courseId || !id(value.module_id) || !DIGEST.test(String(value.expected_digest || ""))) return null;
    if (!validFilename(value.filename) || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_PACKAGE_BYTES
      || !DIGEST.test(String(value.sha256 || ""))) return null;
    return {
      courseId,
      moduleId: id(value.module_id),
      expectedDigest: value.expected_digest,
      manifest: { filename: value.filename, size_bytes: value.size_bytes, sha256: value.sha256 },
    };
  };
  const readText = async (response) => {
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declared) && declared > MAX_BYTES) throw new Error("moodle_scorm_response_too_large");
    const text = await response.text();
    if (typeof text !== "string" || text.length > MAX_BYTES) throw new Error("moodle_scorm_response_too_large");
    return text;
  };
  const readLimitedBytes = async (response, maximum = MAX_PACKAGE_BYTES) => {
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declared) && declared > maximum) throw new Error("moodle_scorm_response_too_large");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximum) throw new Error("moodle_scorm_response_too_large");
    return new Uint8Array(buffer);
  };
  const draftItemId = (value) => typeof value === "string" && ID.test(value) && Number.isSafeInteger(Number(value)) ? value : "";
  const draftFilesAjax = async (context, action, body) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/repository/draftfiles_ajax.php", { action }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, ...body }),
      });
    } catch { return null; }
    let text;
    try { text = await readText(response); } catch { return null; }
    if (!response.ok) return null;
    let payload;
    try { payload = JSON.parse(text); } catch { return null; }
    return object(payload) ? payload : null;
  };
  const readDraftListing = (context, itemId, filepath = "/") => draftFilesAjax(context, "list", { itemid: itemId, filepath });
  const managerState = (listing) => !listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)
    ? "unverified" : listing.filecount === 0 && listing.list.length === 0 ? "empty" : "nonempty";
  const inspectFileManagers = async (context, form, formData) => {
    const managers = [];
    const seen = new Set();
    const inspect = async (name, value) => {
      seen.add(name);
      const itemId = draftItemId(value);
      const listing = itemId ? await readDraftListing(context, itemId) : null;
      managers.push({ name, itemId, state: managerState(listing), listing });
    };
    for (const control of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(control.getAttribute("name") || "");
      if (!name || seen.has(name)) continue;
      await inspect(name, formData.get(name));
    }
    for (const name of new Set(Array.from(formData.keys()).filter((entry) => /\[itemid\]$/.test(entry)))) {
      if (seen.has(name)) continue;
      const values = formData.getAll(name);
      await inspect(name, values.length === 1 ? values[0] : "");
    }
    return managers;
  };
  const valuesFromForm = (formData, form, fileManagers) => {
    const states = new Map(fileManagers.map(({ name, state }) => [name, state]));
    const values = {};
    for (const [name, value] of formData.entries()) {
      const managerStateValue = states.get(name);
      if (managerStateValue) {
        if (values[name] === undefined) values[name] = { filemanager: { state: managerStateValue } };
        continue;
      }
      if (transientField(name)) continue;
      if (typeof File !== "undefined" && value instanceof File) {
        if (value.size > 0) throw new Error("moodle_scorm_form_invalid");
        continue;
      }
      if (typeof value !== "string") throw new Error("moodle_scorm_form_invalid");
      const safeValue = redact(value);
      if (values[name] === undefined) values[name] = safeValue;
      else if (Array.isArray(values[name])) values[name].push(safeValue);
      else values[name] = [values[name], safeValue];
    }
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      if (control.checked) continue;
      values[control.name] = "0";
      const prefix = control.name.slice(0, -"[enabled]".length);
      for (const part of DATE_PARTS) delete values[`${prefix}[${part}]`];
    }
    return values;
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
  const dateFromValues = (values, field) => {
    if (one(values, `${field}[enabled]`) !== "1") return null;
    const date = Object.fromEntries(DATE_PARTS.map((part) => [part, Number(one(values, `${field}[${part}]`))]));
    return validDate(date) ? date : null;
  };
  const namedControls = (documentValue, name) => Array.from(documentValue?.querySelectorAll?.("[name]") || [])
    .filter((control) => control.getAttribute("name") === name);
  const selectAllows = (documentValue, name, value) => {
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1 || selects[0].disabled || selects[0].multiple) return false;
    return Array.from(selects[0].options || []).some((option) => String(option.value || "") === value);
  };
  const selectedValue = (documentValue, values, name) => {
    const current = one(values, name);
    if (current) return current;
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return "";
    const selected = Array.from(selects[0].options || []).filter((option) => option.selected);
    return selected.length === 1 ? String(selected[0].value || "") : "";
  };
  const textWritable = (documentValue, name) => {
    const controls = namedControls(documentValue, name).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
    return controls.length === 1 && !controls[0].disabled;
  };
  const dateWritable = (documentValue, field) => {
    const toggles = namedControls(documentValue, `${field}[enabled]`)
      .filter((control) => String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (toggles.length !== 1 || toggles[0].disabled) return false;
    return DATE_PARTS.every((part) => {
      const selects = namedControls(documentValue, `${field}[${part}]`).filter((control) => control.tagName === "SELECT");
      return selects.length === 1 && !selects[0].disabled;
    });
  };
  const routeMatches = (value, endpoint, required) => {
    let actual;
    let expected;
    try { actual = new URL(value || endpoint); expected = new URL(endpoint); } catch { return false; }
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && [...actual.searchParams.keys()].length === Object.keys(required).length
      && Object.entries(required).every(([name, item]) => actual.searchParams.getAll(name).length === 1 && actual.searchParams.get(name) === String(item));
  };
  const jsonObjectAt = (source, start) => {
    let index = start;
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] !== "{") return "";
    const begin = index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(begin, index + 1);
      }
    }
    return "";
  };
  const packageManagerConfig = (documentValue, formData) => {
    const itemId = draftItemId(formData.getAll(PACKAGE_FIELD).length === 1 ? String(formData.get(PACKAGE_FIELD) || "") : "");
    const inputs = documentValue.querySelectorAll(`[data-fieldtype="filemanager"] input[type="hidden"][name="${PACKAGE_FIELD}"]`);
    if (!itemId || inputs.length !== 1 || !inputs[0].id || inputs[0].value !== itemId
      || documentValue.querySelectorAll(`[id="${CSS.escape(inputs[0].id)}"]`).length !== 1) return null;
    const configs = [];
    for (const script of documentValue.querySelectorAll("script:not([src])")) {
      const source = String(script.textContent || "");
      if (source.length > MAX_BYTES || source.includes("\u0000")) return null;
      const calls = /\bM\.form_filemanager\.init\s*\(/g;
      let call;
      while ((call = calls.exec(source))) {
        const comma = source.indexOf(",", calls.lastIndex);
        if (comma < calls.lastIndex) return null;
        const json = jsonObjectAt(source, comma + 1);
        if (!json) return null;
        let config;
        try { config = JSON.parse(json); } catch { return null; }
        if (!object(config)) return null;
        configs.push(config);
        calls.lastIndex = comma + json.length + 1;
      }
    }
    const matches = configs.filter((config) => config.target === inputs[0].id);
    if (matches.length !== 1) return null;
    const config = matches[0];
    const accepted = Array.isArray(config.accepted_types) ? config.accepted_types : [];
    const acceptedTypes = accepted.filter((entry) => entry === ".zip" || entry === ".xml");
    const validLimit = (value) => Number.isSafeInteger(value) && value >= -1;
    const uploads = object(config.filepicker) && object(config.filepicker.repositories)
      ? Object.entries(config.filepicker.repositories).filter(([key, repository]) => object(repository) && repository.type === "upload" && id(key) === id(repository.id))
      : [];
    const author = config.author === undefined ? null
      : typeof config.author === "string" && config.author.length <= 255 && !config.author.includes("\u0000") ? config.author : false;
    const contextId = id(config.context?.id);
    if (id(config.itemid) !== itemId || !contextId || accepted.length !== 2 || acceptedTypes.length !== 2
      || config.maxfiles !== 1 || (config.subdirs !== false && config.subdirs !== 0) || !validLimit(config.maxbytes)
      || uploads.length !== 1 || !id(uploads[0][0]) || !id(uploads[0][1].id) || author === false) return null;
    return { itemId, contextId, repoId: id(uploads[0][1].id), author, maxBytes: config.maxbytes, acceptedTypes };
  };
  const packageFileFromListing = (listing) => {
    if (!object(listing) || listing.filecount !== 1 || !Array.isArray(listing.list) || listing.list.length !== 1
      || !object(listing.tree) || !Array.isArray(listing.tree.children) || listing.tree.children.length !== 0) return null;
    const file = listing.list[0];
    const size = file?.size === null ? 0 : file?.size;
    if (!object(file) || file.filepath !== "/" || (file.type !== "file" && file.type !== "zip")
      || typeof file.filename !== "string" || !file.filename || file.filename.length > 255 || file.filename.includes("/")
      || !Number.isSafeInteger(size) || size < 0) return null;
    return { filename: file.filename, size_bytes: size };
  };
  const loadScormForm = async (context, courseId, moduleId) => {
    const endpoint = urlFor(context, "/course/modedit.php", { update: moduleId, return: 0 });
    const route = { update: moduleId, return: "0" };
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_scorm_form_read_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { error: "moodle_scorm_form_read_failed", status: response.status }; }
    if (!response.ok || typeof DOMParser === "undefined" || typeof FormData === "undefined" || !routeMatches(response.url, endpoint, route)) {
      return { error: "moodle_scorm_form_read_failed", status: response.status };
    }
    const status = response.status;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { error: "moodle_scorm_form_read_failed", status }; }
    const identity = { update: moduleId, course: courseId, modulename: "scorm" };
    const forms = Array.from(documentValue.querySelectorAll("form")).filter((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const values = new FormData(candidate);
        return Object.entries(identity).every(([name, item]) => values.getAll(name).length === 1 && String(values.get(name) || "") === item);
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_scorm_form_target_invalid", status };
    const form = forms[0];
    let action;
    try { action = new URL(form.getAttribute("action") || endpoint, endpoint); } catch { return { error: "moodle_scorm_form_target_invalid", status }; }
    const expected = new URL(endpoint);
    if (action.origin !== expected.origin || action.pathname !== expected.pathname || action.hash
      || (action.search && !routeMatches(action.toString(), endpoint, route))) return { error: "moodle_scorm_form_target_invalid", status };
    const submits = Array.from(form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]'))
      .filter((control) => control.name === "submitbutton2" && !control.disabled && typeof control.value === "string" && control.value && control.value.length <= 500);
    if (submits.length !== 1) return { error: "moodle_scorm_form_target_invalid", status };
    let formData;
    try { formData = new FormData(form); } catch { return { error: "moodle_scorm_form_read_failed", status }; }
    const entries = [...formData.entries()];
    if (entries.length > MAX_FORM_ENTRIES
      || entries.some(([name, value]) => typeof name !== "string" || !name || name.length > 255 || (typeof value === "string" && value.length > MAX_VALUE_BYTES))) {
      return { error: "moodle_scorm_form_target_invalid", status };
    }
    const sesskeys = formData.getAll("sesskey");
    if (sesskeys.length !== 1 || sesskeys[0] !== context.sesskey) return { error: "moodle_form_session_mismatch", status };
    let fileManagers;
    let values;
    try {
      fileManagers = await inspectFileManagers(context, form, formData);
      values = valuesFromForm(formData, form, fileManagers);
    } catch { return { error: "moodle_scorm_form_read_failed", status }; }
    if (!["name", PACKAGE_FIELD, "scormtype", "updatefreq", "popup"].every((name) => Object.hasOwn(values, name))) {
      return { error: "moodle_scorm_form_target_invalid", status };
    }
    if (one(values, "scormtype") !== "local" || one(values, "updatefreq") !== "0") return { error: "moodle_scorm_package_type_refused", status };
    const manager = packageManagerConfig(documentValue, formData);
    const packageManager = fileManagers.filter((entry) => entry.name === PACKAGE_FIELD);
    if (!manager || packageManager.length !== 1 || packageManager[0].itemId !== manager.itemId
      || packageManager[0].state !== "nonempty") return { error: "moodle_scorm_package_area_invalid", status };
    if (fileManagers.some((entry) => entry.name !== PACKAGE_FIELD && entry.state !== "empty")) {
      return { error: "moodle_scorm_form_files_refused", status };
    }
    const packageFile = packageFileFromListing(packageManager[0].listing);
    if (!packageFile) return { error: "moodle_scorm_package_area_invalid", status };
    return {
      status,
      document: documentValue,
      form,
      formData,
      values,
      manager,
      packageFile,
      identity,
      action: action.toString(),
      submit: { name: submits[0].name, value: submits[0].value },
      visible: one(values, "visible") === "1",
      snapshotDigest: await digest(values),
    };
  };
  const protectedDigest = (values, names, packageFile) => {
    const copy = { ...values };
    for (const name of names) delete copy[name];
    return digest(packageFile ? { values: copy, package: packageFile } : { values: copy });
  };
  const protectedNames = (values, names) => [...new Set(Object.keys(values).filter((name) => !names.includes(name)))].sort();
  const output = (courseId, moduleId, form) => ({
    course_id: Number(courseId),
    module_id: Number(moduleId),
    name: one(form.values, "name"),
    instructions: one(form.values, "introeditor[text]"),
    instructions_format: Number(one(form.values, "introeditor[format]")),
    package_type: one(form.values, "scormtype"),
    update_frequency: one(form.values, "updatefreq"),
    ...Object.fromEntries(SELECT_SETTINGS.map((name) => [name, selectedValue(form.document, form.values, name)])),
    ...Object.fromEntries(DATE_SETTINGS.map(([argument, field]) => [argument, dateFromValues(form.values, field)])),
    visible: form.visible,
    package: form.packageFile,
  });
  const settingChanges = (form, settings) => {
    const names = [];
    if (Object.hasOwn(settings, "name")) {
      if (!textWritable(form.document, "name")) return null;
      names.push("name");
    }
    if (Object.hasOwn(settings, "instructions")) {
      if (!textWritable(form.document, "introeditor[text]")) return null;
      names.push("introeditor[text]");
    }
    for (const name of SELECT_SETTINGS) {
      if (!Object.hasOwn(settings, name)) continue;
      if (!selectAllows(form.document, name, settings[name])) return null;
      names.push(name);
    }
    for (const [argument, field] of DATE_SETTINGS) {
      if (!Object.hasOwn(settings, argument)) continue;
      if (!dateWritable(form.document, field)) return null;
      names.push(`${field}[enabled]`, ...DATE_PARTS.map((part) => `${field}[${part}]`));
    }
    return names;
  };
  const applySettings = (formData, settings) => {
    const set = (name, value) => { formData.delete(name); formData.append(name, String(value)); };
    if (Object.hasOwn(settings, "name")) set("name", settings.name);
    if (Object.hasOwn(settings, "instructions")) set("introeditor[text]", settings.instructions);
    for (const name of SELECT_SETTINGS) if (Object.hasOwn(settings, name)) set(name, settings[name]);
    for (const [argument, field] of DATE_SETTINGS) {
      if (!Object.hasOwn(settings, argument)) continue;
      const value = settings[argument];
      if (value === null) {
        formData.delete(`${field}[enabled]`);
        continue;
      }
      set(`${field}[enabled]`, "1");
      for (const part of DATE_PARTS) set(`${field}[${part}]`, value[part]);
    }
  };
  const zipHasSingleRootManifest = (bytes) => {
    const MAX_ZIP_ENTRIES = 10_000;
    const MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
    const MAX_ZIP_COMPRESSION_RATIO = 200;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let index = bytes.byteLength - 22, minimum = Math.max(0, bytes.byteLength - 65_557); index >= minimum; index -= 1) {
      if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
    }
    if (eocd < 0 || eocd + 22 + view.getUint16(eocd + 20, true) !== bytes.byteLength
      || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) return false;
    const entriesOnDisk = view.getUint16(eocd + 8, true);
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (entriesOnDisk !== entries || entries < 1 || entries > MAX_ZIP_ENTRIES
      || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralSize !== eocd) return false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const names = new Set();
    const localOffsets = new Set();
    let manifestCount = 0;
    let uncompressed = 0;
    let offset = centralOffset;
    for (let index = 0; index < entries; index += 1) {
      if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) return false;
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameLength < 1 || nameEnd > eocd || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff || localOffset >= centralOffset) return false;
      let name;
      try { name = decoder.decode(bytes.subarray(nameStart, nameEnd)); } catch { return false; }
      if (!name || name.includes("\u0000") || name.includes("\\") || name.startsWith("/")
        || name.split("/").some((part) => part === ".." ) || names.has(name) || localOffsets.has(localOffset)) return false;
      names.add(name);
      localOffsets.add(localOffset);
      if (name === "imsmanifest.xml") manifestCount += 1;
      uncompressed += uncompressedSize;
      if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) return false;
      if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO) return false;
      offset = nameEnd + extraLength + commentLength;
    }
    return offset === eocd && manifestCount === 1;
  };
  const exactPrivatePackage = async (inputValue, manifest) => {
    const attachment = inputValue?.privateAttachment;
    if (!object(attachment) || Object.keys(attachment).some((key) => !["schema", "handle", "manifest", "bytes_base64"].includes(key))
      || attachment.schema !== "morrow.private-file-attachment.v1" || typeof attachment.handle !== "string"
      || !/^[A-Za-z0-9:_.-]{8,200}$/.test(attachment.handle) || typeof attachment.bytes_base64 !== "string"
      || attachment.bytes_base64.length < 4 || attachment.bytes_base64.length > 1_398_104 || !object(attachment.manifest)
      || attachment.manifest.filename !== manifest.filename || attachment.manifest.size_bytes !== manifest.size_bytes
      || attachment.manifest.sha256 !== manifest.sha256) return null;
    let decoded;
    try {
      const binary = globalThis.atob(attachment.bytes_base64);
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch { return null; }
    if (decoded.byteLength !== manifest.size_bytes) return null;
    let sha256;
    try { sha256 = await bytesDigest(decoded); } catch { return null; }
    return sha256 === manifest.sha256 ? decoded : null;
  };
  const nativeDraftUrl = (context, value, itemId, filename) => {
    let url;
    try { url = new URL(value); } catch { return ""; }
    if (url.origin !== context.origin || url.username || url.password || url.hash || url.protocol !== "https:") return "";
    const path = `${context.basePath}/draftfile.php`;
    if (url.pathname === path) {
      if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll("file").length !== 1) return "";
      const parts = String(url.searchParams.get("file") || "").split("/").filter(Boolean);
      return parts.length === 5 && id(parts[0]) && parts[1] === "user" && parts[2] === "draft" && parts[3] === itemId && parts[4] === filename ? url.toString() : "";
    }
    const prefix = `${path}/`;
    const parts = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split("/") : [];
    return !url.search && parts.length === 5 && id(parts[0]) && parts[1] === "user" && parts[2] === "draft"
      && parts[3] === itemId && decodeURIComponent(parts[4]) === filename ? url.toString() : "";
  };
  const uploadPackageDraft = async (context, manager, manifest, bytes) => {
    let file;
    try { file = new File([bytes], manifest.filename, { type: "application/octet-stream" }); } catch { return { error: "moodle_scorm_package_attachment_invalid" }; }
    const body = new FormData();
    body.append("repo_upload_file", file, manifest.filename);
    body.append("sesskey", context.sesskey);
    body.append("repo_id", manager.repoId);
    body.append("itemid", manager.itemId);
    body.append("savepath", "/");
    body.append("title", manifest.filename);
    body.append("ctx_id", manager.contextId);
    for (const acceptedType of manager.acceptedTypes) body.append("accepted_types[]", acceptedType);
    if (manager.author !== null) body.append("author", manager.author);
    let response;
    try {
      response = await fetch(urlFor(context, "/repository/repository_ajax.php", { action: "upload" }), {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json" }, body,
      });
    } catch { return { error: "moodle_scorm_package_upload_refused" }; }
    let text;
    try { text = await readText(response); } catch { return { error: "moodle_scorm_package_upload_refused", status: response.status }; }
    let result;
    try { result = JSON.parse(text); } catch { return { error: "moodle_scorm_package_upload_refused", status: response.status }; }
    if (!response.ok || !object(result) || result.error || result.fileexists || id(result.id) !== manager.itemId
      || result.file !== manifest.filename || typeof result.url !== "string") return { error: "moodle_scorm_package_upload_refused", status: response.status };
    const draftUrl = nativeDraftUrl(context, result.url, manager.itemId, manifest.filename);
    return draftUrl ? { status: response.status, draftUrl } : { error: "moodle_scorm_package_upload_refused", status: response.status };
  };
  const draftBytesMatch = async (context, draftUrl, manifest) => {
    let response;
    try { response = await fetch(draftUrl, { method: "GET", credentials: "include", cache: "no-store", redirect: "error" }); } catch { return false; }
    if (!response.ok || response.url !== draftUrl) return false;
    let bytes;
    try { bytes = await readLimitedBytes(response); } catch { return false; }
    if (bytes.byteLength !== manifest.size_bytes) return false;
    try { return await bytesDigest(bytes) === manifest.sha256; } catch { return false; }
  };
  const savedPackageBytesMatch = async (context, contextId, manifest) => {
    const endpoint = urlFor(context, `/pluginfile.php/${contextId}/mod_scorm/package/${encodeURIComponent(manifest.filename)}`, { forcedownload: 1 });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error" }); } catch { return false; }
    if (!response.ok || response.url !== endpoint) return false;
    let bytes;
    try { bytes = await readLimitedBytes(response); } catch { return false; }
    if (bytes.byteLength !== manifest.size_bytes) return false;
    try { return await bytesDigest(bytes) === manifest.sha256; } catch { return false; }
  };
  // Moodle redisplays the same native form when it rejects the values, so nothing was saved.
  const sameFormReturned = (text, form) => {
    if (typeof DOMParser === "undefined" || typeof text !== "string") return false;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return false; }
    const action = new URL(form.action);
    return Array.from(documentValue.querySelectorAll("form")).some((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const candidateAction = new URL(candidate.getAttribute("action") || form.action, form.action);
        if (candidateAction.origin !== action.origin || candidateAction.pathname !== action.pathname) return false;
        const values = new FormData(candidate);
        return Object.entries(form.identity).every(([name, item]) => values.getAll(name).length === 1 && String(values.get(name) || "") === item);
      } catch { return false; }
    });
  };
  const postScormForm = async (context, form) => {
    const params = new URLSearchParams();
    try {
      for (const [name, value] of form.formData.entries()) {
        if (name === "coursecontentnotification" || name === "submitbutton" || name === "submitbutton2") continue;
        if (typeof File !== "undefined" && value instanceof File) {
          if (value.size > 0) return { error: "moodle_scorm_form_files_refused" };
          continue;
        }
        if (typeof value !== "string") return { error: "moodle_scorm_form_invalid" };
        params.append(name, value);
      }
    } catch { return { error: "moodle_scorm_form_invalid" }; }
    params.set(form.submit.name, form.submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(form.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: params,
      });
    } catch { return { unconfirmed: "moodle_scorm_save_unknown" }; }
    // The redirect is never followed. That is what keeps every SCORM launch, player,
    // attempt and report route out of this request, whatever Moodle answers with.
    // Chromium exposes a manual same-origin POST redirect as opaqueredirect, so the
    // exact native form readback below is the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    let text;
    try { text = await readText(response); } catch { return { unconfirmed: "moodle_scorm_save_unknown", status: response.status }; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const courseView = new URL(urlFor(context, "/course/view.php", { id: form.courseId }));
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", form.action); } catch { return { unconfirmed: "moodle_scorm_save_unknown", status: response.status }; }
      return redirect.origin === courseView.origin && redirect.pathname === courseView.pathname
        ? { status: response.status }
        : { unconfirmed: "moodle_scorm_save_unknown", status: response.status };
    }
    return response.ok && sameFormReturned(text, form)
      ? { rejected: "moodle_scorm_save_not_sent", status: response.status }
      : { unconfirmed: "moodle_scorm_save_unknown", status: response.status };
  };
  const reloadForForm = async (context, courseId, moduleId, expectedDigest) => {
    const reloaded = await loadScormForm(context, courseId, moduleId);
    if (reloaded.error) return reloaded;
    if (reloaded.snapshotDigest !== expectedDigest) return { error: "moodle_expected_digest_mismatch", status: reloaded.status };
    return reloaded;
  };
  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const courseId = id(input.binding.courseId);
    const settings = definition.kind === "settings" ? settingsArguments(input.arguments, courseId) : null;
    const replacement = definition.kind === "package" ? packageArguments(input.arguments, courseId) : null;
    const args = settings || replacement;
    if (!args) return failure("moodle_scorm_arguments_invalid");
    if (definition.kind === "settings" && input.privateAttachment !== undefined) return failure("moodle_scorm_arguments_invalid");

    const before = await loadScormForm(context, args.courseId, args.moduleId);
    if (before.error) return failure(before.error, before.status);
    if (before.snapshotDigest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    if (replacement && before.visible) return failure("moodle_scorm_activity_visible_refused", before.status);

    const packageBytes = replacement ? await exactPrivatePackage(input, replacement.manifest) : null;
    if (replacement && !packageBytes) return failure("moodle_scorm_package_attachment_invalid", before.status);
    if (replacement && !zipHasSingleRootManifest(packageBytes)) return failure("moodle_scorm_package_manifest_invalid", before.status);

    const preflightContext = currentContext();
    if (!sameContext(context, preflightContext) || !bindingValid(preflightContext, input.binding)) return failure("moodle_binding_mismatch");
    const form = await reloadForForm(preflightContext, args.courseId, args.moduleId, args.expectedDigest);
    if (form.error) return failure(form.error, form.status);
    if (replacement && form.visible) return failure("moodle_scorm_activity_visible_refused", form.status);
    if (replacement && form.manager.maxBytes > 0 && replacement.manifest.size_bytes > form.manager.maxBytes) {
      return failure("moodle_scorm_package_exceeds_native_limit", form.status);
    }
    form.courseId = args.courseId;

    const changedNames = settings ? settingChanges(form, settings.settings) : [PACKAGE_FIELD];
    if (!changedNames || !changedNames.length) return failure("moodle_scorm_setting_not_writable", form.status);
    const beforeProtected = await protectedDigest(form.values, changedNames, settings ? form.packageFile : null);

    if (settings) applySettings(form.formData, settings.settings);
    if (replacement) {
      const removed = await draftFilesAjax(preflightContext, "delete", { itemid: form.manager.itemId, filepath: "/", filename: form.packageFile.filename });
      if (!removed || removed.filepath !== "/") return failure("moodle_scorm_package_area_not_cleared", form.status);
      const cleared = await readDraftListing(preflightContext, form.manager.itemId);
      if (managerState(cleared) !== "empty") return failure("moodle_scorm_package_area_not_cleared", form.status);
      const uploaded = await uploadPackageDraft(preflightContext, form.manager, replacement.manifest, packageBytes);
      if (uploaded.error) return failure(uploaded.error, uploaded.status ?? form.status);
      const staged = packageFileFromListing(await readDraftListing(preflightContext, form.manager.itemId));
      if (!staged || staged.filename !== replacement.manifest.filename || staged.size_bytes !== replacement.manifest.size_bytes
        || !await draftBytesMatch(preflightContext, uploaded.draftUrl, replacement.manifest)) return failure("moodle_scorm_package_draft_mismatch", uploaded.status ?? form.status);
    }

    const sendContext = currentContext();
    if (!sameContext(preflightContext, sendContext) || !bindingValid(sendContext, input.binding)) return failure("moodle_binding_mismatch");
    const posted = await postScormForm(sendContext, form);
    if (posted.rejected) {
      return { ok: false, sent: true, status: posted.status, verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: posted.rejected }, error: posted.rejected };
    }
    if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);

    const after = await loadScormForm(sendContext, args.courseId, args.moduleId);
    if (after.error) return unconfirmed("moodle_scorm_readback_unconfirmed", posted.status);

    const data = output(args.courseId, args.moduleId, after);
    const afterProtected = await protectedDigest(after.values, changedNames, settings ? after.packageFile : null);
    const settingsMatch = !settings || (
      (!Object.hasOwn(settings.settings, "name") || data.name === settings.settings.name)
      && (!Object.hasOwn(settings.settings, "instructions") || data.instructions === settings.settings.instructions)
      && SELECT_SETTINGS.every((name) => !Object.hasOwn(settings.settings, name) || data[name] === settings.settings[name])
      && DATE_SETTINGS.every(([argument]) => !Object.hasOwn(settings.settings, argument)
        || (settings.settings[argument] === null ? data[argument] === null : Boolean(data[argument]) && compareDate(data[argument], settings.settings[argument]) === 0))
    );
    const packageMatch = !replacement || (
      after.packageFile.filename === replacement.manifest.filename
      && after.packageFile.size_bytes === replacement.manifest.size_bytes
      && !after.visible
      && await savedPackageBytesMatch(sendContext, after.manager.contextId, replacement.manifest)
    );
    const matches = settingsMatch && packageMatch && afterProtected === beforeProtected;
    const result = {
      ok: matches,
      sent: true,
      status: posted.status ?? after.status,
      data: { ...data, protected_settings_digest: afterProtected, protected_setting_names: protectedNames(after.values, changedNames) },
      snapshot_digest: after.snapshotDigest,
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_scorm_readback_mismatch" }) },
    };
    return matches ? result : { ...result, error: "moodle_write_not_verified" };
  } catch (error) {
    if (writeAttempted) return unconfirmed("moodle_scorm_save_unknown");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_scorm_execution_failed");
  }
}
