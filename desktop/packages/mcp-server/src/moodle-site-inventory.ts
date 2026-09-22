import { isJsonObject, type JsonObject } from "@morrow/contracts";

/**
 * Projections for Moodle's two read-only system administration reads.
 *
 * Each projection rebuilds its result from fixed fields, so a field the browser
 * added cannot reach MCP egress. Neither read carries a learner identity of any
 * kind, and neither carries free text: every value is a plugin type, a plugin
 * name, a component, a decimal version, a dotted release, a role short name, a
 * capability name, or one of a fixed set of words. A value outside that
 * vocabulary is refused here as well as in the page, so no API key, token,
 * password, session key or salted value can reach a result.
 *
 * The per-type totals and the enabled sets are recomputed from the plugin rows
 * and compared, so a browser result whose summary disagrees with its own rows
 * is refused rather than reported.
 *
 * A role whose override form Moodle did not serve keeps `context_overrides`
 * null. Unknown is never projected as an empty list.
 */

export const MOODLE_SITE_INVENTORY_OPERATION = "moodle.form.admin.site_inventory.read.v1";
export const MOODLE_SITE_INVENTORY_TOOL = "moodle_get_site_inventory";
export const MOODLE_SITE_INVENTORY_SCHEMA = "morrow.moodle-site-inventory.v1";

export const MOODLE_ROLE_DEFINITIONS_OPERATION = "moodle.form.admin.role_definitions.read.v1";
export const MOODLE_ROLE_DEFINITIONS_TOOL = "moodle_get_role_definitions";
export const MOODLE_ROLE_DEFINITIONS_SCHEMA = "morrow.moodle-role-definitions.v1";

const SITE_INVENTORY_METHOD = "admin_plugins_overview";
const ROLE_DEFINITIONS_METHOD = "admin_roles_manage_index";

const SITE_INVENTORY_CAPABILITY = "moodle/site:config";
const ROLE_DEFINITIONS_CAPABILITY = "moodle/role:manage";
const ROLE_OVERRIDE_CAPABILITY = "moodle/role:override";

const RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024;
const PLUGIN_LIMIT = 2_000;
const ROLE_LIMIT = 200;
const CAPABILITY_ROW_LIMIT = 5_000;
const OVERRIDE_LIMIT = 500;
const VERSION_LIMIT = 9_999_999_999;

/** The plugin types the inventory reports as their own enabled sets. */
const REPORTED_TYPES = ["auth", "enrol", "qbank", "availability", "repository", "filter"] as const;
const AVAILABILITY = ["enabled", "disabled", "not_reported"] as const;
const PERMISSIONS = ["allow", "prevent", "prohibit"] as const;
const OMITTED_CONTROLS = [
  "plugin_display_name", "plugin_settings_link", "plugin_uninstall_link", "plugin_update_control", "plugin_notes",
  "role_display_name", "role_description", "role_action_links", "form_session_key", "hidden_form_controls",
] as const;

const RELEASE = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u;
const PLUGIN_TYPE = /^[a-z][a-z0-9]{0,30}$/u;
const PLUGIN_NAME = /^[a-z][a-z0-9_]{0,60}$/u;
const PLUGIN_STATUS = /^[a-z][a-z0-9]{0,30}$/u;
const ARCHETYPE = /^[a-z]{1,20}$/u;
const SHORTNAME = /^[A-Za-z0-9_-]{1,100}$/u;
const CAPABILITY = /^[a-z][a-z0-9_]{0,30}\/[a-z][a-z0-9_]{0,60}:[a-z][a-z0-9_]{0,60}$/u;

export type MoodleSiteAdministrationExpectation = Readonly<{ courseId: number; roleId: number | null }>;

export type MoodleSiteAdministrationRead = Readonly<{
  operation: string;
  tool: string;
  schema: string;
  /** The error prefix the runtime raises for this read. */
  prefix: string;
  summary: string;
  project: (value: unknown, expected: MoodleSiteAdministrationExpectation) => JsonObject;
}>;

function positiveId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function count(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}

