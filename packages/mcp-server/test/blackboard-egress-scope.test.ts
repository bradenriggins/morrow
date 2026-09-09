import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type IncomingMessage, type ServerResponse } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../../blackboard-learn-api/src/binding.js";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const COURSE_ID = "_22_1";
const CONTENT_ID = "_33_1";
const MISSING_CONTENT_ID = "_44_1";
const PRINCIPAL_ID = "_11_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function availablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  const port = address.port;
  await new Promise<void>((closed) => server.close(() => closed()));
  return port;
}

async function createBlackboardFixture(): Promise<{
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly close: () => Promise<void>;
}> {
  // Real home, not the OS temp dir: the spawned blackboard-learn-api
  // process's config-privacy check walks every real ancestor to filesystem
  // root, which fails under Linux's world-writable /tmp.
  const directory = await mkdtemp(join(homedir(), ".morrow-blackboard-egress-scope-test-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  let content: JsonObject = {
    id: CONTENT_ID,
    courseId: COURSE_ID,
    contentHandler: { id: "resource/x-bb-document" },
    title: "Week one",
    availability: { available: "Yes" },
  };
  const server = createHttpsServer({ key, cert: certificate }, async (request: IncomingMessage, response: ServerResponse) => {
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
          id: "_membership_2", courseId: COURSE_ID, userId: "_55_1", courseRoleId: "Student",
          availability: { available: "Yes" },
          user: { id: "_55_1", name: { given: "Jane", family: "Doe" }, contact: { email: "jane@example.edu" } },
        }],
        paging: {},
      });
      return;
    }
    if (pathname === `/learn/api/public/v3/courses/${COURSE_ID}` || pathname === `/learn/api/public/v1/courses/${COURSE_ID}`) {
      json(response, { id: COURSE_ID, courseId: "BIO-101", name: "Biology", ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "GET") {
      json(response, content);
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "PATCH") {
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
    close: async () => {
      await new Promise<void>((closed) => server.close(() => closed()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * One gateway that publishes both source families: the browser Canvas
 * connector, whose results need the roster redaction below, and the Blackboard
 * Learn REST source, which redacts learner identity inside its own process.
 */
function configuration(
  root: string,
  fixture: Awaited<ReturnType<typeof createBlackboardFixture>>,
  connectorPort: number,
) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "compact",
    sourcePolicy: { requireAttestation: false },
    upstreams: [
      {
        id: "canvas-session",
        label: "Morrow Bridge",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
        cwd: root,
        env: {
          MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
          MORROW_CANVAS_CONNECTOR_STATE: join(fixture.directory, "connector.json"),
          MORROW_CANVAS_CONNECTOR_PORT: String(connectorPort),
          MORROW_CANVAS_CONNECTOR_TOKEN: "gateway-connector-secret-".repeat(3),
          MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: "a".repeat(32),
        },
        sourceDisposition: "adapted_owned",
        priority: 200,
        required: true,
        enabled: true,
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "learner", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      },
      {
        id: "blackboard-rest",
        label: "Blackboard Learn REST fixture",
        kind: "mcp-stdio",
        command: process.execPath,
        args: [resolve(root, "packages/blackboard-learn-api/dist/index.js")],
        cwd: root,
        env: {
          HOME: join(fixture.directory, "home"),
          MORROW_BLACKBOARD_CONFIG: fixture.configPath,
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
        },
        sourceDisposition: "direct_owned",
        priority: 175,
        required: true,
        enabled: true,
        outputPrivacy: {},
        outputPrivacyDefault: {
          allowedFields: [], fieldPolicy: "scrub-sensitive", dataClass: "learner", maxRecords: 10_000,
          maxBytes: 2_000_000, freeText: "allow", learnerTokens: true, artifactInspection: "deny", aiClientAdmission: "allow",
        },
      },
    ],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(fixture.directory, "gateway.sqlite3") },
    privacy: {
      canvasOrigin: "browser-session",
      account: "local",
      principal: "local",
      learnerVaultPath: join(fixture.directory, "vault.json"),
    },
    maxCatalogTools: 2_000,
  });
}

/** A gateway problem code, whether it is returned bare or inside a canonical result. */
function problemCode(value: JsonObject): string | undefined {
  const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  if (!structured) return undefined;
  if (typeof structured.code === "string") return structured.code;
  const data = isJsonObject(structured.data) ? structured.data : null;
  return data && typeof data.code === "string" ? data.code : undefined;
}

describe("Blackboard egress exemption scope", () => {
  it("keys the roster-redaction exemption to the invoked source, not to the requested binding id", async () => {
    const fixture = await createBlackboardFixture();
    const root = resolve("../..");
    let runtime: MorrowRuntime | undefined;
    try {
      const connectorPort = await availablePort();
      runtime = await MorrowRuntime.connect(configuration(root, fixture, connectorPort), {
        statePath: join(fixture.directory, "morrow.sqlite3"),
      });
      const gateway = runtime.gateway;
      const sourceBindingId = deriveBlackboardSourceBindingId(fixture.baseUrl, PRINCIPAL_ID, COURSE_ID);
      const canvasTool = gateway.catalog.tools.find((tool) => (
        tool.capability?.route.backend === "canvas-connector" && tool.annotations?.readOnlyHint === true
      ));
      if (!canvasTool) throw new Error("this gateway published no Canvas connector read tool");
      expect(gateway.catalog.tools.some((tool) => (
        tool.upstreamId === "blackboard-rest" && tool.capability?.provider === "blackboard"
      ))).toBe(true);

      // A Canvas connector result carrying learner text. The caller claims a
      // Blackboard binding for it, which is the only thing the old condition
      // read. Morrow must still take the Canvas roster route and fail closed,
      // because no browser binding backs this call.
      const forged = await gateway.redactMcpEgress({
        content: [{ type: "text", text: "Feedback for Jane Doe" }],
        structuredContent: {
          schema: "morrow.canvas-page.v1",
          title: "Feedback for Jane Doe",
          body: "Jane Doe asked about the syllabus.",
        },
      }, {
        course_id: "77",
        _morrow: { source_binding_id: "blackboard:forged" },
      }, { bound: false, toolName: canvasTool.publicName });
      expect(forged.isError, JSON.stringify(forged)).toBe(true);
      expect(problemCode(forged)).toBe("learner_roster_binding_unavailable");
      expect(JSON.stringify(forged)).not.toContain("Jane Doe");

      // The same claim through the compact capability wrapper, which is how the
      // shipped desktop configuration reaches every catalog tool.
      const forgedThroughWrapper = await gateway.redactMcpEgress({
        content: [{ type: "text", text: "Feedback for Jane Doe" }],
        structuredContent: { schema: "morrow.canvas-page.v1", title: "Feedback for Jane Doe" },
      }, {
        course_id: "77",
        _morrow: { source_binding_id: "blackboard:forged" },
      }, { bound: false, toolName: "morrow_capability_read" });
      expect(problemCode(forgedThroughWrapper)).toBe("learner_roster_binding_unavailable");
      expect(JSON.stringify(forgedThroughWrapper)).not.toContain("Jane Doe");

      // A value the Blackboard source produced, with its real binding. The
      // invoked capability now carries the exemption: the same value passes
      // under the Blackboard read tool and is refused under a Canvas
      // connector tool.
      const readInput = { tenant_id: "fixture", source_binding_id: sourceBindingId, course_id: COURSE_ID };
      const read = await gateway.callSourceOwned("blackboard_read_course", readInput);
      expect(read.isError, JSON.stringify(read)).not.toBe(true);
      const projectedRead = await gateway.redactMcpEgress(read, readInput, {
        bound: false,
        toolName: "blackboard_read_course",
      });
      expect(projectedRead.isError, JSON.stringify(projectedRead)).not.toBe(true);
      expect(JSON.stringify(projectedRead)).toContain("Biology");
      expect(JSON.stringify(projectedRead)).not.toContain("Jane Doe");
      const readAsCanvasTool = await gateway.redactMcpEgress(read, readInput, {
        bound: false,
        toolName: canvasTool.publicName,
      });
      expect(problemCode(readAsCanvasTool)).toBe("learner_roster_binding_unavailable");

      // Morrow's own Blackboard plan tool has no catalog entry of its own, so
      // it is recognised by name against the published Blackboard source.
      const patchInput = {
        tenant_id: "fixture",
        source_binding_id: sourceBindingId,
        course_id: COURSE_ID,
        content_id: CONTENT_ID,
        patch: { title: "Reviewed title" },
      };
      const planned = await gateway.planBlackboardContentPatch(patchInput);
      const projectedPlan = await gateway.redactMcpEgress(planned, patchInput, {
        bound: false,
        toolName: "morrow_plan_blackboard_content_patch",
      });
      expect(projectedPlan.isError, JSON.stringify(projectedPlan)).not.toBe(true);
      expect(projectedPlan.structuredContent).toMatchObject({ effectState: "awaiting_approval" });

      // A refused Blackboard plan must still say why it was refused instead of
      // turning into an unrelated privacy failure.
      const rejected = await gateway.planBlackboardContentPatch({ ...patchInput, content_id: MISSING_CONTENT_ID });
      const projectedRejection = await gateway.redactMcpEgress(rejected, {
        ...patchInput,
        content_id: MISSING_CONTENT_ID,
      }, { bound: false, toolName: "morrow_plan_blackboard_content_patch" });
      expect(problemCode(projectedRejection)).toBe("operation_plan_invalid");

      // morrow_operation_dispatch names an operation, not a capability, so the
      // Blackboard source is read from the capability Morrow stamped on the
      // dispatch result.
      const plannedContent = isJsonObject(projectedPlan.structuredContent) ? projectedPlan.structuredContent : null;
      const operationId = plannedContent && typeof plannedContent.operationId === "string"
        ? plannedContent.operationId
        : "";
      expect(operationId).toMatch(/^op:/u);
      gateway.approveOperation(operationId);
      const dispatched = await gateway.dispatchOperation(operationId);
      const projectedDispatch = await gateway.redactMcpEgress(dispatched, { operation_id: operationId }, {
        bound: false,
        toolName: "morrow_operation_dispatch",
      });
      expect(projectedDispatch.isError, JSON.stringify(projectedDispatch)).not.toBe(true);
      expect(projectedDispatch.structuredContent).toMatchObject({
        effectState: "verified",
        tool: "blackboard_apply_reviewed_content_patch",
        backend: "blackboard-rest",
      });
    } finally {
      await runtime?.close();
      await fixture.close();
    }
  }, 60_000);
});
