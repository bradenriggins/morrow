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

const ORIGIN = "https://moodle.example.edu";
const SITE_URL = `${ORIGIN}/campus/`;
const SOURCE_BINDING_ID = "moodle:participants";
const PRINCIPAL_FINGERPRINT = "b".repeat(64);
const TOKEN = "moodle-participants-token-".repeat(3);
const EXTENSION_ID = "e".repeat(32);
const TABLE_METHOD = "core_table_get_dynamic_table_content";
const PAGE_METHOD = "native_enrol_instances_page";
const CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
const TABLE_PROOF = {
  method: TABLE_METHOD, complete: true, required_capabilities: CAPABILITIES,
  participant_limit: 500, page_size: 100, page_request_limit: 5, page_request_count: 1,
};

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

const participantsData = {
  schema: "morrow.moodle-course-participants.v1", provider: "moodle", course_id: 2,
  participant_count: 2,
  participants: [
    { user_id: "7", roles: ["Student"], enrolment_methods: ["Manual enrolments"] },
    { user_id: "3", roles: ["Non-editing teacher"], enrolment_methods: ["Manual enrolments", "Cohort sync"] },
  ],
  proof: { ...TABLE_PROOF, total_rows: 2 },
  // The page world also saw these. They must not survive the projection.
  raw_rows: [{ user_id: 7, fullname: "Jane Moodle", email: "jane@example.edu", lastaccess: "Today" }],
};

const methodsData = {
  schema: "morrow.moodle-enrolment-methods.v1", provider: "moodle", course_id: 2, method_count: 2,
  methods: [
    { name: "Manual enrolments", enabled: true, participant_count: 2 },
    { name: "Self enrolment (Student)", enabled: false, participant_count: 0 },
  ],
  proof: { method: PAGE_METHOD, complete: true, required_capabilities: CAPABILITIES, method_limit: 100 },
  raw_rows: [{ enrolid: 11, fullname: "Jane Moodle" }],
};

function enrolmentData(userId: string) {
  return {
    schema: "morrow.moodle-participant-enrolment.v1", provider: "moodle", course_id: 2,
    learner: { user_id: userId }, enrolment_count: 1,
    enrolments: [{ method: "Manual enrolments", status: "Active", start: "2026-01-01T00:00:00.000Z", end: null }],
    proof: TABLE_PROOF,
    raw_cells: [{ user_id: Number(userId), fullname: "Jane Moodle", email: "jane@example.edu" }],
  };
}

function result(command: BridgeCommand, digest: string, participantsCourseId: number): JsonObject {
  if (command.toolName === "morrow_private_moodle_find_enrolment_candidate") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, status: 200, complete: true, provider: "moodle",
    data: {
      schema: "morrow.moodle-enrolment-candidate.private.v1", provider: "moodle", course_id: 2,
      candidate: { user_id: "21", fullname: "Mary Jackson", email: "mary@example.edu" },
      match: { kind: "exact_native_query", candidate_count: 1, query: "Mary Jackson" },
      proof: {
        method: "native_manual_enrolment_candidate_search", route: "/enrol/manual/manage.php", complete: true,
        dispatch_count: 0, read_request_count: 2, candidate_limit: 100,
      },
    },
  };
  if (command.toolName === "moodle_get_course_participant_roster") return {
    schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200, truncated: false,
    data: {
      schema: "morrow.moodle-course-roster.v1", provider: "moodle", sourceBindingId: SOURCE_BINDING_ID, courseId: "2",
      origin: ORIGIN, siteUrl: SITE_URL, principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1,
      catalogDigest: digest, status: "complete", complete: true,
      identities: [{ id: "7", name: "Student Name" }, { id: "3", name: "Course Teacher" }],
      proof: { method: TABLE_METHOD, pageSize: 100, requestCount: 1, pageCount: 1, rowCount: 2, identityCount: 2 },
    },
    snapshot_digest: "d".repeat(64),
  };
  if (command.toolName === "moodle_get_course_participants") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: { ...participantsData, course_id: participantsCourseId },
    snapshot_digest: "e".repeat(64),
  };
  if (command.toolName === "moodle_get_enrolment_methods") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: methodsData,
    snapshot_digest: "e".repeat(64),
  };
  if (command.toolName === "moodle_get_participant_enrolment") return {
    schema: "morrow.canvas-browser-result.v1", ok: true, sent: false, provider: "moodle", complete: true,
    data: enrolmentData(String(command.arguments.user_id)),
    snapshot_digest: "e".repeat(64),
  };
  throw new Error(`unexpected source tool ${command.toolName}`);
}