function keys(value: JsonObject, expected: readonly string[], error: string): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) throw new Error(error);
}

function proofOf(
  value: JsonObject,
  method: string,
  capability: string,
  extra: Readonly<Record<string, unknown>>,
  error: string,
): JsonObject {
  const proof = isJsonObject(value.proof) ? value.proof : null;
  if (!proof || proof.method !== method || proof.complete !== true || proof.required_capability !== capability) {
    throw new Error(error);
  }
  for (const [key, entry] of Object.entries(extra)) {
    if (Array.isArray(entry)) {
      const actual = proof[key];
      if (!Array.isArray(actual) || actual.length !== entry.length
        || actual.some((item, index) => item !== entry[index])) throw new Error(error);
      continue;
    }
    if (proof[key] !== entry) throw new Error(error);
  }
  return {
    method,
    complete: true,
    required_capability: capability,
    ...Object.fromEntries(Object.entries(extra).map(([key, entry]) => [key, Array.isArray(entry) ? [...entry] : entry])),
  };
}

type PluginRow = Readonly<{
  type: string;
  name: string;
  component: string;
  version: number | null;
  availability: (typeof AVAILABILITY)[number];
  status: string;
  deprecated_type: boolean;
}>;

function pluginRows(value: unknown, error: string): PluginRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PLUGIN_LIMIT) throw new Error(error);
  const rows: PluginRow[] = [];
  let previous = "";
  for (const entry of value) {
    if (!isJsonObject(entry)) throw new Error(error);
    keys(entry, ["type", "name", "component", "version", "availability", "status", "deprecated_type"], error);
    const { type, name, component, status } = entry;
    const availability = AVAILABILITY.find((known) => known === entry.availability);
    const version = entry.version === null ? null : count(entry.version, VERSION_LIMIT);
    if (typeof type !== "string" || !PLUGIN_TYPE.test(type) || typeof name !== "string" || !PLUGIN_NAME.test(name)
      || typeof component !== "string" || component !== `${type}_${name}`
      || typeof status !== "string" || !PLUGIN_STATUS.test(status)
      || !availability || (entry.version !== null && version === null)
      || typeof entry.deprecated_type !== "boolean") throw new Error(error);
    // The page sorts the inventory by component, so a result whose rows are out
    // of order or repeat a component did not come from that page.
    if (component <= previous) throw new Error(error);
    previous = component;
    rows.push({ type, name, component, version, availability, status, deprecated_type: entry.deprecated_type });
  }
  return rows;
}

/**
 * The Moodle release and the installed plugin inventory of one site, read from
 * Moodle's own administration pages. It carries no learner data and no course
 * content, and it adds no administration write.
 */
