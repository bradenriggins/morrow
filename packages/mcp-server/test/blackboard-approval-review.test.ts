import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { deriveBlackboardSourceBindingId } from "../../blackboard-learn-api/src/binding.js";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";

const TENANT_ID = "review-tenant";
const COURSE_ID = "_22_1";
const CONTENT_ID = "_33_1";
const PRINCIPAL_ID = "_11_1";
const CREDENTIAL_REVISION = "8c751fc3-ecf9-4558-b86b-d97a34e93295";
const COURSE_NAME = "Introduction to Biology";
const CURRENT_TITLE = "Week 1 overview";
const CURRENT_DESCRIPTION = "Read the syllabus before the first class.";
const REQUESTED_TITLE = "Week 1 orientation";
const TEST_CERTIFICATE = fileURLToPath(new URL("./fixtures/blackboard-test-cert.pem", import.meta.url));
const TEST_KEY = fileURLToPath(new URL("./fixtures/blackboard-test-key.pem", import.meta.url));

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function operationId(value: JsonObject): string {
  if (!isJsonObject(value.structuredContent) || typeof value.structuredContent.operationId !== "string") {
    throw new Error(`Blackboard plan did not produce an operation id: ${JSON.stringify(value)}`);
  }
  return value.structuredContent.operationId;
}

/** The reviewed source plan digest Morrow froze into the dispatch request. */
function reviewedPlanDigest(operation: JsonObject): string {
  const plan = isJsonObject(operation.plan) ? operation.plan : null;
  const args = plan && isJsonObject(plan.arguments) ? plan.arguments : null;
  if (!args || typeof args.expected_plan_digest !== "string") {
    throw new Error("Blackboard operation did not retain its reviewed source plan digest");
  }
  return args.expected_plan_digest;
}

async function createFixture(): Promise<{
  readonly directory: string;
  readonly baseUrl: string;
  readonly configPath: string;
  readonly requests: () => readonly string[];
  readonly close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-review-"));
  const certificate = await readFile(TEST_CERTIFICATE);
  const key = await readFile(TEST_KEY);
  const requests: string[] = [];
  const content: JsonObject = {
    id: CONTENT_ID,
    parentId: "_34_1",
    courseId: COURSE_ID,
    contentHandler: { id: "resource/x-bb-document" },
    title: CURRENT_TITLE,
    description: CURRENT_DESCRIPTION,
    position: 1,
    availability: { available: "Yes", allowGuests: true, adaptiveRelease: {} },
  };
  const server = createServer({ key, cert: certificate }, (request: IncomingMessage, response: ServerResponse) => {
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
      json(response, { id: COURSE_ID, courseId: "BIO-101", name: COURSE_NAME, ultraStatus: "Ultra", closedComplete: false });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}`) {
      json(response, { id: COURSE_ID, courseId: "BIO-101", name: COURSE_NAME });
      return;
    }
    if (pathname === `/learn/api/public/v1/courses/${COURSE_ID}/contents/${CONTENT_ID}` && request.method === "GET") {
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
    requests: () => requests,
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
    toolSurface: "compact",
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

describe("Blackboard approval review page", () => {
  it("names the course and item, shows the current values beside the requested ones, and keeps the tenant, binding, and plan digest off the page", async () => {
    const fixture = await createFixture();
    const root = resolve("../..");
    const sourceBindingId = deriveBlackboardSourceBindingId(fixture.baseUrl, PRINCIPAL_ID, COURSE_ID);
    let runtime: MorrowRuntime | undefined;
    try {
      runtime = await MorrowRuntime.connect(configuration(root, fixture), { statePath: join(fixture.directory, "morrow.sqlite3") });
      const planned = await runtime.gateway.planBlackboardContentPatch({
        tenant_id: TENANT_ID,
        source_binding_id: sourceBindingId,
        course_id: COURSE_ID,
        content_id: CONTENT_ID,
        patch: { title: REQUESTED_TITLE, availability: { available: "No" } },
      });
      expect(planned.isError, JSON.stringify(planned)).not.toBe(true);
      const id = operationId(planned);
      expect(runtime.gateway.operationGet(id)).toMatchObject({ state: "awaiting_approval" });

      const reviewUrl = runtime.gateway.approvalUrl(id)!;
      const review = await fetch(reviewUrl);
      const page = await review.text();
      expect(review.status).toBe(200);

      // The reviewer sees which course and which item the change lands on.
      expect(page).toContain(`<dt>Course</dt><dd>${COURSE_NAME}</dd>`);
      expect(page).toContain(`<dt>Item</dt><dd>${CURRENT_TITLE}</dd>`);
      // Both the saved values and the requested values, under the same labels.
      expect(page).toContain("<summary>Current content and values</summary>");
      expect(page).toContain(`<dt>Title</dt><dd>${CURRENT_TITLE}</dd>`);
      expect(page).toContain(CURRENT_DESCRIPTION);
      expect(page).toContain("<dt>Visible to students</dt><dd>Yes</dd>");
      expect(page).toContain(`<dt>Title</dt><dd>${REQUESTED_TITLE}</dd>`);
      expect(page).toContain("<dt>Visible to students</dt><dd>No</dd>");
      expect(page).toContain("Edit item?");
      expect(page).toContain("Morrow applies these changes and checks them in Blackboard.");
      // The Blackboard route is this computer's REST connection, not the browser.
      expect(page).toContain("Keep your assistant open while Morrow works.");
      expect(page).not.toContain("Chrome");

      // Named targets are resolved, so the page can be approved.
      expect(page).toContain('<button class="approve" type="submit">');
      expect(page).not.toContain("Morrow could not identify the course");

      // Technical routing values and roster identities never reach the page.
      const sourcePlanDigest = reviewedPlanDigest(runtime.gateway.operationGet(id));
      expect(sourcePlanDigest).toMatch(/^[0-9a-f]{64}$/);
      for (const secret of [TENANT_ID, sourceBindingId, sourcePlanDigest, "Jane Doe", "jane@example.edu"]) {
        expect(page, `review page leaked ${secret}`).not.toContain(secret);
      }
      for (const label of ["Tenant ID", "Source binding ID", "Expected plan digest", "Patch"]) {
        expect(page, `review page rendered ${label}`).not.toContain(`<dt>${label}</dt>`);
      }

      // Once the change is approved the page stops calling saved values current,
      // and still labels the change an edit of a named item.
      runtime.gateway.approveOperation(id);
      const approved = await (await fetch(reviewUrl)).text();
      expect(approved).toContain(`<dt>Item</dt><dd>${CURRENT_TITLE}</dd>`);
      expect(approved).toContain("Requested values are shown below. Earlier values are not available in this review.");
      expect(approved).not.toContain("<summary>Current content and values</summary>");

      // Rendering the review sends no change to Blackboard.
      expect(fixture.requests().filter((entry) => !entry.startsWith("GET ") && !entry.startsWith("POST /learn/api/public/v1/oauth2/token"))).toEqual([]);
    } finally {
      await runtime?.close();
      await fixture.close();
    }
  }, 30_000);
});
