import { describe, expect, it } from "vitest";
import {
  MOODLE_ROLE_DEFINITIONS_SCHEMA,
  MOODLE_SITE_INVENTORY_SCHEMA,
  moodleSiteAdministrationReadByTool,
  projectMoodleRoleDefinitions,
  projectMoodleSiteInventory,
} from "../src/moodle-site-inventory.js";

const COURSE = { courseId: 2, roleId: null };
const OMITTED_CONTROLS = [
  "plugin_display_name", "plugin_settings_link", "plugin_uninstall_link", "plugin_update_control", "plugin_notes",
  "role_display_name", "role_description", "role_action_links", "form_session_key", "hidden_form_controls",
];

const inventoryProof = {
  method: "admin_plugins_overview",
  complete: true,
  required_capability: "moodle/site:config",
  administration: "site_administrator_required",
  release_source: "admin_environment_version_control",
  plugin_limit: 2_000,
  response_byte_limit: 2 * 1024 * 1024,
  request_count: 2,
  omitted_controls: OMITTED_CONTROLS,
};
const plugins = [
  { type: "auth", name: "cas", component: "auth_cas", version: 2_025_041_400, availability: "disabled", status: "uptodate", deprecated_type: false },
  { type: "auth", name: "manual", component: "auth_manual", version: 2_025_041_400, availability: "enabled", status: "uptodate", deprecated_type: false },
  { type: "filter", name: "mathjaxloader", component: "filter_mathjaxloader", version: 2_025_041_400, availability: "enabled", status: "uptodate", deprecated_type: false },
  { type: "theme", name: "boost", component: "theme_boost", version: null, availability: "not_reported", status: "new", deprecated_type: true },
];
const inventory = {
  schema: MOODLE_SITE_INVENTORY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  moodle_release: "5.2.2",
  plugin_count: 4,
  enabled_count: 2,
  disabled_count: 1,
  availability_not_reported_count: 1,
  deprecated_type_count: 1,
  types: [
    { type: "auth", installed_count: 2, enabled_count: 1, disabled_count: 1 },
    { type: "filter", installed_count: 1, enabled_count: 1, disabled_count: 0 },
    { type: "theme", installed_count: 1, enabled_count: 0, disabled_count: 0 },
  ],
  enabled_plugins_by_type: {
    auth: ["manual"], enrol: [], qbank: [], availability: [], repository: [], filter: ["mathjaxloader"],
  },
  plugins,
  proof: inventoryProof,
};

const roleProof = (requestCount: number) => ({
  method: "admin_roles_manage_index",
  complete: true,
  required_capability: "moodle/role:manage",
  context_override_capability: "moodle/role:override",
  administration: "system_context_role_management_required",
  role_limit: 200,
  capability_row_limit: 5_000,
  override_limit: 500,
  response_byte_limit: 2 * 1024 * 1024,
  request_count: requestCount,
  omitted_controls: OMITTED_CONTROLS,
});
const roles = [
  { role_id: 1, short_name: "manager" },
  { role_id: 3, short_name: "editingteacher" },
  { role_id: 5, short_name: "student" },
];
const roleList = {
  schema: MOODLE_ROLE_DEFINITIONS_SCHEMA,
  provider: "moodle",
  course_id: 2,
  context_id: 25,
  role_count: 3,
  roles,
  selected_role: null,
  proof: roleProof(1),
};
const selectedTeacher = {
  ...roleList,
  selected_role: {
    role_id: 3,
    short_name: "editingteacher",
    archetype: "editingteacher",
    context_overrides_visible: true,
    context_override_count: 2,
    context_overrides: [
      { capability: "mod/quiz:grade", permission: "prevent" },
      { capability: "moodle/course:update", permission: "allow" },
    ],
  },
  proof: roleProof(3),
};
const TEACHER = { courseId: 2, roleId: 3 };

describe("moodleSiteAdministrationReadByTool", () => {
  it("names both administration reads and nothing else", () => {
    expect(moodleSiteAdministrationReadByTool("moodle_get_site_inventory")?.prefix).toBe("moodle_site_inventory");
    expect(moodleSiteAdministrationReadByTool("moodle_get_role_definitions")?.prefix).toBe("moodle_role_definitions");
    expect(moodleSiteAdministrationReadByTool("moodle_get_course_activity_report")).toBeNull();
    expect(moodleSiteAdministrationReadByTool(undefined)).toBeNull();
  });
});

