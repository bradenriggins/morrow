import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { loadCanvasApiCatalog, planCanvasRecoveryDescriptor } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";

const ROOT = resolve("../..");
const CATALOG_PATH = resolve(ROOT, "artifacts/canvas-api/canvas-api-catalog.json");
const SOURCE_BINDING_ID = "canvas:recovery-account";
const EXTENSION_ID = "a".repeat(32);
const TOKEN = "gateway-connector-secret-".repeat(3);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  const port = address.port;
  await new Promise<void>((closed) => server.close(() => closed()));
  return port;
}

function rawDigest(relativePath: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, relativePath))).digest("hex");
}

function connectorCatalogDigest(canvasCatalogDigest: string): string {
  const canvasBrowser = rawDigest("connector/extension/generated/canvas-browser-catalog.json");
  const moodle = rawDigest("connector/extension/generated/moodle-browser-catalog.json");
  return createHash("sha256").update(`${canvasCatalogDigest}\n${canvasBrowser}\n${moodle}`).digest("hex");
}

function connectorConfig(directory: string, port: number) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "canvas-session",
      label: "Morrow Canvas Connector",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [resolve(ROOT, "packages/canvas-connector-mcp/dist/index.js")],
      cwd: ROOT,
      env: {
        MORROW_CANVAS_CATALOG_PATH: CATALOG_PATH,
        MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
        MORROW_CANVAS_CONNECTOR_PORT: String(port),
        MORROW_CANVAS_CONNECTOR_TOKEN: TOKEN,
        MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: EXTENSION_ID,
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
    privacy: {
      canvasOrigin: "browser-session",
      account: "local",
      principal: "local",
      learnerVaultPath: join(directory, "vault.json"),
    },
    maxCatalogTools: 2_000,
  });
}

function structured(result: JsonObject): JsonObject {
  return isJsonObject(result.structuredContent) ? result.structuredContent : {};
}

function operationId(result: JsonObject): string {
  const value = structured(result).operationId;
  if (typeof value !== "string") throw new Error("operation id missing");
  return value;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((wake) => setTimeout(wake, 10));
  }
}

