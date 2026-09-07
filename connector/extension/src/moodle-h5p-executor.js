/**
 * Moodle H5P activity (`mod_h5pactivity`): read the native settings form, read
 * the native creation form, create one hidden activity from one reviewed `.h5p`
 * package, and edit the bounded settings of an existing one.
 *
 * Every route here is the native activity form `course/modedit.php`, Moodle's
 * own private draft area, and `pluginfile.php` for the saved package bytes.
 * No route opens `/mod/h5pactivity/view.php`, `/mod/h5pactivity/report.php`,
 * `/h5p/embed.php`, or any other H5P player route. Opening the activity view
 * deploys the package into the site's H5P store and records a module view, a
 * completion state and an attempt, so it is never part of a read or a write.
 *
 * Native source, read from Moodle v5.2.2:
 * - The form declares `name`, the standard intro editor, one `packagefile`
 *   filemanager that accepts `.h5p` only with `maxfiles => 1` and
 *   `subdirs => 0`, three `displayopt[...]` checkboxes, and the
 *   `enabletracking`, `grademethod` and `reviewmode` selects.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/h5pactivity/mod_form.php#L44-L148
 * - `\core_h5p\helper::decode_display_options` names exactly the three display
 *   options this executor reads and writes: export, embed, copyright.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/h5p/classes/helper.php#L166-L176
 * - `h5pactivity_set_mainfile` saves the draft area into the module's own
 *   `package` file area at item 0, and `h5pactivity_pluginfile` serves it from
 *   `/pluginfile.php/<context>/mod_h5pactivity/package/<revision>/<filename>`,
 *   where the revision segment is read and ignored.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/mod/h5pactivity/lib.php#L457-L499
 *
 * Content bank selection is out of scope. When the form's package comes from the
 * content bank, `mod_form.php` renders a link to `/contentbank/view.php` for
 * that exact content, and the draft listing marks the file as a reference. Both
 * are refused before anything is uploaded or sent, because a content-bank
 * reference is shared content whose other uses this executor cannot read.
 *
 * Byte equality does not establish H5P validity or learner access. The archive
 * check below proves only that the reviewed file is a ZIP with one root
 * `h5p.json`; whether Moodle can deploy the content, whether the library is
 * installed, and whether a learner can open it are not observable here.
 *
 * Chrome serializes this function for a MAIN-world injection. Keep every
 * dependency inside the function body.
 */
