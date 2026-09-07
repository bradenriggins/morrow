/**
 * Reads Moodle's own system administration pages, read-only.
 *
 * Two reads live here and neither one sends a write of any kind.
 *
 * - `moodle_get_site_inventory` reports the Moodle release and the installed
 *   plugin inventory by plugin type, with the enabled state Moodle itself shows
 *   for each plugin. The enabled authentication, enrolment, question-bank
 *   filter, availability condition, repository and filter plugins are that same
 *   inventory read by type, not a separate source.
 * - `moodle_get_role_definitions` reports every role's short name, and for one
 *   named role its archetype and the capability overrides that Moodle shows at
 *   the selected course's own context.
 *
 * Both are administration pages. Moodle serves them only to a site
 * administrator or to a person holding the exact system-context capability, so
 * both reads fail closed when the native administration markup is not there:
 * Morrow refuses and says the page was not served, and it never treats a page
 * it cannot read as an empty inventory.
 *
 * Routes, read from Moodle v5.2.2 source:
 * - Plugins overview: GET /<admin>/plugins.php with no parameters, which calls
 *   require_admin() before anything else, so a person who is not a site
 *   administrator never reaches the page. Its table is
 *   `table#plugins-control-panel`. Each plugin row carries the plugin type, the
 *   component and the status in its own row classes as `type-<type>`,
 *   `name-<component>` and `status-<status>`, adds `enabled` or `disabled` when
 *   Moodle reports an availability state for that plugin type and neither when
 *   it does not, and adds `deprecatedtype` for a deprecated plugin type. Each
 *   plugin type is preceded by one `plugintypeheader` row.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/admin/plugins.php
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/admin/renderer.php
 * - Moodle release: GET /<admin>/environment.php with no parameters, which
 *   calls admin_externalpage_setup('environment') and therefore requires
 *   moodle/site:config at the system context. Its version control is
 *   `select[name="version"]`, and with no version parameter in the request the
 *   selected option's value is the site's own normalized release.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/admin/environment.php
 * - Role list: GET /<admin>/roles/manage.php, which calls
 *   require_capability('moodle/role:manage') at the system context. Its table
 *   is `table#roles`; the first cell links define.php with the role id and the
 *   third cell holds the role short name.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/admin/roles/manage.php
 * - Role archetype: GET /<admin>/roles/define.php?action=edit&roleid=<id>,
 *   which requires the same moodle/role:manage capability. Rendering the form
 *   saves nothing; Moodle changes a role only on a POST carrying its session
 *   key. The archetype control is `select[name="archetype"]` and its selected
 *   option's value is the raw archetype key, or the empty string for a role
 *   with no archetype.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/admin/roles/define.php
 * - Context overrides: GET /<admin>/roles/override.php?contextid=<id>&roleid=<id>,
 *   which requires moodle/role:override, or moodle/role:safeoverride, at that
 *   exact context. Rendering the form saves nothing. Its form is
 *   `form#overrideform`; each capability row is `tr.rolecap`, the capability
 *   name is `th.name span.cap-name`, and the checked radio's value is the
 *   permission at this context: 0 inherit, 1 allow, -1 prevent, -1000 prohibit.
 *   A capability whose checked value is not 0 is overridden here.
 *   https://github.com/moodle/moodle/blob/v5.2.2/public/admin/roles/override.php
 *
 * What these routes record: each page is a page view of an administration
 * screen and records Moodle's own page-view logging for the signed-in person,
 * exactly as opening the screen in Moodle does. None of them changes a plugin
 * state, a role, a permission, a course, or any learner state, and none of them
 * opens an activity view, player, attempt or report page.
 *
 * No secret leaves the page. Every value in a result is rebuilt from a fixed
 * vocabulary that this file validates: a plugin type, a plugin name, a decimal
 * version, a dotted release, a role short name, a capability name and one of
 * four permission words. No free text, attribute, link, form value or hidden
 * control is copied, so no API key, token, password, session key or salted
 * value can reach a result. A row or control carrying a class or a value this
 * file does not recognise is refused rather than reported.
 */

/**
 * Runs one of the two Moodle system administration reads in the page world. The
 * operation key selects the read; every helper is inline because Chrome
 * serializes this function for MAIN-world injection.
 */