export function projectMoodleSiteInventory(
  value: unknown,
  expected: MoodleSiteAdministrationExpectation,
): JsonObject {
  const error = "moodle_site_inventory_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_SITE_INVENTORY_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId) throw new Error(error);
  const release = typeof value.moodle_release === "string" && RELEASE.test(value.moodle_release) ? value.moodle_release : null;
  const plugins = pluginRows(value.plugins, error);
  if (!release || count(value.plugin_count, PLUGIN_LIMIT) !== plugins.length) throw new Error(error);
  const types = new Map<string, { type: string; installed_count: number; enabled_count: number; disabled_count: number }>();
  const enabledByType = new Map<string, string[]>(REPORTED_TYPES.map((type) => [type, []]));
  let enabled = 0;
  let disabled = 0;
  let notReported = 0;
  let deprecated = 0;
  for (const plugin of plugins) {
    const entry = types.get(plugin.type)
      ?? { type: plugin.type, installed_count: 0, enabled_count: 0, disabled_count: 0 };
    entry.installed_count += 1;
    if (plugin.availability === "enabled") {
      entry.enabled_count += 1;
      enabled += 1;
      enabledByType.get(plugin.type)?.push(plugin.name);
    } else if (plugin.availability === "disabled") {
      entry.disabled_count += 1;
      disabled += 1;
    } else notReported += 1;
    if (plugin.deprecated_type) deprecated += 1;
    types.set(plugin.type, entry);
  }
  const expectedTypes = [...types.values()].sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0));
  const actualTypes = Array.isArray(value.types) ? value.types : null;
  if (value.enabled_count !== enabled || value.disabled_count !== disabled
    || value.availability_not_reported_count !== notReported || value.deprecated_type_count !== deprecated
    || !actualTypes || actualTypes.length !== expectedTypes.length) throw new Error(error);
  actualTypes.forEach((entry, index) => {
    const known = expectedTypes[index]!;
    if (!isJsonObject(entry)) throw new Error(error);
    keys(entry, ["type", "installed_count", "enabled_count", "disabled_count"], error);
    if (entry.type !== known.type || entry.installed_count !== known.installed_count
      || entry.enabled_count !== known.enabled_count || entry.disabled_count !== known.disabled_count) throw new Error(error);
  });
  const actualEnabled = isJsonObject(value.enabled_plugins_by_type) ? value.enabled_plugins_by_type : null;
  if (!actualEnabled) throw new Error(error);
  keys(actualEnabled, [...REPORTED_TYPES], error);
  for (const type of REPORTED_TYPES) {
    const known = enabledByType.get(type)!;
    const actual = actualEnabled[type];
    if (!Array.isArray(actual) || actual.length !== known.length
      || actual.some((name, index) => name !== known[index])) throw new Error(error);
  }
  return {
    schema: MOODLE_SITE_INVENTORY_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    moodle_release: release,
    plugin_count: plugins.length,
    enabled_count: enabled,
    disabled_count: disabled,
    availability_not_reported_count: notReported,
    deprecated_type_count: deprecated,
    types: expectedTypes.map((entry) => ({ ...entry })),
    enabled_plugins_by_type: Object.fromEntries(REPORTED_TYPES.map((type) => [type, [...enabledByType.get(type)!]])),
    plugins: plugins.map((plugin) => ({ ...plugin })),
    proof: proofOf(value, SITE_INVENTORY_METHOD, SITE_INVENTORY_CAPABILITY, {
      administration: "site_administrator_required",
      release_source: "admin_environment_version_control",
      plugin_limit: PLUGIN_LIMIT,
      response_byte_limit: RESPONSE_BYTE_LIMIT,
      request_count: 2,
      omitted_controls: OMITTED_CONTROLS,
    }, error),
  };
}

function selectedRole(
  value: unknown,
  roles: readonly { role_id: number; short_name: string }[],
  expected: MoodleSiteAdministrationExpectation,
  error: string,
): JsonObject | null {
  if (expected.roleId === null) {
    if (value !== null) throw new Error(error);
    return null;
  }
  if (!isJsonObject(value)) throw new Error(error);
  keys(value, ["role_id", "short_name", "archetype", "context_overrides_visible", "context_override_count", "context_overrides"], error);
  const known = roles.find((role) => role.role_id === expected.roleId);
  const archetype = value.archetype === null
    ? null
    : typeof value.archetype === "string" && ARCHETYPE.test(value.archetype) ? value.archetype : undefined;
  if (!known || value.role_id !== known.role_id || value.short_name !== known.short_name || archetype === undefined
    || typeof value.context_overrides_visible !== "boolean") throw new Error(error);
  // Moodle did not serve the override form, so the overrides at this context
  // stay unknown. Unknown is never an empty list.
  if (!value.context_overrides_visible) {
    if (value.context_overrides !== null || value.context_override_count !== null) throw new Error(error);
    return {
      role_id: known.role_id,
      short_name: known.short_name,
      archetype,
      context_overrides_visible: false,
      context_override_count: null,
      context_overrides: null,
    };
  }
  if (!Array.isArray(value.context_overrides) || value.context_overrides.length > OVERRIDE_LIMIT
    || value.context_override_count !== value.context_overrides.length) throw new Error(error);
  let previous = "";
  const overrides = value.context_overrides.map((entry) => {
    if (!isJsonObject(entry)) throw new Error(error);
    keys(entry, ["capability", "permission"], error);
    const permission = PERMISSIONS.find((known2) => known2 === entry.permission);
    if (typeof entry.capability !== "string" || !CAPABILITY.test(entry.capability) || !permission
      || entry.capability <= previous) throw new Error(error);
    previous = entry.capability;
    return { capability: entry.capability, permission };
  });
  return {
    role_id: known.role_id,
    short_name: known.short_name,
    archetype,
    context_overrides_visible: true,
    context_override_count: overrides.length,
    context_overrides: overrides,
  };
}

