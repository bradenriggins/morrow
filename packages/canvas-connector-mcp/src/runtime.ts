import { randomUUID } from "node:crypto";
import { BridgeOutcomeUnknownError, BridgeUnavailableError, LoopbackBridgeServer, bridgeFailureResult } from "@morrow/bridge-loopback";
import { splitBridgeCallArguments, type BridgeBinding, type BridgeProblem } from "@morrow/bridge-protocol";
import { canvasOperationMap, loadCanvasApiCatalog, type CanvasApiCatalog, type CanvasApiOperation } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type { CanvasConnectorConfig } from "./config.js";

function resultObject(value: unknown): JsonObject {
  return isJsonObject(value) ? structuredClone(value) : { value: value ?? null };
}

function failedProblem(problem: BridgeProblem | undefined): JsonObject {
  return {
    schema: "morrow.canvas-connector.result.v1",
    ok: false,
    problem: problem || {
      schema: "morrow.bridge.problem.v1",
      code: "bridge_result_missing",
      message: "The Canvas connector returned no result.",
      recoverable: false,
    },
  };
}

export class CanvasConnectorRuntime {
  readonly catalog: CanvasApiCatalog;
  readonly bridge: LoopbackBridgeServer;
  readonly operations: ReadonlyMap<string, CanvasApiOperation>;

  private constructor(catalog: CanvasApiCatalog, bridge: LoopbackBridgeServer) {
    this.catalog = catalog;
    this.bridge = bridge;
    this.operations = canvasOperationMap(catalog);
  }

  static async start(config: CanvasConnectorConfig): Promise<CanvasConnectorRuntime> {
    const catalog = loadCanvasApiCatalog(config.catalogPath);
    const bridge = new LoopbackBridgeServer({
      token: config.token,
      expectedRuntimeRevision: config.runtimeRevision,
      expectedCatalogDigest: catalog.catalogDigest,
      allowedExtensionIds: config.allowedExtensionIds,
      port: config.port,
      pairingEnabled: true,
      onPairApproved: config.approveExtensionId,
    });
    try {
      await bridge.start();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        throw new Error(`Morrow's Chrome bridge port ${config.port} is already in use. Only one AI client can run this Morrow installation at a time. The existing bridge was not changed.`, { cause: error });
      }
      throw error;
    }
    return new CanvasConnectorRuntime(catalog, bridge);
  }

  health(): JsonObject {
    return {
      schema: "morrow.canvas-connector.health.v1",
      ready: this.bridge.health().connected,
      catalogDigest: this.catalog.catalogDigest,
      operationCount: this.catalog.counts.totalOperations,
      newQuizzesOperationCount: this.catalog.counts.newQuizzesOperations,
      itemBankOperationCount: this.catalog.counts.itemBankOperations,
      bridge: this.bridge.health(),
    };
  }

  bindings(): readonly BridgeBinding[] {
    return this.bridge.listBindings();
  }

  async call(toolName: string, rawArguments: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    const operation = this.operations.get(toolName);
    if (!operation) throw new Error(`Canvas connector has no operation named ${toolName}`);
    if (operation.service === "item_bank" && !operation.readOnly && operation.nickname !== "create_bank") {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "item_bank_dependency_review_required",
        message: "Changes to an existing Item Bank require a complete dependency and affected-course review. This release cannot yet establish that evidence.",
        recoverable: false,
      });
    }
    const split = splitBridgeCallArguments(rawArguments);
    const kind = operation.readOnly ? "invoke_read" : "invoke_write";
    try {
      const response = await this.bridge.invoke({
        kind,
        toolName,
        operationKey: operation.key,
        arguments: split.arguments,
        sourceBindingId: split.options.sourceBindingId,
        operationId: split.options.operationId || `operation:${randomUUID()}`,
        ...(split.options.outerGrant ? { outerGrant: split.options.outerGrant } : {}),
      });
      if (!response.ok) return failedProblem(response.problem);
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        toolName,
        operationKey: operation.key,
        commandKind: kind,
        result: resultObject(response.result),
      };
    } catch (error) {
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        toolName,
        operationKey: operation.key,
        commandKind: kind,
        problem: bridgeFailureResult(error),
        ...(error instanceof BridgeOutcomeUnknownError ? { resultState: "unknown" } : {}),
        ...(error instanceof BridgeUnavailableError ? { resultState: "not_sent" } : {}),
      };
    }
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }
}
