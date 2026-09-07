import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { executeMoodleSiteInventoryReadInPage } from "../../connector/extension/src/moodle-site-inventory-read.js";

const READS = [
  {
    key: "moodle.form.admin.site_inventory.read.v1",
    tool: "moodle_get_site_inventory",
    capability: "moodle/site:config",
  },
  {
    key: "moodle.form.admin.role_definitions.read.v1",
    tool: "moodle_get_role_definitions",
    capability: "moodle/role:manage",
  },
];
const operationFor = (entry) => Object.freeze({ key: entry.key, toolName: entry.tool, provider: "moodle", readOnly: true });

test("the Moodle system administration reads are cataloged and routed through the extension worker", () => {
  const root = new URL("../..", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("connector/extension/generated/moodle-browser-catalog.json", root), "utf8"));
  for (const entry of READS) {
    const entries = catalog.operations.filter((operation) => operation.key === entry.key);
    assert.equal(entries.length, 1, `${entry.key} must be cataloged exactly once`);
    assert.equal(entries[0].toolName, entry.tool);
    assert.equal(entries[0].provider, "moodle");
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].reviewTool, undefined, `${entry.tool} adds no write`);
    assert.equal(entries[0].inputSchema.additionalProperties, false);
    assert.ok(entries[0].description.includes(entry.capability), `${entry.tool} must state ${entry.capability}`);
    // Both reads are administration reads, so both must say what Morrow does
    // when the signed-in person is not an administrator.
    assert.ok(
      entries[0].description.includes("administrator"),
      `${entry.tool} must state the administrator requirement`,
    );
  }
  const inventory = catalog.operations.find((operation) => operation.toolName === "moodle_get_site_inventory");
  for (const stated of ["No secret leaves the page", "Browser-fixture proof only"]) {
    assert.ok(inventory.description.includes(stated), `the site inventory description must state "${stated}"`);
  }
  const worker = readFileSync(new URL("connector/extension/src/service-worker.js", root), "utf8");
  assert.match(worker, /import \{ executeMoodleSiteInventoryReadInPage \} from "\.\/moodle-site-inventory-read\.js";/);
  assert.match(worker, /const MOODLE_SITE_ADMINISTRATION_READ_OPERATIONS = new Map\(\[/);
  assert.match(worker, /func: executeMoodleSiteInventoryReadInPage/);
  for (const entry of READS) assert.ok(worker.includes(`["${entry.key}", { toolName: "${entry.tool}"`), `${entry.key} must be routed`);
});

