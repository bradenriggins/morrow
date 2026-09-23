import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonObject, sha256Text, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import type { GatewayRuntime } from "../src/runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

/**
 * Canvas's two "Update/create page" routes create the page when it does not exist: a page route
 * whose `url_or_id` names no page creates that page, and the front page route creates a published
 * page and makes it the front page when the course has none. The routine bundle "Edit page text and
 * titles" changes only an existing page, so Morrow reads the page first and sends a change to a page
 * Canvas does not hold to the educator's review.
 */
const CASE_TIMEOUT_MS = 30_000;

function operationId(result: JsonObject): string {
  const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof value !== "string") throw new Error("operation id missing");
  return value;
}

function connectorConfig(directory: string, port: number) {
  const root = resolve("../..");
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Canvas Connector",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: root,
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: "gateway-connector-secret-".repeat(3),
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: "a".repeat(32),
      },
      sourceDisposition: "adapted_owned",
      outputPrivacy: {},
      outputPrivacyDefault: {
        allowedFields: [],
        fieldPolicy: "scrub-sensitive",
        dataClass: "course",
        maxRecords: 10_000,
        maxBytes: 2_000_000,
        freeText: "allow",
        learnerTokens: true,
        artifactInspection: "deny",
        aiClientAdmission: "allow",
      },
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: join(directory, "gateway.sqlite3") },
    privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
    maxCatalogTools: 2_000,
  });
}

