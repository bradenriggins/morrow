import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeCommand } from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

/**
 * WI-2.4 (D1b): after an operation for a browser course enters or leaves
 * `awaiting_approval`, the runtime pushes the present list of reviews that
 * wait to the Bridge popup with `morrow_browser_ui_state`. A push that fails,
 * or cannot be sent, must never fail the plan that triggered it.
 */
const CASE_TIMEOUT_MS = 30_000;

function operationId(result: JsonObject): string {
  const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
  if (typeof value !== "string") throw new Error(`operation id missing: ${JSON.stringify(result)}`);
  return value;
}

function connectorConfig(directory: string, port: number) {
  const root = resolve("../..");
  const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
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
        MORROW_CANVAS_CATALOG_PATH: catalogPath,
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

describe("WI-2.4: the reviews that wait, pushed to the Bridge popup", () => {
  let directory = "";
  let bridge: BridgeTestClient | undefined;
  let runtime: GatewayRuntime | undefined;

  afterEach(async () => {
    await bridge?.close().catch(() => {});
    bridge = undefined;
    await runtime?.close();
    runtime = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = "";
  });

  it("pushes the present list on entry and on exit, and a disconnected Bridge never fails the plan", async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-ui-state-"));
    const port = await reserveLoopbackPort();
    const config = connectorConfig(directory, port);
    runtime = await GatewayRuntime.connect(config);
    runtime.setApprovalBaseUrl("http://127.0.0.1:4317");

    const root = resolve("../..");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const sourceBindingId = "canvas:ui-state-test";
    const uiStateCommands: BridgeCommand[] = [];
    bridge = await connectBridgeTestClient({
      port,
      token: "gateway-connector-secret-".repeat(3),
      extensionId: "a".repeat(32),
      catalogDigest: browserDigest,
      bindings: [{
        sourceBindingId, provider: "canvas", origin: "https://school.instructure.com",
        courseId: "42", principalFingerprint: "c".repeat(64), sessionGeneration: 1,
        catalogDigest: browserDigest, runtimeVerified: true, editPolicyRevision: 0, editOptionsAvailable: true,
      }],
    });
    bridge.onCommand((command) => {
      if (command.kind === "ui_state") {
        uiStateCommands.push(command);
        bridge!.respond(command, {});
        return;
      }
      // No case here dispatches or approves, so nothing else should arrive.
      bridge!.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "unexpected_command", message: "unexpected command in this case", recoverable: false });
    });
    await assertPortListening(port);

    // No active Edit grant covers this course, so the write goes to review
    // (D2a): planning it is what enters `awaiting_approval`.
    const planned = await runtime.call("canvas_edit_assignment", {
      course_id: "42", id: "88", assignment_due_at: "2026-09-10T17:00:00Z",
      _morrow: { source_binding_id: sourceBindingId },
    });
    expect(planned.isError).not.toBe(true);
    const id = operationId(planned);
    expect(runtime.operationGet(id)).toMatchObject({ state: "awaiting_approval" });

    const opened = await bridge.waitForCommand((command) => command.kind === "ui_state");
    expect(opened.uiState).toMatchObject({
      reviews: [{ url: `http://127.0.0.1:4317/operations/${id}` }],
    });
    expect(opened.uiState?.reviews).toHaveLength(1);
    expect(String(opened.uiState?.reviews[0]?.label)).toContain("course 42");

    // The person's browser disconnects. Cancelling the operation still tries
    // to push the now-empty list, and that push has nowhere to land: the
    // cancellation itself must still complete cleanly (WI-2.4, "A failed
    // ui_state must never fail a plan").
    await bridge.close();
    bridge = undefined;
    const cancelled = runtime.cancelOperation(id);
    expect(cancelled).toMatchObject({ state: "cancelled" });
    expect(runtime.operationGet(id)).toMatchObject({ state: "cancelled" });
  }, CASE_TIMEOUT_MS);

  // A reconnect (laptop sleep, a Chrome restart, a Bridge reload) clears the Bridge's review list,
  // badge and approval key, so every new connection receives the present list again.
  it("sends the present list and the approval key again to a Bridge that reconnects", async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-ui-state-"));
    const port = await reserveLoopbackPort();
    runtime = await GatewayRuntime.connect(connectorConfig(directory, port));
    runtime.setApprovalBaseUrl("http://127.0.0.1:4317");
    const presence = { origin: "http://127.0.0.1:4317", key: "q".repeat(43) };
    runtime.setApprovalPresence(presence);
    const root = resolve("../..");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const sourceBindingId = "canvas:ui-state-reconnect-test";
    const binding = {
      sourceBindingId, provider: "canvas", origin: "https://school.instructure.com",
      courseId: "42", principalFingerprint: "c".repeat(64), sessionGeneration: 1,
      catalogDigest: browserDigest, runtimeVerified: true, editPolicyRevision: 0, editOptionsAvailable: true,
    };
    const connect = async () => {
      const client = await connectBridgeTestClient({
        port, token: "gateway-connector-secret-".repeat(3), extensionId: "a".repeat(32), catalogDigest: browserDigest, bindings: [binding],
      });
      const uiStates: BridgeCommand[] = [];
      client.onCommand((command) => {
        if (command.kind === "ui_state") {
          uiStates.push(command);
          client.respond(command, {});
          return;
        }
        client.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "unexpected_command", message: "unexpected command in this case", recoverable: false });
      });
      return { client, uiStates };
    };
    const received = (uiStates: BridgeCommand[], predicate: (command: BridgeCommand) => boolean) => vi.waitFor(() => {
      const found = uiStates.find(predicate);
      if (!found) throw new Error("no matching ui_state yet");
      return found;
    }, { timeout: 10_000, interval: 20 });

    let connection = await connect();
    bridge = connection.client;
    await assertPortListening(port);
    const planned = await runtime.call("canvas_edit_assignment", {
      course_id: "42", id: "88", assignment_due_at: "2026-09-10T17:00:00Z",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const id = operationId(planned);
    const review = { url: `http://127.0.0.1:4317/operations/${id}`, label: expect.stringContaining("course 42") };
    await received(connection.uiStates, (command) => command.uiState?.reviews.length === 1);

    await bridge.close();
    connection = await connect();
    bridge = connection.client;
    const replayed = await received(connection.uiStates, () => true);
    expect(replayed.uiState).toEqual({ reviews: [review], presence });
    expect(runtime.operationGet(id)).toMatchObject({ state: "awaiting_approval" });

    // A review that ends while no Bridge is connected is not listed again on the next connection.
    await bridge.close();
    runtime.cancelOperation(id);
    connection = await connect();
    bridge = connection.client;
    const current = await received(connection.uiStates, () => true);
    expect(current.uiState).toEqual({ reviews: [], presence });
  }, CASE_TIMEOUT_MS);

  it("hands the approval key to the Bridge with each push, and again when a review page opens", async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-ui-state-"));
    const port = await reserveLoopbackPort();
    const config = connectorConfig(directory, port);
    runtime = await GatewayRuntime.connect(config);
    runtime.setApprovalBaseUrl("http://127.0.0.1:4317");
    const presence = { origin: "http://127.0.0.1:4317", key: "q".repeat(43) };
    runtime.setApprovalPresence(presence);

    const root = resolve("../..");
    const browserDigest = bridgeCatalogDigestForTests(root);
    bridge = await connectBridgeTestClient({
      port,
      token: "gateway-connector-secret-".repeat(3),
      extensionId: "a".repeat(32),
      catalogDigest: browserDigest,
      bindings: [],
    });
    bridge.onCommand((command) => {
      if (command.kind === "ui_state") {
        bridge!.respond(command, {});
        return;
      }
      bridge!.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "unexpected_command", message: "unexpected command in this case", recoverable: false });
    });
    await assertPortListening(port);

    runtime.announceApprovalPresence();
    const announced = await bridge.waitForCommand((command) => command.kind === "ui_state");
    expect(announced.uiState).toEqual({ reviews: [], presence });
  }, CASE_TIMEOUT_MS);

  it("sends a review's label-to-name map only to the paired Bridge, and drops it when the review ends", async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-ui-state-"));
    const port = await reserveLoopbackPort();
    runtime = await GatewayRuntime.connect(connectorConfig(directory, port));
    runtime.setApprovalBaseUrl("http://127.0.0.1:4317");
    const root = resolve("../..");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const sourceBindingId = "canvas:ui-state-names-test";
    bridge = await connectBridgeTestClient({
      port,
      token: "gateway-connector-secret-".repeat(3),
      extensionId: "a".repeat(32),
      catalogDigest: browserDigest,
      bindings: [{
        sourceBindingId, provider: "canvas", origin: "https://school.instructure.com",
        courseId: "42", principalFingerprint: "c".repeat(64), sessionGeneration: 1,
        catalogDigest: browserDigest, runtimeVerified: true, editPolicyRevision: 0, editOptionsAvailable: true,
      }],
    });
    const uiStates: BridgeCommand[] = [];
    bridge.onCommand((command) => {
      if (command.kind === "ui_state") {
        uiStates.push(command);
        bridge!.respond(command, {});
        return;
      }
      bridge!.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "unexpected_command", message: "unexpected command in this case", recoverable: false });
    });
    await assertPortListening(port);

    const planned = await runtime.call("canvas_edit_assignment", {
      course_id: "42", id: "88", assignment_due_at: "2026-09-10T17:00:00Z",
      _morrow: { source_binding_id: sourceBindingId },
    });
    const id = operationId(planned);
    const pushed = (predicate: (command: BridgeCommand) => boolean) => vi.waitFor(() => {
      const found = uiStates.find(predicate);
      if (!found) throw new Error("no matching ui_state yet");
      return found;
    }, { timeout: 10_000, interval: 20 });
    await pushed((command) => command.uiState?.reviews.length === 1);

    runtime.setReviewLearnerNames(`/operations/${id}`, { "Student A1": "Jane Doe" });
    const named = await pushed((command) => Boolean(command.uiState?.learnerNames));
    expect(named.uiState?.learnerNames).toEqual([{ path: `/operations/${id}`, names: { "Student A1": "Jane Doe" } }]);
    // A path that is not a review, and a map with a label that is not Morrow's, are never sent.
    runtime.setReviewLearnerNames("/recent", { "Student A1": "Jane Doe" });
    runtime.setReviewLearnerNames(`/operations/${id}x`, { "Student 1": "Jane Doe" });
    // The educator cancels: the review ends, and the next push carries no names.
    runtime.cancelOperation(id);
    const ended = await pushed((command) => command.uiState?.reviews.length === 0);
    expect(ended.uiState?.learnerNames).toBeUndefined();
    expect(uiStates.at(-1)?.uiState?.learnerNames).toBeUndefined();
    expect(JSON.stringify(uiStates.map((command) => command.uiState?.learnerNames ?? []))).not.toContain("/recent");
  }, CASE_TIMEOUT_MS);

  it("never sends a key that belongs to another review origin", async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-ui-state-"));
    const port = await reserveLoopbackPort();
    runtime = await GatewayRuntime.connect(connectorConfig(directory, port));
    runtime.setApprovalBaseUrl("http://127.0.0.1:4317");
    expect(() => runtime!.setApprovalPresence({ origin: "http://127.0.0.1:9999", key: "q".repeat(43) }))
      .toThrow("approval key must belong to the approval service");
  }, CASE_TIMEOUT_MS);

  // WI-3.5: the review link label names the change with the catalog's curated plain
  // label, not the raw catalog title, wherever a review is offered (the assistant's
  // attention text and this popup list both call the same private helper).
  it("names a waiting review with the tool's curated plain label", async () => {
    directory = mkdtempSync(join(tmpdir(), "morrow-ui-state-"));
    const port = await reserveLoopbackPort();
    const config = connectorConfig(directory, port);
    runtime = await GatewayRuntime.connect(config);
    runtime.setApprovalBaseUrl("http://127.0.0.1:4317");

    const root = resolve("../..");
    const browserDigest = bridgeCatalogDigestForTests(root);
    const sourceBindingId = "canvas:ui-state-label-test";
    bridge = await connectBridgeTestClient({
      port,
      token: "gateway-connector-secret-".repeat(3),
      extensionId: "a".repeat(32),
      catalogDigest: browserDigest,
      bindings: [{
        sourceBindingId, provider: "canvas", origin: "https://school.instructure.com",
        courseId: "42", principalFingerprint: "c".repeat(64), sessionGeneration: 1,
        catalogDigest: browserDigest, runtimeVerified: true, editPolicyRevision: 0, editOptionsAvailable: true,
      }],
    });
    bridge.onCommand((command) => {
      if (command.kind === "ui_state") {
        bridge!.respond(command, {});
        return;
      }
      bridge!.respondProblem(command, { schema: "morrow.bridge.problem.v1", code: "unexpected_command", message: "unexpected command in this case", recoverable: false });
    });
    await assertPortListening(port);

    // A destructive tool always goes to review (D2a), so this needs no Edit grant.
    // The catalog's curated label for `canvas_delete_quiz` is "Remove a quiz", distinct
    // from its raw summary "Delete a quiz" (the pre-WI-3.5 fallback).
    const planned = await runtime.call("canvas_delete_quiz", {
      course_id: "42", id: "88",
      _morrow: { source_binding_id: sourceBindingId },
    });
    expect(planned.isError).not.toBe(true);
    const id = operationId(planned);
    expect(runtime.operationGet(id)).toMatchObject({ state: "awaiting_approval" });

    const opened = await bridge.waitForCommand((command) => command.kind === "ui_state");
    expect(opened.uiState?.reviews).toHaveLength(1);
    expect(opened.uiState?.reviews[0]).toMatchObject({
      url: `http://127.0.0.1:4317/operations/${id}`,
      label: "Remove a quiz in course 42",
    });
  }, CASE_TIMEOUT_MS);
});
