import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../../blackboard-learn-api/src/binding.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { BLACKBOARD_ACTIONS } from "../src/blackboard-actions.js";

const COURSE_ID = "_22_1";
const CONTENT_ID = "_33_1";
const PRINCIPAL_ID = "_11_1";
const COPY_DESTINATION_ID = "BIO-101-COPY";
const COPIED_COURSE_ID = "_23_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function operationId(value: unknown): string {
  if (!isJsonObject(value) || !isJsonObject(value.structuredContent) || typeof value.structuredContent.operationId !== "string") {
    throw new Error("Blackboard plan did not produce an operation id");
  }
  return value.structuredContent.operationId;
}

function sourceBindingId(baseUrl: string): string {
  return deriveBlackboardSourceBindingId(baseUrl, PRINCIPAL_ID, COURSE_ID);
}

function expectedSourcePlanDigest(runtime: MorrowRuntime, operation: string): string {
  const record = runtime.gateway.operationGet(operation);
  const plan = isJsonObject(record.plan) ? record.plan : null;
  const argumentsValue = plan && isJsonObject(plan.arguments) ? plan.arguments : null;
  if (!argumentsValue || typeof argumentsValue.expected_plan_digest !== "string") {
    throw new Error("Blackboard operation did not retain its reviewed source plan digest");
  }
  return argumentsValue.expected_plan_digest;
}

function returnedEffectScope(value: JsonObject): JsonObject {
  const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  if (!structured || !isJsonObject(structured.effect_scope)) {
    throw new Error("Blackboard source did not return its effect binding scope");
  }
  return structured.effect_scope;
}

/** The Blackboard connection a plan was reviewed under, as the dispatch route requires it. */
function reviewedConnection(scope: JsonObject): JsonObject {
  return { principal_fingerprint: scope.principalFingerprint, session_generation: scope.sessionGeneration };
}

function returnedPlanDigest(value: JsonObject): string {
  const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  if (!structured || typeof structured.planDigest !== "string") {
    throw new Error("Blackboard source did not return its content plan digest");
  }
  return structured.planDigest;
}

