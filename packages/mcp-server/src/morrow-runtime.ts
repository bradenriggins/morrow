import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  BatchSourceSettlementStore,
  DurableBatchStore,
  loadOrCreateBatchEncryptionKey,
  recoverBatchState,
  runBatchWindow,
  taskProjectionFromGatewayResult,
  type BatchChildRecord,
  type BatchCourseSetInput,
  type BatchExecutionResult,
  type BatchMode,
  type BatchRatePolicyInput,
  type BatchRecord,
  type BatchSourceSettlementRecord,
  type BatchSourceSettlementSummary,
  type BatchState,
  type CreateBatchChildInput,
} from "@morrow/batch-engine";
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  type CatalogTool,
  type JsonObject,
} from "@morrow/contracts";
import type { GatewayConfig } from "./config.js";
import { LoopbackApprovalServer } from "./approval-server.js";
import { GatewayRuntime } from "./runtime.js";

export const MORROW_BATCH_TOOL_NAMES = Object.freeze([
  "morrow_batch_health",
  "morrow_batch_create",
  "morrow_batch_get",
  "morrow_batch_results_page",
  "morrow_batches_recent",
  "morrow_batch_run",
  "morrow_batch_resume",
  "morrow_batch_reconcile",
  "morrow_batch_pause",
  "morrow_batch_cancel",
] as const);

export interface CreateGatewayBatchOperationInput {
  readonly childId?: string;
  readonly courseId?: string;
  readonly tool: string;
  readonly arguments: JsonObject;
  readonly sourceBindingId?: string;
  readonly dependencyChildIds?: readonly string[];
  readonly sourceObservationDigest?: string;
  readonly readbackSpecDigest?: string;
  readonly correctionFactsDigest?: string;
}

export interface CreateGatewayBatchInput {
  readonly name: string;
  readonly mode: BatchMode;
  readonly concurrency: number;
  readonly operations: readonly CreateGatewayBatchOperationInput[];
  readonly operationFamily?: string;
  readonly courseSet?: BatchCourseSetInput;
  readonly profileDigest?: string;
  readonly planDigest?: string;
  readonly approvalPreviewDigest?: string;
  readonly requestEstimate?: number;
  readonly readbackSpecDigest?: string;
  readonly correctionFactsDigest?: string;
  readonly expiresAt?: string;
  readonly ratePolicy?: BatchRatePolicyInput;
}

