import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { projectOutput, type OutputPrivacyDescriptor } from "@morrow/gateway-core";
import { afterEach, describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../../blackboard-learn-api/src/binding.js";
import { BLACKBOARD_TOOL_DEFINITIONS } from "../../blackboard-learn-api/src/operations/index.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const COURSE_ID = "_22_1";
const FOLDER_ID = "_100_1";
const DOCUMENT_ID = "_101_1";
const ASSESSMENT_ID = "_102_1";
const PRINCIPAL_ID = "_11_1";
const STUDENT_ID = "_44_1";
const COLUMN_ID = "_88_1";
const ATTEMPT_ID = "_501_1";
const ANNOUNCEMENT_ID = "_90_1";
const GROUP_ID = "_66_1";
const GROUP_SET_ID = "_67_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));

/**
 * The Blackboard tool names, read from the source registry itself
 * (`packages/blackboard-learn-api/src/operations/`) rather than retyped here.
 * A tool added to that registry therefore has to state which surface it belongs
 * to before this file passes.
 */
const PUBLIC_BLACKBOARD_TOOLS = BLACKBOARD_TOOL_DEFINITIONS
  .filter((tool) => !tool.private).map((tool) => tool.name);
const PRIVATE_BLACKBOARD_TOOLS = BLACKBOARD_TOOL_DEFINITIONS
  .filter((tool) => tool.private).map((tool) => tool.name);
/**
 * The public reads. Two public tools carry no capability block, because each
 * reads this installation's own state and sends no Blackboard request: the
 * configuration check, and the record of the changes Morrow sent and could not
 * confirm. Neither is one of the Blackboard capabilities.
 */
const BLACKBOARD_READ_TOOLS = BLACKBOARD_TOOL_DEFINITIONS
  .filter((tool) => !tool.private && tool.capability !== null).map((tool) => tool.name);
const HEALTH_TOOL = "morrow_blackboard_health";
const UNRESOLVED_EFFECTS_TOOL = "blackboard_unresolved_effects";

/** One roster: the account this credential acts as, and one enrolled learner. */
const ROSTER: readonly JsonObject[] = [
  {
    id: "_m10_1", courseId: COURSE_ID, userId: PRINCIPAL_ID, courseRoleId: "Instructor", availability: { available: "Yes" },
    user: { id: PRINCIPAL_ID, name: { given: "Ada", family: "Byron" }, contact: { email: "ada.byron@example.edu" } },
  },
  {
    id: "_m11_1", courseId: COURSE_ID, userId: STUDENT_ID, courseRoleId: "Student", availability: { available: "Yes" },
    user: { id: STUDENT_ID, name: { given: "Jane", family: "Doe" }, contact: { email: "jane.doe@example.edu" } },
  },
];

const COURSE: JsonObject = {
  id: COURSE_ID, courseId: "BIO-101", name: "Biology with Jane Doe",
  ultraStatus: "Ultra", closedComplete: false, availability: { available: "Yes" },
};

function contentItem(id: string, title: string, position: number, parentId?: string): JsonObject {
  return {
    id,
    courseId: COURSE_ID,
    ...(parentId ? { parentId } : {}),
    title,
    position,
    hasChildren: false,
    contentHandler: { id: "resource/x-bb-document" },
    availability: { available: "Yes" },
  };
}

function folderItem(id: string, title: string, position: number): JsonObject {
  return { ...contentItem(id, title, position), hasChildren: true, contentHandler: { id: "resource/x-bb-folder" } };
}

/** One test or assignment, which Blackboard returns under the Ultra test-link handler. */
function testLinkItem(id: string, title: string, position: number): JsonObject {
  return { ...contentItem(id, title, position), contentHandler: { id: "resource/x-bb-asmt-test-link" } };
}

/**
 * The content item each read is given. `blackboard_read_course_assessment`
 * reads a test or an assignment, so it is given the fixture's test link rather
 * than the folder every other content read is given.
 */
function contentIdFor(name: string): string {
  return name === "blackboard_read_course_assessment" ? ASSESSMENT_ID : FOLDER_ID;
}

const CONTENT: ReadonlyMap<string, JsonObject> = new Map([
  [FOLDER_ID, folderItem(FOLDER_ID, "Module 1 with Jane Doe", 1)],
  [DOCUMENT_ID, contentItem(DOCUMENT_ID, "Syllabus", 2)],
  [ASSESSMENT_ID, testLinkItem(ASSESSMENT_ID, "Week 1 quiz for Jane Doe", 3)],
  ["_110_1", contentItem("_110_1", "Week 1", 1, FOLDER_ID)],
]);

/** The one gradebook column, its one attempt, and the grade on it. */
const GRADEBOOK_COLUMN: JsonObject = {
  id: COLUMN_ID,
  contentId: DOCUMENT_ID,
  externalGrade: true,
  name: "Essay 1 for Jane Doe",
  description: "The first essay.",
  score: { possible: 10 },
  availability: { available: "Yes" },
  grading: { type: "Attempts", due: "2026-09-30T23:59:00.000Z", attemptsAllowed: 2 },
};

const GRADEBOOK_ATTEMPT: JsonObject = {
  id: ATTEMPT_ID,
  userId: STUDENT_ID,
  status: "NeedsGrading",
  score: 8,
  created: "2026-09-20T10:00:00.000Z",
  attemptDate: "2026-09-20T10:00:00.000Z",
  modified: "2026-09-21T08:30:00.000Z",
  exempt: false,
  studentSubmission: "My essay, by Jane Doe.",
};

const GRADEBOOK_GRADE: JsonObject = {
  userId: STUDENT_ID,
  columnId: COLUMN_ID,
  status: "NeedsGrading",
  score: 8,
  text: "8",
  exempt: false,
  feedback: "Good work, Jane.",
};

/** The one course announcement, for the announcement reads. */
const ANNOUNCEMENT: JsonObject = {
  id: ANNOUNCEMENT_ID,
  title: "Welcome to the course",
  body: "Jane Doe is the lab assistant this term.",
  availability: { duration: { type: "Continuous" } },
  showAtTopOfCourse: false,
  created: "2026-09-01T08:00:00.000Z",
};

/** The one course group, its set, and who is in it, for the group reads. */
const GROUP: JsonObject = {
  id: GROUP_ID, name: "Lab team 1", description: "The first lab team.",
  availability: { available: "Yes" }, groupSetId: GROUP_SET_ID,
};

const GROUP_SET: JsonObject = {
  id: GROUP_SET_ID, name: "Lab teams", description: "Every lab team.", availability: { available: "Yes" },
};

const GROUP_MEMBERS: readonly JsonObject[] = [{ id: "_gm1_1", groupId: GROUP_ID, userId: STUDENT_ID }];

/** The files one content item carries, for the attachment reads. */
const ATTACHMENTS: readonly JsonObject[] = [
  { id: "att-1", fileName: "Week 1 handout.txt", mimeType: "text/plain", size: 24 },
];

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function structured(result: unknown): JsonObject {
  if (!isJsonObject(result) || !isJsonObject(result.structuredContent)) {
    throw new Error("The Morrow tool returned no structured result.");
  }
  return result.structuredContent;
}

/** A gateway problem code, whether it is returned bare or inside a canonical result. */
function problemCode(result: unknown): string | undefined {
  const content = structured(result);
  if (typeof content.code === "string") return content.code;
  const data = isJsonObject(content.data) ? content.data : null;
  return data && typeof data.code === "string" ? data.code : undefined;
}

/** Protected references can be used for a selected learner read without releasing identity fields. */
async function expectLearnerReferenceRead(
  name: string,
  call: (tool: string, args: JsonObject) => Promise<unknown>,
  scope: JsonObject,
): Promise<void> {
  const roster = structured(await call("blackboard_course_roster_summary", scope));
  const data = isJsonObject(roster.data) ? roster.data : roster;
  expect(data, name).toMatchObject({ schema: "morrow.blackboard.roster-summary.v1" });
  const learner = Array.isArray(data.learners) ? data.learners.find((entry) => isJsonObject(entry) && entry.courseRoleId === "Student") : null;
  expect(learner).toMatchObject({ learnerToken: expect.stringMatching(/^learner_/) });
  const read = await call(name, {
    ...scope,
    learner_reference: isJsonObject(learner) ? learner.learnerToken : "",
    ...(name.includes("gradebook") ? { column_id: COLUMN_ID } : {}),
  });
  expect(isJsonObject(read) ? read.isError : true, `${name}: ${JSON.stringify(read)}`).not.toBe(true);
  expect(JSON.stringify(read)).not.toContain("Jane Doe");
  expect(JSON.stringify(read)).not.toContain("jane.doe@example.edu");
  const refused = await call(name, { ...scope, learner_reference: "learner_00000000-0000-4000-8000-000000000000" });
  expect(isJsonObject(refused) ? refused.isError : undefined, `${name}: ${JSON.stringify(refused)}`).toBe(true);
}

/** The exact `required` list one capability descriptor publishes. */
function requiredInput(descriptor: JsonObject): readonly string[] {
  const schema = isJsonObject(descriptor.inputSchema) ? descriptor.inputSchema : {};
  return Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
}

async function createFixture(): Promise<{
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly requests: () => readonly string[];
  readonly close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-surface-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  const requests: string[] = [];
  const server = createServer({ key, cert: certificate }, async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "https://fixture.invalid").pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: 3600 });
      return;
    }
    if (pathname === "/learn/api/public/v1/users/me" || pathname === `/learn/api/public/v1/users/${PRINCIPAL_ID}`) {
      json(response, { id: PRINCIPAL_ID });
      return;
    }
    const membership = new RegExp(`^/learn/api/public/v1/courses/${COURSE_ID}/users/([^/]+)$`).exec(pathname);
    if (membership) {
      const record = ROSTER.find((entry) => entry.userId === membership[1]);
      json(response, record || { message: "not found" }, record ? 200 : 404);
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/users`) {
      json(response, { results: ROSTER, paging: {} });
      return;
    }
    if (pathname === `/learn/api/public/v1/users/${PRINCIPAL_ID}/courses`) {
      json(response, {
        results: [{ id: "_m20_1", userId: PRINCIPAL_ID, courseId: COURSE_ID, courseRoleId: "Instructor", course: COURSE }],
        paging: {},
      });
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${COURSE_ID}` || pathname === `/learn/api/public/v1/courses/${COURSE_ID}`) {
      json(response, COURSE);
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents`) {
      json(response, { results: [CONTENT.get(FOLDER_ID), CONTENT.get(DOCUMENT_ID)], paging: {} });
      return;
    }
    const children = new RegExp(`^/learn/api/public/v1/courses/${COURSE_ID}/contents/([^/]+)/children$`).exec(pathname);
    if (children) {
      json(response, { results: children[1] === FOLDER_ID ? [CONTENT.get("_110_1")] : [], paging: {} });
      return;
    }
    const gradebook = `/learn/api/public/v2/courses/${COURSE_ID}/gradebook/columns`;
    if (pathname === gradebook) {
      json(response, { results: [GRADEBOOK_COLUMN], paging: {} });
      return;
    }
    if (pathname === `${gradebook}/${COLUMN_ID}`) {
      json(response, GRADEBOOK_COLUMN);
      return;
    }
    if (pathname === `${gradebook}/${COLUMN_ID}/attempts`) {
      json(response, { results: [GRADEBOOK_ATTEMPT], paging: {} });
      return;
    }
    if (pathname === `${gradebook}/${COLUMN_ID}/attempts/${ATTEMPT_ID}`) {
      json(response, GRADEBOOK_ATTEMPT);
      return;
    }
    if (pathname === `${gradebook}/${COLUMN_ID}/users/${STUDENT_ID}`) {
      json(response, GRADEBOOK_GRADE);
      return;
    }
    const announcements = `/learn/api/public/v1/courses/${COURSE_ID}/announcements`;
    if (pathname === announcements) {
      json(response, { results: [ANNOUNCEMENT], paging: {} });
      return;
    }
    if (pathname === `${announcements}/${ANNOUNCEMENT_ID}`) {
      json(response, ANNOUNCEMENT);
      return;
    }
    const groups = `/learn/api/public/v2/courses/${COURSE_ID}/groups`;
    if (pathname === `${groups}/sets`) {
      json(response, { results: [GROUP_SET], paging: {} });
      return;
    }
    if (pathname === groups) {
      json(response, { results: [GROUP], paging: {} });
      return;
    }
    if (pathname === `${groups}/${GROUP_ID}`) {
      json(response, GROUP);
      return;
    }
    // Group memberships are read at v1 whichever version the group routes answer.
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/groups/${GROUP_ID}/users`) {
      json(response, { results: GROUP_MEMBERS, paging: {} });
      return;
    }
    const attachment = new RegExp(`^/learn/api/public/v1/courses/${COURSE_ID}/contents/([^/]+)/attachments/([^/]+)$`).exec(pathname);
    if (attachment) {
      json(response, ATTACHMENTS.find((entry) => entry.id === attachment[2]) || { message: "not found" }, ATTACHMENTS.some((entry) => entry.id === attachment[2]) ? 200 : 404);
      return;
    }
    const attachments = new RegExp(`^/learn/api/public/v1/courses/${COURSE_ID}/contents/([^/]+)/attachments$`).exec(pathname);
    if (attachments) {
      json(response, { results: ATTACHMENTS, paging: {} });
      return;
    }
    const item = new RegExp(`^/learn/api/public/v1/courses/${COURSE_ID}/contents/([^/]+)$`).exec(pathname);
    if (item && CONTENT.has(item[1] || "")) {
      json(response, CONTENT.get(item[1] || ""));
      return;
    }
    json(response, { message: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Blackboard fixture has no TCP address");
  const baseUrl = `https://127.0.0.1:${address.port}`;
  const credentialDirectory = join(directory, "home", ".morrow", "credentials", "blackboard");
  const configPath = join(directory, "blackboard-learn.json");
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(credentialDirectory, "fixture.secret"), JSON.stringify({
    schema: "morrow.blackboard-learn.credential.v1",
    credentialRevision: CREDENTIAL_REVISION,
    applicationSecret: "client-secret",
  }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({
    schema: "morrow.blackboard-learn.config.v1",
    tenants: [{
      id: "fixture",
      baseUrl,
      applicationKey: "app-key",
      credentialRef: "file",
      credentialRevision: CREDENTIAL_REVISION,
      principalId: PRINCIPAL_ID,
      courseBindings: [{ courseId: COURSE_ID }],
    }],
  }), { mode: 0o600 });
  return {
    directory,
    baseUrl,
    configPath,
    requests: () => [...requests],
    close: async () => {
      await new Promise<void>((closed) => server.close(() => closed()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** One gateway configuration whose only source is the Blackboard REST fixture. */
function configuration(
  root: string,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  surface: { readonly profile: "private-full" | "public-canvas" | "sandbox" | "read-only"; readonly toolSurface: "compact" | "full" },
) {
  return {
    schema: "morrow.upstreams.v1",
    profile: surface.profile,
    toolSurface: surface.toolSurface,
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "blackboard-rest",
      label: "Blackboard Learn REST fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [join(root, "packages/blackboard-learn-api/dist/index.js")],
      cwd: root,
      env: {
        HOME: join(fixture.directory, "home"),
        MORROW_BLACKBOARD_CONFIG: fixture.configPath,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      sourceDisposition: "direct_owned",
      priority: 100,
      required: true,
      enabled: true,
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "learner", maxRecords: 10_000,
        maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(fixture.directory, "gateway.sqlite3") },
    privacy: {
      canvasOrigin: "browser-session",
      account: "local",
      principal: "local",
      learnerVaultPath: join(fixture.directory, "vault.json"),
    },
    maxCatalogTools: 2_000,
  };
}

let dispose: (() => Promise<void>) | undefined;

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** One running gateway and one connected MCP client, in the named surface. */
async function harness(surface: {
  readonly profile: "private-full" | "read-only";
  readonly toolSurface: "compact" | "full";
}) {
  const fixture = await createFixture();
  const root = resolve("../..");
  const runtime = await MorrowRuntime.connect(
    parseGatewayConfig(configuration(root, fixture, surface)),
    { statePath: join(fixture.directory, "morrow.sqlite3") },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createFullMorrowServer(runtime), { transport: serverTransport });
  const client = new Client({ name: "morrow-blackboard-surface", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(clientTransport);
  dispose = async () => {
    await client.close();
    await server.close();
    await runtime.close();
    await fixture.close();
  };
  const scope = {
    tenant_id: "fixture",
    source_binding_id: deriveBlackboardSourceBindingId(fixture.baseUrl, PRINCIPAL_ID, COURSE_ID),
    course_id: COURSE_ID,
  };
  return {
    runtime,
    client,
    scope,
    requests: fixture.requests,
    listToolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
    capabilityGet: async (name: string) => structured(await client.callTool({ name: "morrow_capability_get", arguments: { name } })),
  };
}

describe("Blackboard reachability across Morrow tool surfaces", () => {
  it("registers exactly the Blackboard reads and the configuration check in the full surface", async () => {
    // A registry parse that found nothing must fail here, not pass as agreement.
    expect(PRIVATE_BLACKBOARD_TOOLS).toEqual([
      "blackboard_plan_membership_patch",
      "blackboard_apply_reviewed_membership_patch",
      "blackboard_verify_membership_patch",
      "blackboard_plan_gradebook_column_patch",
      "blackboard_apply_reviewed_gradebook_column_patch",
      "blackboard_verify_gradebook_column_patch",
      "blackboard_plan_gradebook_grade_patch",
      "blackboard_apply_reviewed_gradebook_grade_patch",
      "blackboard_verify_gradebook_grade_patch",
      "blackboard_plan_content_attachment",
      "blackboard_apply_reviewed_content_attachment",
      "blackboard_verify_content_attachment",
      "blackboard_plan_ultra_assignment",
      "blackboard_apply_reviewed_ultra_assignment",
      "blackboard_verify_ultra_assignment",
      "blackboard_plan_course_announcement",
      "blackboard_apply_reviewed_course_announcement",
      "blackboard_verify_course_announcement",
      "blackboard_plan_course_announcement_patch",
      "blackboard_apply_reviewed_course_announcement_patch",
      "blackboard_verify_course_announcement_patch",
      "blackboard_plan_course_group",
      "blackboard_apply_reviewed_course_group",
      "blackboard_verify_course_group",
      "blackboard_plan_course_group_patch",
      "blackboard_apply_reviewed_course_group_patch",
      "blackboard_verify_course_group_patch",
      "blackboard_plan_group_membership",
      "blackboard_apply_reviewed_group_membership",
      "blackboard_verify_group_membership",
      "blackboard_plan_group_membership_removal",
      "blackboard_apply_reviewed_group_membership_removal",
      "blackboard_verify_group_membership_removal",
      "blackboard_plan_course_availability",
      "blackboard_apply_reviewed_course_availability",
      "blackboard_verify_course_availability",
      "blackboard_plan_content_dated_visibility",
      "blackboard_apply_reviewed_content_dated_visibility",
      "blackboard_verify_content_dated_visibility",
      // The held course copy. It carries a capability block that is unavailable
      // in every profile, so the Gateway keeps it out of the catalog and no
      // surface answers under its name.
      "blackboard_course_copy",
      "blackboard_plan_content_patch",
      "blackboard_apply_reviewed_content_patch",
      "blackboard_verify_content_patch",
    ]);
    expect(BLACKBOARD_READ_TOOLS.length).toBeGreaterThanOrEqual(8);
    expect(PUBLIC_BLACKBOARD_TOOLS).toEqual([HEALTH_TOOL, ...BLACKBOARD_READ_TOOLS, UNRESOLVED_EFFECTS_TOOL]);

    const morrow = await harness({ profile: "private-full", toolSurface: "full" });
    const names = await morrow.listToolNames();
    for (const tool of PUBLIC_BLACKBOARD_TOOLS) expect(names).toContain(tool);
    for (const tool of PRIVATE_BLACKBOARD_TOOLS) expect(names).not.toContain(tool);

    // Each read answers under its own canonical name in this surface.
    for (const name of BLACKBOARD_READ_TOOLS) {
      const capability = await morrow.capabilityGet(name);
      const required = requiredInput(isJsonObject(capability.descriptor) ? capability.descriptor : {});
      if (required.includes("learner_reference")) {
        await expectLearnerReferenceRead(name, (tool, args) => morrow.client.callTool({ name: tool, arguments: args }), morrow.scope);
        continue;
      }
      const result = await morrow.client.callTool({
        name,
        arguments: {
          ...morrow.scope,
          ...(required.includes("content_id") ? { content_id: contentIdFor(name) } : {}),
          ...(required.includes("attachment_id") ? { attachment_id: "att-1" } : {}),
          ...(required.includes("column_id") ? { column_id: COLUMN_ID } : {}),
          ...(required.includes("attempt_id") ? { attempt_id: ATTEMPT_ID } : {}),
          ...(required.includes("announcement_id") ? { announcement_id: ANNOUNCEMENT_ID } : {}),
          ...(required.includes("group_id") ? { group_id: GROUP_ID } : {}),
        },
      });
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
      expect(structured(result)).toMatchObject({ schema: "morrow.result.v1", data: { ok: true, status: "api_configured_live_untested" } });
      expect(JSON.stringify(result)).not.toContain("Jane Doe");
      expect(JSON.stringify(result)).not.toContain("jane.doe@example.edu");
    }

    const health = await morrow.client.callTool({ name: HEALTH_TOOL, arguments: {} });
    expect(health.isError, JSON.stringify(health)).not.toBe(true);
    expect(structured(health)).toMatchObject({ data: { schema: "morrow.blackboard.health.v1", tenantCount: 1 } });

    // The record of the changes Morrow could not confirm answers here too, so a
    // person can find out what needs looking at without an approved operation.
    const unresolved = await morrow.client.callTool({ name: UNRESOLVED_EFFECTS_TOOL, arguments: {} });
    expect(unresolved.isError, JSON.stringify(unresolved)).not.toBe(true);
    expect(structured(unresolved)).toMatchObject({
      data: { schema: "morrow.blackboard.unresolved-effects.v1", ok: true, count: 0, effects: [] },
    });
  }, 60_000);

  it("reaches every Blackboard read through morrow_capability_read in the shipped compact surface", async () => {
    const morrow = await harness({ profile: "private-full", toolSurface: "compact" });
    const names = await morrow.listToolNames();
    expect(names).toContain("morrow_capability_read");
    expect(names).toContain("morrow_capability_change");
    // The desktop app ships this surface, so no catalog tool is registered by name.
    for (const tool of [...PUBLIC_BLACKBOARD_TOOLS, ...PRIVATE_BLACKBOARD_TOOLS]) expect(names).not.toContain(tool);

    const search = structured(await morrow.client.callTool({
      name: "morrow_catalog_search",
      arguments: { source: "blackboard-rest", limit: 100 },
    }));
    const found = Array.isArray(search.tools)
      ? search.tools.map((tool) => (isJsonObject(tool) ? tool.publicName : undefined))
      : [];
    expect([...found].sort()).toEqual([...PUBLIC_BLACKBOARD_TOOLS].sort());
    expect(search).toMatchObject({ totalMatches: PUBLIC_BLACKBOARD_TOOLS.length });

    for (const name of BLACKBOARD_READ_TOOLS) {
      // morrow_catalog_search returns a bounded projection without the
      // descriptor, so the evidence label is read where the server
      // instructions send an assistant next: morrow_capability_get.
      const capability = await morrow.capabilityGet(name);
      expect(capability, name).toMatchObject({
        schema: "morrow.capability-get.v1",
        profile: "private-full",
        descriptor: {
          canonicalName: name,
          provider: "blackboard",
          route: { backend: "lms-api" },
          behavior: { readOnly: true, mutating: false },
          evidence: { live: { state: "unknown", reason: "api_configured_live_untested" } },
          profiles: {
            "private-full": { state: "supported" },
            "public-canvas": { state: "profile_limited" },
            sandbox: { state: "profile_limited" },
            "read-only": { state: "supported" },
          },
        },
      });

      const required = requiredInput(isJsonObject(capability.descriptor) ? capability.descriptor : {});
      if (required.includes("learner_reference")) {
        await expectLearnerReferenceRead(
          name,
          (tool, args) => morrow.client.callTool({ name: "morrow_capability_read", arguments: { name: tool, arguments: args } }),
          morrow.scope,
        );
        continue;
      }
      const read = await morrow.client.callTool({
        name: "morrow_capability_read",
        arguments: {
          name,
          arguments: {
            ...morrow.scope,
            ...(required.includes("content_id") ? { content_id: contentIdFor(name) } : {}),
            ...(required.includes("attachment_id") ? { attachment_id: "att-1" } : {}),
            ...(required.includes("column_id") ? { column_id: COLUMN_ID } : {}),
            ...(required.includes("attempt_id") ? { attempt_id: ATTEMPT_ID } : {}),
            ...(required.includes("announcement_id") ? { announcement_id: ANNOUNCEMENT_ID } : {}),
          ...(required.includes("group_id") ? { group_id: GROUP_ID } : {}),
          },
        },
      });
      expect(read.isError, `${name}: ${JSON.stringify(read)}`).not.toBe(true);
      expect(structured(read)).toMatchObject({ schema: "morrow.result.v1", tool: name, data: { ok: true, status: "api_configured_live_untested" } });
      expect(JSON.stringify(read)).not.toContain("Jane Doe");
    }

    // The configuration check is reachable the same way. It is published with
    // no source capability metadata, so the merged catalog gives it a defaulted
    // descriptor rather than a Blackboard one; only its reachability is claimed
    // here.
    const health = await morrow.client.callTool({ name: "morrow_capability_read", arguments: { name: HEALTH_TOOL, arguments: {} } });
    expect(health.isError, JSON.stringify(health)).not.toBe(true);
    expect(structured(health)).toMatchObject({ data: { schema: "morrow.blackboard.health.v1" } });

    // No private dispatch route is discoverable or callable through either
    // capability wrapper, in either mode.
    for (const name of PRIVATE_BLACKBOARD_TOOLS) {
      expect(await morrow.capabilityGet(name)).toMatchObject({ schema: "morrow.problem.v1", code: "capability_not_found" });
      for (const wrapper of ["morrow_capability_read", "morrow_capability_change"]) {
        // Named with no course connection, so the refusal reports the reason
        // the name was refused. A request that names one meets the learner
        // privacy boundary first and reports that instead.
        const refused = await morrow.client.callTool({ name: wrapper, arguments: { name, arguments: {} } });
        expect(refused.isError, `${wrapper} ${name}: ${JSON.stringify(refused)}`).toBe(true);
        expect(problemCode(refused), `${wrapper} ${name}`).toBe("capability_not_found");

        const bound = await morrow.client.callTool({
          name: wrapper,
          arguments: { name, arguments: { ...morrow.scope, content_id: DOCUMENT_ID, patch: { title: "Reviewed title" } } },
        });
        expect(bound.isError, `${wrapper} ${name}: ${JSON.stringify(bound)}`).toBe(true);
      }
    }
    expect(morrow.requests().filter((entry) => entry.startsWith("PATCH "))).toEqual([]);
  }, 60_000);

  it("admits Blackboard reads and refuses the Blackboard write in the read-only profile", async () => {
    const morrow = await harness({ profile: "read-only", toolSurface: "compact" });
    const patch = { ...morrow.scope, content_id: DOCUMENT_ID, patch: { title: "Reviewed title" } };

    const read = await morrow.client.callTool({
      name: "morrow_capability_read",
      arguments: { name: "blackboard_read_course", arguments: morrow.scope },
    });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(JSON.stringify(read)).toContain("Biology");

    // The one Blackboard route that sends a change is not in this profile's
    // catalog at all, so it cannot be invoked and cannot be frozen into a plan.
    expect(morrow.runtime.gateway.catalog.tools.map((tool) => tool.upstreamName))
      .not.toContain("blackboard_apply_reviewed_content_patch");
    expect(morrow.runtime.gateway.catalog.excluded).toContainEqual({
      upstreamId: "blackboard-rest",
      upstreamName: "blackboard_apply_reviewed_content_patch",
      reason: "profile_unavailable",
      detail: "This action requires an approved Morrow effect.",
    });

    const change = await morrow.client.callTool({
      name: "morrow_capability_change",
      arguments: { name: "blackboard_apply_reviewed_content_patch", arguments: {} },
    });
    expect(change.isError).toBe(true);
    expect(problemCode(change)).toBe("capability_not_found");
    expect((await morrow.client.callTool({
      name: "morrow_capability_change",
      arguments: { name: "blackboard_apply_reviewed_content_patch", arguments: patch },
    })).isError).toBe(true);

    const planned = await morrow.client.callTool({ name: "morrow_plan_blackboard_content_patch", arguments: patch });
    expect(planned.isError, JSON.stringify(planned)).toBe(true);
    expect(problemCode(planned)).toBe("operation_plan_invalid");
    expect(morrow.runtime.gateway.effectHealth()).toMatchObject({ recentOperationCount: 0 });
    expect(morrow.requests().filter((entry) => entry.startsWith("PATCH "))).toEqual([]);
  }, 60_000);

  it("plans the same Blackboard write in the private-full profile, which is what the read-only refusal is measured against", async () => {
    const morrow = await harness({ profile: "private-full", toolSurface: "compact" });
    const planned = await morrow.client.callTool({
      name: "morrow_plan_blackboard_content_patch",
      arguments: { ...morrow.scope, content_id: DOCUMENT_ID, patch: { title: "Reviewed title" } },
    });
    expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
    expect(structured(planned)).toMatchObject({ effectState: "awaiting_approval" });
    // Planning freezes the reviewed change. It sends no Blackboard change.
    expect(morrow.requests().filter((entry) => entry.startsWith("PATCH "))).toEqual([]);
  }, 60_000);

  it("accepts a source-redacted learner reference and refuses a learner identity from the same source", () => {
    // The projection every Blackboard result passes on its way out of the
    // source. The Blackboard source states that it returns learner tokens and
    // no learner identity; this is where Morrow holds it to that.
    const descriptor: OutputPrivacyDescriptor = {
      allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "learner", maxRecords: 10_000,
      maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
    };
    const referenced = projectOutput({
      content: [{ type: "text", text: "Two people are enrolled." }],
      structuredContent: { schema: "morrow.blackboard.roster-summary.v1", learners: [{ learnerToken: "lt_1", courseRoleId: "Student" }] },
    }, { descriptor, learnerBoundary: "source" });
    expect(referenced).toMatchObject({ structuredContent: { learners: [{ learnerToken: "lt_1", courseRoleId: "Student" }] } });

    const leaked = projectOutput({
      content: [{ type: "text", text: "One person is enrolled." }],
      structuredContent: {
        schema: "morrow.blackboard.roster-summary.v1",
        learners: [{ id: "_44_1", name: "Jane Doe", email: "jane.doe@example.edu" }],
      },
    }, { descriptor, learnerBoundary: "source" });
    expect(leaked).toMatchObject({ isError: true, structuredContent: { code: "privacy_source_learner_identity_refused" } });
    expect(JSON.stringify(leaked)).not.toContain("Jane Doe");
  });

  it("refuses a Blackboard source outright in the sandbox and public-canvas profiles", async () => {
    const fixture = await createFixture();
    dispose = () => fixture.close();
    const root = resolve("../..");

    // The synthetic estate takes no live provider source, so a Blackboard
    // tenant never reaches a sandbox catalog.
    expect(() => parseGatewayConfig(configuration(root, fixture, { profile: "sandbox", toolSurface: "compact" })))
      .toThrow(/sandbox profile accepts only the local synthetic sandbox upstream/);

    // The public profile requires a verified source attestation for every
    // upstream, which this local REST source does not carry.
    expect(() => parseGatewayConfig(configuration(root, fixture, { profile: "public-canvas", toolSurface: "compact" })))
      .toThrow(/requires a configured source attestation/);
  }, 30_000);
});