describe("projectMoodleSiteInventory", () => {
  it("projects the release, the inventory and the enabled sets", () => {
    expect(projectMoodleSiteInventory(inventory, COURSE)).toEqual(inventory);
  });

  it("drops every field the browser added and keeps no free text", () => {
    const projected = projectMoodleSiteInventory({
      ...inventory,
      settings_url: "https://moodle.example.edu/admin/settings.php?sesskey=abc123&token=wstoken7f3a91c4",
      administrator_email: "admin@example.edu",
      notes: "Password: Hunter2!Administrator",
    }, COURSE);
    const text = JSON.stringify(projected);
    for (const secret of ["sesskey", "wstoken", "admin@example.edu", "Hunter2", "settings.php"]) {
      expect(text).not.toContain(secret);
    }
    expect(projected).toEqual(inventory);
  });

  it("refuses a summary that disagrees with its own rows", () => {
    expect(() => projectMoodleSiteInventory({ ...inventory, enabled_count: 3 }, COURSE)).toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({ ...inventory, plugin_count: 3 }, COURSE)).toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({
      ...inventory,
      enabled_plugins_by_type: { ...inventory.enabled_plugins_by_type, auth: ["manual", "cas"] },
    }, COURSE)).toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({
      ...inventory,
      types: [{ type: "auth", installed_count: 2, enabled_count: 2, disabled_count: 0 }, ...inventory.types.slice(1)],
    }, COURSE)).toThrow("moodle_site_inventory_invalid");
  });

  it("refuses a row this read does not recognise", () => {
    // A disabled plugin reported as enabled by an availability word that is not
    // one of the three this read emits.
    expect(() => projectMoodleSiteInventory({
      ...inventory,
      plugins: [{ ...plugins[0], availability: "unknown" }, ...plugins.slice(1)],
    }, COURSE)).toThrow("moodle_site_inventory_invalid");
    // A component that is not its own type and name.
    expect(() => projectMoodleSiteInventory({
      ...inventory,
      plugins: [{ ...plugins[0], component: "auth_other" }, ...plugins.slice(1)],
    }, COURSE)).toThrow("moodle_site_inventory_invalid");
    // A plugin row carrying one more field than the page emits.
    expect(() => projectMoodleSiteInventory({
      ...inventory,
      plugins: [{ ...plugins[0], settings_url: "/admin/settings.php" }, ...plugins.slice(1)],
    }, COURSE)).toThrow("moodle_site_inventory_invalid");
  });

  it("refuses an unsorted or repeated inventory", () => {
    expect(() => projectMoodleSiteInventory({ ...inventory, plugins: [...plugins].reverse() }, COURSE))
      .toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({
      ...inventory,
      plugin_count: 5,
      enabled_count: 3,
      types: [{ type: "auth", installed_count: 3, enabled_count: 2, disabled_count: 1 }, ...inventory.types.slice(1)],
      enabled_plugins_by_type: { ...inventory.enabled_plugins_by_type, auth: ["manual", "manual"] },
      plugins: [plugins[0], plugins[1], plugins[1], plugins[2], plugins[3]],
    }, COURSE)).toThrow("moodle_site_inventory_invalid");
  });

  it("refuses a release, a course or a proof that is not this read's", () => {
    expect(() => projectMoodleSiteInventory({ ...inventory, moodle_release: "5.2.2+ (Build: 20260101)" }, COURSE))
      .toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory(inventory, { courseId: 9, roleId: null }))
      .toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({ ...inventory, proof: { ...inventoryProof, request_count: 1 } }, COURSE))
      .toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({ ...inventory, proof: { ...inventoryProof, required_capability: null } }, COURSE))
      .toThrow("moodle_site_inventory_invalid");
    expect(() => projectMoodleSiteInventory({ ...inventory, proof: { ...inventoryProof, omitted_controls: [] } }, COURSE))
      .toThrow("moodle_site_inventory_invalid");
  });
});