describe("Canvas unresolved-operation recovery", () => {
  it("checks an unresolved Canvas change with its retained read-only comparator and never sends it again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-recovery-"));
    const port = await availablePort();
    const catalog = loadCanvasApiCatalog(CATALOG_PATH);
    const browserCatalogDigest = connectorCatalogDigest(catalog.catalogDigest);
    const morrow = await MorrowRuntime.connect(connectorConfig(directory, port), {
      statePath: join(directory, "gateway.sqlite3"),
    });
    const runtime = morrow.gateway;
    let bridge: BridgeTestClient | undefined;

    // The saved Canvas state this fake course returns to every read.
    const assignments: Record<string, JsonObject> = {
      88: { id: "88", course_id: "42", name: "Cell transport reflection", published: true },
      99: { id: "99", course_id: "42", name: "Osmosis lab", published: true },
    };
    let assignmentGroups: JsonObject[] = [
      { id: "9", course_id: "42", name: "Assignments", position: 1, created_at: "2026-01-04T09:00:00Z" },
    ];
    let writeCommands = 0;
    // Set for one write to make Canvas answer the way a dropped browser POST or
    // PUT does: the change may have landed and nothing confirms it.
    let nextWriteOutcomeUnknown = false;

    const binding = (sessionGeneration: number) => ({
      sourceBindingId: SOURCE_BINDING_ID,
      provider: "canvas" as const,
      origin: "https://school.instructure.com",
      courseId: "42",
      principalFingerprint: "c".repeat(64),
      sessionGeneration,
      catalogDigest: browserCatalogDigest,
      runtimeVerified: true,
    });

    try {
      bridge = await connectBridgeTestClient({
        port,
        token: TOKEN,
        extensionId: EXTENSION_ID,
        catalogDigest: browserCatalogDigest,
        bindings: [binding(1)],
      });

      const readData = (command: BridgeCommand): unknown => {
        if (command.toolName === "canvas_get_single_assignment") return assignments[String(command.arguments.id)] ?? null;
        if (command.toolName === "canvas_list_assignment_groups") return assignmentGroups;
        return { id: "42", name: "Biology" };
      };

      bridge.onCommand((command) => {
        if (command.kind !== "invoke_write") {
          bridge?.respond(command, {
            schema: "morrow.canvas-browser-result.v1",
            ok: true,
            sent: true,
            status: 200,
            truncated: false,
            data: readData(command) as JsonObject,
          });
          return;
        }
        writeCommands += 1;
        // The extension plans the retained comparator from the same catalog the
        // service worker uses, and returns it with the write result.
        const write = catalog.operations.find((entry) => entry.toolName === command.toolName);
        const applied = nextWriteOutcomeUnknown ? undefined : { ...command.arguments, id: "301" };
        const readDescriptor = planCanvasRecoveryDescriptor(
          catalog.operations,
          write,
          command.arguments,
          applied,
        );
        if (nextWriteOutcomeUnknown) {
          nextWriteOutcomeUnknown = false;
          bridge?.respondProblem(command, {
            schema: "morrow.bridge.problem.v1",
            code: "write_outcome_unknown",
            message: "Canvas did not confirm this change.",
            recoverable: false,
          }, readDescriptor ? { schema: "morrow.canvas-browser-result.v1", readDescriptor } : undefined);
          return;
        }
        bridge?.respond(command, {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          status: 200,
          truncated: false,
          data: applied as JsonObject,
          verification: {
            schema: "morrow.browser-verification.v1",
            status: "verified",
            strategy: "updated-resource",
            readTool: "canvas_get_single_assignment",
            evidence: "fresh_readback_matches_requested_postcondition",
          },
          ...(readDescriptor ? { readDescriptor } : {}),
        });
      });

      const editAssignment = async (assignmentId: string, name: string, suffix: string) => {
        const planned = await runtime.call("canvas_edit_assignment", {
          course_id: "42",
          id: assignmentId,
          assignment_name: name,
          _morrow: {
            operation_id: `operation:canvas-recovery-${suffix}`,
            source_binding_id: SOURCE_BINDING_ID,
          },
        });
        expect(structured(planned)).toMatchObject({ status: "awaiting_approval" });
        const id = operationId(planned);
        runtime.approveOperation(id);
        return id;
      };

      // 1. A change whose outcome Canvas never confirmed.
      nextWriteOutcomeUnknown = true;
      const first = await editAssignment("88", "Cell transport reflection v2", "first");
      const dispatched = await runtime.dispatchOperation(first);
      expect(structured(dispatched)).toMatchObject({ effectState: "applied_or_unknown" });
      expect(writeCommands).toBe(1);
      const unresolved = runtime.effects.get(first);
      expect(unresolved.state).toBe("applied_or_unknown");
      expect(unresolved.connectorReadDescriptor).toMatchObject({
        schema: "morrow.canvas-recovery-descriptor.v1",
        strategy: "updated-resource",
        writeMethod: "PUT",
        read: { readTool: "canvas_get_single_assignment", arguments: { course_id: "42", id: "88" } },
      });
      // The retained comparator is a route, its ids and the approved field value.
      expect(JSON.stringify(unresolved.connectorReadDescriptor)).not.toContain("https://");

      // 2. The unresolved target is locked: a second change to it is not sent.
      const second = await editAssignment("88", "Cell transport reflection v3", "second");
      const blocked = await runtime.dispatchOperation(second);
      expect(blocked.isError).toBe(true);
      expect(structured(blocked)).toMatchObject({ data: { reason: "provider_effect_target_conflict" } });
      expect(runtime.effects.get(second)).toMatchObject({ state: "approved", dispatchAttempt: 0 });
      expect(writeCommands).toBe(1);

      // 3. Canvas does not hold the requested result: the record stays unresolved.
      const mismatched = await runtime.reconcileOperation(first);
      expect(structured(mismatched)).toMatchObject({
        phase: "readback_unconfirmed",
        effectState: "applied_or_unknown",
        data: { verification: { status: "mismatch", evidence: "requested_field_mismatch:assignment_name" } },
      });
      expect(runtime.effects.get(first).state).toBe("applied_or_unknown");
      expect(writeCommands).toBe(1);

      // 4. Canvas holds the requested result: the record settles to verified.
      assignments["88"] = { ...assignments["88"]!, name: "Cell transport reflection v2" };
      const settled = await runtime.reconcileOperation(first);
      expect(structured(settled)).toMatchObject({
        phase: "verified_readback",
        effectState: "verified",
        verification: { status: "verified" },
        data: {
          schema: "morrow.canvas-operation-recovery.v1",
          resentWrite: false,
          verification: { status: "verified", readTool: "canvas_get_single_assignment" },
        },
      });
      expect(runtime.effects.get(first)).toMatchObject({ state: "verified", verificationStatus: "verified" });
      expect(writeCommands).toBe(1);

      // 5. Only a verified settlement releases the target lock.
      const released = await runtime.dispatchOperation(second);
      expect(released.isError).not.toBe(true);
      expect(structured(released)).toMatchObject({ effectState: "verified" });
      expect(writeCommands).toBe(2);

      // 6. A changed course connection refuses the check and reads nothing.
      nextWriteOutcomeUnknown = true;
      const third = await editAssignment("99", "Osmosis lab revised", "third");
      await runtime.dispatchOperation(third);
      expect(runtime.effects.get(third).state).toBe("applied_or_unknown");
      expect(writeCommands).toBe(3);
      assignments["99"] = { ...assignments["99"]!, name: "Osmosis lab revised" };
      bridge.updateBindings([binding(2)]);
      await waitUntil(async () => {
        const bindings = await runtime.callSourceOwned("morrow_browser_bindings", {});
        return JSON.stringify(structured(bindings)).includes("\"sessionGeneration\":2");
      }, "the changed course connection did not reach the connector");
      const refused = await runtime.reconcileOperation(third);
      expect(structured(refused)).toMatchObject({
        phase: "reconciliation_refused_binding_changed",
        effectState: "applied_or_unknown",
      });
      expect(structured(refused).limitations).toContain(
        "Morrow did not check this change because the connected Canvas course, sign-in or session is not the one the change was sent from. Open that course in Chrome, connect it again, then ask Morrow to check this saved request.",
      );
      expect(runtime.effects.get(third).state).toBe("applied_or_unknown");
      expect(writeCommands).toBe(3);

      // The same course connection resolves the same record.
      bridge.updateBindings([binding(1)]);
      await waitUntil(async () => {
        const bindings = await runtime.callSourceOwned("morrow_browser_bindings", {});
        return JSON.stringify(structured(bindings)).includes("\"sessionGeneration\":1");
      }, "the original course connection did not reach the connector");
      const recovered = await runtime.reconcileOperation(third);
      expect(structured(recovered)).toMatchObject({ phase: "verified_readback", effectState: "verified" });
      expect(writeCommands).toBe(3);

      // 7. An unconfirmed create is judged on the parent collection.
      nextWriteOutcomeUnknown = true;
      const created = await runtime.call("canvas_create_assignment_group", {
        course_id: "42",
        name: "Weekly labs",
        position: "2",
        _morrow: {
          operation_id: "operation:canvas-recovery-create",
          source_binding_id: SOURCE_BINDING_ID,
        },
      });
      const createId = operationId(created);
      runtime.approveOperation(createId);
      await runtime.dispatchOperation(createId);
      expect(runtime.effects.get(createId).state).toBe("applied_or_unknown");
      expect(runtime.effects.get(createId).connectorReadDescriptor).toMatchObject({
        strategy: "created-resource",
        writeMethod: "POST",
        collection: { readTool: "canvas_list_assignment_groups", arguments: { course_id: "42" } },
      });
      expect(writeCommands).toBe(4);

      // Two matching records with no creation time cannot be told apart from
      // course work that was already there, so the check reports a duplicate.
      assignmentGroups = [
        ...assignmentGroups,
        { id: "301", course_id: "42", name: "Weekly labs", position: 2 },
        { id: "302", course_id: "42", name: "Weekly labs", position: 2 },
      ];
      const undated = await runtime.reconcileOperation(createId);
      expect(structured(undated)).toMatchObject({
        phase: "duplicate_effect_suspected",
        effectState: "applied_or_unknown",
        data: {
          duplicateScan: {
            readTool: "canvas_list_assignment_groups",
            outcome: "duplicate",
            reason: "multiple_matching_records_without_creation_time",
            matchedRecords: 2,
          },
        },
      });

      // Two records created inside this request's window: the same verdict, and
      // a next action the instructor can take.
      const sentAt = new Date().toISOString();
      assignmentGroups = [
        assignmentGroups[0]!,
        { id: "301", course_id: "42", name: "Weekly labs", position: 2, created_at: sentAt },
        { id: "302", course_id: "42", name: "Weekly labs", position: 2, created_at: sentAt },
      ];
      const duplicated = await runtime.reconcileOperation(createId);
      expect(structured(duplicated)).toMatchObject({
        phase: "duplicate_effect_suspected",
        effectState: "applied_or_unknown",
        data: { duplicateScan: { outcome: "duplicate", reason: "multiple_records_created_in_operation_window", matchedRecords: 2 } },
      });
      expect(structured(duplicated).limitations).toContain(
        "Canvas holds more than one record that matches this request from the time it was sent, so the change may have been created twice. Open the course in Canvas and delete the copies you do not want. Morrow will not send or remove anything for you.",
      );
      expect(runtime.effects.get(createId).state).toBe("applied_or_unknown");
      expect(writeCommands).toBe(4);

      // One record created inside the window settles the same record.
      assignmentGroups = [assignmentGroups[0]!, assignmentGroups[1]!];
      const single = await runtime.reconcileOperation(createId);
      expect(structured(single)).toMatchObject({
        phase: "verified_readback",
        effectState: "verified",
        data: { duplicateScan: { outcome: "single", matchedRecords: 1 } },
      });
      expect(runtime.effects.get(createId)).toMatchObject({ state: "verified", verificationStatus: "verified" });

      // Nothing in this whole recovery sent a change to Canvas.
      expect(writeCommands).toBe(4);
    } finally {
      await bridge?.close();
      await morrow.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