export interface GatewayBatchPageInput {
  readonly batchId: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface RecentBatchesInput {
  readonly state?: BatchState;
  readonly limit?: number;
}

export interface RunGatewayBatchInput {
  readonly batchId: string;
  readonly maxChildren?: number;
  readonly courseSetDigest?: string;
  readonly profileDigest?: string;
  readonly ratePolicy?: BatchRatePolicyInput;
}

export interface ReconcileGatewayBatchInput {
  readonly batchId: string;
  readonly offset?: number;
  readonly maxChildren?: number;
  readonly includeTerminal?: boolean;
}

interface PreparedGatewayBatchChild {
  readonly child: CreateBatchChildInput;
  readonly sourceBindingId?: string;
}

interface ReconciledSourceTask {
  readonly settlement: BatchSourceSettlementRecord;
  readonly problemCode?: string;
  readonly problemDigest?: string;
}

const STABLE_SOURCE_SETTLEMENT_STATES = new Set([
  "succeeded",
  "failed_no_effect",
  "cancelled",
  "reverted",
]);

function publicTool(runtime: GatewayRuntime, name: string): CatalogTool {
  const normalized = String(name || "").trim();
  const tool = runtime.catalog.tools.find((candidate) => candidate.publicName === normalized);
  if (!tool) throw new Error(`Unknown Morrow tool ${normalized}.`);
  return tool;
}

function sourceTool(
  runtime: GatewayRuntime,
  sourceId: string,
  sourceToolName: string,
): CatalogTool {
  const matches = runtime.catalog.tools.filter((candidate) => (
    candidate.upstreamId === sourceId && candidate.upstreamName === sourceToolName
  ));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${sourceId} mapping for ${sourceToolName}; found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

function selectedSourceBindingId(
  rawArguments: JsonObject,
  explicitSourceBindingId?: string,
): string {
  const existing = isJsonObject(rawArguments._morrow) ? rawArguments._morrow : {};
  const embedded = typeof existing.source_binding_id === "string"
    ? existing.source_binding_id.trim()
    : "";
  const explicit = String(explicitSourceBindingId || "").trim();
  if (embedded && explicit && embedded !== explicit) {
    throw new Error("The child contains two different source binding ids");
  }
  return explicit || embedded;
}

function normalizeBatchArguments(
  mapping: CatalogTool,
  rawArguments: JsonObject,
  sourceBindingId: string,
): JsonObject {
  const args = structuredClone(rawArguments);
  if (mapping.upstreamId !== "example-legacy") {
    if (args._morrow !== undefined || sourceBindingId) {
      throw new Error("_morrow routing controls apply only to Morrow legacy tools");
    }
    return args;
  }

  const existing = isJsonObject(args._morrow) ? args._morrow : {};
  if (existing.operation_id !== undefined) {
    throw new Error("Batch operation identity is generated by Morrow and cannot be supplied in child arguments");
  }
  args._morrow = {
    ...(sourceBindingId ? { source_binding_id: sourceBindingId } : {}),
  };
  return args;
}

function sourceBindingIdFromStoredArguments(value: JsonObject): string | undefined {
  if (!isJsonObject(value._morrow)) return undefined;
  const sourceBindingId = typeof value._morrow.source_binding_id === "string"
    ? value._morrow.source_binding_id.trim()
    : "";
  return sourceBindingId || undefined;
}

function gatewayMeta(value: JsonObject): Record<string, unknown> | null {
  if (!isJsonObject(value._meta)) return null;
  const meta = value._meta["io.morrow/gateway"];
  return isJsonObject(meta) ? meta : null;
}

function gatewayOperationId(value: JsonObject): string | undefined {
  const meta = gatewayMeta(value);
  const operationId = typeof meta?.gatewayOperationId === "string"
    ? meta.gatewayOperationId.trim()
    : "";
  return operationId || undefined;
}

function problemCode(value: JsonObject): string {
  if (!isJsonObject(value.structuredContent)) return "";
  return typeof value.structuredContent.code === "string"
    ? value.structuredContent.code.trim()
    : "";
}

function problemDigest(value: JsonObject): string | undefined {
  if (!isJsonObject(value.structuredContent)) return undefined;
  const digest = typeof value.structuredContent.detailDigest === "string"
    ? value.structuredContent.detailDigest.trim()
    : "";
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function childResult(
  runtime: GatewayRuntime,
  batch: BatchRecord,
  child: BatchChildRecord,
  result: JsonObject,
): BatchExecutionResult {
  const meta = gatewayMeta(result);
  const operationId = typeof meta?.gatewayOperationId === "string"
    ? meta.gatewayOperationId
    : "";
  const operation = operationId
    ? runtime.operationGet(operationId)
    : null;
  const gatewayOperationState = isJsonObject(operation) && typeof operation.state === "string"
    ? operation.state
    : typeof meta?.gatewayOperationState === "string"
      ? meta.gatewayOperationState
      : "";
  const sourceResultState = isJsonObject(operation) && typeof operation.sourceResultState === "string"
    ? operation.sourceResultState
    : "";
  const sourceTaskId = isJsonObject(operation) && typeof operation.sourceTaskId === "string"
    ? operation.sourceTaskId
    : "";
  const resultDigest = sha256Json(result);

  if (gatewayOperationState === "source_unknown") {
    return {
      state: "unknown",
      resultDigest,
      ...(operationId ? { gatewayOperationId: operationId } : {}),
      gatewayOperationState,
      ...(sourceResultState ? { sourceResultState } : {}),
      ...(sourceTaskId ? { sourceTaskId } : {}),
      errorDigest: sha256Text("gateway_source_unknown"),
    };
  }

  if (result.isError === true) {
    return {
      state: problemCode(result) === "operation_already_recorded"
        && gatewayOperationState === "response_received"
        ? "succeeded"
        : "failed",
      resultDigest,
      ...(operationId ? { gatewayOperationId: operationId } : {}),
      ...(gatewayOperationState ? { gatewayOperationState } : {}),
      ...(sourceResultState ? { sourceResultState } : {}),
      ...(sourceTaskId ? { sourceTaskId } : {}),
      errorDigest: sha256Text(problemCode(result) || "gateway_tool_error"),
    };
  }

  if (batch.mode === "stage_writes" && !sourceTaskId) {
    return {
      state: "unknown",
      resultDigest,
      ...(operationId ? { gatewayOperationId: operationId } : {}),
      ...(gatewayOperationState ? { gatewayOperationState } : {}),
      ...(sourceResultState ? { sourceResultState } : {}),
      errorDigest: sha256Text("staged_write_missing_source_task"),
    };
  }

  return {
    state: "succeeded",
    resultDigest,
    ...(operationId ? { gatewayOperationId: operationId } : {}),
    ...(gatewayOperationState ? { gatewayOperationState } : {}),
    ...(sourceResultState ? { sourceResultState } : {}),
    ...(sourceTaskId ? { sourceTaskId } : {}),
  };
}

function statePath(config: GatewayConfig, override?: string): string {
  return override || config.operationJournal.path;
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        output[index] = await mapper(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

export class MorrowRuntime {
  readonly gateway: GatewayRuntime;
  readonly batches: DurableBatchStore;
  readonly sourceSettlements: BatchSourceSettlementStore;
  readonly approval: LoopbackApprovalServer;

  private constructor(
    gateway: GatewayRuntime,
    batches: DurableBatchStore,
    sourceSettlements: BatchSourceSettlementStore,
    approval: LoopbackApprovalServer,
  ) {
    this.gateway = gateway;
    this.batches = batches;
    this.sourceSettlements = sourceSettlements;
    this.approval = approval;
  }

  static async connect(
    config: GatewayConfig,
    options: { readonly statePath?: string; readonly batchKeyPath?: string } = {},
  ): Promise<MorrowRuntime> {
    const reserved = new Set([
      ...config.filters.excludeNames,
      ...MORROW_BATCH_TOOL_NAMES,
    ]);
    const effectiveConfig: GatewayConfig = {
      ...config,
      filters: {
        ...config.filters,
        excludeNames: [...reserved].sort(),
      },
    };
    const path = statePath(effectiveConfig, options.statePath);
    const gateway = await GatewayRuntime.connect(effectiveConfig, { journalPath: path });
    try {
      const key = path === ":memory:"
        ? randomBytes(32)
        : loadOrCreateBatchEncryptionKey(
          resolve(options.batchKeyPath || `${path}.batch.key`),
        );
      const batches = new DurableBatchStore({ path, encryptionKey: key });
      const sourceSettlements = new BatchSourceSettlementStore({ path });
      try {
        const approval = new LoopbackApprovalServer(gateway);
        await approval.start();
        const runtime = new MorrowRuntime(gateway, batches, sourceSettlements, approval);
        await runtime.recoverStartupBatches();
        return runtime;
      } catch (error) {
        sourceSettlements.close();
        batches.close();
        throw error;
      }
    } catch (error) {
      await gateway.close();
      throw error;
    }
  }

  private async recoverStartupBatches(): Promise<void> {
    const batches: BatchRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = this.batches.listPage(offset, 500);
      batches.push(...page.batches);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    for (const batch of batches) {
      try {
        if (["paused", "inspection_required"].includes(batch.state)) {
          recoverBatchState({
            path: this.batches.path,
            batchId: batch.batchId,
            mode: "apply_safe",
          });
        }
        if (batch.mode !== "stage_writes") continue;
        this.ensureSourceSettlementRows(batch.batchId);
        let reconciliationOffset = 0;
        for (;;) {
          const result = await this.batchReconcile({
            batchId: batch.batchId,
            offset: reconciliationOffset,
            maxChildren: 500,
          });
          const nextOffset = typeof result.nextOffset === "number" ? result.nextOffset : null;
          if (nextOffset === null) break;
          reconciliationOffset = nextOffset;
        }
      } catch {
        this.batches.quarantine(batch.batchId);
      }
    }
  }

  private ensureSourceSettlementRows(batchId: string): BatchSourceSettlementSummary {
    const batch = this.batches.getBatch(batchId);
    if (batch.mode !== "stage_writes") {
      return this.sourceSettlements.summary(batchId);
    }
    let offset = 0;
    for (;;) {
      const page = this.batches.listChildren(batchId, offset, 500);
      const identities = page.children.map((child) => {
        const argumentsValue = this.batches.readArguments(batchId, child.childId);
        return {
          childId: child.childId,
          sourceId: child.sourceId,
          ...(sourceBindingIdFromStoredArguments(argumentsValue)
            ? { sourceBindingId: sourceBindingIdFromStoredArguments(argumentsValue) }
            : {}),
        };
      });
      this.sourceSettlements.initialize(batchId, identities);

      for (const child of page.children) {
        const current = this.sourceSettlements.get(batchId, child.childId);
        if (child.sourceTaskId && !current.sourceTaskId) {
          this.sourceSettlements.markStaged(batchId, child.childId, {
            sourceTaskId: child.sourceTaskId,
            ...(child.gatewayOperationId ? { gatewayOperationId: child.gatewayOperationId } : {}),
            ...(child.sourceResultState ? { taskStatus: child.sourceResultState } : {}),
          });
        } else if (!child.sourceTaskId && current.state === "not_started") {
          if (child.state === "unknown") {
            this.sourceSettlements.markDispatchResult(
              batchId,
              child.childId,
              "unknown",
              child.gatewayOperationId || undefined,
            );
          } else if (child.state === "failed") {
            this.sourceSettlements.markDispatchResult(
              batchId,
              child.childId,
              "failed",
              child.gatewayOperationId || undefined,
            );
          }
        }
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return this.sourceSettlements.summary(batchId);
  }

  private settlementPage(
    batchId: string,
    children: readonly BatchChildRecord[],
  ): readonly BatchSourceSettlementRecord[] {
    const rows: BatchSourceSettlementRecord[] = [];
    for (const child of children) {
      try {
        rows.push(this.sourceSettlements.get(batchId, child.childId));
      } catch {
        // Read-only batches intentionally have no source-task settlement rows.
      }
    }
    return rows;
  }

  batchHealth(): JsonObject {
    const recent = this.batches.list(200);
    const stageWriteBatches = recent.filter((batch) => batch.mode === "stage_writes");
    const summaries = stageWriteBatches.map((batch) => this.sourceSettlements.summary(batch.batchId));
    return {
      schema: "morrow.batch-store.health.v1",
      path: this.batches.path,
      recentBatchCount: recent.length,
      recentCoverageComplete: recent.length < 200,
      activeBatches: recent.filter((batch) => ["planned", "running", "paused"].includes(batch.state)).length,
      inspectionRequiredBatches: recent.filter((batch) => batch.state === "inspection_required").length,
      stageWriteBatchCount: stageWriteBatches.length,
      awaitingSourceApprovalBatches: summaries.filter((summary) => summary.outcome === "awaiting_approval").length,
      sourceAttentionBatches: summaries.filter((summary) => summary.requiresAttention).length,
    };
  }

  batchCreate(input: CreateGatewayBatchInput): JsonObject {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new Error("A batch requires at least one explicit operation");
    }

    const prepared: PreparedGatewayBatchChild[] = input.operations.map((operation) => {
      const mapping = publicTool(this.gateway, operation.tool);
      const readOnly = mapping.annotations?.readOnlyHint === true;
      const sourceBindingId = selectedSourceBindingId(operation.arguments, operation.sourceBindingId);
      if (input.mode === "read_only" && !readOnly) {
        throw new Error(`read_only batch cannot include ${mapping.publicName}`);
      }
      if (input.mode === "stage_writes" && (readOnly || mapping.upstreamId !== "example-legacy")) {
        throw new Error(
          `stage_writes batch currently accepts only Morrow legacy write tools; ${mapping.publicName} is not eligible`,
        );
      }
      if (input.mode === "stage_writes" && !sourceBindingId) {
        throw new Error(
          `stage_writes child ${operation.childId || mapping.publicName} requires an exact source_binding_id`,
        );
      }
      return {
        ...(sourceBindingId ? { sourceBindingId } : {}),
        child: {
          ...(operation.childId ? { childId: operation.childId } : {}),
          ...(operation.courseId ? { courseId: operation.courseId } : {}),
          publicToolName: mapping.publicName,
          sourceId: mapping.upstreamId,
          sourceToolName: mapping.upstreamName,
          readOnly,
          arguments: normalizeBatchArguments(mapping, operation.arguments, sourceBindingId),
          ...(operation.dependencyChildIds ? { dependencyChildIds: operation.dependencyChildIds } : {}),
          ...(operation.sourceObservationDigest ? { sourceObservationDigest: operation.sourceObservationDigest } : {}),
          ...(operation.readbackSpecDigest ? { readbackSpecDigest: operation.readbackSpecDigest } : {}),
          ...(operation.correctionFactsDigest ? { correctionFactsDigest: operation.correctionFactsDigest } : {}),
        },
      };
    });

    const concurrency = input.mode === "stage_writes"
      ? Math.min(input.concurrency, 4)
      : input.concurrency;
    const detail = this.batches.create({
      name: input.name,
      mode: input.mode,
      catalogDigest: this.gateway.catalog.digest,
      concurrency,
      children: prepared.map((entry) => entry.child),
      ...(input.operationFamily ? { operationFamily: input.operationFamily } : {}),
      ...(input.courseSet ? { courseSet: input.courseSet } : {}),
      ...(input.profileDigest ? { profileDigest: input.profileDigest } : {}),
      ...(input.planDigest ? { planDigest: input.planDigest } : {}),
      ...(input.approvalPreviewDigest ? { approvalPreviewDigest: input.approvalPreviewDigest } : {}),
      ...(input.requestEstimate === undefined ? {} : { requestEstimate: input.requestEstimate }),
      ...(input.readbackSpecDigest ? { readbackSpecDigest: input.readbackSpecDigest } : {}),
      ...(input.correctionFactsDigest ? { correctionFactsDigest: input.correctionFactsDigest } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.ratePolicy ? { ratePolicy: input.ratePolicy } : {}),
    });

    if (input.mode === "stage_writes") {
      this.sourceSettlements.initialize(
        detail.batch.batchId,
        detail.children.map((child, index) => ({
          childId: child.childId,
          sourceId: child.sourceId,
          ...(prepared[index]?.sourceBindingId
            ? { sourceBindingId: prepared[index]!.sourceBindingId }
            : {}),
        })),
      );
    }

    return {
      schema: "morrow.batch-created.v1",
      batch: detail.batch,
      manifest: detail.manifest,
      sourceSettlement: this.sourceSettlements.summary(detail.batch.batchId),
      returnedChildren: Math.min(detail.children.length, 25),
      children: detail.children.slice(0, 25),
      note: input.mode === "stage_writes"
        ? "Running this batch stages donor tasks only. Provider success remains separate and requires source-task reconciliation after human approval."
        : "Running this batch performs bounded read-only operations.",
    };
  }

  batchGet(input: GatewayBatchPageInput): JsonObject {
    const page = this.batches.listChildren(
      input.batchId,
      input.offset ?? 0,
      input.limit ?? 100,
    );
    return {
      schema: "morrow.batch-detail.v1",
      batch: page.batch,
      manifest: this.batches.getManifest(input.batchId),
      sourceSettlement: this.sourceSettlements.summary(input.batchId),
      offset: page.offset,
      returned: page.returned,
      nextOffset: page.nextOffset,
      children: page.children,
      sourceSettlements: this.settlementPage(input.batchId, page.children),
    };
  }

  batchResultsPage(input: GatewayBatchPageInput): JsonObject {
    const detail = this.batchGet(input);
    return {
      ...detail,
      schema: "morrow.batch-results-page.v1",
    } as JsonObject;
  }

  batchesRecent(input: RecentBatchesInput = {}): JsonObject {
    const requestedLimit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const candidates = this.batches.list(input.state ? 200 : requestedLimit);
    const batches = (input.state
      ? candidates.filter((batch) => batch.state === input.state)
      : candidates
    ).slice(0, requestedLimit);
    return {
      schema: "morrow.batches.list.v1",
      returned: batches.length,
      batches: batches.map((batch) => ({
        ...batch,
        sourceSettlement: this.sourceSettlements.summary(batch.batchId),
      })),
    };
  }

  async batchRun(input: RunGatewayBatchInput): Promise<JsonObject> {
    const sourceSummaryBefore = this.ensureSourceSettlementRows(input.batchId);
    const result = await runBatchWindow(
      this.batches,
      input.batchId,
      async ({ batch, child, arguments: args }) => {
        const forwarded = structuredClone(args) as Record<string, unknown>;
        if (child.sourceId === "example-legacy" && child.sourceOperationId) {
          forwarded._morrow = {
            ...(isJsonObject(forwarded._morrow) ? forwarded._morrow : {}),
            operation_id: child.sourceOperationId,
          };
        }
        const resultValue = await this.gateway.callSourceOwned(child.publicToolName, forwarded);
        const outcome = childResult(this.gateway, batch, child, resultValue);
        if (batch.mode === "stage_writes") {
          try {
            if (outcome.state === "succeeded" && outcome.sourceTaskId) {
              this.sourceSettlements.markStaged(batch.batchId, child.childId, {
                sourceTaskId: outcome.sourceTaskId,
                ...(outcome.gatewayOperationId
                  ? { gatewayOperationId: outcome.gatewayOperationId }
                  : {}),
                ...(outcome.sourceResultState
                  ? { taskStatus: outcome.sourceResultState }
                  : {}),
              });
            } else {
              this.sourceSettlements.markDispatchResult(
                batch.batchId,
                child.childId,
                outcome.state === "unknown" ? "unknown" : "failed",
                outcome.gatewayOperationId,
              );
            }
          } catch (error) {
            const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
            return {
              ...outcome,
              state: "unknown",
              errorDigest: sha256Text(`source_settlement_record_failed:${detail}`),
            };
          }
        }
        return outcome;
      },
      {
        expectedCatalogDigest: this.gateway.catalog.digest,
        maxChildren: input.maxChildren,
        ...(input.courseSetDigest ? { expectedCourseSetDigest: input.courseSetDigest } : {}),
        ...(input.profileDigest ? { expectedProfileDigest: input.profileDigest } : {}),
        ...(input.ratePolicy ? { ratePolicy: input.ratePolicy } : {}),
      },
    );
    const sourceSettlement = this.sourceSettlements.summary(input.batchId);
    return {
      ...result,
      sourceSettlementBefore: sourceSummaryBefore,
      sourceSettlement,
      sourceSettlements: this.settlementPage(input.batchId, result.children),
      ...(result.batch.mode === "stage_writes"
        ? {
            providerOutcomeFinal: sourceSettlement.terminal,
            note: "Batch orchestration state reports whether task staging finished. sourceSettlement reports the separately reconciled provider outcome.",
          }
        : { providerOutcomeFinal: result.batch.state === "completed" }),
    } as unknown as JsonObject;
  }

  async batchResume(input: RunGatewayBatchInput): Promise<JsonObject> {
    const result = await this.batchRun(input);
    return {
      ...result,
      schema: "morrow.batch-resumed.v1",
    } as JsonObject;
  }

  async batchReconcile(input: ReconcileGatewayBatchInput): Promise<JsonObject> {
    const batch = this.batches.getBatch(input.batchId);
    const sourceSettlementBefore = this.ensureSourceSettlementRows(input.batchId);
    if (batch.mode !== "stage_writes") {
      return {
        schema: "morrow.batch-reconciliation.v1",
        batch,
        sourceSettlementBefore,
        sourceSettlement: sourceSettlementBefore,
        offset: 0,
        scanned: 0,
        processed: 0,
        nextOffset: null,
        settlements: [],
        problems: [],
        note: "Read-only batches have no separately approved source tasks to reconcile.",
      };
    }

    const inspectionTool = sourceTool(
      this.gateway,
      "example-legacy",
      "morrow_legacy_task_get",
    );
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const maxChildren = Math.max(1, Math.min(Math.trunc(input.maxChildren ?? 50), 500));
    const page = this.sourceSettlements.list(input.batchId, offset, maxChildren);
    const candidates = page.filter((settlement) => (
      settlement.sourceTaskId
      && (input.includeTerminal === true || !STABLE_SOURCE_SETTLEMENT_STATES.has(settlement.state))
    ));

    const reconciled = await mapLimit(candidates, Math.min(batch.concurrency, 4), async (settlement) => {
      const result = await this.gateway.callSourceOwned(inspectionTool.publicName, {
        task_id: settlement.sourceTaskId,
        ...(settlement.sourceBindingId
          ? { source_binding_id: settlement.sourceBindingId }
          : {}),
      });
      const reconciliationOperationId = gatewayOperationId(result);
      const projection = taskProjectionFromGatewayResult(result);
      if (projection) {
        return {
          settlement: this.sourceSettlements.applyTaskProjection(
            input.batchId,
            settlement.childId,
            projection,
            reconciliationOperationId,
          ),
        } satisfies ReconciledSourceTask;
      }

      const code = problemCode(result) || "source_task_projection_unavailable";
      const digest = problemDigest(result) || sha256Text(code);
      return {
        settlement: this.sourceSettlements.applyTaskProjection(
          input.batchId,
          settlement.childId,
          {
            taskId: settlement.sourceTaskId,
            status: "unknown",
            outcome: "inspection_required",
            terminal: false,
            resultCounts: {},
          },
          reconciliationOperationId,
        ),
        problemCode: code,
        problemDigest: digest,
      } satisfies ReconciledSourceTask;
    });

    const sourceSettlement = this.sourceSettlements.summary(input.batchId);
    const nextOffset = offset + page.length < sourceSettlement.total
      ? offset + page.length
      : null;
    return {
      schema: "morrow.batch-reconciliation.v1",
      batch: this.batches.getBatch(input.batchId),
      sourceSettlementBefore,
      sourceSettlement,
      offset,
      scanned: page.length,
      processed: reconciled.length,
      nextOffset,
      settlements: reconciled.map((entry) => entry.settlement),
      problems: reconciled
        .filter((entry) => entry.problemCode)
        .map((entry) => ({
          childId: entry.settlement.childId,
          code: entry.problemCode,
          detailDigest: entry.problemDigest,
        })),
      providerOutcomeFinal: sourceSettlement.terminal,
    };
  }

  batchPause(batchId: string): JsonObject {
    const batch = this.batches.pause(batchId);
    return {
      schema: "morrow.batch-paused.v1",
      batch,
      sourceSettlement: this.sourceSettlements.summary(batchId),
    };
  }

  batchCancel(batchId: string): JsonObject {
    const batch = this.batches.cancel(batchId);
    return {
      schema: "morrow.batch-cancelled.v1",
      batch,
      sourceSettlement: this.sourceSettlements.summary(batchId),
      note: "Only undispatched child operations were cancelled. Existing source tasks retain their independently recorded state.",
    };
  }

  async close(): Promise<void> {
    await this.approval.close();
    this.sourceSettlements.close();
    this.batches.close();
    await this.gateway.close();
  }
}
