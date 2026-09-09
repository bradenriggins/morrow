import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { loadCanvasApiCatalog } from "@morrow/canvas-api-catalog";
import type { JsonObject } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import { buildLocalCanvasConfig } from "../../client-config/src/index.js";
import { parseGatewayConfig } from "../src/config.js";
import { createFullMorrowServer } from "../src/full-server.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const ORIGIN = "https://canvas.example.edu";
const SITE_URL = `${ORIGIN}/courses/2/quizzes/8`;
const SOURCE_BINDING_ID = "canvas:classic-quiz-summary";
const PRINCIPAL_FINGERPRINT = "c".repeat(64);
const TOKEN = "canvas-classic-quiz-summary-token-".repeat(3);
const EXTENSION_ID = "a".repeat(32);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function browserCatalogDigest(root: string): string {
  const canvas = loadCanvasApiCatalog(resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"));
  const canvasBrowser = createHash("sha256").update(readFileSync(resolve(root, "connector/extension/generated/canvas-browser-catalog.json"))).digest("hex");
  const moodle = createHash("sha256").update(readFileSync(resolve(root, "connector/extension/generated/moodle-browser-catalog.json"))).digest("hex");
  return createHash("sha256").update(`${canvas.catalogDigest}\n${canvasBrowser}\n${moodle}`).digest("hex");
}

function configuration(root: string, directory: string, port: number) {
  const generated = structuredClone(buildLocalCanvasConfig(root, process.execPath)) as { upstreams: Record<string, unknown>[]; operationJournal: Record<string, unknown>; privacy: Record<string, unknown> };
  const upstream = generated.upstreams[0];
  if (!upstream) throw new Error("browser upstream unavailable");
  return parseGatewayConfig({
    ...generated,
    upstreams: [{ ...upstream, env: { ...(upstream.env as Record<string, string>), MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"), MORROW_CANVAS_CONNECTOR_PORT: String(port), MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN, MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID } }],
    operationJournal: { ...generated.operationJournal, path: join(directory, "gateway.sqlite3") },
    privacy: { ...generated.privacy, learnerVaultPath: join(directory, "vault.json") },
  });
}

function result(command: BridgeCommand): JsonObject {
  if (command.toolName === "canvas_list_users_in_course_users") {
    expect(String(command.arguments.course_id)).toBe("2");
    expect(command.arguments).toMatchObject({
      include: ["enrollments", "uuid"], enrollment_type: ["student"],
      enrollment_state: ["active", "invited", "rejected", "completed", "inactive"], morrow_max_pages: 50,
    });
    return {
      schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
      data: [{ id: 7, name: "Jane Canvas", email: "jane@example.edu" }],
    };
  }
  if (command.toolName !== "canvas_get_classic_quiz_submission_summary" || command.operationKey !== "canvas.api.v1.course.quiz.submissions.aggregate.read.v1") {
    throw new Error(`unexpected source tool ${command.toolName}`);
  }
  expect(command.arguments).toEqual({ course_id: 2, quiz_id: 8 });
  return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "canvas", complete: true,
    data: {
      schema: "morrow.canvas-classic-quiz-submission-summary.v1", provider: "canvas", course_id: 2, quiz_id: 8,
      attempt_count: 4, complete_count: 1, pending_review_count: 1,
      workflow_state_counts: { untaken: 1, pending_review: 1, complete: 1, settings_only: 1, preview: 0 },
      proof: {
        method: "GET /api/v1/courses/:course_id/quizzes/:quiz_id/submissions",
        complete: true, pagination_complete: true, pages_read: 2, response_row_count: 4, needs_grading_count_proven: false,
      },
      raw_rows: [{ id: 71, user_id: 7, name: "Jane Canvas", email: "jane@example.edu", score: 100, answer: "private answer", comments: "private feedback", validation_token: "private-token" }],
    },
    snapshot_digest: "d".repeat(64),
  };
}

describe("Canvas Classic Quiz submission-summary Full MCP exposure", () => {
  it("returns a source-bound aggregate projection and never exposes the raw learner submission reader", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-classic-quiz-summary-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "canvas", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Private Canvas course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        if (command.kind !== "invoke_read") return;
        commands.push(command);
        bridge?.respond(command, result(command));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-canvas-classic-quiz-summary", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("morrow_capability_read");
      expect(gateway.capabilityGet("canvas_get_classic_quiz_submission_summary")).toMatchObject({ descriptor: { canonicalName: "canvas_get_classic_quiz_submission_summary", behavior: { readOnly: true } } });
      expect(gateway.capabilityGet("canvas_get_all_quiz_submissions")).toMatchObject({ code: "capability_not_found" });
      const roster = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_list_users_in_course_users", arguments: {
        course_id: "2", include: ["enrollments", "uuid"], enrollment_type: ["student"],
        enrollment_state: ["active", "invited", "rejected", "completed", "inactive"], morrow_max_pages: 50,
        _morrow: { source_binding_id: SOURCE_BINDING_ID },
      } } });
      const rosterText = JSON.stringify(roster);
      expect(roster.isError, rosterText).not.toBe(true);
      expect(rosterText).toMatch(/Student A[1-9][0-9]*/);
      for (const privateValue of ["Jane Canvas", "jane@example.edu", '"id":7']) expect(rosterText).not.toContain(privateValue);
      const allowed = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_get_classic_quiz_submission_summary", arguments: { course_id: 2, quiz_id: 8, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const allowedText = JSON.stringify(allowed);
      expect(allowed.isError, allowedText).not.toBe(true);
      for (const privateValue of ["Jane Canvas", "jane@example.edu", "private answer", "private feedback", "private-token", '"user_id":7', '"id":71', '"score":100']) expect(allowedText).not.toContain(privateValue);
      expect(allowed.structuredContent).toMatchObject({ schema: "morrow.result.v1", tool: "canvas_get_classic_quiz_submission_summary", data: { attempt_count: 4, complete_count: 1, pending_review_count: 1, workflow_state_counts: { preview: 0 }, proof: { pagination_complete: true, needs_grading_count_proven: false } } });
      expect(commands.map((command) => command.toolName)).toEqual([
        "canvas_list_users_in_course_users", "canvas_list_users_in_course_users",
        "canvas_list_users_in_course_users",
        "canvas_list_users_in_course_users", "canvas_get_classic_quiz_submission_summary",
      ]);
      const disallowed = await client.callTool({ name: "morrow_capability_read", arguments: { name: "canvas_get_classic_quiz_submission_summary", arguments: { course_id: 2, quiz_id: 8, _morrow: { source_binding_id: "canvas:wrong-course" } } } });
      expect(disallowed.isError).toBe(true);
      expect(commands).toHaveLength(5);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