describe("projectMoodleRoleDefinitions", () => {
  it("projects the role list alone when no role was named", () => {
    expect(projectMoodleRoleDefinitions(roleList, COURSE)).toEqual(roleList);
  });

  it("projects one role's archetype and its overrides at the selected context", () => {
    expect(projectMoodleRoleDefinitions(selectedTeacher, TEACHER)).toEqual(selectedTeacher);
  });

  it("keeps an unread override form unknown rather than empty", () => {
    const unknown = {
      ...selectedTeacher,
      selected_role: {
        role_id: 3,
        short_name: "editingteacher",
        archetype: "editingteacher",
        context_overrides_visible: false,
        context_override_count: null,
        context_overrides: null,
      },
    };
    const projected = projectMoodleRoleDefinitions(unknown, TEACHER) as Record<string, Record<string, unknown>>;
    expect(projected.selected_role!.context_overrides).toBeNull();
    expect(projected.selected_role!.context_override_count).toBeNull();
    // An unread override form must never be reported as a role with no
    // overrides at this context.
    expect(() => projectMoodleRoleDefinitions({
      ...unknown,
      selected_role: { ...unknown.selected_role, context_overrides: [], context_override_count: 0 },
    }, TEACHER)).toThrow("moodle_role_definitions_invalid");
  });

  it("projects a role with no archetype as none", () => {
    const custom = {
      ...selectedTeacher,
      roles: [...roles, { role_id: 9, short_name: "programreviewer" }],
      role_count: 4,
      selected_role: { ...selectedTeacher.selected_role, role_id: 9, short_name: "programreviewer", archetype: null },
    };
    const projected = projectMoodleRoleDefinitions(custom, { courseId: 2, roleId: 9 }) as Record<string, Record<string, unknown>>;
    expect(projected.selected_role!.archetype).toBeNull();
  });

  it("refuses a selected role the role list does not hold, or one nobody asked for", () => {
    expect(() => projectMoodleRoleDefinitions(selectedTeacher, { courseId: 2, roleId: 7 }))
      .toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions(selectedTeacher, COURSE)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions(roleList, TEACHER)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions({
      ...selectedTeacher,
      selected_role: { ...selectedTeacher.selected_role, short_name: "renamedrole" },
    }, TEACHER)).toThrow("moodle_role_definitions_invalid");
  });

  it("refuses an override permission or capability this read does not recognise", () => {
    expect(() => projectMoodleRoleDefinitions({
      ...selectedTeacher,
      selected_role: {
        ...selectedTeacher.selected_role,
        context_overrides: [{ capability: "mod/quiz:grade", permission: "inherit" }],
        context_override_count: 1,
      },
    }, TEACHER)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions({
      ...selectedTeacher,
      selected_role: {
        ...selectedTeacher.selected_role,
        context_overrides: [{ capability: "Update the course", permission: "allow" }],
        context_override_count: 1,
      },
    }, TEACHER)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions({
      ...selectedTeacher,
      selected_role: {
        ...selectedTeacher.selected_role,
        context_overrides: [...selectedTeacher.selected_role.context_overrides].reverse(),
      },
    }, TEACHER)).toThrow("moodle_role_definitions_invalid");
  });

  it("drops every field the browser added and keeps no free text", () => {
    const projected = projectMoodleRoleDefinitions({
      ...selectedTeacher,
      session_key: "moodle-private-session-key",
      role_description: "Managed by admin@example.edu, password Hunter2!Administrator",
    }, TEACHER);
    const text = JSON.stringify(projected);
    for (const secret of ["moodle-private-session-key", "admin@example.edu", "Hunter2", "Managed by"]) {
      expect(text).not.toContain(secret);
    }
    expect(projected).toEqual(selectedTeacher);
  });

  it("refuses a context, a course or a proof that is not this read's", () => {
    expect(() => projectMoodleRoleDefinitions({ ...roleList, context_id: 0 }, COURSE)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions(roleList, { courseId: 9, roleId: null })).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions({ ...roleList, proof: roleProof(3) }, COURSE)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions({ ...roleList, role_count: 2 }, COURSE)).toThrow("moodle_role_definitions_invalid");
    expect(() => projectMoodleRoleDefinitions({
      ...roleList,
      roles: [...roles, { role_id: 3, short_name: "duplicate" }],
      role_count: 4,
    }, COURSE)).toThrow("moodle_role_definitions_invalid");
  });
});
