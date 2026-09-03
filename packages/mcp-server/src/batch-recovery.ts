import {
  recoverBatchState,
  type BatchRecoveryMode,
  type BatchSourceSettlementSummary,
} from "@morrow/batch-engine";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import type { MorrowRuntime } from "./morrow-runtime.js";

export interface RecoverGatewayBatchInput {
  readonly batchId: string;
  readonly mode: BatchRecoveryMode;
  readonly afterOrdinal?: number;
  readonly maxChildren?: number;
}

function sourceBindingId(value: JsonObject): string | undefined {
  if (!isJsonObject(value._morrow)) return undefined;
  const binding = typeof value._morrow.source_binding_id === "string"
    ? value._morrow.source_binding_id.trim()
    : "";
  return binding || undefined;
}

function synchronizeSourceSettlement(
  runtime: MorrowRuntime,
  batchId: string,
): BatchSourceSettlementSummary {
  const detail = runtime.batches.get(batchId);
  if (detail.batch.mode !== "stage_writes") {
    return runtime.sourceSettlements.summary(batchId);
  }

  runtime.sourceSettlements.initialize(
    batchId,
    detail.children.map((child) => {
      const args = runtime.batches.readArguments(batchId, child.childId);
      const binding = sourceBindingId(args);
      return {
        childId: child.childId,
        sourceId: child.sourceId,
        ...(binding ? { sourceBindingId: binding } : {}),
      };
    }),
  );

  for (const child of detail.children) {
    const settlement = runtime.sourceSettlements.get(batchId, child.childId);
    if (child.sourceTaskId && !settlement.sourceTaskId) {
      runtime.sourceSettlements.markStaged(batchId, child.childId, {
        sourceTaskId: child.sourceTaskId,
        ...(child.gatewayOperationId ? { gatewayOperationId: child.gatewayOperationId } : {}),
        ...(child.sourceResultState ? { taskStatus: child.sourceResultState } : {}),
      });
      continue;
    }
    if (settlement.sourceTaskId || settlement.state !== "not_started") continue;
    if (child.state === "unknown") {
      runtime.sourceSettlements.markDispatchResult(
        batchId,
        child.childId,
        "unknown",
        child.gatewayOperationId || undefined,
      );
    } else if (child.state === "failed") {
      runtime.sourceSettlements.markDispatchResult(
        batchId,
        child.childId,
        "failed",
        child.gatewayOperationId || undefined,
      );
    }
  }

  return runtime.sourceSettlements.summary(batchId);
}

export function recoverGatewayBatch(
  runtime: MorrowRuntime,
  input: RecoverGatewayBatchInput,
): JsonObject {
  const recovery = recoverBatchState({
    path: runtime.batches.path,
    batchId: input.batchId,
    mode: input.mode,
    ...(input.afterOrdinal !== undefined ? { afterOrdinal: input.afterOrdinal } : {}),
    ...(input.maxChildren !== undefined ? { maxChildren: input.maxChildren } : {}),
  });
  const sourceSettlement = input.mode === "apply_safe"
    ? synchronizeSourceSettlement(runtime, input.batchId)
    : runtime.sourceSettlements.summary(input.batchId);
  return {
    ...recovery,
    sourceSettlement,
    note: input.mode === "inspect"
      ? "No batch child state or provider state was changed."
      : "Safe recovery changed local orchestration records only. It made zero provider dispatches.",
  } as unknown as JsonObject;
}