describe("Moodle participant and enrolment Full MCP exposure", () => {
  it("tokenizes every participant, keeps the roster tool private, refuses an unknown identity, and refuses a partial list", async () => {
    const root = resolve("../.."); const directory = mkdtempSync(join(tmpdir(), "morrow-moodle-participants-integration-")); const port = await availablePort();
    const digest = browserCatalogDigest(root); const runtime = await MorrowRuntime.connect(configuration(root, directory, port), { statePath: join(directory, "batch.sqlite3") }); const gateway = runtime.gateway;
    let bridge: BridgeTestClient | undefined; let server: ReturnType<typeof serveStdio> | undefined; let client: Client | undefined; const commands: BridgeCommand[] = [];
    let participantsCourseId = 2;
    let participantsBounded = false;
    try {
      bridge = await connectBridgeTestClient({ port, token: TOKEN, extensionId: EXTENSION_ID, catalogDigest: digest,
        bindings: [{ sourceBindingId: SOURCE_BINDING_ID, provider: "moodle", origin: ORIGIN, siteUrl: SITE_URL, courseId: "2", courseName: "Enrolment course", principalFingerprint: PRINCIPAL_FINGERPRINT, sessionGeneration: 1, catalogDigest: digest, editPolicyRevision: 0, runtimeVerified: true }] });
      bridge.onCommand((command) => {
        commands.push(command);
        if (command.kind === "invoke_write") {
          bridge?.respondProblem(command, {
            schema: "morrow.bridge.problem.v1", code: "canvas_request_not_sent",
            message: "The fixture stopped before a provider write.", recoverable: true,
          });
          return;
        }
        if (command.kind !== "invoke_read") return;
        // The page world reports a course past its own bound as incomplete. It
        // returns no row at all, so no partial list can reach the gateway.
        if (participantsBounded && command.toolName === "moodle_get_course_participants") {
          bridge?.respondProblem(command, {
            schema: "morrow.bridge.problem.v1", code: "canvas_request_not_sent",
            message: "moodle_course_participants_incomplete", recoverable: true,
          });
          return;
        }
        bridge?.respond(command, result(command, digest, participantsCourseId));
      });
      const [left, right] = InMemoryTransport.createLinkedPair(); server = serveStdio(() => createFullMorrowServer(runtime), { transport: right });
      client = new Client({ name: "morrow-moodle-participants", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); await client.connect(left);

      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toContain("morrow_capability_read");
      expect(listed).toContain("morrow_find_moodle_enrolment_candidate");
      // The redaction roster is the source of every token below and is still
      // not a tool an assistant can reach.
      expect(listed).not.toContain("moodle_get_course_participant_roster");
      expect(listed).not.toContain("morrow_private_moodle_find_enrolment_candidate");
      for (const tool of ["moodle_get_course_participants", "moodle_get_enrolment_methods", "moodle_get_participant_enrolment"]) {
        expect(gateway.capabilityGet(tool)).toMatchObject({
          descriptor: { canonicalName: tool, behavior: { readOnly: true }, authority: { dataClass: "learner" } },
        });
      }
      expect(gateway.capabilityGet("moodle_get_course_participant_roster"))
        .toMatchObject({ schema: "morrow.problem.v1", code: "capability_not_found" });

      const rawWrite = await gateway.call("moodle_suspend_participant", {
        course_id: 2,
        user_id: 7,
        expected_digest: "f".repeat(64),
        _morrow: { source_binding_id: SOURCE_BINDING_ID },
      });
      expect(rawWrite).toMatchObject({
        isError: true,
        structuredContent: {
          schema: "morrow.result.v1",
          data: { schema: "morrow.problem.v1", code: "learner_token_required", resultState: "not_sent" },
        },
      });
      expect(commands).toHaveLength(0);

      const candidate = await client.callTool({
        name: "morrow_find_moodle_enrolment_candidate",
        arguments: { source_binding_id: SOURCE_BINDING_ID, course_id: 2, query: "Mary Jackson" },
      });
      const candidateText = JSON.stringify(candidate);
      expect(candidate.isError, candidateText).not.toBe(true);
      expect(candidate.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "morrow_find_moodle_enrolment_candidate",
        data: {
          schema: "morrow.moodle-enrolment-candidate.v1", course_id: 2,
          candidate_token: expect.stringMatching(/^learner_/),
          match: { kind: "exact_native_query", candidate_count: 1 },
          proof: { dispatch_count: 0, read_request_count: 2, candidate_limit: 100 },
        },
      });
      for (const privateValue of ["Mary Jackson", "mary@example.edu", "user_id"]) {
        expect(candidateText, `the candidate lookup leaked ${privateValue}`).not.toContain(privateValue);
      }
      const candidateToken = (candidate.structuredContent as { data: { candidate_token: string } }).data.candidate_token;
      const plannedEnrolment = await client.callTool({
        name: "morrow_capability_change",
        arguments: {
          name: "moodle_enrol_participant",
          arguments: {
            course_id: 2, candidate_token: candidateToken, expected_digest: "f".repeat(64),
            _morrow: { source_binding_id: SOURCE_BINDING_ID },
          },
        },
      });
      expect(plannedEnrolment.isError, JSON.stringify(plannedEnrolment)).not.toBe(true);
      const plannedEnrolmentId = (plannedEnrolment.structuredContent as { operationId: string }).operationId;
      expect(plannedEnrolmentId).toMatch(/^op:/);
      gateway.approveOperation(plannedEnrolmentId);
      const stoppedEnrolment = await gateway.dispatchOperation(plannedEnrolmentId);
      expect(stoppedEnrolment.isError).toBe(true);
      const candidateCommands = commands.filter((command) => command.toolName === "morrow_private_moodle_find_enrolment_candidate");
      expect(candidateCommands).toHaveLength(2);
      expect(candidateCommands.every((command) => command.arguments.query === "Mary Jackson")).toBe(true);
      const enrolmentWrite = commands.find((command) => command.kind === "invoke_write" && command.toolName === "moodle_enrol_participant");
      expect(enrolmentWrite?.arguments).toMatchObject({ course_id: 2, user_id: 21, expected_digest: "f".repeat(64) });
      expect(enrolmentWrite?.arguments).not.toHaveProperty("candidate_token");

      const participants = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_course_participants", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const participantsText = JSON.stringify(participants);
      expect(participants.isError, participantsText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "Student Name", "Course Teacher", "raw_rows", "user_id", "lastaccess"]) {
        expect(participantsText, `the participant list leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(participants.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_course_participants",
        data: {
          participant_count: 2,
          participants: [
            { learnerToken: expect.stringMatching(/^learner_/), roles: ["Student"], enrolment_methods: ["Manual enrolments"] },
            { learnerToken: expect.stringMatching(/^learner_/), roles: ["Non-editing teacher"], enrolment_methods: ["Manual enrolments", "Cohort sync"] },
          ],
          proof: { required_capabilities: CAPABILITIES, total_rows: 2 },
        },
      });
      const rows = (participants.structuredContent as { data: { participants: { learnerToken: string }[] } }).data.participants;
      expect(new Set(rows.map((row) => row.learnerToken)).size).toBe(2);

      const methods = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_enrolment_methods", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const methodsText = JSON.stringify(methods);
      expect(methods.isError, methodsText).not.toBe(true);
      // The method list is course configuration. It carries no identity and no
      // token, so it needs no roster.
      for (const privateValue of ["Jane Moodle", "learnerToken", "raw_rows", "enrolid", "user_id"]) {
        expect(methodsText, `the method list leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(methods.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_enrolment_methods",
        data: {
          method_count: 2,
          methods: [
            { name: "Manual enrolments", enabled: true, participant_count: 2 },
            { name: "Self enrolment (Student)", enabled: false, participant_count: 0 },
          ],
          proof: { method: PAGE_METHOD, required_capabilities: CAPABILITIES },
        },
      });

      const enrolment = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_participant_enrolment", arguments: { course_id: 2, learner_token: rows[0]!.learnerToken, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const enrolmentText = JSON.stringify(enrolment);
      expect(enrolment.isError, enrolmentText).not.toBe(true);
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "Student Name", "raw_cells", "user_id"]) {
        expect(enrolmentText, `the enrolment record leaked ${privateValue}`).not.toContain(privateValue);
      }
      expect(enrolment.structuredContent).toMatchObject({
        schema: "morrow.result.v1", tool: "moodle_get_participant_enrolment",
        data: {
          learner: { learnerToken: rows[0]!.learnerToken },
          enrolment_count: 1,
          enrolments: [{ method: "Manual enrolments", status: "Active", start: "2026-01-01T00:00:00.000Z", end: null }],
        },
      });

      const sourceEnrolment = commands.find((command) => command.toolName === "moodle_get_participant_enrolment");
      expect(sourceEnrolment?.arguments).toMatchObject({ course_id: 2, user_id: 7 });
      expect(sourceEnrolment?.arguments).not.toHaveProperty("learner_token");

      const unknown = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_participant_enrolment", arguments: { course_id: 2, learner_token: `learner_${"a".repeat(64)}`, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const unknownText = JSON.stringify(unknown);
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ schema: "morrow.result.v1", data: { schema: "morrow.problem.v1" } });
      for (const privateValue of ["Manual enrolments", "Active", "2026-01-01"]) {
        expect(unknownText, `the refusal leaked ${privateValue}`).not.toContain(privateValue);
      }

      // A course past the participant bound returns no list at all.
      participantsBounded = true;
      const bounded = await client.callTool({ name: "morrow_capability_read", arguments: { name: "moodle_get_course_participants", arguments: { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } } } });
      const boundedText = JSON.stringify(bounded);
      expect(bounded.isError, boundedText).toBe(true);
      expect(boundedText).toContain("moodle_course_participants_incomplete");
      for (const privateValue of ["learnerToken", "participant_count", "Non-editing teacher"]) {
        expect(boundedText, `the bounded refusal leaked ${privateValue}`).not.toContain(privateValue);
      }
      participantsBounded = false;

      // A page result that names a different course than the request is refused
      // before any row is projected.
      participantsCourseId = 5;
      const mismatch = await gateway.call("moodle_get_course_participants", { course_id: 2, _morrow: { source_binding_id: SOURCE_BINDING_ID } });
      const mismatchText = JSON.stringify(mismatch);
      expect(mismatchText).toContain("moodle_course_participants_invalid");
      for (const privateValue of ["Jane Moodle", "jane@example.edu", "learnerToken"]) {
        expect(mismatchText).not.toContain(privateValue);
      }

      // Token resolution performs a complete, exact-scope roster read before
      // the numeric Moodle user_id reaches the private browser executor.
      const names = commands.map((command) => command.toolName);
      expect(names.filter((name) => name === "moodle_get_participant_enrolment")).toHaveLength(1);
      expect(names.filter((name) => name === "moodle_get_course_participant_roster").length).toBeGreaterThanOrEqual(4);
    } finally {
      await client?.close(); await server?.close(); await bridge?.close();
      await runtime.close(); rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