describe("Edit page text and titles changes only a page Canvas already holds", () => {
  const root = resolve("../..");
  const sourceBindingId = "canvas:test-account";
  const browserCatalogDigest = bridgeCatalogDigestForTests(root);
  const pageRoute = "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses";
  const frontPageRoute = "PUT /v1/courses/{course_id}/front_page#update_create_front_page_courses";
  const editPermission = {
    schema: "morrow.bridge.edit-permission.v1" as const,
    revision: 1,
    scopeDigest: "d".repeat(64),
    catalogDigest: browserCatalogDigest,
    sourceBindingId,
    enabledCategories: ["canvas_pages_text"],
    rules: [
      { operationKey: pageRoute, toolName: "canvas_update_create_page_courses", allowedChangedFields: ["wiki_page_body", "wiki_page_title"] },
      { operationKey: frontPageRoute, toolName: "canvas_update_create_front_page_courses", allowedChangedFields: ["wiki_page_body", "wiki_page_title"] },
    ],
  };
  const binding = {
    sourceBindingId,
    provider: "canvas" as const,
    origin: "https://school.instructure.com",
    courseId: "42",
    courseName: "Biology",
    principalFingerprint: "c".repeat(64),
    sessionGeneration: 1,
    catalogDigest: browserCatalogDigest,
    runtimeVerified: true,
    editPolicyRevision: 1,
    editOptionsAvailable: true,
    editPermission: {
      schema: editPermission.schema,
      revision: editPermission.revision,
      scopeDigest: editPermission.scopeDigest,
      catalogDigest: editPermission.catalogDigest,
      sourceBindingId,
    },
  };
  const lesson = { page_id: "91", url: "lesson", title: "Cell structure", body: "<p>Cells have membranes.</p>", published: true, front_page: false };
  const home = { page_id: "92", url: "home", title: "Welcome", body: "<p>Welcome to Biology.</p>", published: true, front_page: true };

  let directory = "";
  let morrow: MorrowRuntime;
  let runtime: GatewayRuntime;
  let bridge: BridgeTestClient | undefined;
  let frontPage: typeof home | null = null;
  const writes: { toolName: string; authorization: unknown }[] = [];
  const pageReads: string[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-edit-scope-page-create-"));
    const port = await reserveLoopbackPort();
    morrow = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
    runtime = morrow.gateway;
    await assertPortListening(port);
    bridge = await connectBridgeTestClient({
      port,
      token: "gateway-connector-secret-".repeat(3),
      extensionId: "a".repeat(32),
      catalogDigest: browserCatalogDigest,
      bindings: [binding],
    });
    bridge.onCommand((command) => {
      if (command.kind === "ui_state") {
        bridge?.respond(command, {});
        return;
      }
      if (command.kind === "edit_policy_options_get") {
        bridge?.respond(command, {
          schema: "morrow.bridge.edit-options.v1",
          sourceBindingId,
          provider: "canvas",
          catalogDigest: browserCatalogDigest,
          policyRevision: 1,
          runtimeVerified: true,
          options: [],
          editPermission,
        });
        return;
      }
      if (command.kind === "invoke_write") {
        writes.push({ toolName: command.toolName, authorization: command.outerGrant?.authorization });
      }
      const pageRead = command.kind === "invoke_read" && ["canvas_show_page_courses", "canvas_show_front_page_courses"].includes(command.toolName);
      if (pageRead) pageReads.push(command.toolName === "canvas_show_front_page_courses" ? "front_page" : String(command.arguments.url_or_id));
      const page = command.toolName === "canvas_show_front_page_courses" || command.toolName === "canvas_update_create_front_page_courses"
        ? frontPage
        : command.arguments.url_or_id === "lesson" ? lesson : null;
      if (pageRead && !page) {
        bridge?.respondProblem(command, {
          schema: "morrow.bridge.problem.v1",
          code: "canvas_request_failed",
          message: "Canvas returned HTTP 404",
          recoverable: true,
        }, { schema: "morrow.canvas-browser-failure.v1", provider: "canvas", sent: true, status: 404 });
        return;
      }
      const saved = page && command.kind === "invoke_write"
        ? { ...page, ...(typeof command.arguments.wiki_page_title === "string" ? { title: command.arguments.wiki_page_title } : {}) }
        : page;
      bridge?.respond(command, {
        schema: "morrow.canvas-browser-result.v1",
        ok: true,
        sent: true,
        status: 200,
        ...(saved && typeof saved.body === "string" ? { pageBodySha256: sha256Text(saved.body) } : {}),
        truncated: false,
        data: saved || (["canvas_list_users_in_course_users", "canvas_list_enrollments_courses"].includes(command.toolName) ? [] : { id: "42", name: "Biology" }),
        ...(command.kind === "invoke_write" ? { verification: { schema: "morrow.browser-verification.v1", status: "verified", strategy: "updated-resource" } } : {}),
      });
    });
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    await bridge?.close();
    await morrow?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("changes the title of a page that exists with no review", async () => {
    writes.length = 0;
    pageReads.length = 0;
    const edited = await runtime.call("canvas_update_create_page_courses", {
      course_id: "42", url_or_id: "lesson", wiki_page_title: "Cell structure and function",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const operation = runtime.effects.get(operationId(edited));
    expect(operation.plan).toMatchObject({ authorization: { kind: "edit_scope" } });
    expect(pageReads[0]).toBe("lesson");
    expect(writes).toEqual([{ toolName: "canvas_update_create_page_courses", authorization: { kind: "edit_scope", policyDigest: "d".repeat(64), policyRevision: 1 } }]);
  }, CASE_TIMEOUT_MS);

  it("sends a page that does not exist to review, because Canvas would create it", async () => {
    writes.length = 0;
    pageReads.length = 0;
    const planned = await runtime.call("canvas_update_create_page_courses", {
      course_id: "42", url_or_id: "new-unit-7", wiki_page_title: "Unit 7", wiki_page_body: "<p>Unit 7 overview.</p>",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const operation = runtime.effects.get(operationId(planned));
    expect(operation).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" } } });
    expect(pageReads).toContain("new-unit-7");
    expect(writes).toEqual([]);
    runtime.cancelOperation(operation.operationId);
  }, CASE_TIMEOUT_MS);

  it("sends a front page change to review when the course has no front page, because Canvas would create and publish one", async () => {
    writes.length = 0;
    pageReads.length = 0;
    frontPage = null;
    const planned = await runtime.call("canvas_update_create_front_page_courses", {
      course_id: "42", wiki_page_title: "Welcome", wiki_page_body: "<p>Welcome to Biology.</p>",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const operation = runtime.effects.get(operationId(planned));
    expect(operation).toMatchObject({ state: "awaiting_approval", plan: { authorization: { kind: "review" } } });
    expect(pageReads).toContain("front_page");
    expect(writes).toEqual([]);
    runtime.cancelOperation(operation.operationId);
  }, CASE_TIMEOUT_MS);

  it("changes the front page with no review when the course has one", async () => {
    writes.length = 0;
    pageReads.length = 0;
    frontPage = home;
    const edited = await runtime.call("canvas_update_create_front_page_courses", {
      course_id: "42", wiki_page_title: "Welcome to Biology",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const operation = runtime.effects.get(operationId(edited));
    expect(operation.plan).toMatchObject({ authorization: { kind: "edit_scope" } });
    expect(pageReads[0]).toBe("front_page");
    expect(writes.map((write) => write.toolName)).toEqual(["canvas_update_create_front_page_courses"]);
  }, CASE_TIMEOUT_MS);
});
