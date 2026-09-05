import { randomUUID } from "node:crypto";
import { BridgeOutcomeUnknownError, BridgeUnavailableError, LoopbackBridgeServer, bridgeFailureResult } from "@morrow/bridge-loopback";
import { splitBridgeCallArguments, type BridgeBinding, type BridgeProblem, type BridgeProvider } from "@morrow/bridge-protocol";
import { canvasOperationMap, loadCanvasApiCatalog, type CanvasApiCatalog, type CanvasApiOperation } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { bridgeCatalogDigest, loadMoodleBrowserCatalog, type MoodleBrowserCatalog, type MoodleBrowserOperation } from "./browser-catalog.js";
import type { CanvasConnectorConfig } from "./config.js";

function resultObject(value: unknown): JsonObject {
  return isJsonObject(value) ? structuredClone(value) : { value: value ?? null };
}

type ConnectorOperation = CanvasApiOperation | MoodleBrowserOperation;

function operationProvider(operation: ConnectorOperation): BridgeProvider {
  return "provider" in operation ? operation.provider : "canvas";
}

function isCanvasOperation(operation: ConnectorOperation): operation is CanvasApiOperation {
  return !("provider" in operation);
}

function exactMoodleCourseId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return undefined;
}

function failedProblem(problem: BridgeProblem | undefined, provider: BridgeProvider = "canvas"): JsonObject {
  return {
    schema: "morrow.canvas-connector.result.v1",
    ok: false,
    provider,
    ...(["canvas_request_not_sent", "page_guard_unavailable", "moodle_binding_required", "moodle_expected_digest_required", "moodle_binding_course_mismatch"].includes(problem?.code || "") ? { resultState: "not_sent" } : {}),
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
  readonly moodleCatalog: MoodleBrowserCatalog;
  readonly catalogDigest: string;
  readonly bridge: LoopbackBridgeServer;
  readonly operations: ReadonlyMap<string, ConnectorOperation>;

  private constructor(catalog: CanvasApiCatalog, moodleCatalog: MoodleBrowserCatalog, bridge: LoopbackBridgeServer) {
    this.catalog = catalog;
    this.moodleCatalog = moodleCatalog;
    this.catalogDigest = bridgeCatalogDigest(catalog, moodleCatalog);
    this.bridge = bridge;
    this.operations = new Map<string, ConnectorOperation>([
      ...[...canvasOperationMap(catalog)].map(([toolName, operation]) => [toolName, operation] as const),
      ...moodleCatalog.operations.map((operation) => [operation.toolName, operation] as const),
    ]);
    if (this.operations.size !== catalog.operations.length + moodleCatalog.operations.length) {
      throw new Error("Canvas and Moodle browser catalogs contain duplicate tool names.");
    }
  }

  static async start(config: CanvasConnectorConfig): Promise<CanvasConnectorRuntime> {
    const catalog = loadCanvasApiCatalog(config.catalogPath);
    const moodleCatalog = loadMoodleBrowserCatalog();
    const catalogDigest = bridgeCatalogDigest(catalog, moodleCatalog);
    const bridge = new LoopbackBridgeServer({
      token: config.token,
      expectedRuntimeRevision: config.runtimeRevision,
      expectedCatalogDigest: catalogDigest,
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
    return new CanvasConnectorRuntime(catalog, moodleCatalog, bridge);
  }

  health(): JsonObject {
    return {
      schema: "morrow.canvas-connector.health.v1",
      ready: this.bridge.health().connected,
      catalogDigest: this.catalogDigest,
      operationCount: this.operations.size,
      newQuizzesOperationCount: this.catalog.counts.newQuizzesOperations,
      itemBankOperationCount: this.catalog.counts.itemBankOperations,
      bridge: this.bridge.health(),
    };
  }

  bindings(): readonly BridgeBinding[] {
    return this.bridge.listBindings();
  }

  canvasBindings(): readonly BridgeBinding[] {
    return this.bindings().filter((binding) => binding.provider === "canvas");
  }

  async call(toolName: string, rawArguments: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    const operation = this.operations.get(toolName);
    if (!operation) throw new Error(`Canvas connector has no operation named ${toolName}`);
    const provider = operationProvider(operation);
    if (isCanvasOperation(operation) && operation.service === "item_bank" && !operation.readOnly && operation.nickname !== "create_bank") {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "item_bank_dependency_review_required",
        message: "Changes to an existing Item Bank require a complete dependency and affected-course review. This release cannot yet establish that evidence.",
        recoverable: false,
      }, provider);
    }
    const split = splitBridgeCallArguments(rawArguments);
    if ("morrow_page_guard" in split.arguments) throw new TypeError("Page checks must use Morrow's local controls.");
    if (split.options.pageGuard) {
      if (toolName !== "canvas_update_create_page_courses" || this.bridge.health().runtimeRevision !== "1.0.0-rc.2") {
        return failedProblem({ schema: "morrow.bridge.problem.v1", code: "page_guard_unavailable", message: "This page correction needs the current Morrow extension and a connected course.", recoverable: true }, provider);
      }
    }
    if (provider === "moodle" && !split.options.sourceBindingId) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "moodle_binding_required",
        message: "This Moodle action needs one exact current Moodle binding.",
        recoverable: true,
      }, provider);
    }
    if (provider === "moodle") {
      const binding = this.bindings().find((entry) => entry.sourceBindingId === split.options.sourceBindingId);
      const courseId = exactMoodleCourseId(split.arguments.course_id);
      if (binding?.provider === "moodle" && courseId && binding.courseId !== courseId) {
        return failedProblem({
          schema: "morrow.bridge.problem.v1",
          code: "moodle_binding_course_mismatch",
          message: "The selected Moodle binding is for a different course.",
          recoverable: true,
        }, provider);
      }
    }
    if (provider === "moodle" && !operation.readOnly && !/^[0-9a-f]{64}$/.test(String(split.arguments.expected_digest || ""))) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "moodle_expected_digest_required",
        message: "This Moodle change needs the snapshot digest from its exact preceding read.",
        recoverable: true,
      }, provider);
    }
    const kind = operation.readOnly ? "invoke_read" : "invoke_write";
    try {
      const response = await this.bridge.invoke({
        kind,
        toolName,
        operationKey: operation.key,
        arguments: { ...split.arguments, ...(split.options.pageGuard ? { morrow_page_guard: split.options.pageGuard } : {}) },
        sourceBindingId: split.options.sourceBindingId,
        operationId: split.options.operationId || `operation:${randomUUID()}`,
        ...(split.options.outerGrant ? { outerGrant: split.options.outerGrant } : {}),
      });
      if (!response.ok) return failedProblem(response.problem, provider);
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        provider,
        toolName,
        operationKey: operation.key,
        commandKind: kind,
        result: resultObject(response.result),
      };
    } catch (error) {
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        provider,
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