export async function executeMoodleH5pInPage(rawInput) {
  const PROVIDER = "moodle";
  const MODULE = "h5pactivity";
  const SCHEMA = "morrow.moodle-h5pactivity.v1";
  const CREATION_SCHEMA = "morrow.moodle-h5pactivity-creation-form.v1";
  const MODEDIT_PATH = "/course/modedit.php";
  const COURSE_VIEW_PATH = "/course/view.php";
  const CONTENT_BANK_VIEW_PATH = "/contentbank/view.php";
  const STATE_METHOD = "core_courseformat_get_state";
  const PACKAGE_FIELD = "packagefile";
  const ACCEPTED_TYPE = ".h5p";
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_PACKAGE_BYTES = 1024 * 1024;
  const MAX_FORM_ENTRIES = 600;
  const MAX_VALUE_BYTES = 64 * 1024;
  const MAX_ACTIVITIES = 10_000;
  const MAX_NAME_LENGTH = 1333;
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,8})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  // The three bounded selects. Each value is checked against the options the
  // current native control offers, so no value is ever invented here.
  const SELECT_SETTINGS = [["enable_tracking", "enabletracking"], ["grade_method", "grademethod"], ["review_mode", "reviewmode"]];
  const DISPLAY_SETTINGS = [["display_export", "displayopt[export]"], ["display_embed", "displayopt[embed]"], ["display_copyright", "displayopt[copyright]"]];
  const definitions = Object.freeze({
    "moodle.form.course.modedit.h5pactivity.read.v1": { toolName: "moodle_get_h5pactivity", readOnly: true, kind: "activity" },
    "moodle.form.course.modedit.h5pactivity.create.read.v1": { toolName: "moodle_get_h5pactivity_creation_form", readOnly: true, kind: "creation-form" },
    "moodle.form.course.modedit.h5pactivity.create.write.v1": { toolName: "moodle_create_h5pactivity", readOnly: false, kind: "create" },
    "moodle.form.course.modedit.h5pactivity.write.v1": { toolName: "moodle_update_h5pactivity", readOnly: false, kind: "settings" },
  });
  const CREATION_KINDS = ["creation-form", "create"];

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
  // The dispatch landed and Morrow read what it produced, so the outcome is
  // known. `reason` names what disagreed; `extra.error` names the failure a
  // caller acts on when it differs from the reason.
  const mismatch = (reason, status, extra = {}) => ({
    ok: false,
    sent: true,
    ...(Number.isInteger(status) ? { status } : {}),
    ...extra,
    verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason },
    error: extra.error ?? reason,
  });
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return ID.test(text) ? text : "";
  };
  const sectionNumber = (value) => {
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
    return COUNT.test(text) ? text : "";
  };
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const collapsed = (value, maximum = MAX_NAME_LENGTH) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text && text.length <= maximum && !CONTROL.test(text) ? text : "";
  };
  const validString = (value, maximum) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000");
  const validSelectValue = (value) => validString(value, 64) && Boolean(value);
  const hasEmbeddedFile = (value) => /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i.test(String(value));
  const validFilename = (value) => typeof value === "string" && value.length >= 5 && value.length <= 255 && value === value.trim()
    && !/[\\/\u0000-\u001f]/.test(value) && value !== "." && value !== ".." && /\.h5p$/i.test(value);
  // A field whose value is a session key, a draft item id or a secret never
  // reaches a result and never enters a digest.
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") throw new Error("moodle_h5pactivity_digest_unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const bytesDigest = async (bytes) => {
    if (!globalThis.crypto?.subtle) throw new Error("moodle_h5pactivity_digest_unavailable");
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
    const anchorCourseId = configuredCourse || bodyCourse;
    if (!anchorCourseId) return null;
    return { origin: site.origin, siteUrl: site.href, basePath, principalId, anchorCourseId, sesskey: cfg.sesskey };
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
    const optional = ["name", "instructions", ...SELECT_SETTINGS.map(([argument]) => argument), ...DISPLAY_SETTINGS.map(([argument]) => argument)];
    if (!exactKeys(value, ["course_id", "module_id", "expected_digest"], optional)) return null;
    if (id(value.course_id) !== courseId || !id(value.module_id) || !DIGEST.test(String(value.expected_digest || ""))) return null;
    if (!optional.some((key) => Object.hasOwn(value, key))) return null;
    if (Object.hasOwn(value, "name") && (!validString(value.name, MAX_NAME_LENGTH) || collapsed(value.name) !== value.name)) return null;
    if (Object.hasOwn(value, "instructions") && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions))) return null;
    if (SELECT_SETTINGS.some(([argument]) => Object.hasOwn(value, argument) && !validSelectValue(value[argument]))) return null;
    if (DISPLAY_SETTINGS.some(([argument]) => Object.hasOwn(value, argument) && typeof value[argument] !== "boolean")) return null;
    return { courseId, moduleId: id(value.module_id), expectedDigest: value.expected_digest, settings: value };
  };
  const creationArguments = (value, courseId) => {
    if (!exactKeys(value, ["course_id", "section_id", "name", "filename", "size_bytes", "sha256", "expected_digest"])) return null;
    if (id(value.course_id) !== courseId || !id(value.section_id) || !DIGEST.test(String(value.expected_digest || ""))) return null;
    if (!validString(value.name, MAX_NAME_LENGTH) || collapsed(value.name) !== value.name) return null;
    if (!validFilename(value.filename) || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 1
      || value.size_bytes > MAX_PACKAGE_BYTES || !DIGEST.test(String(value.sha256 || ""))) return null;
    return {
      courseId,
      sectionId: id(value.section_id),
      name: value.name,
      expectedDigest: value.expected_digest,
      manifest: { filename: value.filename, size_bytes: value.size_bytes, sha256: value.sha256 },
    };
  };
  const readArguments = (value, courseId, creating) => {
    const targetKey = creating ? "section_id" : "module_id";
    if (!exactKeys(value, ["course_id", targetKey])) return null;
    if (id(value.course_id) !== courseId || !id(value[targetKey])) return null;
    return creating ? { courseId, sectionId: id(value.section_id) } : { courseId, moduleId: id(value.module_id) };
  };
  const readText = async (response) => {
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declared) && declared > MAX_BYTES) throw new Error("moodle_h5pactivity_response_too_large");
    const text = await response.text();
    if (typeof text !== "string" || text.length > MAX_BYTES) throw new Error("moodle_h5pactivity_response_too_large");
    return text;
  };
  const readLimitedBytes = async (response, maximum = MAX_PACKAGE_BYTES) => {
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declared) && declared > maximum) throw new Error("moodle_h5pactivity_response_too_large");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximum) throw new Error("moodle_h5pactivity_response_too_large");
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
  // A draft entry Moodle marks as a reference is a file that lives somewhere
  // else, which is how a content-bank selection reaches this form.
  const listingHasReference = (listing) => Array.isArray(listing?.list)
    && listing.list.some((file) => object(file) && (file.isref === true || file.isref === 1 || file.originalmissing === true));
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
  const valuesFromForm = (formData, fileManagers) => {
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
        if (value.size > 0) throw new Error("moodle_h5pactivity_form_invalid");
        continue;
      }
      if (typeof value !== "string") throw new Error("moodle_h5pactivity_form_invalid");
      const safeValue = redact(value);
      if (values[name] === undefined) values[name] = safeValue;
      else if (Array.isArray(values[name])) values[name].push(safeValue);
      else values[name] = [values[name], safeValue];
    }
    return values;
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
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
  const checkboxControl = (documentValue, name) => {
    const controls = namedControls(documentValue, name)
      .filter((control) => control.tagName === "INPUT" && String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    return controls.length === 1 ? controls[0] : null;
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
  /**
   * The one `packagefile` filemanager the H5P form declares. Its accepted type
   * list, file count and subdirectory setting are the native options in
   * mod_form.php, so anything else is a form this executor was not written for.
   */
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
    const validLimit = (value) => Number.isSafeInteger(value) && value >= -1;
    const uploads = object(config.filepicker) && object(config.filepicker.repositories)
      ? Object.entries(config.filepicker.repositories).filter(([key, repository]) => object(repository) && repository.type === "upload" && id(key) === id(repository.id))
      : [];
    const author = config.author === undefined ? null
      : typeof config.author === "string" && config.author.length <= 255 && !config.author.includes("\u0000") ? config.author : false;
    const contextId = id(config.context?.id);
    if (id(config.itemid) !== itemId || !contextId || accepted.length !== 1 || accepted[0] !== ACCEPTED_TYPE
      || config.maxfiles !== 1 || (config.subdirs !== false && config.subdirs !== 0) || !validLimit(config.maxbytes)
      || uploads.length !== 1 || !id(uploads[0][0]) || !id(uploads[0][1].id) || author === false) return null;
    return {
      itemId,
      contextId,
      repoId: id(uploads[0][1].id),
      author,
      maxBytes: config.maxbytes,
      acceptedTypes: [ACCEPTED_TYPE],
      semantic: { target: inputs[0].id, context_id: contextId, maxfiles: 1, subdirs: false, maxbytes: config.maxbytes, accepted_types: [ACCEPTED_TYPE], repo_id: id(uploads[0][1].id), author },
    };
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
  /**
   * `mod_form.php` renders a link to `/contentbank/view.php` for the exact
   * content only when the activity's package is a content-bank reference. The
   * generic `/contentbank/index.php` link is present whenever the person can
   * reach the content bank at all and is not a package source.
   */
  const contentBankReference = (form, context) => {
    const path = `${context.basePath}${CONTENT_BANK_VIEW_PATH}`;
    return Array.from(form?.querySelectorAll?.("a[href]") || []).some((anchor) => {
      let url;
      try { url = new URL(anchor.getAttribute("href") || "", context.siteUrl); } catch { return false; }
      return url.origin === context.origin && url.pathname === path;
    });
  };
  const courseState = async (context, courseId) => {
    const endpoint = urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: STATE_METHOD });
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([{ index: 0, methodname: STATE_METHOD, args: { courseid: Number(courseId) } }]),
      });
    } catch { return { error: "moodle_h5pactivity_course_state_unavailable" }; }
    if (!response.ok || !sameContext(context, currentContext())) return { error: "moodle_h5pactivity_course_state_unavailable", status: response.status };
    let raw;
    try { raw = await readText(response); } catch { return { error: "moodle_h5pactivity_course_state_unavailable", status: response.status }; }
    let value;
    try {
      const payload = JSON.parse(raw);
      const entry = Array.isArray(payload) && payload.length === 1 && object(payload[0]) ? payload[0] : null;
      if (!entry || entry.error || entry.exception || !("data" in entry)) return { error: "moodle_h5pactivity_course_state_unavailable", status: response.status };
      value = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
    } catch { return { error: "moodle_h5pactivity_course_state_unavailable", status: response.status }; }
    if (!object(value) || !object(value.course) || id(value.course.id) !== courseId
      || !Array.isArray(value.section) || !Array.isArray(value.cm)
      || value.cm.length > MAX_ACTIVITIES || value.section.length > MAX_ACTIVITIES) {
      return { error: "moodle_h5pactivity_course_state_unavailable", status: response.status };
    }
    return { status: response.status, course: value.course, sections: value.section, activities: value.cm };
  };
  const courseTarget = (state) => ({ field: "course_id", label: "Course", name: collapsed(state.course?.fullname || state.course?.name) || "Moodle course" });
  const sectionOf = (state, sectionId) => {
    const matches = state.sections.filter((entry) => object(entry) && id(entry.id) === sectionId);
    if (matches.length !== 1) return null;
    const number = sectionNumber(matches[0].number);
    return number === "" ? null : { id: sectionId, number, name: collapsed(matches[0].title || matches[0].rawtitle) || "Selected course section" };
  };
  const activityOf = (state, moduleId) => {
    const matches = state.activities.filter((entry) => object(entry) && id(entry.id) === moduleId);
    if (matches.length !== 1 || String(matches[0].module || "") !== MODULE) return null;
    const sectionId = id(matches[0].sectionid);
    const name = collapsed(matches[0].name);
    return sectionId && name ? { id: moduleId, sectionId, name, visible: matches[0].visible === true } : null;
  };
  /**
   * Reads one native H5P `course/modedit.php` form and proves it is the core
   * form for the exact approved target. `identity` names the hidden fields the
   * form must carry exactly once with exactly these values.
   */
  const loadForm = async (context, endpoint, route, identity, creating) => {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } });
    } catch { return { error: "moodle_h5pactivity_form_read_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { error: "moodle_h5pactivity_form_read_failed", status: response.status }; }
    if (!response.ok || typeof DOMParser === "undefined" || typeof FormData === "undefined" || !routeMatches(response.url, endpoint, route)) {
      return { error: "moodle_h5pactivity_form_read_failed", status: response.status };
    }
    const status = response.status;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { error: "moodle_h5pactivity_form_read_failed", status }; }
    const forms = Array.from(documentValue.querySelectorAll("form")).filter((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const values = new FormData(candidate);
        return Object.entries(identity).every(([name, item]) => values.getAll(name).length === 1 && String(values.get(name) || "") === item);
      } catch { return false; }
    });
    if (forms.length !== 1) return { error: "moodle_h5pactivity_form_target_invalid", status };
    const form = forms[0];
    let action;
    try { action = new URL(form.getAttribute("action") || endpoint, endpoint); } catch { return { error: "moodle_h5pactivity_form_target_invalid", status }; }
    const expected = new URL(endpoint);
    if (action.origin !== expected.origin || action.pathname !== expected.pathname || action.hash
      || (action.search && !routeMatches(action.toString(), endpoint, route))) return { error: "moodle_h5pactivity_form_target_invalid", status };
    const submits = Array.from(form.querySelectorAll('input[type="submit"][name], button[type="submit"][name]'))
      .filter((control) => control.name === "submitbutton2" && !control.disabled && typeof control.value === "string" && control.value && control.value.length <= 500);
    if (submits.length !== 1) return { error: "moodle_h5pactivity_form_target_invalid", status };
    let formData;
    try { formData = new FormData(form); } catch { return { error: "moodle_h5pactivity_form_read_failed", status }; }
    const entries = [...formData.entries()];
    if (entries.length > MAX_FORM_ENTRIES
      || entries.some(([name, value]) => typeof name !== "string" || !name || name.length > 255 || (typeof value === "string" && value.length > MAX_VALUE_BYTES))) {
      return { error: "moodle_h5pactivity_form_target_invalid", status };
    }
    const sesskeys = formData.getAll("sesskey");
    if (sesskeys.length !== 1 || sesskeys[0] !== context.sesskey) return { error: "moodle_form_session_mismatch", status };
    // Content bank selection is out of scope, so it stops here: before any
    // upload and before any save.
    if (contentBankReference(form, context)) return { error: "moodle_h5pactivity_content_bank_source_refused", status };
    let fileManagers;
    let values;
    try {
      fileManagers = await inspectFileManagers(context, form, formData);
      values = valuesFromForm(formData, fileManagers);
    } catch { return { error: "moodle_h5pactivity_form_read_failed", status }; }
    const required = ["name", PACKAGE_FIELD, "visible", ...SELECT_SETTINGS.map(([, field]) => field)];
    if (!required.every((name) => Object.hasOwn(values, name))) return { error: "moodle_h5pactivity_form_target_invalid", status };
    if (DISPLAY_SETTINGS.some(([, field]) => !checkboxControl(documentValue, field))) return { error: "moodle_h5pactivity_form_target_invalid", status };
    const manager = packageManagerConfig(documentValue, formData);
    const packageManager = fileManagers.filter((entry) => entry.name === PACKAGE_FIELD);
    if (!manager || packageManager.length !== 1 || packageManager[0].itemId !== manager.itemId) {
      return { error: "moodle_h5pactivity_package_area_invalid", status };
    }
    if (fileManagers.some((entry) => entry.name !== PACKAGE_FIELD && entry.state !== "empty")) {
      return { error: "moodle_h5pactivity_form_files_refused", status };
    }
    if (listingHasReference(packageManager[0].listing)) return { error: "moodle_h5pactivity_content_bank_source_refused", status };
    if (packageManager[0].state !== (creating ? "empty" : "nonempty")) return { error: "moodle_h5pactivity_package_area_invalid", status };
    const packageFile = creating ? null : packageFileFromListing(packageManager[0].listing);
    if (!creating && !packageFile) return { error: "moodle_h5pactivity_package_area_invalid", status };
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
      nativeSesskey: context.sesskey,
    };
  };
  const proof = () => ({
    method: "native_form_read",
    route: MODEDIT_PATH,
    required_capability: "moodle/course:manageactivities",
    scope: "one_h5p_activity",
    module: MODULE,
    content_bank_selection: "out_of_scope_refused",
    player_opened: false,
    attempts_read: false,
  });
  const displayOptions = (values) => Object.fromEntries(DISPLAY_SETTINGS.map(([argument, field]) => [argument, Object.hasOwn(values, field)]));
  const activityData = (courseId, moduleId, sectionId, form) => ({
    schema: SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    module_id: Number(moduleId),
    section_id: Number(sectionId),
    name: one(form.values, "name"),
    instructions: one(form.values, "introeditor[text]"),
    instructions_format: Number(one(form.values, "introeditor[format]")),
    ...Object.fromEntries(SELECT_SETTINGS.map(([argument, field]) => [argument, selectedValue(form.document, form.values, field)])),
    ...displayOptions(form.values),
    visible: form.visible,
    package: form.packageFile,
    proof: proof(),
  });
  const creationData = (courseId, section, form) => ({
    schema: CREATION_SCHEMA,
    provider: PROVIDER,
    course_id: Number(courseId),
    section_id: Number(section.id),
    section_number: Number(section.number),
    module: MODULE,
    visible: false,
    package_area_empty: true,
    max_package_bytes: MAX_PACKAGE_BYTES,
    accepted_type: ACCEPTED_TYPE,
    ...Object.fromEntries(SELECT_SETTINGS.map(([argument, field]) => [argument, selectedValue(form.document, form.values, field)])),
    ...displayOptions(form.values),
    proof: proof(),
  });
  const activityEndpoint = (context, moduleId) => urlFor(context, MODEDIT_PATH, { update: moduleId, return: 0 });
  const creationEndpoint = (context, courseId, sectionId) => urlFor(context, MODEDIT_PATH, { add: MODULE, course: courseId, sectionid: sectionId, return: 0 });
  const loadActivityForm = async (context, courseId, moduleId) => {
    const form = await loadForm(context, activityEndpoint(context, moduleId), { update: moduleId, return: "0" },
      { update: moduleId, course: courseId, modulename: MODULE }, false);
    if (form.error) return form;
    return { ...form, snapshotDigest: await digest({ values: form.values, package: form.packageFile }) };
  };
  const loadCreationForm = async (context, courseId, section) => {
    const form = await loadForm(context, creationEndpoint(context, courseId, section.id), { add: MODULE, course: courseId, sectionid: section.id, return: "0" },
      { course: courseId, add: MODULE, modulename: MODULE, section: section.number, return: "0" }, true);
    if (form.error) return form;
    return { ...form, section, snapshotDigest: await digest({ values: form.values, manager: form.manager.semantic, section: { id: section.id, number: section.number } }) };
  };
  const readActivity = async (context, courseId, moduleId) => {
    const state = await courseState(context, courseId);
    if (state.error) return failure(state.error, state.status);
    const activity = activityOf(state, moduleId);
    if (!activity) return failure("moodle_h5pactivity_module_target_invalid", state.status);
    const form = await loadActivityForm(context, courseId, moduleId);
    if (form.error) return failure(form.error, form.status);
    const data = activityData(courseId, moduleId, activity.sectionId, form);
    return {
      ok: true, sent: true, status: form.status, data, form, state, activity,
      targets: [courseTarget(state), { field: "module_id", label: "H5P activity", name: activity.name }],
      snapshot_digest: form.snapshotDigest,
    };
  };
  const readCreationForm = async (context, courseId, sectionId) => {
    const state = await courseState(context, courseId);
    if (state.error) return failure(state.error, state.status);
    const section = sectionOf(state, sectionId);
    if (!section) return failure("moodle_h5pactivity_section_target_invalid", state.status);
    const form = await loadCreationForm(context, courseId, section);
    if (form.error) return failure(form.error, form.status);
    const data = creationData(courseId, section, form);
    return {
      ok: true, sent: true, status: form.status, data, form, state, section,
      targets: [courseTarget(state), { field: "section_id", label: "Section", name: section.name }],
      snapshot_digest: form.snapshotDigest,
    };
  };
  /**
   * An `.h5p` file is a ZIP whose root holds `h5p.json`. This walks the central
   * directory, refuses an archive that disagrees with its own local headers,
   * and requires exactly one root `h5p.json`. It proves the shape of the file
   * only. It does not establish that Moodle can deploy the content.
   */
  const h5pArchiveHasRootDefinition = (bytes) => {
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
    let definitionCount = 0;
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
        || name.split("/").some((part) => part === "..") || names.has(name) || localOffsets.has(localOffset)) return false;
      names.add(name);
      localOffsets.add(localOffset);
      if (name === "h5p.json") definitionCount += 1;
      uncompressed += uncompressedSize;
      if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) return false;
      if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO) return false;
      offset = nameEnd + extraLength + commentLength;
    }
    return offset === eocd && definitionCount === 1;
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
    try { file = new File([bytes], manifest.filename, { type: "application/octet-stream" }); } catch { return { error: "moodle_h5pactivity_package_attachment_invalid" }; }
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
    } catch { return { error: "moodle_h5pactivity_package_upload_refused" }; }
    let text;
    try { text = await readText(response); } catch { return { error: "moodle_h5pactivity_package_upload_refused", status: response.status }; }
    let result;
    try { result = JSON.parse(text); } catch { return { error: "moodle_h5pactivity_package_upload_refused", status: response.status }; }
    if (!response.ok || !object(result) || result.error || result.fileexists || id(result.id) !== manager.itemId
      || result.file !== manifest.filename || typeof result.url !== "string") return { error: "moodle_h5pactivity_package_upload_refused", status: response.status };
    const draftUrl = nativeDraftUrl(context, result.url, manager.itemId, manifest.filename);
    return draftUrl ? { status: response.status, draftUrl } : { error: "moodle_h5pactivity_package_upload_refused", status: response.status };
  };
  const bytesMatch = async (endpoint, manifest) => {
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error" }); } catch { return false; }
    if (!response.ok || response.url !== endpoint) return false;
    let bytes;
    try { bytes = await readLimitedBytes(response); } catch { return false; }
    if (bytes.byteLength !== manifest.size_bytes) return false;
    try { return await bytesDigest(bytes) === manifest.sha256; } catch { return false; }
  };
  const savedPackageBytesMatch = (context, contextId, manifest) => bytesMatch(
    urlFor(context, `/pluginfile.php/${contextId}/mod_${MODULE}/package/0/${encodeURIComponent(manifest.filename)}`, { forcedownload: 1 }),
    manifest,
  );
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
  const postForm = async (context, form, courseId, overrides) => {
    const params = new URLSearchParams();
    try {
      for (const [name, value] of form.formData.entries()) {
        if (name === "coursecontentnotification" || name === "submitbutton" || name === "submitbutton2") continue;
        if (typeof File !== "undefined" && value instanceof File) {
          if (value.size > 0) return { error: "moodle_h5pactivity_form_files_refused" };
          continue;
        }
        if (typeof value !== "string") return { error: "moodle_h5pactivity_form_invalid" };
        params.append(name, value);
      }
    } catch { return { error: "moodle_h5pactivity_form_invalid" }; }
    for (const [name, value] of Object.entries(overrides)) {
      params.delete(name);
      if (value !== null) params.append(name, value);
    }
    params.set(form.submit.name, form.submit.value);
    let response;
    try {
      writeAttempted = true;
      response = await fetch(form.action, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "manual",
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: params,
      });
    } catch { return { unconfirmed: "moodle_h5pactivity_save_unknown" }; }
    // The redirect is never followed. That is what keeps /mod/h5pactivity/view.php,
    // the H5P player and every attempt or report route out of this request,
    // whatever Moodle answers with. Chromium exposes a manual same-origin POST
    // redirect as opaqueredirect, so the readback below is the confirmation.
    if (response.type === "opaqueredirect") return { sent: true };
    let text;
    try { text = await readText(response); } catch { return { unconfirmed: "moodle_h5pactivity_save_unknown", status: response.status }; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const courseView = new URL(urlFor(context, COURSE_VIEW_PATH, { id: courseId }));
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", form.action); } catch { return { unconfirmed: "moodle_h5pactivity_save_unknown", status: response.status }; }
      return redirect.origin === courseView.origin && redirect.pathname === courseView.pathname
        ? { status: response.status }
        : { unconfirmed: "moodle_h5pactivity_save_unknown", status: response.status };
    }
    return response.ok && sameFormReturned(text, form)
      ? { rejected: "moodle_h5pactivity_save_not_sent", status: response.status }
      : { unconfirmed: "moodle_h5pactivity_save_unknown", status: response.status };
  };
  const protectedDigest = (values, names, packageFile) => {
    const copy = { ...values };
    for (const name of names) delete copy[name];
    return digest(packageFile ? { values: copy, package: packageFile } : { values: copy });
  };
  const protectedNames = (values, names) => [...new Set(Object.keys(values).filter((name) => !names.includes(name)))].sort();
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
    for (const [argument, field] of SELECT_SETTINGS) {
      if (!Object.hasOwn(settings, argument)) continue;
      if (!selectAllows(form.document, field, settings[argument])) return null;
      names.push(field);
    }
    for (const [argument, field] of DISPLAY_SETTINGS) {
      if (!Object.hasOwn(settings, argument)) continue;
      const control = checkboxControl(form.document, field);
      if (!control || control.disabled) return null;
      names.push(field);
    }
    return names;
  };
  const settingOverrides = (form, settings) => {
    const overrides = {};
    if (Object.hasOwn(settings, "name")) overrides.name = settings.name;
    if (Object.hasOwn(settings, "instructions")) overrides["introeditor[text]"] = settings.instructions;
    for (const [argument, field] of SELECT_SETTINGS) if (Object.hasOwn(settings, argument)) overrides[field] = settings[argument];
    for (const [argument, field] of DISPLAY_SETTINGS) {
      if (!Object.hasOwn(settings, argument)) continue;
      // A Moodle checkbox travels only when it is on. Clearing one means
      // sending nothing under that name.
      overrides[field] = settings[argument] ? String(checkboxControl(form.document, field).value || "1") : null;
    }
    return overrides;
  };
  const runUpdate = async (context, inputValue, args) => {
    const before = await readActivity(context, args.courseId, args.moduleId);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const preflightContext = currentContext();
    if (!sameContext(context, preflightContext) || !bindingValid(preflightContext, inputValue.binding)) return failure("moodle_binding_mismatch");
    const form = await loadActivityForm(preflightContext, args.courseId, args.moduleId);
    if (form.error) return failure(form.error, form.status);
    if (form.snapshotDigest !== args.expectedDigest || form.action !== before.form.action) return failure("moodle_expected_digest_mismatch", form.status);
    const changedNames = settingChanges(form, args.settings);
    if (!changedNames || !changedNames.length) return failure("moodle_h5pactivity_setting_not_writable", form.status);
    const beforeProtected = await protectedDigest(form.values, changedNames, form.packageFile);
    const sendContext = currentContext();
    if (!sameContext(preflightContext, sendContext) || !bindingValid(sendContext, inputValue.binding)) return failure("moodle_binding_mismatch");
    const posted = await postForm(sendContext, form, args.courseId, settingOverrides(form, args.settings));
    if (posted.error) return failure(posted.error, form.status);
    if (posted.rejected) return mismatch(posted.rejected, posted.status);
    if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);
    const after = await readActivity(sendContext, args.courseId, args.moduleId);
    if (!after.ok) return unconfirmed("moodle_h5pactivity_readback_unconfirmed", posted.status);
    const afterProtected = await protectedDigest(after.form.values, changedNames, after.form.packageFile);
    const settingsMatch = (!Object.hasOwn(args.settings, "name") || after.data.name === args.settings.name)
      && (!Object.hasOwn(args.settings, "instructions") || after.data.instructions === args.settings.instructions)
      && SELECT_SETTINGS.every(([argument]) => !Object.hasOwn(args.settings, argument) || after.data[argument] === args.settings[argument])
      && DISPLAY_SETTINGS.every(([argument]) => !Object.hasOwn(args.settings, argument) || after.data[argument] === args.settings[argument]);
    const matches = settingsMatch && afterProtected === beforeProtected;
    const result = {
      ok: matches,
      sent: true,
      status: posted.status ?? after.status,
      data: { ...after.data, protected_settings_digest: afterProtected, protected_setting_names: protectedNames(after.form.values, changedNames) },
      targets: after.targets,
      snapshot_digest: after.snapshot_digest,
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_h5pactivity_readback_mismatch" }) },
    };
    return matches ? result : { ...result, error: "moodle_write_not_verified" };
  };
  const runCreate = async (context, inputValue, args) => {
    const before = await readCreationForm(context, args.courseId, args.sectionId);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expectedDigest) return failure("moodle_expected_digest_mismatch", before.status);
    const bytes = await exactPrivatePackage(inputValue, args.manifest);
    if (!bytes) return failure("moodle_h5pactivity_package_attachment_invalid", before.status);
    if (!h5pArchiveHasRootDefinition(bytes)) return failure("moodle_h5pactivity_package_definition_invalid", before.status);
    const preflightContext = currentContext();
    if (!sameContext(context, preflightContext) || !bindingValid(preflightContext, inputValue.binding)) return failure("moodle_binding_mismatch");
    // The activity list read immediately before the dispatch is the baseline
    // the new module is found against, so nothing already there can match.
    const refreshed = await readCreationForm(preflightContext, args.courseId, args.sectionId);
    if (!refreshed.ok) return refreshed;
    if (refreshed.snapshot_digest !== args.expectedDigest || refreshed.form.action !== before.form.action
      || refreshed.section.number !== before.section.number) return failure("moodle_expected_digest_mismatch", refreshed.status);
    const form = refreshed.form;
    if (form.manager.maxBytes > 0 && args.manifest.size_bytes > form.manager.maxBytes) {
      return failure("moodle_h5pactivity_package_exceeds_native_limit", refreshed.status);
    }
    const existingIds = new Set(refreshed.state.activities.map((entry) => id(object(entry) ? entry.id : "")).filter(Boolean));
    const uploaded = await uploadPackageDraft(preflightContext, form.manager, args.manifest, bytes);
    if (uploaded.error) return failure(uploaded.error, uploaded.status ?? refreshed.status);
    const listing = await readDraftListing(preflightContext, form.manager.itemId);
    if (listingHasReference(listing)) return failure("moodle_h5pactivity_content_bank_source_refused", uploaded.status);
    const staged = packageFileFromListing(listing);
    if (!staged || staged.filename !== args.manifest.filename || staged.size_bytes !== args.manifest.size_bytes
      || !await bytesMatch(uploaded.draftUrl, args.manifest)) return failure("moodle_h5pactivity_package_draft_mismatch", uploaded.status ?? refreshed.status);
    const sendContext = currentContext();
    if (!sameContext(preflightContext, sendContext) || !bindingValid(sendContext, inputValue.binding)) return failure("moodle_binding_mismatch");
    const posted = await postForm(sendContext, form, args.courseId, { name: args.name, visible: "0", [PACKAGE_FIELD]: form.manager.itemId });
    if (posted.error) return failure(posted.error, refreshed.status);
    if (posted.rejected) return mismatch(posted.rejected, posted.status);
    if (posted.unconfirmed) return unconfirmed(posted.unconfirmed, posted.status);
    const state = await courseState(sendContext, args.courseId);
    if (state.error) return unconfirmed("moodle_h5pactivity_create_unconfirmed", posted.status);
    const created = state.activities.filter((entry) => object(entry) && !existingIds.has(id(entry.id))
      && String(entry.module || "") === MODULE && collapsed(entry.name) === args.name
      && id(entry.sectionid) === args.sectionId && entry.visible === false);
    const moduleId = created.length === 1 ? id(created[0].id) : "";
    if (!moduleId) return unconfirmed("moodle_h5pactivity_create_unconfirmed", posted.status);
    const saved = await readActivity(sendContext, args.courseId, moduleId);
    if (!saved.ok) return unconfirmed("moodle_h5pactivity_create_unconfirmed", posted.status);
    const savedMatches = saved.data.name === args.name && saved.data.visible === false
      && saved.data.section_id === Number(args.sectionId)
      && object(saved.data.package) && saved.data.package.filename === args.manifest.filename
      && saved.data.package.size_bytes === args.manifest.size_bytes
      && await savedPackageBytesMatch(sendContext, saved.form.manager.contextId, args.manifest);
    const data = { ...saved.data, created: true, package: { ...args.manifest } };
    if (!savedMatches) {
      return mismatch("moodle_h5pactivity_saved_bytes_mismatch", posted.status ?? saved.status, {
        data, targets: saved.targets, snapshot_digest: saved.snapshot_digest, error: "moodle_write_not_verified",
      });
    }
    return {
      ok: true,
      sent: true,
      status: posted.status ?? saved.status,
      data,
      targets: saved.targets,
      snapshot_digest: saved.snapshot_digest,
      verification: { schema: "morrow.browser-verification.v1", status: "verified" },
    };
  };

  try {
    const context = currentContext();
    if (input?.mode !== "execute" || !context) return failure("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return failure("moodle_execution_expired");
    const definition = expectedOperation(input.operation);
    if (!definition) return failure("moodle_operation_refused");
    if (!bindingValid(context, input.binding)) return failure("moodle_binding_mismatch");
    const courseId = id(input.binding.courseId);
    if (definition.kind !== "create" && input.privateAttachment !== undefined) return failure("moodle_h5pactivity_arguments_invalid");
    if (definition.readOnly) {
      const args = readArguments(input.arguments, courseId, CREATION_KINDS.includes(definition.kind));
      if (!args) return failure("moodle_h5pactivity_arguments_invalid");
      const read = definition.kind === "creation-form"
        ? await readCreationForm(context, args.courseId, args.sectionId)
        : await readActivity(context, args.courseId, args.moduleId);
      return read.ok
        ? { ok: true, sent: true, status: read.status, data: read.data, targets: read.targets, snapshot_digest: read.snapshot_digest }
        : read;
    }
    if (definition.kind === "settings") {
      const args = settingsArguments(input.arguments, courseId);
      return args ? await runUpdate(context, input, args) : failure("moodle_h5pactivity_arguments_invalid");
    }
    const args = creationArguments(input.arguments, courseId);
    return args ? await runCreate(context, input, args) : failure("moodle_h5pactivity_arguments_invalid");
  } catch (error) {
    if (writeAttempted) return unconfirmed("moodle_h5pactivity_save_unknown");
    const message = String(error?.message || error);
    return failure(message.startsWith("moodle_") ? message : "moodle_h5pactivity_execution_failed");
  }
}