async function createFixture(): Promise<{
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly counts: () => { readonly patch: number; readonly requests: readonly string[] };
  readonly close: () => Promise<void>;
}> {
  // Real home, not the OS temp dir: the spawned blackboard-learn-api
  // process's config-privacy check walks every real ancestor to filesystem
  // root, which fails under Linux's world-writable /tmp.
  const directory = await mkdtemp(join(homedir(), ".morrow-blackboard-gateway-test-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  const requests: string[] = [];
  let patch = 0;
  const announcements = new Map<string, JsonObject>();
  const attachments = new Map<string, JsonObject>();
  let uploadedBytes = 0;
  let copyTaskReads = 0;
  let copyStarted = false;
  let learnerMembership: JsonObject = {
    id: "_membership_2", courseId: COURSE_ID, userId: "_44_1", courseRoleId: "Student", availability: { available: "Yes" },
  };
  let content: JsonObject = {
    id: CONTENT_ID,
    courseId: COURSE_ID,
    contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome Jane Doe",
    description: "Jane Doe uses jane@example.edu",
    availability: { available: "Yes" },
  };
  const server = createServer({ key, cert: certificate }, async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "https://fixture.invalid").pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from("app-key:client-secret").toString("base64")}`);
      json(response, { access_token: "temporary-token", expires_in: 3600 });
      return;
    }
    expect(request.headers.authorization).toBe("Bearer temporary-token");
    const announcementsPath = `/learn/api/public/v1/courses/${COURSE_ID}/announcements`;
    if (pathname === announcementsPath) {
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const record = { ...JSON.parse(body), id: "_91_1", created: "2026-09-07T12:00:00.000Z" };
        announcements.set(record.id, record);
        json(response, record, 201);
      } else json(response, { results: [...announcements.values()], paging: {} });
      return;
    }
    if (pathname === `${announcementsPath}/_91_1`) { json(response, announcements.get("_91_1")); return; }
    if (pathname === "/learn/api/public/v1/uploads" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf(Buffer.from("\r\n\r\n"));
      const closing = raw.lastIndexOf(Buffer.from("\r\n--"));
      expect(separator).toBeGreaterThan(0);
      expect(closing).toBeGreaterThan(separator);
      expect(raw.subarray(separator + 4, closing).toString()).toBe("Reviewed file bytes.");
      uploadedBytes = closing - separator - 4;
      json(response, { id: "upload-1" }, 201);
      return;
    }
    const attachmentsPath = `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}/attachments`;
    if (pathname === attachmentsPath) {
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const payload = JSON.parse(body);
        expect(payload.uploadId).toBe("upload-1");
        const record = { id: "att-1", fileName: payload.fileName, mimeType: "text/plain", size: uploadedBytes };
        attachments.set(record.id, record);
        json(response, record, 201);
      } else json(response, { results: [...attachments.values()], paging: {} });
      return;
    }
    if (pathname === `${attachmentsPath}/att-1`) { json(response, attachments.get("att-1")); return; }
    if (pathname === "/learn/api/public/v1/users/me") {
      json(response, { id: PRINCIPAL_ID });
      return;
    }
    if (pathname === `/learn/api/public/v1/users/${PRINCIPAL_ID}`) {
      json(response, { id: PRINCIPAL_ID });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/users/${PRINCIPAL_ID}`) {
      json(response, { id: "_membership_1", courseId: COURSE_ID, userId: PRINCIPAL_ID });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/users/_44_1`) {
      if (request.method === "PATCH") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        learnerMembership = { ...learnerMembership, ...JSON.parse(body) };
      }
      json(response, learnerMembership);
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/users`) {
      json(response, {
        results: [{
          id: "_membership_2", courseId: COURSE_ID, userId: "_44_1", courseRoleId: "Student",
          availability: { available: "Yes" },
          user: { id: "_44_1", name: { given: "Jane", family: "Doe" }, contact: { email: "jane@example.edu" } },
        }],
        paging: {},
      });
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${COURSE_ID}`) {
      json(response, { id: COURSE_ID, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (pathname === `/learn/api/public/v2/courses/${COURSE_ID}/copy` && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      expect(JSON.parse(body)).toEqual({ targetCourse: { courseId: COPY_DESTINATION_ID } });
      copyStarted = true;
      response.writeHead(202, { location: `/learn/api/public/v1/courses/${COURSE_ID}/tasks/_99_1` });
      response.end();
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/tasks/_99_1`) {
      copyTaskReads += 1;
      if (copyTaskReads < 3) json(response, { status: "Running" });
      else {
        response.writeHead(303, { location: `/learn/api/public/v3/courses/${COPIED_COURSE_ID}` });
        response.end();
      }
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${COPIED_COURSE_ID}`
      || pathname === `/learn/api/public/v3/courses/externalId%3A${COPY_DESTINATION_ID}`) {
      if (!copyStarted) { json(response, { message: "not found" }, 404); return; }
      json(response, {
        id: COPIED_COURSE_ID,
        courseId: COPY_DESTINATION_ID,
        name: "Biology",
        ultraStatus: "Ultra",
        closedComplete: false,
      });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "GET") {
      json(response, content);
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "PATCH") {
      patch += 1;
      let body = "";
      for await (const chunk of request) body += String(chunk);
      content = { ...content, ...(JSON.parse(body) as JsonObject) };
      json(response, content);
      return;
    }
    json(response, { message: "not found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Blackboard fixture has no TCP address");
  const baseUrl = `https://127.0.0.1:${address.port}`;
  const home = join(directory, "home");
  const credentialDirectory = join(home, ".morrow", "credentials", "blackboard");
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
    counts: () => ({ patch, requests }),
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function configuration(
  root: string,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  source: { readonly entry?: string; readonly env?: Readonly<Record<string, string>> } = {},
) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "blackboard-rest",
      label: "Blackboard Learn REST fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [source.entry || join(root, "packages/blackboard-learn-api/dist/index.js")],
      cwd: root,
      env: {
        HOME: join(fixture.directory, "home"),
        MORROW_BLACKBOARD_CONFIG: fixture.configPath,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        ...source.env,
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
    operationJournal: { path: ":memory:" },
  });
}

