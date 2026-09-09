import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:https";
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
const PRINCIPAL_ID = "_11_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function operationId(value: JsonObject): string {
  if (!isJsonObject(value.structuredContent) || typeof value.structuredContent.operationId !== "string") {
    throw new Error("The Blackboard plan produced no operation id");
  }
  return value.structuredContent.operationId;
}

async function createFixture(): Promise<{
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  /** The fixture answers a PATCH without storing it when this is false. */
  storePatch: boolean;
  readonly editContentTitle: (title: string) => void;
  readonly counts: () => { readonly patch: number };
  readonly close: () => Promise<void>;
}> {
  // Real home, not the OS temp dir: the spawned blackboard-learn-api
  // process's config-privacy check walks every real ancestor to filesystem
  // root, which fails under Linux's world-writable /tmp.
  const directory = await mkdtemp(join(homedir(), ".morrow-blackboard-dispatch-state-test-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  let patch = 0;
  let content: JsonObject = {
    id: CONTENT_ID,
    courseId: COURSE_ID,
    contentHandler: { id: "resource/x-bb-document" },
    title: "Welcome Jane Doe",
    description: "Jane Doe uses jane@example.edu",
    availability: { available: "Yes" },
  };
  const control = { storePatch: true };
  const server = createServer({ key, cert: certificate }, async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url || "/", "https://fixture.invalid").pathname;
    if (pathname === "/learn/api/public/v1/oauth2/token") {
      json(response, { access_token: "temporary-token", expires_in: 3600 });
      return;
    }
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
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "GET") {
      json(response, content);
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "PATCH") {
      patch += 1;
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (control.storePatch) content = { ...content, ...(JSON.parse(body) as JsonObject) };
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
    get storePatch() { return control.storePatch; },
    set storePatch(value: boolean) { control.storePatch = value; },
    editContentTitle: (title: string) => { content = { ...content, title }; },
    counts: () => ({ patch }),
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function configuration(root: string, fixture: Awaited<ReturnType<typeof createFixture>>) {
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
    operationJournal: { path: ":memory:" },
  });
}

describe("Blackboard Gateway effect execution state", () => {
  it("records a refusal that sent nothing as failed and an unconfirmed sent PATCH as applied_or_unknown", async () => {
    const fixture = await createFixture();
    const root = resolve("../..");
    let runtime: MorrowRuntime | undefined;
    try {
      runtime = await MorrowRuntime.connect(configuration(root, fixture), { statePath: join(fixture.directory, "morrow.sqlite3") });
      const input = {
        tenant_id: "fixture",
        source_binding_id: deriveBlackboardSourceBindingId(fixture.baseUrl, PRINCIPAL_ID, COURSE_ID),
        course_id: COURSE_ID,
        content_id: CONTENT_ID,
        patch: { title: "Reviewed title" },
      };

      // The instructor edits the item after review. Nothing is sent, so the
      // operation must settle failed and leave the target open for new work.
      const planned = await runtime.gateway.planBlackboardContentPatch(input);
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const changedOperationId = operationId(planned);
      runtime.gateway.approveOperation(changedOperationId);
      fixture.editContentTitle("Changed by the instructor");
      const refused = await runtime.gateway.dispatchOperation(changedOperationId);
      expect(refused.isError).toBe(true);
      const refusedRecord = runtime.gateway.operationGet(changedOperationId);
      expect(refusedRecord.state).toBe("failed");
      expect(refusedRecord.attention[0]).toBe("dispatch_failed_before_send");
      expect(fixture.counts().patch).toBe(0);

      // The PATCH is sent and answered, but the fresh read does not show the
      // reviewed value. Morrow cannot prove what landed, so it stops here.
      fixture.storePatch = false;
      const secondPlan = await runtime.gateway.planBlackboardContentPatch(input);
      expect(secondPlan.isError, JSON.stringify(secondPlan)).not.toBe(true);
      const unconfirmedOperationId = operationId(secondPlan);
      runtime.gateway.approveOperation(unconfirmedOperationId);
      const unconfirmed = await runtime.gateway.dispatchOperation(unconfirmedOperationId);
      expect(unconfirmed.isError).toBe(true);
      const unconfirmedRecord = runtime.gateway.operationGet(unconfirmedOperationId);
      expect(unconfirmedRecord.state).toBe("applied_or_unknown");
      expect(unconfirmedRecord.attention[0]).toBe("provider_effect_may_have_landed");
      expect(fixture.counts().patch).toBe(1);
    } finally {
      await runtime?.close();
      await fixture.close();
    }
  }, 60_000);
});
