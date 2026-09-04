import { randomUUID } from "node:crypto";
import {
  BridgeOutcomeUnknownError,
  BridgeUnavailableError,
  LoopbackBridgeServer,
  bridgeFailureResult,
  type LoopbackBridgeHealth,
} from "@morrow/bridge-loopback";
import {
  splitBridgeCallArguments,
  type BridgeBinding,
  type BridgeProblem,
} from "@morrow/bridge-protocol";
import { isJsonObject, type JsonObject, type UpstreamTool } from "@morrow/contracts";
import type { SourceCatalogSnapshot } from "@morrow/gateway-core";
import type { LegacyBridgeConfig } from "./config.js";

export interface LegacyBridgeRuntimeHealth {
  readonly schema: "morrow.legacy-bridge.health.v1";
  readonly source: {
    readonly id: string;
    readonly revision: string;
    readonly toolCount: number;
    readonly digest: string;
  };
  readonly bridge: LoopbackBridgeHealth;
}

function operationId(value: string | undefined): string {
  return value || `operation:${randomUUID()}`;
}

function toolByName(catalog: SourceCatalogSnapshot, name: string): UpstreamTool {
  const tool = catalog.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Morrow legacy bridge has no source tool named ${name}`);
  return tool;
}

function resultObject(value: unknown): JsonObject {
  if (isJsonObject(value)) return structuredClone(value);
  return { value: value === undefined ? null : value };
}

function failedProblem(problem: BridgeProblem | undefined): JsonObject {
  return {
    schema: "morrow.legacy-bridge.result.v1",
    ok: false,
    problem: problem || {
      schema: "morrow.bridge.problem.v1",
      code: "bridge_result_missing",
      message: "The extension bridge returned no result.",
      recoverable: false,
    },
  };
}

export class LegacyBridgeRuntime {
  readonly catalog: SourceCatalogSnapshot;
  readonly bridge: LoopbackBridgeServer;

  private constructor(config: LegacyBridgeConfig, bridge: LoopbackBridgeServer) {
    this.catalog = config.sourceCatalog;
    this.bridge = bridge;
  }

  static async start(config: LegacyBridgeConfig): Promise<LegacyBridgeRuntime> {
    const bridge = new LoopbackBridgeServer({
      token: config.token,
      expectedDonorRevision: config.expectedRevision,
      expectedCatalogDigest: config.sourceCatalog.digest,
      allowedExtensionIds: config.allowedExtensionIds,
      port: config.port,
    });
    await bridge.start();
    return new LegacyBridgeRuntime(config, bridge);
  }

  health(): LegacyBridgeRuntimeHealth {
    return {
      schema: "morrow.legacy-bridge.health.v1",
      source: {
        id: this.catalog.source.id,
        revision: this.catalog.source.revision || "unknown",
        toolCount: this.catalog.count,
        digest: this.catalog.digest,
      },
      bridge: this.bridge.health(),
    };
  }

  bindings(): readonly BridgeBinding[] {
    return this.bridge.listBindings();
  }

  async call(sourceToolName: string, rawArguments: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    const tool = toolByName(this.catalog, sourceToolName);
    const split = splitBridgeCallArguments(rawArguments);
    const kind = tool.annotations?.readOnlyHint === true ? "invoke_read" : "stage_write";
    try {
      const response = await this.bridge.invoke({
        kind,
        toolName: tool.name,
        arguments: split.arguments,
        sourceBindingId: split.options.sourceBindingId,
        operationId: operationId(split.options.operationId),
        ...(split.options.outerGrant ? { outerGrant: split.options.outerGrant } : {}),
      });
      if (!response.ok) return failedProblem(response.problem);
      return {
        schema: "morrow.legacy-bridge.result.v1",
        ok: true,
        sourceToolName: tool.name,
        commandKind: kind,
        result: resultObject(response.result),
      };
    } catch (error) {
      const problem = bridgeFailureResult(error);
      return {
        schema: "morrow.legacy-bridge.result.v1",
        ok: false,
        sourceToolName: tool.name,
        commandKind: kind,
        problem,
        ...(error instanceof BridgeOutcomeUnknownError
          ? { operationId: error.operationId, resultState: "unknown" }
          : {}),
        ...(error instanceof BridgeUnavailableError ? { resultState: "not_sent" } : {}),
      };
    }
  }

  async taskGet(taskId: string, sourceBindingId?: string): Promise<JsonObject> {
    try {
      const response = await this.bridge.invoke({
        kind: "task_get",
        taskId,
        sourceBindingId,
      });
      if (!response.ok) return failedProblem(response.problem);
      return {
        schema: "morrow.legacy-bridge.task.v1",
        ok: true,
        task: resultObject(response.result),
      };
    } catch (error) {
      return {
        schema: "morrow.legacy-bridge.task.v1",
        ok: false,
        problem: bridgeFailureResult(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }
}