/**
 * Every role's short name, and one named role's archetype and the capability
 * overrides Moodle shows at the selected course's own context. It carries no
 * learner data and adds no administration write.
 */
export function projectMoodleRoleDefinitions(
  value: unknown,
  expected: MoodleSiteAdministrationExpectation,
): JsonObject {
  const error = "moodle_role_definitions_invalid";
  if (!isJsonObject(value) || value.schema !== MOODLE_ROLE_DEFINITIONS_SCHEMA || value.provider !== "moodle"
    || positiveId(value.course_id) !== expected.courseId || positiveId(value.context_id) === null) throw new Error(error);
  const source = Array.isArray(value.roles) ? value.roles : null;
  if (!source || source.length === 0 || source.length > ROLE_LIMIT
    || count(value.role_count, ROLE_LIMIT) !== source.length) throw new Error(error);
  const identifiers = new Set<number>();
  const roles = source.map((entry) => {
    if (!isJsonObject(entry)) throw new Error(error);
    keys(entry, ["role_id", "short_name"], error);
    const roleId = positiveId(entry.role_id);
    if (roleId === null || identifiers.has(roleId) || typeof entry.short_name !== "string"
      || !SHORTNAME.test(entry.short_name)) throw new Error(error);
    identifiers.add(roleId);
    return { role_id: roleId, short_name: entry.short_name };
  });
  const selected = selectedRole(value.selected_role, roles, expected, error);
  return {
    schema: MOODLE_ROLE_DEFINITIONS_SCHEMA,
    provider: "moodle",
    course_id: expected.courseId,
    context_id: positiveId(value.context_id)!,
    role_count: roles.length,
    roles: roles.map((role) => ({ ...role })),
    selected_role: selected,
    proof: proofOf(value, ROLE_DEFINITIONS_METHOD, ROLE_DEFINITIONS_CAPABILITY, {
      context_override_capability: ROLE_OVERRIDE_CAPABILITY,
      administration: "system_context_role_management_required",
      role_limit: ROLE_LIMIT,
      capability_row_limit: CAPABILITY_ROW_LIMIT,
      override_limit: OVERRIDE_LIMIT,
      response_byte_limit: RESPONSE_BYTE_LIMIT,
      request_count: expected.roleId === null ? 1 : 3,
      omitted_controls: OMITTED_CONTROLS,
    }, error),
  };
}

const READS: readonly MoodleSiteAdministrationRead[] = [
  {
    operation: MOODLE_SITE_INVENTORY_OPERATION,
    tool: MOODLE_SITE_INVENTORY_TOOL,
    schema: MOODLE_SITE_INVENTORY_SCHEMA,
    prefix: "moodle_site_inventory",
    summary: "Morrow read this Moodle site's release and its installed plugin inventory.",
    project: projectMoodleSiteInventory,
  },
  {
    operation: MOODLE_ROLE_DEFINITIONS_OPERATION,
    tool: MOODLE_ROLE_DEFINITIONS_TOOL,
    schema: MOODLE_ROLE_DEFINITIONS_SCHEMA,
    prefix: "moodle_role_definitions",
    summary: "Morrow read this Moodle site's role definitions.",
    project: projectMoodleRoleDefinitions,
  },
];

export function moodleSiteAdministrationReadByTool(toolName: unknown): MoodleSiteAdministrationRead | null {
  return READS.find((entry) => entry.tool === toolName) ?? null;
}

export function projectMoodleSiteAdministrationBrowserResult(
  read: MoodleSiteAdministrationRead,
  browserData: unknown,
  expected: MoodleSiteAdministrationExpectation,
): JsonObject {
  return read.project(browserData, expected);
}
