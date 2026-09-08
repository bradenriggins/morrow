import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../../blackboard-learn-api/src/binding.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { createMorrowServer } from "../src/server.js";
import type { GatewayRuntime } from "../src/runtime.js";

const TENANT_ID = "fixture";
const COURSE_ID = "_22_1";
const CONTENT_ID = "_33_1";
const PRINCIPAL_ID = "_11_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const SOURCE_BINDING_ID = `blackboard:${"a".repeat(64)}`;
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));

/** One positive case for each of the four signals this audit is required to report. */
const signalHtml = [
  "<h1>Week 1</h1>",
  "<h3>Reading</h3>",
  "<img src=\"diagram.png\">",
  "<table><tr><td>Monday</td></tr></table>",
  "<video src=\"lecture.mp4\"></video>",
].join("");

const auditArgs = {
  provider: "blackboard" as const,
  tenant_id: TENANT_ID,
  source_binding_id: SOURCE_BINDING_ID,
  course_id: COURSE_ID,
  target: { kind: "content_item" as const, item_id: CONTENT_ID },
};

const catalogInputSchema: JsonObject = {
  type: "object",
  properties: { tenant_id: { type: "string" }, source_binding_id: { type: "string" }, course_id: { type: "string" }, content_id: { type: "string" } },
  required: ["tenant_id", "source_binding_id", "course_id"],
  additionalProperties: false,
};

function blackboardCapability(name: string): JsonObject {
  return {
    provider: "blackboard",
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    sourceImplementations: [{
      system: "morrow-fixture", toolName: name, sourceExport: `operation:${name}`,
      sourcePath: "fixtures/blackboard-catalog.json", sourceDigest: "b".repeat(64),
    }],
  };
}

/**
 * A Blackboard REST source that answers the two reads this audit makes, plus
 * the private plan route the remediation candidate is observed from. `source:
 * false` is the installation with no configured tenant.
 */
function fixture(options: {
  readonly content?: JsonObject;
  readonly source?: boolean;
  readonly contentRead?: boolean;
  readonly refusal?: string;
} = {}) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  const present = options.source !== false;
  const readTools = present
    ? (options.contentRead === false ? ["blackboard_read_course"] : ["blackboard_read_course", "blackboard_read_course_content"])
    : [];
  const content = options.content ?? {
    id: CONTENT_ID, title: "Week 1 overview", description: signalHtml, availability: { available: "Yes" }, position: 1,
  };
  const runtime = {
    catalog: {
      tools: present
        ? [
          ...readTools.map((name) => ({
            publicName: name, upstreamName: name, upstreamId: "blackboard-rest", inputSchema: catalogInputSchema,
            annotations: { readOnlyHint: true }, capability: blackboardCapability(name),
          })),
          {
            publicName: "blackboard_plan_content_patch", upstreamName: "blackboard_plan_content_patch",
            upstreamId: "blackboard-rest", inputSchema: catalogInputSchema, annotations: { readOnlyHint: true },
            capability: blackboardCapability("blackboard_plan_content_patch"),
          },
        ]
        : [],
    },
    config: {
      upstreams: [{
        id: "blackboard-rest", outputPrivacy: {},
        outputPrivacyDefault: { fieldPolicy: "scrub-sensitive", freeText: "allow", aiClientAdmission: "allow" },
      }],
    },
    searchCatalog: ({ query }: { query: string }) => ({
      tools: readTools.filter((name) => name.includes(query)).map((name) => ({
        publicName: name, upstreamName: name, upstreamId: "blackboard-rest", annotations: { readOnlyHint: true },
      })),
    }),
    capabilityGet: (name: string) => ({ descriptor: blackboardCapability(name) }),
    callSourceOwned: async (name: string, argumentsValue: JsonObject) => {
      calls.push({ name, arguments: argumentsValue });
      if (options.refusal) {
        return {
          isError: true,
          content: [{ type: "text", text: "Morrow could not complete the Blackboard request." }],
          structuredContent: {
            schema: "morrow.blackboard.result.v1", ok: false, resultState: "not_sent",
            problem: { code: options.refusal, message: "The Blackboard source connection does not match this selected course." },
          },
        };
      }
      const scope = { tenantId: TENANT_ID, sourceBindingId: SOURCE_BINDING_ID, courseId: COURSE_ID };
      return {
        structuredContent: name === "blackboard_read_course"
          ? {
            schema: "morrow.blackboard.course.v1", ok: true, ...scope,
            course: { id: COURSE_ID, courseId: "BIO-101", name: "Biology" },
            status: "api_configured_live_untested", diagnostics: { providerRequests: 3 },
          }
          : {
            schema: "morrow.blackboard.content.v1", ok: true, ...scope, contentId: CONTENT_ID, content,
            status: "api_configured_live_untested", diagnostics: { providerRequests: 1 },
          },
      };
    },
  } as unknown as GatewayRuntime;
  return { runtime, calls };
}

