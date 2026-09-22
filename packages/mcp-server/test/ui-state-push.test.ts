import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