test("the Moodle system administration reads fail closed without an administrator and carry no secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-site-inventory-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const PRIVATE_SESSION = "moodle-private-session-key";
  const PRIVATE_TOKEN = "wstoken7f3a91c4e5d6";
  const PRIVATE_PASSWORD = "Hunter2!Administrator";
  const PRIVATE_SALT = "$2y$10$V0dGhZq9K1u2s3d4f5g6h7";
  const PRIVATE_EMAIL = "admin@example.edu";
  const requests = [];
  let origin = "";
  let mode = "complete";
  let browser;

  // Markup from Moodle 5.2.2. The environment page renders one version control
  // whose selected option value is the site's own normalized release.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/admin/environment.php
  const environmentBody = () => {
    if (mode === "environment-missing-select") return "<!doctype html><html><body><p>Nothing here</p></body></html>";
    const current = mode === "environment-bad-release" ? "5.2.2-dev+build" : "5.2.2";
    return `<!doctype html><html><body class="path-admin"><form method="get" action="/admin/environment.php"><label for="menuversion">Moodle version</label><select id="menuversion" class="custom-select" name="version"><option value="4.5">4.5</option><option value="${current}" selected>${current} (current)</option></select></form></body></html>`;
  };

  // The plugins control panel writes the plugin type, the component and the
  // status into each row's own classes, adds enabled or disabled when Moodle
  // reports an availability state, and precedes each type with one
  // plugintypeheader row.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/admin/renderer.php
  const PLUGINS = [
    { type: "mod", name: "assign", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "auth", name: "manual", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "auth", name: "cas", status: "uptodate", availability: "disabled", version: "2025041400" },
    { type: "availability", name: "date", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "enrol", name: "manual", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "enrol", name: "self", status: "uptodate", availability: "disabled", version: "2025041400" },
    { type: "filter", name: "mathjaxloader", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "filter", name: "multilang", status: "uptodate", availability: "disabled", version: "2025041400" },
    { type: "qbank", name: "viewcreator", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "qbank", name: "deletequestion", status: "uptodate", availability: "disabled", version: "2025041400" },
    { type: "repository", name: "upload", status: "uptodate", availability: "enabled", version: "2025041400" },
    { type: "theme", name: "boost", status: "uptodate", availability: null, version: "2025041400" },
    { type: "local", name: "sitehelper", status: "new", availability: null, version: "", deprecated: true },
  ];
  const pluginRow = (plugin, last) => {
    const component = `${plugin.type}_${plugin.name}`;
    const classes = [`type-${plugin.type}`, `name-${component}`, `status-${plugin.status}`];
    if (plugin.deprecated) classes.push("deprecatedtype");
    if (plugin.availability) classes.push(plugin.availability);
    if (mode === "plugins-unknown-class" && component === "auth_cas") classes.push("sitecontrol-experimental");
    classes.push("r0");
    if (last) classes.push("lastrow");
    const componentName = mode === "plugins-component-mismatch" && component === "enrol_self" ? "enrol_other" : component;
    const version = mode === "plugins-bad-version" && component === "filter_multilang" ? "2025-04-14" : plugin.version;
    // The display name, settings link, uninstall link and notes carry values a
    // result must never hold.
    return `<tr class="${classes.join(" ")}"><td class="cell c0 pluginname"><div class="displayname"><img class="icon pluginicon" src="/theme/image.php/boost/${component}/1/icon" alt=""/>${plugin.name} for ${PRIVATE_EMAIL}</div><div class="componentname">${componentName}</div></td><td class="cell c1 version"><div class="release">5.2.2</div><div class="versionnumber">${version}</div></td><td class="cell c2 availability">${plugin.availability === "enabled" ? "Enabled" : plugin.availability === "disabled" ? "Disabled" : ""}</td><td class="cell c3 settings"><a href="/admin/settings.php?section=${component}&amp;sesskey=${PRIVATE_SESSION}&amp;token=${PRIVATE_TOKEN}">Settings</a></td><td class="cell c4 uninstall"><a href="/admin/plugins.php?uninstall=${component}&amp;sesskey=${PRIVATE_SESSION}">Uninstall</a></td><td class="cell c5 notes lastcol">Password: ${PRIVATE_PASSWORD} salt ${PRIVATE_SALT}</td></tr>`;
  };
  const pluginsBody = () => {
    if (mode === "plugins-missing-table") return "<!doctype html><html><body><p>You do not have permission.</p></body></html>";
    const rows = [];
    let previousType = "";
    PLUGINS.forEach((plugin, index) => {
      if (plugin.type !== previousType) {
        previousType = plugin.type;
        rows.push(`<tr class="plugintypeheader type-${plugin.type} r0"><th class="cell c0 pluginname lastcol" colspan="6"><span id="plugin_type_cell_${plugin.type}">${plugin.type} plugins</span></th></tr>`);
      }
      rows.push(pluginRow(plugin, index === PLUGINS.length - 1));
    });
    return `<!doctype html><html><body class="path-admin"><table class="generaltable table table-striped table-hover" id="plugins-control-panel"><thead><tr><th class="header c0 pluginname">Plugin name</th></tr></thead><tbody>${rows.join("")}</tbody></table></body></html>`;
  };

  // The role list links each role's own definition page with its id and holds
  // the role short name in its third cell.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/admin/roles/manage.php
  const ROLES = [
    { id: 1, shortname: "manager", archetype: "manager" },
    { id: 3, shortname: "editingteacher", archetype: "editingteacher" },
    { id: 5, shortname: "student", archetype: "student" },
    { id: 9, shortname: "programreviewer", archetype: "" },
  ];
  const rolesBody = () => {
    if (mode === "roles-missing-table") return "<!doctype html><html><body><p>You do not have permission.</p></body></html>";
    const rows = ROLES.map((role, index) => `<tr class="r${index % 2}${index === ROLES.length - 1 ? " lastrow" : ""}"><td class="cell c0 leftalign"><a href="${origin}/admin/roles/define.php?action=view&amp;roleid=${role.id}">${role.shortname} (${PRIVATE_EMAIL})</a></td><td class="cell c1 leftalign">Managed by ${PRIVATE_EMAIL}, password ${PRIVATE_PASSWORD}</td><td class="cell c2 leftalign">${role.shortname}</td><td class="cell c3 leftalign lastcol"><a href="${origin}/admin/roles/manage.php?action=delete&amp;roleid=${role.id}&amp;sesskey=${PRIVATE_SESSION}">Delete</a></td></tr>`).join("");
    return `<!doctype html><html><body class="path-admin"><table id="roles" class="admintable table generaltable table-hover"><thead><tr><th class="header c0">Role</th><th class="header c1">Description</th><th class="header c2">Short name</th><th class="header c3">Edit</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  };

  // The role definition form holds the short name in one text control and the
  // raw archetype key as the selected option of one select control.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/admin/roles/classes/define_role_table_advanced.php
  const defineBody = (roleId) => {
    const role = ROLES.find((entry) => entry.id === roleId);
    if (!role) return "<!doctype html><html><body><p>Unknown role.</p></body></html>";
    const shortname = mode === "define-shortname-changed" ? "renamedrole" : role.shortname;
    const chosen = mode === "define-bad-archetype" ? "Editing Teacher" : role.archetype;
    const options = ["", "manager", "editingteacher", "student"]
      .map((value) => (value === role.archetype ? chosen : value))
      .map((value) => `<option value="${value}"${value === chosen ? " selected" : ""}>${value || "None"}</option>`)
      .join("");
    return `<!doctype html><html><body class="path-admin"><form method="post" action="/admin/roles/define.php"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}"/><input type="text" id="shortname" name="shortname" maxlength="100" value="${shortname}" class="form-control"/><select class="form-select" name="archetype" id="menuarchetype">${options}</select></form></body></html>`;
  };

  // The override form renders one row per capability with four permission
  // radios; the checked value is the permission at this exact context, and 0 is
  // inherit, which is no override.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/admin/roles/classes/override_permissions_table_advanced.php
  const OVERRIDE_ROWS = [
    { capability: "moodle/course:update", permission: "1" },
    { capability: "mod/quiz:grade", permission: "-1" },
    { capability: "moodle/course:viewhiddenactivities", permission: "0" },
    { capability: "moodle/site:config", permission: "-1000" },
  ];
  const overrideRow = (row) => {
    const permission = mode === "override-unknown-permission" && row.capability === "mod/quiz:grade" ? "7" : row.permission;
    const values = ["0", "1", "-1", "-1000"];
    const cells = (values.includes(permission) ? values : [...values, permission])
      .map((value) => `<td class="cell perm-${value}"><label><input type="radio" name="${row.capability}" value="${value}"${value === permission ? " checked=\"checked\"" : ""} /><span class="note">Permission</span></label></td>`)
      .join("");
    const extra = permission === "0" ? "" : " overriddenpermission table-warning";
    return `<tr class="rolecap riskconfig${extra}"><th scope="row" class="name"><span class="cap-desc"><a href="/help.php?component=core_role">Capability help</a><span class="cap-name">${row.capability}</span></span></th>${cells}</tr>`;
  };
  const overrideBody = () => `<!doctype html><html><body class="path-admin"><form id="overrideform" action="/admin/roles/override.php" method="post"><input type="hidden" name="sesskey" value="${PRIVATE_SESSION}"/><input type="hidden" name="roleid" value="3"/><table class="rolecaps" id="capabilities"><tbody>${OVERRIDE_ROWS.map(overrideRow).join("")}</tbody></table></form></body></html>`;

  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    const target = new URL(request.url || "/", origin);
    requests.push({ method: request.method, pathname: target.pathname, search: target.search });
    request.on("error", () => {});
    response.on("error", () => {});
    if (target.pathname === "/course/view.php") {
      const config = { cfg: { wwwroot: origin, sesskey: PRIVATE_SESSION, userId: 3, courseId: 2, courseContextId: 25, admin: "admin" } };
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body class="path-course course-2"><script>var M = ${JSON.stringify(config)};</script></body></html>`);
      return;
    }
    if (mode === "not-administrator") {
      response.writeHead(403, { "content-type": "text/html" }).end("<!doctype html><html><body><p>You do not have permission.</p></body></html>");
      return;
    }
    if (request.method === "GET" && mode === "oversize") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write(`<!doctype html><html><body><!--${"x".repeat(2 * 1024 * 1024 + 4_096)}-->`);
      response.end("</body></html>");
      return;
    }
    if (request.method === "GET" && target.pathname === "/admin/environment.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(environmentBody());
      return;
    }
    if (request.method === "GET" && target.pathname === "/admin/plugins.php") {
      if (mode === "plugins-forbidden") {
        response.writeHead(403, { "content-type": "text/html" }).end("<!doctype html><html><body><p>Site administrator required.</p></body></html>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(pluginsBody());
      return;
    }
    if (request.method === "GET" && target.pathname === "/admin/roles/manage.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(rolesBody());
      return;
    }
    if (request.method === "GET" && target.pathname === "/admin/roles/define.php") {
      response.writeHead(200, { "content-type": "text/html" }).end(defineBody(Number(target.searchParams.get("roleid"))));
      return;
    }
    if (request.method === "GET" && target.pathname === "/admin/roles/override.php") {
      if (mode === "override-forbidden") {
        response.writeHead(403, { "content-type": "text/html" }).end("<!doctype html><html><body><p>You cannot override this role here.</p></body></html>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(overrideBody());
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    origin = `https://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${origin}/course/view.php?id=2`);
    const call = (entry, args, expiresAt = Date.now() + 60_000) => page.evaluate(
      executeMoodleSiteInventoryReadInPage,
      JSON.stringify({
        operation: operationFor(entry),
        arguments: args,
        binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" },
        expiresAt,
      }),
    );
    const [inventory, roles] = READS;
    const adminRequests = () => requests.filter((request) => request.pathname.startsWith("/admin/")).length;

    const beforeInvalid = adminRequests();
    assert.deepEqual(await call(inventory, { course_id: 2, extra: true }), { ok: false, sent: false, error: "moodle_site_inventory_arguments_invalid" });
    assert.deepEqual(await call(inventory, { course_id: 9 }), { ok: false, sent: false, error: "moodle_site_inventory_arguments_invalid" });
    assert.deepEqual(await call(inventory, { course_id: 2 }, Date.now() - 1), { ok: false, sent: false, error: "moodle_site_inventory_arguments_invalid" });
    assert.deepEqual(await call(roles, { course_id: 2, role_id: 0 }), { ok: false, sent: false, error: "moodle_role_definitions_arguments_invalid" });
    assert.deepEqual(await call(roles, { course_id: 2, role_id: 3, extra: 1 }), { ok: false, sent: false, error: "moodle_role_definitions_arguments_invalid" });
    assert.deepEqual(
      await page.evaluate(executeMoodleSiteInventoryReadInPage, JSON.stringify({
        operation: { key: "moodle.form.admin.unknown.read.v1", toolName: "moodle_get_site_inventory", provider: "moodle", readOnly: true },
        arguments: { course_id: 2 }, binding: { origin, siteUrl: `${origin}/`, principalId: "3", courseId: "2" }, expiresAt: Date.now() + 60_000,
      })),
      { ok: false, sent: false, error: "moodle_site_administration_operation_refused" },
    );
    assert.equal(adminRequests(), beforeInvalid, "a refused argument set must reach no Moodle administration page");

    const site = await call(inventory, { course_id: 2 });
    assert.equal(site.ok, true, JSON.stringify(site));
    assert.match(site.snapshot_digest, /^[0-9a-f]{64}$/);
    assert.equal(site.data.moodle_release, "5.2.2");
    assert.equal(site.data.plugin_count, 13);
    assert.equal(site.data.enabled_count, 7);
    assert.equal(site.data.disabled_count, 4);
    assert.equal(site.data.availability_not_reported_count, 2, "a plugin type with no enabled state is reported as such, not as disabled");
    assert.equal(site.data.deprecated_type_count, 1);
    assert.deepEqual(site.data.enabled_plugins_by_type, {
      auth: ["manual"],
      enrol: ["manual"],
      qbank: ["viewcreator"],
      availability: ["date"],
      repository: ["upload"],
      filter: ["mathjaxloader"],
    });
    assert.deepEqual(site.data.types, [
      { type: "auth", installed_count: 2, enabled_count: 1, disabled_count: 1 },
      { type: "availability", installed_count: 1, enabled_count: 1, disabled_count: 0 },
      { type: "enrol", installed_count: 2, enabled_count: 1, disabled_count: 1 },
      { type: "filter", installed_count: 2, enabled_count: 1, disabled_count: 1 },
      { type: "local", installed_count: 1, enabled_count: 0, disabled_count: 0 },
      { type: "mod", installed_count: 1, enabled_count: 1, disabled_count: 0 },
      { type: "qbank", installed_count: 2, enabled_count: 1, disabled_count: 1 },
      { type: "repository", installed_count: 1, enabled_count: 1, disabled_count: 0 },
      { type: "theme", installed_count: 1, enabled_count: 0, disabled_count: 0 },
    ]);
    assert.deepEqual(site.data.plugins[0], {
      type: "auth", name: "cas", component: "auth_cas", version: 2_025_041_400, availability: "disabled", status: "uptodate", deprecated_type: false,
    });
    assert.deepEqual(site.data.plugins.find((plugin) => plugin.component === "local_sitehelper"), {
      type: "local", name: "sitehelper", component: "local_sitehelper", version: null, availability: "not_reported", status: "new", deprecated_type: true,
    });
    assert.deepEqual(site.data.proof, {
      method: "admin_plugins_overview",
      complete: true,
      required_capability: "moodle/site:config",
      administration: "site_administrator_required",
      release_source: "admin_environment_version_control",
      plugin_limit: 2_000,
      response_byte_limit: 2 * 1024 * 1024,
      request_count: 2,
      omitted_controls: [
        "plugin_display_name", "plugin_settings_link", "plugin_uninstall_link", "plugin_update_control", "plugin_notes",
        "role_display_name", "role_description", "role_action_links", "form_session_key", "hidden_form_controls",
      ],
    });

    const roleList = await call(roles, { course_id: 2 });
    assert.equal(roleList.ok, true, JSON.stringify(roleList));
    assert.equal(roleList.data.context_id, 25);
    assert.equal(roleList.data.role_count, 4);
    assert.deepEqual(roleList.data.roles, [
      { role_id: 1, short_name: "manager" },
      { role_id: 3, short_name: "editingteacher" },
      { role_id: 5, short_name: "student" },
      { role_id: 9, short_name: "programreviewer" },
    ]);
    assert.equal(roleList.data.selected_role, null, "the role list alone opens no role definition");
    assert.equal(roleList.data.proof.request_count, 1);
    assert.equal(roleList.data.proof.required_capability, "moodle/role:manage");
    assert.equal(roleList.data.proof.context_override_capability, "moodle/role:override");

    const teacher = await call(roles, { course_id: 2, role_id: 3 });
    assert.equal(teacher.ok, true, JSON.stringify(teacher));
    assert.deepEqual(teacher.data.selected_role, {
      role_id: 3,
      short_name: "editingteacher",
      archetype: "editingteacher",
      context_overrides_visible: true,
      context_override_count: 3,
      context_overrides: [
        { capability: "mod/quiz:grade", permission: "prevent" },
        { capability: "moodle/course:update", permission: "allow" },
        { capability: "moodle/site:config", permission: "prohibit" },
      ],
    });
    assert.equal(teacher.data.proof.request_count, 3);

    const custom = await call(roles, { course_id: 2, role_id: 9 });
    assert.equal(custom.ok, true, JSON.stringify(custom));
    assert.equal(custom.data.selected_role.archetype, null, "a role with no archetype reports none, not a guess");

    // Nothing a result carries comes from free text on the page, so no session
    // key, token, password, salted value or address can leave it.
    for (const result of [site, roleList, teacher, custom]) {
      const text = JSON.stringify(result);
      for (const secret of [PRIVATE_SESSION, PRIVATE_TOKEN, PRIVATE_PASSWORD, PRIVATE_SALT, PRIVATE_EMAIL, "sesskey", "token=", "/admin/", "theme/image.php", "Password"]) {
        assert.equal(text.includes(secret), false, `an administration read leaked ${secret}`);
      }
    }

    // Every administration request is a page read on its own fixed route, and
    // no read opens an activity, a player, an attempt or a report page.
    const adminRoutes = requests.filter((request) => request.pathname.startsWith("/admin/"));
    assert.ok(adminRoutes.length > 0);
    for (const request of adminRoutes) assert.equal(request.method, "GET");
    assert.equal(requests.some((request) => request.method !== "GET"), false, "an administration read sends no POST");
    assert.equal(requests.some((request) => /^\/mod\//.test(request.pathname)), false, "no read opens a module page");
    assert.equal(requests.some((request) => request.pathname === "/admin/index.php"), false, "no read opens the upgrade page");
    for (const request of requests.filter((entry) => entry.pathname === "/admin/plugins.php")) assert.equal(request.search, "");
    for (const request of requests.filter((entry) => entry.pathname === "/admin/roles/override.php")) {
      assert.match(request.search, /^\?contextid=25&roleid=[1-9][0-9]*$/);
    }
    for (const request of requests.filter((entry) => entry.pathname === "/admin/roles/define.php")) {
      assert.match(request.search, /^\?action=edit&roleid=[1-9][0-9]*$/);
    }

    assert.deepEqual(await call(roles, { course_id: 2, role_id: 7 }), { ok: false, sent: false, error: "moodle_role_definitions_role_unavailable" });

    // Moodle answers an administration page it will not serve with its own
    // error page. Morrow refuses; it never reports an empty inventory.
    mode = "not-administrator";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_administration_required" });
    assert.deepEqual(await call(roles, { course_id: 2 }), { ok: false, sent: false, error: "moodle_role_definitions_administration_required" });
    mode = "plugins-forbidden";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_administration_required" });
    mode = "plugins-missing-table";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_administration_required" });
    mode = "roles-missing-table";
    assert.deepEqual(await call(roles, { course_id: 2 }), { ok: false, sent: false, error: "moodle_role_definitions_administration_required" });
    mode = "environment-missing-select";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_administration_required" });

    // A control this read does not recognise is refused, never guessed.
    mode = "plugins-unknown-class";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_page_control_unrecognised" });
    mode = "plugins-bad-version";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_page_control_unrecognised" });
    mode = "environment-bad-release";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_page_control_unrecognised" });
    mode = "override-unknown-permission";
    assert.deepEqual(await call(roles, { course_id: 2, role_id: 3 }), { ok: false, sent: false, error: "moodle_role_definitions_page_control_unrecognised" });
    mode = "define-bad-archetype";
    assert.deepEqual(await call(roles, { course_id: 2, role_id: 3 }), { ok: false, sent: false, error: "moodle_role_definitions_page_control_unrecognised" });

    mode = "plugins-component-mismatch";
    assert.deepEqual(await call(inventory, { course_id: 2 }), { ok: false, sent: false, error: "moodle_site_inventory_response_invalid" });
    mode = "define-shortname-changed";
    assert.deepEqual(await call(roles, { course_id: 2, role_id: 3 }), { ok: false, sent: false, error: "moodle_role_definitions_response_changed" });

    // Moodle refuses the override form to a person who may not override this
    // role here. The overrides then stay unknown and are never reported as none.
    mode = "override-forbidden";
    const unknownOverrides = await call(roles, { course_id: 2, role_id: 3 });
    assert.equal(unknownOverrides.ok, true, JSON.stringify(unknownOverrides));
    assert.equal(unknownOverrides.data.selected_role.context_overrides_visible, false);
    assert.equal(unknownOverrides.data.selected_role.context_overrides, null);
    assert.equal(unknownOverrides.data.selected_role.context_override_count, null);
    assert.equal(unknownOverrides.data.selected_role.archetype, "editingteacher");

    mode = "oversize";
    for (const [entry, args] of [[inventory, { course_id: 2 }], [roles, { course_id: 2 }]]) {
      assert.deepEqual(await call(entry, args), {
        ok: false,
        sent: false,
        complete: false,
        error: `${entry.tool === "moodle_get_site_inventory" ? "moodle_site_inventory" : "moodle_role_definitions"}_incomplete`,
      });
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