export async function executeMoodleSiteInventoryReadInPage(rawInput) {
  const PROVIDER = "moodle";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_PLUGINS = 2_000;
  const MAX_ROLES = 200;
  const MAX_CAPABILITY_ROWS = 5_000;
  const MAX_OVERRIDES = 500;
  // The plugin types this read reports as their own enabled sets, because each
  // one changes what a course can do. They are the same rows as the inventory,
  // selected by type.
  const REPORTED_TYPES = Object.freeze(["auth", "enrol", "qbank", "availability", "repository", "filter"]);
  // Every plugin row class Moodle's own plugins control panel writes. A row
  // carrying anything else is a control this read does not understand, and it
  // is refused rather than reported.
  const PLUGIN_ROW_CLASSES = new Set(["r0", "r1", "lastrow", "plugintypeheader", "deprecatedtype", "enabled", "disabled"]);
  // Moodle's four capability permissions. The value is the one this read emits.
  const PERMISSIONS = new Map([["0", "inherit"], ["1", "allow"], ["-1", "prevent"], ["-1000", "prohibit"]]);
  // Everything on these administration pages this read never parses. None of it
  // reaches a result, so no link, key, token or free text can leave the page.
  const OMITTED_CONTROLS = Object.freeze([
    "plugin_display_name", "plugin_settings_link", "plugin_uninstall_link", "plugin_update_control", "plugin_notes",
    "role_display_name", "role_description", "role_action_links", "form_session_key", "hidden_form_controls",
  ]);
  const DEFINITIONS = new Map([
    ["moodle.form.admin.site_inventory.read.v1", {
      tool: "moodle_get_site_inventory",
      schema: "morrow.moodle-site-inventory.v1",
      prefix: "moodle_site_inventory",
      method: "admin_plugins_overview",
      capability: "moodle/site:config",
    }],
    ["moodle.form.admin.role_definitions.read.v1", {
      tool: "moodle_get_role_definitions",
      schema: "morrow.moodle-role-definitions.v1",
      prefix: "moodle_role_definitions",
      method: "admin_roles_manage_index",
      capability: "moodle/role:manage",
    }],
  ]);
  const ID = /^[1-9][0-9]{0,18}$/;
  const COUNT = /^(?:0|[1-9][0-9]{0,9})$/;
  const ADMIN_DIRECTORY = /^[a-z][a-z0-9_-]{0,30}$/;
  const RELEASE = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/;
  const PLUGIN_TYPE = /^[a-z][a-z0-9]{0,30}$/;
  const PLUGIN_NAME = /^[a-z][a-z0-9_]{0,60}$/;
  const PLUGIN_STATUS = /^[a-z][a-z0-9]{0,30}$/;
  const ARCHETYPE = /^[a-z]{0,20}$/;
  const SHORTNAME = /^[A-Za-z0-9_-]{1,100}$/;
  const CAPABILITY = /^[a-z][a-z0-9_]{0,30}\/[a-z][a-z0-9_]{0,60}:[a-z][a-z0-9_]{0,60}$/;
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && ID.test(value) ? value : "";
  const input = (() => { try { return typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput; } catch { return null; } })();
  const operation = object(input) ? input.operation : null;
  const definition = object(operation) && typeof operation.key === "string" ? DEFINITIONS.get(operation.key) : undefined;
  if (!definition) return { ok: false, sent: false, error: "moodle_site_administration_operation_refused" };
  const fail = (error) => ({ ok: false, sent: false, error: `${definition.prefix}_${error}` });
  const incomplete = () => ({ ok: false, sent: false, complete: false, error: `${definition.prefix}_incomplete` });
  const cfg = globalThis.M?.cfg;
  if (!object(cfg) || typeof cfg.wwwroot !== "string" || typeof cfg.sesskey !== "string" || !cfg.sesskey
    || typeof cfg.admin !== "string" || !ADMIN_DIRECTORY.test(cfg.admin)) return fail("context_invalid");
  const adminDirectory = cfg.admin;
  let site;
  try { site = new URL(cfg.wwwroot); } catch { return fail("context_invalid"); }
  const basePath = site.pathname.replace(/\/$/, "");
  const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
  const courseId = id(cfg.courseId) || bodyCourse;
  const principalId = id(cfg.userId);
  const contextId = id(cfg.courseContextId);
  const currentPath = String(globalThis.location?.pathname || "");
  if (site.protocol !== "https:" || site.search || site.hash || site.username || site.password
    || site.origin !== globalThis.location?.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))
    || !courseId || !principalId || !contextId) return fail("context_invalid");
  const args = input.arguments;
  const binding = input.binding;
  if (operation.toolName !== definition.tool || operation.provider !== PROVIDER || operation.readOnly !== true
    || !object(args) || id(args.course_id) !== courseId
    || !object(binding) || binding.origin !== site.origin || binding.siteUrl !== site.href
    || id(binding.principalId) !== principalId || id(binding.courseId) !== courseId
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) return fail("arguments_invalid");
  let requestedRoleId = "";
  if (definition.prefix === "moodle_role_definitions") {
    const keys = Object.keys(args).length;
    requestedRoleId = args.role_id === undefined ? "" : id(args.role_id);
    if (keys !== (args.role_id === undefined ? 1 : 2)
      || (args.role_id !== undefined && !requestedRoleId)) return fail("arguments_invalid");
  } else if (Object.keys(args).length !== 1) return fail("arguments_invalid");
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
      return received.origin === expected.origin && received.pathname === expected.pathname
        && received.search === expected.search && !received.hash && !received.username && !received.password;
    } catch { return false; }
  };
  const boundedText = async (response, endpoint) => {
    const declared = response?.headers?.get?.("content-length");
    if (declared !== null && (!COUNT.test(String(declared)) || Number(declared) > MAX_RESPONSE_BYTES)) return "limit";
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
  /**
   * One bounded GET of a native administration page, parsed into a document.
   * A response Moodle refused is "forbidden": Moodle answers an administration
   * page it will not serve with its own error page, so the caller decides
   * whether that is a refusal of the whole read or one part of it that stays
   * unreadable.
   */
  const adminDocument = async (path, query) => {
    if (Date.now() >= input.expiresAt || !sameContext()) return "context";
    const endpoint = url(path, query);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "text/html" },
      });
    } catch { return "failed"; }
    if (!response.ok) return response.status === 403 ? "forbidden" : "failed";
    const html = await boundedText(response, endpoint);
    if (html === "limit") return "limit";
    if (typeof html !== "string" || typeof globalThis.DOMParser !== "function") return "failed";
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      return parsed.querySelector("parsererror") ? "failed" : parsed;
    } catch { return "failed"; }
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
  /** The site-relative path of a same-origin URL, or null when it is elsewhere. */
  const sitePath = (href) => {
    if (typeof href !== "string") return null;
    let target;
    try { target = new URL(href, site.href); } catch { return null; }
    if (target.origin !== site.origin) return null;
    if (basePath && !(target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))) return null;
    return { path: basePath ? target.pathname.slice(basePath.length) : target.pathname, query: target.searchParams };
  };
  /** The value of the one selected option of the one control with this name. */
  const selectedValue = (parsed, name) => {
    const controls = [...parsed.querySelectorAll(`select[name="${name}"]`)];
    if (controls.length !== 1) return null;
    const chosen = [...controls[0].querySelectorAll("option[selected]")];
    return chosen.length === 1 ? String(chosen[0].getAttribute("value") ?? "") : null;
  };
  const cellText = (row, selector) => {
    const cell = row.querySelector(selector);
    return cell ? String(cell.textContent || "").trim() : null;
  };

  const readSiteInventory = async () => {
    const environment = await adminDocument(`/${adminDirectory}/environment.php`, {});
    if (typeof environment === "string") return environment;
    const release = selectedValue(environment, "version");
    if (release === null) return "administration";
    if (!RELEASE.test(release)) return "control";
    const parsed = await adminDocument(`/${adminDirectory}/plugins.php`, {});
    if (typeof parsed === "string") return parsed;
    const tables = [...parsed.querySelectorAll("table#plugins-control-panel")];
    if (tables.length !== 1) return "administration";
    const plugins = [];
    const components = new Set();
    for (const row of [...tables[0].querySelectorAll("tbody tr")]) {
      let type = "";
      let component = "";
      let status = "";
      let availability = "not_reported";
      let deprecatedType = false;
      let heading = false;
      for (const token of String(row.getAttribute("class") || "").split(/\s+/).filter(Boolean)) {
        if (PLUGIN_ROW_CLASSES.has(token)) {
          if (token === "enabled" || token === "disabled") {
            if (availability !== "not_reported") return "invalid";
            availability = token;
          } else if (token === "deprecatedtype") deprecatedType = true;
          else if (token === "plugintypeheader") heading = true;
          continue;
        }
        if (token.startsWith("type-")) { if (type) return "invalid"; type = token.slice(5); continue; }
        if (token.startsWith("name-")) { if (component) return "invalid"; component = token.slice(5); continue; }
        if (token.startsWith("status-")) { if (status) return "invalid"; status = token.slice(7); continue; }
        // A control on an administration page Morrow's allowlist does not hold.
        return "control";
      }
      // One heading row introduces each plugin type and names no plugin.
      if (heading) {
        if (!PLUGIN_TYPE.test(type) || component || status) return "invalid";
        continue;
      }
      if (!PLUGIN_TYPE.test(type) || !PLUGIN_STATUS.test(status) || !component.startsWith(`${type}_`)) return "invalid";
      const name = component.slice(type.length + 1);
      if (!PLUGIN_NAME.test(name) || components.has(component)) return "invalid";
      // The row classes and the plugin name cell must name the same component.
      if (cellText(row, "td.pluginname div.componentname") !== component) return "invalid";
      const versionText = cellText(row, "td.version div.versionnumber");
      if (versionText === null) return "invalid";
      if (versionText !== "" && !COUNT.test(versionText)) return "control";
      components.add(component);
      if (plugins.length >= MAX_PLUGINS) return "limit";
      plugins.push({
        type,
        name,
        component,
        version: versionText === "" ? null : Number(versionText),
        availability,
        status,
        deprecated_type: deprecatedType,
      });
    }
    if (plugins.length === 0) return "administration";
    plugins.sort((left, right) => (left.component < right.component ? -1 : left.component > right.component ? 1 : 0));
    const types = new Map();
    let enabled = 0;
    let disabled = 0;
    let notReported = 0;
    let deprecated = 0;
    for (const plugin of plugins) {
      const entry = types.get(plugin.type) || { type: plugin.type, installed_count: 0, enabled_count: 0, disabled_count: 0 };
      entry.installed_count += 1;
      if (plugin.availability === "enabled") { entry.enabled_count += 1; enabled += 1; }
      else if (plugin.availability === "disabled") { entry.disabled_count += 1; disabled += 1; }
      else notReported += 1;
      if (plugin.deprecated_type) deprecated += 1;
      types.set(plugin.type, entry);
    }
    const enabledByType = {};
    for (const type of REPORTED_TYPES) {
      enabledByType[type] = plugins.filter((plugin) => plugin.type === type && plugin.availability === "enabled").map((plugin) => plugin.name);
    }
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      moodle_release: release,
      plugin_count: plugins.length,
      enabled_count: enabled,
      disabled_count: disabled,
      availability_not_reported_count: notReported,
      deprecated_type_count: deprecated,
      types: [...types.values()].sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0)),
      enabled_plugins_by_type: enabledByType,
      plugins,
      proof: {
        method: definition.method,
        complete: true,
        required_capability: definition.capability,
        administration: "site_administrator_required",
        release_source: "admin_environment_version_control",
        plugin_limit: MAX_PLUGINS,
        response_byte_limit: MAX_RESPONSE_BYTES,
        request_count: 2,
        omitted_controls: OMITTED_CONTROLS,
      },
    };
  };

  const readRoleDefinitions = async () => {
    const manage = await adminDocument(`/${adminDirectory}/roles/manage.php`, {});
    if (typeof manage === "string") return manage;
    const tables = [...manage.querySelectorAll("table#roles")];
    if (tables.length !== 1) return "administration";
    const roles = [];
    const seen = new Set();
    for (const row of [...tables[0].querySelectorAll("tbody tr")]) {
      const link = row.querySelector("td.c0 a[href]");
      const shortName = cellText(row, "td.c2");
      if (!link || shortName === null) return "invalid";
      const target = sitePath(link.getAttribute("href"));
      if (!target || target.path !== `/${adminDirectory}/roles/define.php` || target.query.get("action") !== "view") return "invalid";
      const roleId = id(target.query.get("roleid") || "");
      if (!roleId || !SHORTNAME.test(shortName) || seen.has(roleId)) return "invalid";
      seen.add(roleId);
      if (roles.length >= MAX_ROLES) return "limit";
      roles.push({ role_id: Number(roleId), short_name: shortName });
    }
    if (roles.length === 0) return "administration";
    let requestCount = 1;
    let selectedRole = null;
    if (requestedRoleId) {
      const known = roles.find((role) => role.role_id === Number(requestedRoleId));
      if (!known) return "target";
      const define = await adminDocument(`/${adminDirectory}/roles/define.php`, { action: "edit", roleid: requestedRoleId });
      if (typeof define === "string") return define === "forbidden" ? "administration" : define;
      requestCount += 1;
      const shortControls = [...define.querySelectorAll('input[name="shortname"]')];
      if (shortControls.length !== 1) return "administration";
      // The role list and the role's own form must name the same role.
      if (String(shortControls[0].getAttribute("value") ?? "") !== known.short_name) return "changed";
      const archetype = selectedValue(define, "archetype");
      if (archetype === null) return "administration";
      if (!ARCHETYPE.test(archetype)) return "control";
      const override = await adminDocument(`/${adminDirectory}/roles/override.php`, { contextid: contextId, roleid: requestedRoleId });
      if (typeof override === "string" && override !== "forbidden") return override;
      requestCount += 1;
      // Moodle serves the override form only to a person who may override this
      // role at this exact context, and answers with its own error page when it
      // will not. The overrides then stay unknown; they are never reported as
      // none.
      const forms = override === "forbidden" ? [] : [...override.querySelectorAll("form#overrideform")];
      let overrides = null;
      if (forms.length === 1) {
        const rows = [...forms[0].querySelectorAll("tr.rolecap")];
        if (rows.length > MAX_CAPABILITY_ROWS) return "limit";
        overrides = [];
        for (const row of rows) {
          const capability = cellText(row, "th.name span.cap-name");
          if (capability === null || !CAPABILITY.test(capability)) return "invalid";
          const checked = [...row.querySelectorAll('input[type="radio"][checked]')];
          if (checked.length !== 1 || checked[0].getAttribute("name") !== capability) return "invalid";
          const permission = PERMISSIONS.get(String(checked[0].getAttribute("value") ?? ""));
          if (!permission) return "control";
          if (permission === "inherit") continue;
          if (overrides.length >= MAX_OVERRIDES) return "limit";
          overrides.push({ capability, permission });
        }
        overrides.sort((left, right) => (left.capability < right.capability ? -1 : left.capability > right.capability ? 1 : 0));
      }
      selectedRole = {
        role_id: known.role_id,
        short_name: known.short_name,
        archetype: archetype === "" ? null : archetype,
        context_overrides_visible: overrides !== null,
        context_override_count: overrides === null ? null : overrides.length,
        context_overrides: overrides,
      };
    }
    return {
      schema: definition.schema,
      provider: PROVIDER,
      course_id: Number(courseId),
      context_id: Number(contextId),
      role_count: roles.length,
      roles,
      selected_role: selectedRole,
      proof: {
        method: definition.method,
        complete: true,
        required_capability: definition.capability,
        context_override_capability: "moodle/role:override",
        administration: "system_context_role_management_required",
        role_limit: MAX_ROLES,
        capability_row_limit: MAX_CAPABILITY_ROWS,
        override_limit: MAX_OVERRIDES,
        response_byte_limit: MAX_RESPONSE_BYTES,
        request_count: requestCount,
        omitted_controls: OMITTED_CONTROLS,
      },
    };
  };

  const readers = {
    moodle_site_inventory: readSiteInventory,
    moodle_role_definitions: readRoleDefinitions,
  };
  const data = await readers[definition.prefix]();
  if (data === "limit") return incomplete();
  if (data === "context") return fail("context_changed");
  if (data === "failed") return fail("request_failed");
  if (data === "forbidden" || data === "administration") return fail("administration_required");
  if (data === "control") return fail("page_control_unrecognised");
  if (data === "changed") return fail("response_changed");
  if (data === "target") return fail("role_unavailable");
  if (typeof data === "string" || !object(data)) return fail("response_invalid");
  if (!sameContext() || Date.now() > input.expiresAt) return fail("context_changed");
  const snapshotDigest = await digest(data);
  if (!snapshotDigest) return fail("digest_unavailable");
  return { ok: true, sent: false, complete: true, data, snapshot_digest: snapshotDigest };
}