describe("Blackboard API Gateway effect integration", () => {
  it("exposes the existing action plans and dispatches approved announcements and workspace files once", async () => {
    const fixture = await createFixture();
    let runtime: MorrowRuntime | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    try {
      runtime = await MorrowRuntime.connect(configuration(resolve("../.."), fixture), { statePath: join(fixture.directory, "actions.sqlite3") });
      const [left, right] = InMemoryTransport.createLinkedPair();
      const workspaceRoot = await realpath(fixture.directory);
      server = serveStdio(() => createFullMorrowServer(runtime!, { workspaceRoot }), { transport: right });
      client = new Client({ name: "morrow-blackboard-actions", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(left);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(BLACKBOARD_ACTIONS).toHaveLength(14);
      for (const action of BLACKBOARD_ACTIONS) {
        expect(names).toContain(action.publicName);
        expect(names).not.toContain(action.apply.name);
      }
      const scope = { tenant_id: "fixture", source_binding_id: sourceBindingId(fixture.baseUrl), course_id: COURSE_ID };
      await writeFile(join(fixture.directory, "handout.txt"), "Reviewed file bytes.");
      for (const [name, args, writePath] of [
        ["morrow_plan_blackboard_course_announcement", { ...scope, title: "Course update", body: "The lab opens on Monday.", duration_type: "Continuous", show_at_top_of_course: false }, `/learn/api/public/v1/courses/${COURSE_ID}/announcements`],
        ["morrow_plan_blackboard_content_attachment", { ...scope, content_id: CONTENT_ID, file_path: "handout.txt", content_type: "text/plain" }, `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}/attachments`],
      ] as const) {
        const planned = await client.callTool({ name, arguments: args });
        expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
        const id = operationId(planned);
        expect(JSON.stringify(runtime.gateway.operationGet(id))).not.toContain("Reviewed file bytes.");
        expect((await runtime.gateway.dispatchOperation(id)).isError).toBe(true);
        expect(fixture.counts().requests.filter((entry) => entry === `POST ${writePath}`)).toHaveLength(0);
        runtime.gateway.approveOperation(id);
        const dispatched = await runtime.gateway.dispatchOperation(id);
        expect(dispatched.isError, JSON.stringify(dispatched)).not.toBe(true);
        expect(dispatched.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
        expect((await runtime.gateway.dispatchOperation(id)).isError).toBe(true);
        expect(runtime.gateway.operationGet(id)).toMatchObject({ state: "verified" });
        expect(fixture.counts().requests.filter((entry) => entry === `POST ${writePath}`)).toHaveLength(1);
      }
      await writeFile(join(fixture.directory, "next-handout.txt"), "Reviewed file bytes.");
      const lostFile = await client.callTool({ name: "morrow_plan_blackboard_content_attachment", arguments: {
        ...scope, content_id: CONTENT_ID, file_path: "next-handout.txt", content_type: "text/plain",
      } });
      expect(lostFile.isError, JSON.stringify(lostFile)).not.toBe(true);
      const lostId = operationId(lostFile);
      runtime.gateway.approveOperation(lostId);
      const roster = await runtime.gateway.callSourceOwned("blackboard_course_roster_summary", scope);
      const learners = isJsonObject(roster.structuredContent) ? roster.structuredContent.learners : null;
      const learner = Array.isArray(learners) ? learners[0] : null;
      expect(learner).toMatchObject({ learnerToken: expect.stringMatching(/^Student A[1-9][0-9]*$/) });
      const membership = await client.callTool({ name: "morrow_plan_blackboard_membership_patch", arguments: {
        ...scope, learner_reference: isJsonObject(learner) ? learner.learnerToken : "", patch: { courseRoleId: "Grader" },
      } });
      expect(membership.isError, JSON.stringify(membership)).not.toBe(true);
      const membershipId = operationId(membership);
      runtime.gateway.approveOperation(membershipId);
      const isWrite = (entry: string) => entry.startsWith("POST ") && !entry.endsWith("/oauth2/token");
      const priorWrites = fixture.counts().requests.filter(isWrite).length;
      await client.close();
      await server.close();
      await runtime.close();
      runtime = await MorrowRuntime.connect(configuration(resolve("../.."), fixture), { statePath: join(fixture.directory, "actions.sqlite3") });
      expect((await runtime.gateway.dispatchOperation(lostId)).isError).toBe(true);
      expect(runtime.gateway.operationGet(lostId)).toMatchObject({ state: "cancelled", dispatchAttempt: 0 });
      expect(fixture.counts().requests.filter(isWrite)).toHaveLength(priorWrites);
      const changedMembership = await runtime.gateway.dispatchOperation(membershipId);
      expect(changedMembership.isError, JSON.stringify(changedMembership)).not.toBe(true);
      expect(changedMembership.structuredContent).toMatchObject({ effectState: "verified" });
      expect(fixture.counts().requests.filter((entry) => entry === `PATCH /learn/api/public/v1/courses/${COURSE_ID}/users/_44_1`)).toHaveLength(1);
      const vault = await readFile(join(fixture.directory, "home", ".morrow", "blackboard-learners.json"), "utf8");
      expect(vault).not.toContain("Jane");
      expect(vault).not.toContain("_44_1");
    } finally {
      await client?.close();
      await server?.close();
      await runtime?.close();
      await fixture.close();
    }
  }, 40_000);

  it("retains one asynchronous course-copy task and verifies it without resending", async () => {
    const fixture = await createFixture();
    let runtime: MorrowRuntime | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    try {
      runtime = await MorrowRuntime.connect(configuration(resolve("../.."), fixture), { statePath: join(fixture.directory, "course-copy.sqlite3") });
      const [left, right] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(runtime!), { transport: right });
      client = new Client({ name: "morrow-blackboard-copy", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(left);
      const scope = { tenant_id: "fixture", source_binding_id: sourceBindingId(fixture.baseUrl), course_id: COURSE_ID };
      const planned = await client.callTool({
        name: "morrow_plan_blackboard_course_copy",
        arguments: { ...scope, destination_course_id: COPY_DESTINATION_ID },
      });
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const id = operationId(planned);
      runtime.gateway.approveOperation(id);
      const dispatched = await runtime.gateway.dispatchOperation(id);
      expect(dispatched.isError, JSON.stringify(dispatched)).not.toBe(true);
      expect(dispatched.structuredContent).toMatchObject({ effectState: "awaiting_verification" });
      expect(runtime.gateway.operationGet(id)).toMatchObject({
        state: "awaiting_verification",
        sourceTaskId: expect.stringMatching(/^bbcopy:[A-Za-z0-9_-]+$/),
      });
      expect(fixture.counts().requests.filter((entry) => entry === `POST /learn/api/public/v2/courses/${COURSE_ID}/copy`)).toHaveLength(1);

      const verified = await runtime.gateway.reconcileOperation(id);
      expect(verified.isError, JSON.stringify(verified)).not.toBe(true);
      expect(verified.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(runtime.gateway.operationGet(id)).toMatchObject({ state: "verified", verificationStatus: "verified" });
      expect(fixture.counts().requests.filter((entry) => entry === `POST /learn/api/public/v2/courses/${COURSE_ID}/copy`)).toHaveLength(1);
    } finally {
      await client?.close();
      await server?.close();
      await runtime?.close();
      await fixture.close();
    }
  }, 40_000);

  it("keeps source dispatch private and sends one approved reviewed PATCH through the durable Gateway effect", async () => {
    const fixture = await createFixture();
    const root = resolve("../..");
    let runtime: MorrowRuntime | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    try {
      runtime = await MorrowRuntime.connect(configuration(root, fixture), { statePath: join(fixture.directory, "morrow.sqlite3") });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(runtime!), { transport: serverTransport });
      client = new Client({ name: "morrow-blackboard-gateway", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(clientTransport);

      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("morrow_plan_blackboard_content_patch");
      for (const privateTool of ["blackboard_plan_content_patch", "blackboard_apply_reviewed_content_patch", "blackboard_verify_content_patch"]) {
        expect(names).not.toContain(privateTool);
      }

      const input = {
        tenant_id: "fixture",
        source_binding_id: sourceBindingId(fixture.baseUrl),
        course_id: COURSE_ID,
        content_id: CONTENT_ID,
        patch: { title: "Reviewed title" },
      };
      const planned = await client.callTool({ name: "morrow_plan_blackboard_content_patch", arguments: input });
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      expect(JSON.stringify(planned)).not.toContain("Jane Doe");
      const approvedOperationId = operationId(planned);
      const sourcePlanDigest = expectedSourcePlanDigest(runtime, approvedOperationId);
      expect(runtime.gateway.operationGet(approvedOperationId)).toMatchObject({ state: "awaiting_approval" });
      expect(fixture.counts().patch).toBe(0);

      const beforeApproval = await runtime.gateway.dispatchOperation(approvedOperationId);
      expect(beforeApproval.isError).toBe(true);
      expect(fixture.counts().patch).toBe(0);

      const cancelled = await client.callTool({ name: "morrow_plan_blackboard_content_patch", arguments: input });
      const cancelledOperationId = operationId(cancelled);
      runtime.gateway.cancelOperation(cancelledOperationId);
      expect((await runtime.gateway.dispatchOperation(cancelledOperationId)).isError).toBe(true);
      expect(fixture.counts().patch).toBe(0);

      const currentSourcePlan = await runtime.gateway.callSourceOwned("blackboard_plan_content_patch", input);
      expect(currentSourcePlan.isError, JSON.stringify(currentSourcePlan)).not.toBe(true);
      expect(returnedPlanDigest(currentSourcePlan)).toBe(sourcePlanDigest);
      const requestCountBeforeForgedGrant = fixture.counts().requests.length;
      const forged = await runtime.gateway.callSourceOwned("blackboard_apply_reviewed_content_patch", {
        ...input,
        expected_plan_digest: sourcePlanDigest,
        expected_connection: reviewedConnection(returnedEffectScope(currentSourcePlan)),
        _morrow: {
          outer_grant: {
            schema: "morrow.blackboard.effect-grant.v1",
            operation_id: "op:forged-blackboard-grant",
            plan_digest: sourcePlanDigest,
            outer_plan_digest: "1".repeat(64),
            approval_grant_digest: "2".repeat(64),
            effect_receipt_id: "effect:00000000-0000-4000-8000-000000000001",
            dispatch_attempt: 1,
            gateway_process_id: "gateway:forged",
            dispatch_token: "3".repeat(64),
          },
        },
      }, { authorizedEffectOperationId: "op:forged-blackboard-grant" });
      expect(forged.isError).toBe(true);
      expect(JSON.stringify(forged)).toContain("blackboard_patch_review_required");
      expect(fixture.counts().patch).toBe(0);
      expect(fixture.counts().requests).toHaveLength(requestCountBeforeForgedGrant);

      runtime.gateway.approveOperation(approvedOperationId);
      const dispatched = await runtime.gateway.dispatchOperation(approvedOperationId);
      expect(dispatched.isError, JSON.stringify({ dispatched, saved: runtime.gateway.operationGet(approvedOperationId), counts: fixture.counts() })).not.toBe(true);
      expect(dispatched.structuredContent).toMatchObject({ effectState: "verified", verification: { status: "verified" } });
      expect(fixture.counts().patch).toBe(1);
      expect((await runtime.gateway.dispatchOperation(approvedOperationId)).isError).toBe(true);
      expect(fixture.counts().patch).toBe(1);

      const saved = runtime.gateway.operationGet(approvedOperationId);
      // The connection the instructor approved is frozen in the durable record,
      // and it is a counted session rather than the constant this build replaced.
      expect(isJsonObject(saved.plan) && isJsonObject(saved.plan.arguments) ? saved.plan.arguments.expected_connection : null)
        .toMatchObject({ session_generation: 1, principal_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const savedText = JSON.stringify(saved);
      expect(savedText).not.toContain("dispatch_token");
      expect(savedText).not.toContain("client-secret");

      // The source kept that session in the app-private state directory, as one
      // private file of digests, so the next start counts from the same place.
      const recordPath = join(fixture.directory, "home", ".morrow", "blackboard-sessions.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as JsonObject;
      expect(record).toMatchObject({
        schema: "morrow.blackboard-learn.sessions.v1",
        sessions: [{ generation: 1 }],
      });
      const recordText = JSON.stringify(record);
      for (const value of ["client-secret", "app-key", PRINCIPAL_ID, fixture.baseUrl]) {
        expect(recordText).not.toContain(value);
      }
      expect((await stat(recordPath)).mode & 0o077).toBe(0);
      expect(fixture.counts().requests.filter((entry) => entry.startsWith("PATCH "))).toEqual([
        `PATCH /learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}`,
      ]);
    } finally {
      await client?.close();
      await server?.close();
      await runtime?.close();
      await fixture.close();
    }
  }, 30_000);

  it("refuses a Blackboard source that reports no counted session, and freezes one that does", async () => {
    const fixture = await createFixture();
    const root = resolve("../..");
    const entry = fileURLToPath(new URL("./fixtures/blackboard-constant-session-source.mjs", import.meta.url));
    const input = {
      tenant_id: "fixture",
      source_binding_id: sourceBindingId(fixture.baseUrl),
      course_id: COURSE_ID,
      content_id: CONTENT_ID,
      patch: { title: "Reviewed title" },
    };
    let refusing: MorrowRuntime | undefined;
    let counting: MorrowRuntime | undefined;
    try {
      refusing = await MorrowRuntime.connect(
        configuration(root, fixture, { entry, env: { FAKE_BLACKBOARD_SESSION_GENERATION: "0" } }),
        { statePath: join(fixture.directory, "generation-zero.sqlite3") },
      );
      const refused = await refusing.gateway.planBlackboardContentPatch(input);
      expect(refused.isError).toBe(true);
      expect(isJsonObject(refused.structuredContent) ? refused.structuredContent.data : null).toMatchObject({
        code: "operation_plan_invalid",
        // The one refusal this test is about, named exactly.
        detailDigest: sha256Text("Error:Blackboard did not return the exact selected effect scope."),
      });
      expect(refusing.gateway.operationList(10)).toMatchObject({ returned: 0 });
      expect(fixture.counts().patch).toBe(0);

      // The same source, reporting a counted session, is planned and frozen.
      counting = await MorrowRuntime.connect(
        configuration(root, fixture, { entry, env: { FAKE_BLACKBOARD_SESSION_GENERATION: "1" } }),
        { statePath: join(fixture.directory, "generation-one.sqlite3") },
      );
      const planned = await counting.gateway.planBlackboardContentPatch(input);
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const saved = counting.gateway.operationGet(operationId(planned));
      expect(isJsonObject(saved.plan) && isJsonObject(saved.plan.arguments) ? saved.plan.arguments.expected_connection : null)
        .toMatchObject({ session_generation: 1, principal_fingerprint: "d".repeat(64) });
      expect(fixture.counts().patch).toBe(0);
    } finally {
      await refusing?.close();
      await counting?.close();
      await fixture.close();
    }
  }, 30_000);
});