async function withClient<T>(runtime: GatewayRuntime, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "blackboard-course-audit-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createMorrowServer(runtime), { transport: b });
  await client.connect(a);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function auditThrough(runtime: GatewayRuntime, args: unknown) {
  return await withClient(runtime, async (client) => await client.callTool({ name: "morrow_audit_course", arguments: args as JsonObject }));
}

/** The one sentence a text gives Blackboard, so an unrelated sentence cannot satisfy or fail this check. */
function blackboardSentence(text: string): string {
  const match = text.match(/Blackboard[^.]*\./);
  expect(match, "no Blackboard sentence").not.toBeNull();
  return match![0];
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

/** A local Blackboard Learn REST tenant: real HTTPS, real OAuth exchange, real reads. */
async function createTenant(): Promise<{
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-audit-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  const content: JsonObject = {
    id: CONTENT_ID,
    courseId: COURSE_ID,
    contentHandler: { id: "resource/x-bb-document" },
    title: "Week 1 overview",
    description: `${signalHtml}<p>Ask Jane Doe.</p>`,
    availability: { available: "Yes" },
    position: 1,
  };
  const server = createServer({ key, cert: certificate }, (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "https://fixture.invalid").pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: 3600 });
      return;
    }
    if (pathname === "/learn/api/public/v1/users/me" || pathname === `/learn/api/public/v1/users/${PRINCIPAL_ID}`) {
      json(response, { id: PRINCIPAL_ID });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/users/${PRINCIPAL_ID}`) {
      json(response, { id: "_membership_1", courseId: COURSE_ID, userId: PRINCIPAL_ID });
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
      json(response, { id: COURSE_ID, courseId: "BIO-101", name: "Biology" });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}`) {
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
  await writeFile(join(credentialDirectory, `${TENANT_ID}.secret`), JSON.stringify({
    schema: "morrow.blackboard-learn.credential.v1",
    credentialRevision: CREDENTIAL_REVISION,
    applicationSecret: "client-secret",
  }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({
    schema: "morrow.blackboard-learn.config.v1",
    tenants: [{
      id: TENANT_ID,
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
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function configuration(root: string, tenant: Awaited<ReturnType<typeof createTenant>>) {
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
      args: [join(root, "packages/blackboard-learn-api/dist/index.js")],
      cwd: root,
      env: {
        HOME: join(tenant.directory, "home"),
        MORROW_BLACKBOARD_CONFIG: tenant.configPath,
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
    operationJournal: { path: ":memory:" },
  });
}

describe("Blackboard course audit", () => {
  it("reports the source field digest, its signals, and the reviewed change route", async () => {
    const { runtime, calls } = fixture();
    const result = await auditThrough(runtime, auditArgs);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const report = result.structuredContent as JsonObject;
    expect(report).toMatchObject({
      schema: "morrow.course-audit.v1",
      provider: "blackboard",
      status: "evidence_ready",
      tenant_id: TENANT_ID,
      source_binding_id: SOURCE_BINDING_ID,
      source_evidence_state: "api_configured_live_untested",
      course: { id: COURSE_ID, name: "Biology" },
    });
    expect(report.target).toMatchObject({
      kind: "content_item", id: CONTENT_ID, title: "Week 1 overview",
      course_association: "observed_by_course_scoped_read",
      observation_scope: "exact_content_item_fields_only",
      source_fields: { title: "observed", body: "not_returned", description: "observed" },
    });
    const evidence = report.content_evidence as JsonObject;
    expect(evidence).toMatchObject({
      status: "observed", disposition: "untrusted_course_content", field: "description",
      content: signalHtml, sha256: sha256Text(signalHtml), character_count: signalHtml.length,
    });
    expect(evidence.observed_source_signals).toMatchObject({
      image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("diagram.png") }],
      heading_level_jumps: [{ heading_index: 2, from_level: 1, to_level: 3 }],
      tables_without_th: [1],
      embedded_media_tags: [1],
    });
    expect(report.additional_source_fields).toBeUndefined();
    expect(report.remediation).toMatchObject({
      status: "candidate_route_observed",
      planner: "morrow_plan_blackboard_content_patch",
      field: "description",
      supported_fields: ["title", "description", "availability.available"],
      readiness: "not_established_by_catalog",
    });
    expect(report.limits).toEqual(expect.arrayContaining([
      "Rendered learner-view accessibility checks need a Blackboard tenant and remain a manual check.",
      "Blackboard REST configuration is present, but no live Blackboard tenant behaviour is proven here.",
      "No edit, approval, Edit authority decision, or conformance decision occurs in this audit.",
    ]));
    expect(report.upstream_read_provenance).toEqual(expect.arrayContaining([expect.objectContaining({
      upstream_read_tool: "blackboard_read_course_content", operation_key: "operation:blackboard_read_course_content",
    })]));
    expect(calls).toEqual([
      { name: "blackboard_read_course", arguments: { tenant_id: TENANT_ID, source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID } },
      { name: "blackboard_read_course_content", arguments: { tenant_id: TENANT_ID, source_binding_id: SOURCE_BINDING_ID, course_id: COURSE_ID, content_id: CONTENT_ID } },
    ]);
  });

  it("audits a document body and states that the reviewed change route does not cover it", async () => {
    const description = "<p>Read the notes.</p><img src=\"cover.png\">";
    const { runtime } = fixture({ content: { id: CONTENT_ID, title: "Week 1 overview", body: signalHtml, description } });
    const report = (await auditThrough(runtime, auditArgs)).structuredContent as JsonObject;
    expect(report.status).toBe("evidence_ready");
    expect(report.content_evidence).toMatchObject({ status: "observed", field: "body", sha256: sha256Text(signalHtml) });
    expect(report.additional_source_fields).toEqual([expect.objectContaining({
      status: "observed", field: "description", sha256: sha256Text(description),
    })]);
    expect(((report.additional_source_fields as JsonObject[])[0]!.observed_source_signals as JsonObject).image_tags_without_alt)
      .toEqual([{ image_index: 1, image_src_sha256: sha256Text("cover.png") }]);
    expect(report.remediation).toMatchObject({
      status: "blocked_current_contract",
      planner: "morrow_plan_blackboard_content_patch",
      field: "body",
      reason: expect.stringContaining("no reviewed Original HTML or Ultra BbML contract"),
    });
  });

  it("reports a field the privacy boundary held back as not observed", async () => {
    const { runtime } = fixture({ content: { id: CONTENT_ID, title: "Week 1 overview", bodyWithheld: true } });
    const report = (await auditThrough(runtime, auditArgs)).structuredContent as JsonObject;
    expect(report.status).toBe("evidence_incomplete");
    expect(report.content_evidence).toMatchObject({
      status: "not_observed", field: "body",
      reason: expect.stringContaining("held back body at its privacy boundary"),
    });
    expect((report.target as JsonObject).source_fields).toMatchObject({ body: "withheld_by_privacy_boundary", description: "not_returned" });
    expect(report.remediation).toMatchObject({ status: "blocked_current_contract", field: "body" });
  });

  it("names the missing tenant configuration when no Blackboard source is configured", async () => {
    const { runtime, calls } = fixture({ source: false });
    const result = await auditThrough(runtime, auditArgs);
    expect(result.isError).not.toBe(true);
    const report = result.structuredContent as JsonObject;
    expect(report).toMatchObject({
      schema: "morrow.course-audit.v1", provider: "blackboard", status: "provider_unavailable",
      tenant_id: TENANT_ID, source_binding_id: SOURCE_BINDING_ID,
      course: { id: COURSE_ID },
      target: { kind: "content_item", id: CONTENT_ID, course_association: "not_established" },
      remediation: {
        status: "blocked_provider_connection_unavailable",
        reason: expect.stringContaining("no configured Blackboard Learn REST tenant"),
      },
    });
    expect(JSON.stringify(report)).not.toContain("browser");
    expect(calls).toEqual([]);
  });

  it("names the missing read instead of the tenant when a Blackboard source is configured", async () => {
    const { runtime, calls } = fixture({ contentRead: false });
    const report = (await auditThrough(runtime, auditArgs)).structuredContent as JsonObject;
    expect(report).toMatchObject({
      status: "provider_unavailable",
      remediation: {
        status: "blocked_provider_connection_unavailable",
        reason: "This Blackboard connection does not expose the course content read this audit needs.",
      },
    });
    expect(calls).toEqual([]);
  });

  it("refuses with the source's own reason when the Blackboard read is refused", async () => {
    const { runtime } = fixture({ refusal: "blackboard_scope_binding_mismatch" });
    const result = await auditThrough(runtime, auditArgs);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("blackboard_scope_binding_mismatch");
    expect(result.structuredContent).toMatchObject({ schema: "morrow.problem.v1", code: "course_audit_evidence_integrity" });
  });

  it("states the real Blackboard route in the instructions and the audit guidance an assistant reads", async () => {
    const { runtime } = fixture();
    await withClient(runtime, async (client) => {
      const instructions = blackboardSentence(client.getInstructions() ?? "");
      expect(instructions).toContain("configured Learn REST tenant");
      expect(instructions).toContain("untested");
      expect(instructions).not.toMatch(/browser|unavailable|blocked/);

      const guidance = await client.readResource({ uri: "morrow://guidance/course-audit-v1" });
      const text = guidance.contents.map((entry) => (typeof entry.text === "string" ? entry.text : "")).join("\n");
      // The private REST source is the shipped Blackboard route, so no guidance
      // sentence may tell an assistant to avoid it.
      expect(text).not.toContain("private REST fallback");
      const paragraph = text.split("\n").find((line) => line.startsWith("Blackboard Learn works through")) ?? "";
      expect(paragraph).toContain("official REST integration");
      expect(paragraph).toContain("provider_unavailable");
      expect(paragraph).toContain("morrow_plan_blackboard_content_patch");
      expect(paragraph).toContain("no live Blackboard tenant behaviour is proven");
      expect(paragraph).not.toContain("browser");
    });
  });

  it("audits one content item through a configured local Blackboard tenant", async () => {
    const tenant = await createTenant();
    const root = resolve("../..");
    let runtime: MorrowRuntime | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof serveStdio> | undefined;
    try {
      runtime = await MorrowRuntime.connect(configuration(root, tenant), { statePath: join(tenant.directory, "morrow.sqlite3") });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = serveStdio(() => createFullMorrowServer(runtime!), { transport: serverTransport });
      client = new Client({ name: "morrow-blackboard-audit", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "morrow_audit_course",
        arguments: { ...auditArgs, source_binding_id: deriveBlackboardSourceBindingId(tenant.baseUrl, PRINCIPAL_ID, COURSE_ID) },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const report = result.structuredContent as JsonObject;
      expect(report).toMatchObject({
        provider: "blackboard", status: "evidence_ready", source_evidence_state: "api_configured_live_untested",
        course: { id: COURSE_ID, name: "Biology" },
      });
      const evidence = report.content_evidence as JsonObject;
      expect(evidence).toMatchObject({ status: "observed", field: "description" });
      expect(evidence.observed_source_signals).toMatchObject({
        image_tags_without_alt: [{ image_index: 1, image_src_sha256: sha256Text("diagram.png") }],
        heading_level_jumps: [{ heading_index: 2, from_level: 1, to_level: 3 }],
        tables_without_th: [1],
        embedded_media_tags: [1],
      });
      expect(isJsonObject(evidence) && typeof evidence.content === "string" ? evidence.content : "").toContain("<h1>Week 1</h1>");
      expect(report.remediation).toMatchObject({ status: "candidate_route_observed", planner: "morrow_plan_blackboard_content_patch" });
      // The learner named in the audited description, and the roster this source
      // read to redact it, never reach the assistant.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("Jane Doe");
      expect(serialized).not.toContain("jane@example.edu");
      expect(serialized).not.toContain("client-secret");
    } finally {
      await client?.close();
      await server?.close();
      await runtime?.close();
      await tenant.close();
    }
  }, 30_000);
});
