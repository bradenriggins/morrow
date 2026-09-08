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
  type BatchExecutor,
  type BatchMode,
  type BatchRatePolicyInput,
  type BatchRecord,
  type CanvasResultBinding,
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
import { LoopbackApprovalServer, operationStatus, reviewPlatform } from "./approval-server.js";
import { collectCourseAudit, parseBatchCourseAuditInput } from "./course-audit.js";
import {
  boundProgramInventoryResult,
  collectProgramInventory,
  parseProgramInventoryInput,
} from "./course-inventory.js";
import { GatewayRuntime, type PreparedEffectAuthority } from "./runtime.js";
import { BatchWindowScheduler } from "./batch-window-scheduler.js";

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
  "morrow_program_inventory_create",
  "morrow_program_inventory_create_audit_batch",
] as const);

export type BridgeMaintenanceControl =
  | { readonly action: "status" }
  | { readonly action: "quiesce" }
  | { readonly action: "readback" }
  | { readonly action: "resume"; readonly quiesceEpoch: string; readonly fileLayerRestored: true };

const BRIDGE_EXTENSION_ID = /^[a-p]{32}$/;
const BRIDGE_VERSION = /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)){0,3}$/;
const BRIDGE_IDENTIFIER = /^[A-Za-z0-9._-]{16,256}$/;
const BRIDGE_SHA256 = /^[0-9a-f]{64}$/;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isJsonObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function normalizeBridgeMaintenanceControl(value: unknown): BridgeMaintenanceControl {
  if (!isJsonObject(value) || typeof value.action !== "string") {
    throw new Error("The private Bridge maintenance control is invalid.");
  }
  if ((value.action === "status" || value.action === "quiesce" || value.action === "readback")
    && exactKeys(value, ["action"])) return { action: value.action };
  if (value.action !== "resume" || !exactKeys(value, ["action", "quiesceEpoch", "fileLayerRestored"])
    || typeof value.quiesceEpoch !== "string" || !BRIDGE_IDENTIFIER.test(value.quiesceEpoch)
    || value.fileLayerRestored !== true) {
    throw new Error("The private Bridge maintenance control is invalid.");
  }
  return { action: "resume", quiesceEpoch: value.quiesceEpoch, fileLayerRestored: true };
}

function activeFolderProof(value: unknown, extensionId: string, manifestVersion: string): boolean {
  return exactKeys(value, ["schema", "extensionId", "manifestVersion", "challengeId", "nonce", "challengeSha256"])
    && value.schema === "morrow.bridge.active-folder-proof.v1"
    && value.extensionId === extensionId
    && value.manifestVersion === manifestVersion
    && typeof value.challengeId === "string" && BRIDGE_IDENTIFIER.test(value.challengeId)
    && typeof value.nonce === "string" && BRIDGE_IDENTIFIER.test(value.nonce)
    && typeof value.challengeSha256 === "string" && BRIDGE_SHA256.test(value.challengeSha256);
}

function privateBridgeMaintenanceResult(control: BridgeMaintenanceControl, value: JsonObject): JsonObject {
  const source = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  if (value.isError === true || !source || typeof source.schema !== "string"
    || typeof source.extensionId !== "string" || !BRIDGE_EXTENSION_ID.test(source.extensionId)
    || typeof source.manifestVersion !== "string" || !BRIDGE_VERSION.test(source.manifestVersion)) {
    throw new Error("The private Bridge maintenance result is unavailable.");
  }
  const extensionId = source.extensionId;
  const manifestVersion = source.manifestVersion;
  if (control.action === "status") {
    const statusProof = source.installType === "normal"
      ? source.activeFolderProof === null
      : activeFolderProof(source.activeFolderProof, extensionId, manifestVersion);
    if (!exactKeys(source, ["schema", "extensionId", "manifestVersion", "installType", "quiescent", "activeFolderProof"])
      || source.schema !== "morrow.bridge.update-status.v1" || !["admin", "development", "normal", "sideload", "other"].includes(String(source.installType))
      || typeof source.quiescent !== "boolean" || !statusProof) {
      throw new Error("The private Bridge status result is invalid.");
    }
  } else if (control.action === "quiesce") {
    if (!exactKeys(source, ["schema", "extensionId", "manifestVersion", "installType", "quiescent", "quiesceEpoch", "activeFolderProof"])
      || source.schema !== "morrow.bridge.update-quiesced.v1" || source.installType !== "development"
      || source.quiescent !== true || typeof source.quiesceEpoch !== "string" || !BRIDGE_IDENTIFIER.test(source.quiesceEpoch)
      || !activeFolderProof(source.activeFolderProof, extensionId, manifestVersion)) {
      throw new Error("The private Bridge quiescence result is invalid.");
    }
  } else if (control.action === "readback") {
    if (!exactKeys(source, ["schema", "extensionId", "manifestVersion", "installType", "activeFolderProof"])
      || source.schema !== "morrow.bridge.update-readback.v1" || source.installType !== "development"
      || !activeFolderProof(source.activeFolderProof, extensionId, manifestVersion)) {
      throw new Error("The private Bridge readback result is invalid.");
    }
  } else if (!exactKeys(source, ["schema", "extensionId", "manifestVersion", "quiesceEpoch", "resumed"])
    || source.schema !== "morrow.bridge.update-resumed.v1" || source.quiesceEpoch !== control.quiesceEpoch || source.resumed !== true) {
    throw new Error("The private Bridge resume result is invalid.");
  }
  return structuredClone(source);
}

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
  readonly resultBinding?: CanvasResultBinding;
}

export interface CreateGatewayBatchInput {
  readonly batchId?: string;
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
  readonly resultChildId?: string;
}

export interface RecentBatchesInput {
  readonly state?: BatchState;
  readonly limit?: number;
}

/**
 * One child of a running batch, reported while the window is still open so a caller does not have
 * to poll for it. Every field is Morrow's own frozen record: the course the manifest froze for this
 * child and the state the child settled with. No provider result reaches this shape, so no learner
 * identity can leave through it.
 */
export interface BatchChildProgress {
  readonly batchId: string;
  readonly childId: string;
  /** The course the frozen manifest holds for this child. */
  readonly courseId: string;
  readonly outcome: BatchExecutionResult["state"];
  /** Children of this batch that have settled, including this one. */
  readonly settled: number;
  /** Children this batch froze. */
  readonly total: number;
}

export type BatchChildProgressReporter = (progress: BatchChildProgress) => void;

export interface RunGatewayBatchInput {
  readonly batchId: string;
  readonly maxChildren?: number;
  readonly courseSetDigest?: string;
  readonly profileDigest?: string;
  readonly signal?: AbortSignal;
  readonly stopOnUnverified?: boolean;
  /** Called as each child of this window finishes, when the caller asked to hear about them. */
  readonly onChildSettled?: BatchChildProgressReporter;
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
const NATIVE_COURSE_AUDIT_TOOL = "morrow_audit_course";
const NATIVE_COURSE_AUDIT_SOURCE = "morrow-native";
const NATIVE_COURSE_INVENTORY_TOOL = "morrow_inventory_course";
const NATIVE_COURSE_INVENTORY_SOURCE = "morrow-native";

function nativeCourseAuditChild(
  operation: CreateGatewayBatchOperationInput,
  mode: BatchMode,
): PreparedGatewayBatchChild {
  if (mode !== "read_only") throw new Error("morrow_audit_course supports read_only batches only");
  if (operation.resultBinding) throw new Error("morrow_audit_course does not support result binding");
  const input = parseBatchCourseAuditInput(operation.arguments);
  const courseId = String(operation.courseId || "").trim();
  if (courseId !== String(input.course_id)) {
    throw new Error("morrow_audit_course requires matching operation and argument course ids");
  }
  const explicitBinding = String(operation.sourceBindingId || "").trim();
  if (explicitBinding && explicitBinding !== input.source_binding_id) {
    throw new Error("morrow_audit_course requires one matching source binding id");
  }
  return {
    sourceBindingId: input.source_binding_id,
    child: {
      ...(operation.childId ? { childId: operation.childId } : {}),
      courseId,
      publicToolName: NATIVE_COURSE_AUDIT_TOOL,
      sourceId: NATIVE_COURSE_AUDIT_SOURCE,
      sourceToolName: NATIVE_COURSE_AUDIT_TOOL,
      readOnly: true,
      arguments: operation.arguments,
      ...(operation.dependencyChildIds ? { dependencyChildIds: operation.dependencyChildIds } : {}),
      ...(operation.sourceObservationDigest ? { sourceObservationDigest: operation.sourceObservationDigest } : {}),
      ...(operation.readbackSpecDigest ? { readbackSpecDigest: operation.readbackSpecDigest } : {}),
      ...(operation.correctionFactsDigest ? { correctionFactsDigest: operation.correctionFactsDigest } : {}),
    },
  };
}

function nativeCourseInventoryChild(
  operation: CreateGatewayBatchOperationInput,
  mode: BatchMode,
): PreparedGatewayBatchChild {
  if (mode !== "read_only") throw new Error("morrow_inventory_course supports read_only batches only");
  if (operation.resultBinding) throw new Error("morrow_inventory_course does not support result binding");
  const input = parseProgramInventoryInput(operation.arguments);
  if (input.courses.length !== 1) throw new Error("morrow_inventory_course requires exactly one selected course");
  const selected = input.courses[0]!;
  const courseId = String(operation.courseId || "").trim();
  if (courseId !== String(selected.course_id)) {
    throw new Error("morrow_inventory_course requires matching operation and selected course ids");
  }
  const explicitBinding = String(operation.sourceBindingId || "").trim();
  if (explicitBinding && explicitBinding !== selected.source_binding_id) {
    throw new Error("morrow_inventory_course requires one matching source binding id");
  }
  return {
    sourceBindingId: selected.source_binding_id,
    child: {
      ...(operation.childId ? { childId: operation.childId } : {}),
      courseId,
      publicToolName: NATIVE_COURSE_INVENTORY_TOOL,
      sourceId: NATIVE_COURSE_INVENTORY_SOURCE,
      sourceToolName: NATIVE_COURSE_INVENTORY_TOOL,
      readOnly: true,
      arguments: operation.arguments,
      ...(operation.dependencyChildIds ? { dependencyChildIds: operation.dependencyChildIds } : {}),
      ...(operation.sourceObservationDigest ? { sourceObservationDigest: operation.sourceObservationDigest } : {}),
      ...(operation.readbackSpecDigest ? { readbackSpecDigest: operation.readbackSpecDigest } : {}),
      ...(operation.correctionFactsDigest ? { correctionFactsDigest: operation.correctionFactsDigest } : {}),
    },
  };
}

function isNativeCourseAuditChild(child: BatchChildRecord): boolean {
  return child.sourceId === NATIVE_COURSE_AUDIT_SOURCE
    && child.sourceToolName === NATIVE_COURSE_AUDIT_TOOL
    && child.publicToolName === NATIVE_COURSE_AUDIT_TOOL;
}

function isNativeCourseInventoryChild(child: BatchChildRecord): boolean {
  return child.sourceId === NATIVE_COURSE_INVENTORY_SOURCE
    && child.sourceToolName === NATIVE_COURSE_INVENTORY_TOOL
    && child.publicToolName === NATIVE_COURSE_INVENTORY_TOOL;
}

function nativeCourseAuditResult(value: JsonObject): BatchExecutionResult {
  const report = value.structuredContent;
  if (value.isError === true || !isJsonObject(report)
    || report.schema !== "morrow.course-audit.v1" || typeof report.status !== "string") {
    const code = problemCode(value) || "course_audit_unavailable";
    return {
      state: "failed",
      resultDigest: sha256Json(value),
      sourceResultState: code,
      errorDigest: sha256Text(code),
    };
  }
  return {
    state: "succeeded",
    resultDigest: sha256Json(report),
    sourceResultState: report.status,
    resultPayload: report,
  };
}

function nativeCourseInventoryResult(value: JsonObject): BatchExecutionResult {
  const report = value.structuredContent;
  if (value.isError === true || !isJsonObject(report)
    || report.schema !== "morrow.course-inventory.v1" || !Array.isArray(report.courses)) {
    const code = problemCode(value) || "course_inventory_unavailable";
    return {
      state: "failed",
      resultDigest: sha256Json(value),
      sourceResultState: code,
      errorDigest: sha256Text(code),
    };
  }
  const coverage = isJsonObject(report.coverage) ? report.coverage : {};
  return {
    state: "succeeded",
    resultDigest: sha256Json(report),
    sourceResultState: typeof coverage.status === "string" ? coverage.status : "inventory_completed",
    resultPayload: report,
  };
}

function boundedNativeCourseInventoryResult(value: JsonObject): JsonObject {
  const report = value.structuredContent;
  if (value.isError === true || !isJsonObject(report) || report.schema !== "morrow.course-inventory.v1") return value;
  return {
    ...value,
    structuredContent: boundProgramInventoryResult(report),
  };
}

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
  const bridgeControlled = mapping.upstreamId === "example-legacy"
    || mapping.capability?.route.backend === "canvas-connector";
  if (!bridgeControlled) {
    if (args._morrow !== undefined || sourceBindingId) {
      throw new Error("_morrow routing controls apply only to browser-bridge tools");
    }
    return args;
  }

  const existing = isJsonObject(args._morrow) ? args._morrow : {};
  if (existing.operation_id !== undefined) {
    throw new Error("Batch operation identity is generated by Morrow and cannot be supplied in child arguments");
  }
  args._morrow = {
    ...existing,
    ...(sourceBindingId ? { source_binding_id: sourceBindingId } : {}),
  };
  return args;
}

function browserBridgeControlled(mapping: CatalogTool): boolean {
  return mapping.upstreamId === "example-legacy"
    || mapping.capability?.route.backend === "canvas-connector";
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

function canvasRatePolicy(value: JsonObject): BatchRatePolicyInput | undefined {
  if (!isJsonObject(value._meta)) return undefined;
  const raw = value._meta["io.morrow/canvas-rate"];
  if (!isJsonObject(raw)) return undefined;
  const requestCost = typeof raw.requestCost === "number" && Number.isFinite(raw.requestCost)
    ? raw.requestCost : undefined;
  const rateLimitRemaining = typeof raw.rateLimitRemaining === "number" && Number.isFinite(raw.rateLimitRemaining)
    ? raw.rateLimitRemaining : undefined;
  const retryAfterMs = Number.isSafeInteger(raw.retryAfterMs) ? Number(raw.retryAfterMs) : undefined;
  if (requestCost === undefined && rateLimitRemaining === undefined && retryAfterMs === undefined) return undefined;
  return {
    ...(requestCost === undefined ? {} : { requestCost }),
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function gatewayOperationId(value: JsonObject): string | undefined {
  if (isJsonObject(value.structuredContent) && typeof value.structuredContent.operationId === "string") {
    const effectOperationId = value.structuredContent.operationId.trim();
    if (effectOperationId.startsWith("op:")) return effectOperationId;
  }
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

/**
 * A result-bound module placement needs one immutable identifier from its own
 * verified create. Retain only that identifier, never the raw Canvas response
 * that may contain page body or learner data.
 */
function verifiedCanvasCreateArtifact(child: BatchChildRecord, result: JsonObject): JsonObject | undefined {
  const target = child.publicToolName === "canvas_create_page_courses"
    ? "page"
    : child.publicToolName === "canvas_create_assignment"
      ? "assignment"
      : null;
  if (!target || child.sourceToolName !== child.publicToolName) return undefined;
  const structured = result.structuredContent;
  if (!isJsonObject(structured) || structured.schema !== "morrow.result.v1"
    || structured.tool !== child.publicToolName || structured.effectState !== "verified"
    || !isJsonObject(structured.verification) || structured.verification.status !== "verified"
    || !isJsonObject(structured.data)) return undefined;
  const connector = structured.data;
  if (connector.schema !== "morrow.canvas-connector.result.v1" || connector.ok !== true
    || connector.provider !== "canvas" || connector.toolName !== child.publicToolName
    || connector.commandKind !== "invoke_write" || !isJsonObject(connector.result)
    || !isJsonObject(connector.result.data)) return undefined;
  const source = connector.result.data;
  const data = target === "page"
    ? typeof source.url === "string" && source.url.length > 0 && source.url.length <= 1_000
      && source.url === source.url.trim() && !/[\u0000-\u001f\u007f]/u.test(source.url)
      ? { url: source.url }
      : null
    : typeof source.id === "string" && /^[1-9][0-9]{0,18}$/u.test(source.id)
      ? { id: source.id }
      : null;
  if (!data) return undefined;
  return {
    structuredContent: {
      schema: "morrow.result.v1",
      tool: child.publicToolName,
      effectState: "verified",
      verification: { status: "verified" },
      data: {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        provider: "canvas",
        toolName: child.publicToolName,
        commandKind: "invoke_write",
        result: { data },
      },
    },
  };
}

function childResult(
  runtime: GatewayRuntime,
  batch: BatchRecord,
  child: BatchChildRecord,
  result: JsonObject,
): BatchExecutionResult {
  const meta = gatewayMeta(result);
  const operationId = gatewayOperationId(result) || "";
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
  const retainedArtifact = verifiedCanvasCreateArtifact(child, result);
  const resultDigest = sha256Json(retainedArtifact || result);
  const ratePolicy = canvasRatePolicy(result);

  if (gatewayOperationState === "source_unknown") {
    return {
      state: "unknown",
      resultDigest,
      ...(operationId ? { gatewayOperationId: operationId } : {}),
      gatewayOperationState,
      ...(sourceResultState ? { sourceResultState } : {}),
      ...(sourceTaskId ? { sourceTaskId } : {}),
      errorDigest: sha256Text("gateway_source_unknown"),
      ...(ratePolicy ? { ratePolicy } : {}),
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
      ...(ratePolicy ? { ratePolicy } : {}),
    };
  }

  if (batch.mode === "stage_writes" && !sourceTaskId && gatewayOperationState !== "verified") {
    return {
      state: "unknown",
      resultDigest,
      ...(operationId ? { gatewayOperationId: operationId } : {}),
      ...(gatewayOperationState ? { gatewayOperationState } : {}),
      ...(sourceResultState ? { sourceResultState } : {}),
      errorDigest: sha256Text("staged_write_missing_source_task"),
      ...(ratePolicy ? { ratePolicy } : {}),
    };
  }

  return {
    state: "succeeded",
    resultDigest,
    ...(retainedArtifact ? { resultPayload: retainedArtifact } : {}),
    ...(operationId ? { gatewayOperationId: operationId } : {}),
    ...(gatewayOperationState ? { gatewayOperationState } : {}),
    ...(sourceResultState ? { sourceResultState } : {}),
    ...(sourceTaskId ? { sourceTaskId } : {}),
    ...(ratePolicy ? { ratePolicy } : {}),
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
  readonly batchScheduler: BatchWindowScheduler;

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
    this.batchScheduler = new BatchWindowScheduler({
      maxConcurrentReadWindows: gateway.config.batchScheduler.maxConcurrentReadWindows,
    });
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
        let runtime: MorrowRuntime;
        const approval = new LoopbackApprovalServer({
          operationGet: (operationId) => gateway.operationGet(operationId),
          operationList: (limit) => gateway.operationList(limit),
          operationReviewContext: (operationId, cache) => gateway.operationReviewContext(operationId, cache),
          approveOperation: (operationId) => gateway.approveOperation(operationId),
          runApprovedOperation: (operationId) => gateway.dispatchOperation(operationId),
          cancelOperation: (operationId) => gateway.cancelOperation(operationId),
          setApprovalBaseUrl: (baseUrl) => gateway.setApprovalBaseUrl(baseUrl),
          batchApprovalGet: (batchId) => runtime.batchApprovalGet(batchId),
          batchApprovalStatus: (batchId) => runtime.batchApprovalStatus(batchId),
          approveBatch: (batchId) => runtime.approveBatch(batchId),
          runApprovedBatch: (batchId, signal) => runtime.runApprovedBatch(batchId, signal),
          cancelBatchApproval: (batchId) => runtime.cancelBatchApproval(batchId),
        });
        runtime = new MorrowRuntime(gateway, batches, sourceSettlements, approval);
        await approval.start();
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
        if (
          child.state === "succeeded"
          && !child.sourceTaskId
          && child.gatewayOperationId
          && child.gatewayOperationState === "verified"
          && current.state !== "succeeded"
        ) {
          this.sourceSettlements.markDirectVerified(
            batchId,
            child.childId,
            child.gatewayOperationId,
          );
        } else if (child.sourceTaskId && !current.sourceTaskId) {
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

  hasActiveWork(): boolean {
    return this.gateway.hasActiveWork() || this.batches.hasActiveBatches();
  }

  /**
   * This is deliberately stricter than hasActiveWork. Maintenance refuses a
   * bounded history, saved approval, inspection state, or approval request
   * whose final provider outcome is not known to be terminal.
   */
  maintenanceQuiescent(): boolean {
    const effects = this.gateway.effectHealth();
    const effectCoverageComplete = effects.recentCoverageComplete === true;
    const effectCounts = [
      effects.unresolvedOperationCount,
      effects.dispatchingCount,
      effects.appliedOrUnknownCount,
    ];
    if (!effectCoverageComplete || effectCounts.some((count) => !Number.isSafeInteger(count) || count !== 0)) return false;
    const batches = this.batches.list(200);
    if (batches.length >= 200) return false;
    if (batches.some((batch) => !["completed", "partial", "failed", "cancelled"].includes(batch.state))) return false;
    return this.approval.maintenanceQuiescent();
  }

  /**
   * Private desktop-owner route to the fixed Bridge update control. This is
   * intentionally absent from the full MCP server and accepts no tool, path,
   * extension, or release target chosen by the caller.
   */
  async bridgeMaintenance(control: unknown): Promise<JsonObject> {
    const exact = normalizeBridgeMaintenanceControl(control);
    return privateBridgeMaintenanceResult(
      exact,
      await this.gateway.callInternalBridgeMaintenance(exact),
    );
  }

  async health(): Promise<JsonObject> {
    const gateway = this.gateway.health();
    const source = (id: string) => gateway.sources.find((entry) => entry.id === id) || null;
    const connectorSourceId = this.gateway.catalog.tools.find((tool) => tool.capability?.route.backend === "canvas-connector")?.upstreamId;
    const connector = connectorSourceId ? source(connectorSourceId) : null;
    let connectorRuntime: JsonObject | null = null;
    if (connector && this.gateway.catalog.tools.some((tool) => tool.publicName === "morrow_canvas_connector_health")) {
      try {
        const inspected = await this.gateway.callSourceOwned("morrow_canvas_connector_health", {});
        const structured = isJsonObject(inspected.structuredContent) ? inspected.structuredContent : {};
        connectorRuntime = structured.schema === "morrow.canvas-connector.health.v1"
          ? structured
          : isJsonObject(structured.data) ? structured.data : null;
      } catch {
        connectorRuntime = null;
      }
    }
    const bridge = connectorRuntime && isJsonObject(connectorRuntime.bridge)
      ? connectorRuntime.bridge
      : null;
    const extensionConnected = bridge?.connected === true;
    // Only one Morrow can hold the Bridge port on a computer. A second Morrow
    // still starts, without its browser tools, and says so here.
    const bridgeProblem = bridge && isJsonObject(bridge.problem) && typeof bridge.problem.message === "string"
      ? bridge.problem
      : null;
    const batchLedger = this.batchHealth();
    const effectBroker = this.gateway.effectHealth();
    return {
      ...gateway,
      ready: gateway.ready && (!connector || extensionConnected),
      ...(bridgeProblem
        ? { readyDetail: `${bridgeProblem.message} This Morrow started without its Canvas and Moodle browser tools.` }
        : {}),
      components: {
        gateway: { ready: gateway.ready, version: gateway.version },
        morrowKernel: { ready: gateway.ready, effectBroker, batchLedger },
        canvasConnector: connector
          ? {
              processConnected: connector.connected,
              ready: connectorRuntime?.ready === true,
              catalogAttested: connector.catalogAttested !== false,
              ...(connectorRuntime || {}),
            }
          : { processConnected: false, ready: false, reason: "not_configured" },
        extensionBridge: connector
          ? bridge || { connected: false, reason: "health_unavailable" }
          : { connected: false, reason: "not_configured" },
        effectBroker,
        batchLedger,
        approvalServer: { ready: this.approval.baseUrl !== null, transport: "loopback" },
        profile: { name: gateway.profile },
        catalog: { digest: gateway.catalogDigest, publicToolCount: gateway.publicToolCount },
      },
    };
  }

  async batchCreate(input: CreateGatewayBatchInput): Promise<JsonObject> {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new Error("A batch requires at least one explicit operation");
    }
    if (input.courseSet && input.courseSet.source !== "explicit") {
      throw new Error("This release accepts only explicit course sets; saved and discovered sets require a gateway-owned resolver receipt");
    }

    const prepared: PreparedGatewayBatchChild[] = input.operations.map((operation) => {
      if (operation.tool === NATIVE_COURSE_AUDIT_TOOL) {
        return nativeCourseAuditChild(operation, input.mode);
      }
      if (operation.tool === NATIVE_COURSE_INVENTORY_TOOL) {
        return nativeCourseInventoryChild(operation, input.mode);
      }
      const mapping = publicTool(this.gateway, operation.tool);
      const readOnly = mapping.annotations?.readOnlyHint === true;
      const sourceBindingId = selectedSourceBindingId(operation.arguments, operation.sourceBindingId);
      if (input.mode === "read_only" && !readOnly) {
        throw new Error(`read_only batch cannot include ${mapping.publicName}`);
      }
      if (input.mode === "stage_writes" && (readOnly || !browserBridgeControlled(mapping))) {
        throw new Error(
          `stage_writes batch accepts browser-bridge write tools; ${mapping.publicName} is not eligible`,
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
          ...(operation.resultBinding ? { resultBinding: operation.resultBinding } : {}),
        },
      };
    });

    const concurrency = input.mode === "stage_writes"
      ? Math.min(input.concurrency, 4)
      : input.concurrency;
    const initiallyPlannable = prepared
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.child.resultBinding);
    const effectAuthorities = new Map<number, PreparedEffectAuthority>();
    if (input.mode === "stage_writes") {
      const authorities = await mapLimit(initiallyPlannable, 4, async ({ entry, index }) => ({
        index,
        authority: await this.gateway.prepareEffectAuthority(entry.child.publicToolName, entry.child.arguments),
      }));
      for (const entry of authorities) effectAuthorities.set(entry.index, entry.authority);
    }
    const editAuthorized = initiallyPlannable.length > 0
      && effectAuthorities.size === initiallyPlannable.length
      && [...effectAuthorities.values()].every((preparedAuthority) => preparedAuthority.authorization.kind === "edit_scope");
    const detail = this.batches.create({
      ...(input.batchId ? { batchId: input.batchId } : {}),
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
      ...(this.gateway.requestedBy ? { requestedBy: this.gateway.requestedBy } : {}),
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
      try {
        for (const child of detail.children) {
          const preparedIndex = child.ordinal - 1;
          const preparedChild = prepared[preparedIndex];
          if (!preparedChild) throw new Error(`Morrow could not find frozen child ${child.childId}`);
          if (preparedChild.child.resultBinding) continue;
          const argumentsValue = this.batches.readArguments(detail.batch.batchId, child.childId);
          const controls = isJsonObject(argumentsValue._morrow) ? argumentsValue._morrow : {};
          // One outer batch approval governs every child if any child falls
          // outside the extension's current Edit permission.
          const authorization = editAuthorized
            ? effectAuthorities.get(preparedIndex)?.authorization || { kind: "review" as const }
            : { kind: "review" as const };
          const planned = this.gateway.planOperationWithExtensionAuthorization(
            child.publicToolName,
            {
              ...argumentsValue,
              _morrow: {
                ...controls,
                operation_id: child.sourceOperationId,
              },
            },
            authorization,
            effectAuthorities.get(preparedIndex)?.bindingScope,
          );
          const operationId = gatewayOperationId(planned);
          const plannedContent = isJsonObject(planned.structuredContent) ? planned.structuredContent : {};
          const expectedState = editAuthorized ? "approved" : "awaiting_approval";
          if (planned.isError === true || !operationId || plannedContent.effectState !== expectedState) {
            throw new Error(`Morrow could not freeze outer effect ${child.childId}`);
          }
          this.batches.bindGatewayOperation(
            detail.batch.batchId,
            child.childId,
            operationId,
            expectedState,
          );
        }
      } catch (error) {
        this.batches.quarantine(detail.batch.batchId);
        throw error;
      }
    }

    const createdPage = this.batches.listChildren(detail.batch.batchId, 0, 25);

    return {
      schema: "morrow.batch-created.v1",
      batch: createdPage.batch,
      manifest: detail.manifest,
      sourceSettlement: this.sourceSettlements.summary(detail.batch.batchId),
      returnedChildren: createdPage.returned,
      children: createdPage.children,
      ...(input.mode === "stage_writes" && !editAuthorized && this.approval.baseUrl
        ? { approvalUrl: `${this.approval.baseUrl}/batches/${encodeURIComponent(detail.batch.batchId)}` }
        : {}),
      note: input.mode === "stage_writes" && editAuthorized
        ? "The extension's current Edit permissions cover every frozen change in this batch. Running it sends each child once and requires connector-owned fresh readback for every child."
        : input.mode === "stage_writes"
        ? "A human reviews the exact frozen batch on the loopback page. One click starts bounded execution and displays its result there. Do not ask for a typed Continue. Success requires connector-owned fresh readback for every child."
        : "Running this batch performs bounded read-only operations.",
    };
  }

  async programInventoryCreate(input: {
    readonly name: string;
    readonly concurrency: number;
    readonly inventory: unknown;
  }): Promise<JsonObject> {
    const inventory = parseProgramInventoryInput(input.inventory);
    const courseSetDigest = sha256Json({
      schema: "morrow.program-inventory-selection.v1",
      provider: inventory.provider,
      scope: inventory.scope,
      courses: inventory.courses,
    });
    const created = await this.batchCreate({
      name: input.name,
      mode: "read_only",
      concurrency: input.concurrency,
      operationFamily: "program_inventory",
      courseSet: {
        source: "explicit",
        courseIds: inventory.courses.map((course) => String(course.course_id)),
        complete: true,
        paginationComplete: true,
        snapshotDigest: courseSetDigest,
      },
      profileDigest: sha256Json({ profile: this.gateway.config.profile, catalog: this.gateway.catalog.digest }),
      planDigest: sha256Json({ schema: "morrow.program-inventory-plan.v1", inventory }),
      operations: inventory.courses.map((course) => ({
        childId: inventory.provider === "canvas" ? `inventory:${course.course_id}` : `inventory:moodle:${course.course_id}`,
        courseId: String(course.course_id),
        tool: NATIVE_COURSE_INVENTORY_TOOL,
        sourceBindingId: course.source_binding_id,
        arguments: {
          ...inventory,
          courses: [course],
        },
      })),
    });
    return {
      schema: "morrow.program-inventory-created.v1",
      inventoryBatch: created.batch,
      manifest: created.manifest,
      returnedChildren: created.returnedChildren,
      children: created.children,
      note: "Run this read-only batch in bounded windows. Each completed course inventory is saved and remains available if later courses pause, fail, or are cancelled.",
    };
  }

  private programInventoryChildren(batchId: string): {
    readonly batch: BatchRecord;
    readonly manifest: ReturnType<DurableBatchStore["getManifest"]>;
    readonly children: readonly BatchChildRecord[];
  } {
    const batch = this.batches.getBatch(batchId);
    const manifest = this.batches.getManifest(batchId);
    const children: BatchChildRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = this.batches.listChildren(batchId, offset, 500);
      children.push(...page.children);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    if (batch.mode !== "read_only" || children.length === 0 || children.some((child) => !isNativeCourseInventoryChild(child))) {
      throw new Error("batch is not a saved selected-program inventory");
    }
    return { batch, manifest, children };
  }

  async programInventoryCreateAuditBatch(input: {
    readonly inventoryBatchId: string;
    readonly name: string;
    readonly concurrency: number;
    readonly targetIds?: readonly string[];
  }): Promise<JsonObject> {
    const inventory = this.programInventoryChildren(input.inventoryBatchId);
    if (inventory.batch.state === "running") {
      throw new Error("pause the selected-program inventory before freezing an audit batch");
    }
    const courseIds = new Map(inventory.manifest.children.map((child) => [child.childId, child.courseId]));
    const discovered = new Map<string, CreateGatewayBatchOperationInput>();
    for (const child of inventory.children) {
      if (child.state !== "succeeded") continue;
      const saved = this.batches.readResult(input.inventoryBatchId, child.childId);
      if (!saved || saved.schema !== "morrow.course-inventory.v1" || !Array.isArray(saved.audit_children)) continue;
      for (const candidate of saved.audit_children) {
        if (!isJsonObject(candidate)
          || typeof candidate.childId !== "string"
          || typeof candidate.courseId !== "string"
          || typeof candidate.sourceBindingId !== "string"
          || candidate.tool !== NATIVE_COURSE_AUDIT_TOOL
          || !isJsonObject(candidate.arguments)) {
          throw new Error("saved inventory contains an invalid audit target");
        }
        const audit = parseBatchCourseAuditInput(candidate.arguments);
        if (String(audit.course_id) !== candidate.courseId || audit.source_binding_id !== candidate.sourceBindingId
          || String(audit.course_id) !== courseIds.get(child.childId)) {
          throw new Error("saved inventory target is not bound to its completed course");
        }
        if (discovered.has(candidate.childId)) throw new Error("saved inventory contains a duplicate audit target");
        discovered.set(candidate.childId, {
          childId: candidate.childId,
          courseId: candidate.courseId,
          tool: NATIVE_COURSE_AUDIT_TOOL,
          sourceBindingId: candidate.sourceBindingId,
          arguments: candidate.arguments,
        });
      }
    }
    const requested = input.targetIds && input.targetIds.length > 0
      ? [...new Set(input.targetIds)]
      : [...discovered.keys()];
    if (requested.length === 0 || requested.length > 10_000) {
      throw new Error("select one through 10000 eligible saved inventory targets");
    }
    const operations = requested.map((targetId) => {
      const target = discovered.get(targetId);
      if (!target) throw new Error("selected target is unavailable or came from an incomplete source list");
      return target;
    }).sort((left, right) => left.childId!.localeCompare(right.childId!));
    const planDigest = sha256Json({
      schema: "morrow.program-inventory-audit-plan.v1",
      inventoryBatchId: input.inventoryBatchId,
      inventoryManifestDigest: inventory.batch.manifestDigest,
      targets: operations.map((operation) => ({
        childId: operation.childId,
        courseId: operation.courseId,
        sourceBindingId: operation.sourceBindingId,
        requestDigest: sha256Json(operation.arguments),
      })),
    });
    const batchId = `bat:program-audit:${planDigest.slice(0, 40)}`;
    const existing = (() => {
      try {
        const batch = this.batches.getBatch(batchId);
        const manifest = this.batches.getManifest(batchId);
        if (manifest.planDigest !== planDigest || batch.mode !== "read_only") {
          throw new Error("saved audit batch id conflicts with a different frozen plan");
        }
        return { batch, manifest };
      } catch (error) {
        if (error instanceof Error && error.message === "batch does not exist") return null;
        throw error;
      }
    })();
    if (existing) {
      return {
        schema: "morrow.program-inventory-audit-batch.v1",
        inventoryBatchId: input.inventoryBatchId,
        auditBatch: existing.batch,
        manifest: existing.manifest,
        idempotent: true,
        note: "This immutable audit batch was already prepared from the same saved inventory targets.",
      };
    }
    const auditCourseIds = [...new Set(operations.map((operation) => operation.courseId!))].sort();
    let created: JsonObject;
    try {
      created = await this.batchCreate({
        batchId,
        name: input.name,
        mode: "read_only",
        concurrency: input.concurrency,
        operationFamily: `program_inventory_audit:${input.inventoryBatchId}`,
        courseSet: {
          source: "explicit",
          courseIds: auditCourseIds,
          complete: true,
          paginationComplete: true,
          snapshotDigest: sha256Json({ inventoryBatchId: input.inventoryBatchId, inventoryManifestDigest: inventory.batch.manifestDigest }),
        },
        profileDigest: sha256Json({ profile: this.gateway.config.profile, catalog: this.gateway.catalog.digest }),
        planDigest,
        operations,
      });
    } catch (error) {
      const recovered = (() => {
        try {
          const batch = this.batches.getBatch(batchId);
          const manifest = this.batches.getManifest(batchId);
          return manifest.planDigest === planDigest ? { batch, manifest } : null;
        } catch {
          return null;
        }
      })();
      if (!recovered) throw error;
      return {
        schema: "morrow.program-inventory-audit-batch.v1",
        inventoryBatchId: input.inventoryBatchId,
        auditBatch: recovered.batch,
        manifest: recovered.manifest,
        idempotent: true,
        note: "Recovered the immutable audit batch prepared from the saved inventory targets.",
      };
    }
    return {
      schema: "morrow.program-inventory-audit-batch.v1",
      inventoryBatchId: input.inventoryBatchId,
      auditBatch: created.batch,
      manifest: created.manifest,
      returnedChildren: created.returnedChildren,
      children: created.children,
      idempotent: false,
      note: "Run this read-only audit batch in bounded windows. Its targets came only from the saved eligible inventory results.",
    };
  }

  batchApprovalGet(batchId: string): JsonObject {
    const batch = this.batches.getBatch(batchId);
    const manifest = this.batches.getManifest(batchId);
    const courseIds = new Map(manifest.children.map((child) => [child.childId, child.courseId]));
    const children: JsonObject[] = [];
    let offset = 0;
    for (;;) {
      const page = this.batches.listChildren(batchId, offset, 500);
      for (const child of page.children) {
        if (!child.gatewayOperationId) continue;
        const operation = this.gateway.operationGet(child.gatewayOperationId);
        children.push({
          childId: child.childId,
          ordinal: child.ordinal,
          courseId: courseIds.get(child.childId) || null,
          tool: child.publicToolName,
          operation,
        });
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return {
      schema: "morrow.batch-approval.v1",
      batch,
      manifestDigest: batch.manifestDigest,
      profileDigest: manifest.profileDigest,
      catalogDigest: manifest.catalogDigest,
      expiresAt: [manifest.expiresAt, ...children.map((child) => (child.operation as JsonObject).approvalExpiresAt)]
        .filter((expiry): expiry is string => typeof expiry === "string" && Number.isFinite(Date.parse(expiry)))
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || manifest.expiresAt,
      approvalPreviewDigest: manifest.approvalPreviewDigest,
      approvalCoverageChildCount: manifest.approvalCoverageChildCount,
      targetCount: children.length,
      children,
    };
  }

  batchApprovalStatus(batchId: string): JsonObject {
    const batch = this.batches.getBatch(batchId);
    const states: Record<string, string> = {};
    const tools = new Set<string>();
    let confirmedChildren = 0;
    let offset = 0;
    for (;;) {
      const page = this.batches.listChildren(batchId, offset, 500);
      for (const child of page.children) {
        tools.add(child.publicToolName);
        if (child.gatewayOperationState === "verified") confirmedChildren += 1;
        states[String(child.ordinal - 1)] = operationStatus(
          child.state === "pending" ? "awaiting_approval"
            : child.state === "running" ? "dispatching"
              : child.state === "cancelled" ? "cancelled"
                : child.state === "failed" ? "failed"
                  : child.gatewayOperationState || child.state,
          reviewPlatform([child.publicToolName]),
        );
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return {
      schema: "morrow.batch-approval-status.v1",
      platform: reviewPlatform([...tools]),
      batch,
      totalChildren: batch.totalChildren,
      confirmedChildren,
      states,
    };
  }

  approveBatch(batchId: string): JsonObject {
    const snapshot = this.batchApprovalGet(batchId);
    const batch = snapshot.batch as BatchRecord;
    if (!new Set<BatchState>(["planned", "paused"]).has(batch.state)) {
      throw new Error(`batch cannot be approved from ${batch.state}`);
    }
    if (Date.parse(String(snapshot.expiresAt)) <= Date.now()) throw new Error("batch approval preview expired");
    const children = snapshot.children as JsonObject[];
    if (batch.state === "planned" && children.length !== Number(snapshot.approvalCoverageChildCount)) {
      throw new Error("batch approval preview does not cover every target");
    }
    const awaiting = children.filter((child) => (
      isJsonObject(child.operation) && child.operation.state === "awaiting_approval"
    ));
    if (awaiting.length === 0) throw new Error("batch has no child ready for approval");
    for (const child of awaiting) {
      this.gateway.approveOperation(String((child.operation as JsonObject).operationId));
    }
    return this.batchApprovalGet(batchId);
  }

  cancelBatchApproval(batchId: string): JsonObject {
    const snapshot = this.batchApprovalGet(batchId);
    for (const child of snapshot.children as JsonObject[]) {
      if (isJsonObject(child.operation) && ["awaiting_approval", "approved"].includes(String(child.operation.state))) {
        this.gateway.cancelOperation(String(child.operation.operationId));
      }
    }
    return this.batchCancel(batchId);
  }

  async runApprovedBatch(batchId: string, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const approved = this.batches.getBatch(batchId);
        const result = await this.batchScheduler.run(batchId, async () => {
          if (signal.aborted) {
            this.batches.pause(batchId);
            return null;
          }
          const current = this.batches.getBatch(batchId);
          if (!["planned", "running"].includes(current.state)) return null;
          return this.batchRun({
            batchId,
            maxChildren: current.concurrency,
            signal,
            stopOnUnverified: current.mode === "stage_writes",
          });
        }, {
          holder: "morrow-approval-page",
          mode: approved.mode === "stage_writes" ? "stage_writes" : "read_only",
          concurrency: approved.concurrency,
          // Approved work waits for a window without a deadline. A refused wait would quarantine the batch.
          queueTimeoutMs: 0,
        });
        if (!result) return;
        const batch = result.batch as unknown as BatchRecord;
        const children = result.children as JsonObject[];
        if (batch.state !== "running") return;
        if (Number(result.processed) === 0 || children.some((child) => child.gatewayOperationState !== "verified")) {
          this.batches.pause(batchId);
          return;
        }
      }
      this.batches.pause(batchId);
    } catch (error) {
      this.batches.quarantine(batchId);
      throw error;
    }
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
      manifest: {
        schema: "morrow.batch-manifest-ref.v1",
        digest: page.batch.manifestDigest,
        encrypted: true,
      },
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
    const selectedChild = input.resultChildId
      ? (detail.children as BatchChildRecord[]).find((child) => child.childId === input.resultChildId)
      : undefined;
    const auditReport = selectedChild && isNativeCourseAuditChild(selectedChild)
      ? this.batches.readResult(input.batchId, selectedChild.childId)
      : undefined;
    const inventoryReport = selectedChild && isNativeCourseInventoryChild(selectedChild)
      ? this.batches.readResult(input.batchId, selectedChild.childId)
      : undefined;
    return {
      ...detail,
      schema: "morrow.batch-results-page.v1",
      ...(input.resultChildId ? {
        nativeAuditReport: !selectedChild
          ? { status: "not_returned_on_this_page", childId: input.resultChildId }
          : !isNativeCourseAuditChild(selectedChild)
            ? { status: "not_available_for_child", childId: selectedChild.childId }
            : auditReport
              ? { status: "available", childId: selectedChild.childId, report: auditReport }
              : { status: "unavailable", childId: selectedChild.childId },
      } : {}),
      ...(input.resultChildId ? {
        nativeInventoryReport: !selectedChild
          ? { status: "not_returned_on_this_page", childId: input.resultChildId }
          : !isNativeCourseInventoryChild(selectedChild)
            ? { status: "not_available_for_child", childId: selectedChild.childId }
            : inventoryReport
              ? { status: "available", childId: selectedChild.childId, report: inventoryReport }
              : { status: "unavailable", childId: selectedChild.childId },
      } : {}),
    } as JsonObject;
  }

  async batchResultsPageEgress(
    input: GatewayBatchPageInput,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const result = this.batchResultsPage(input);
    if (!input.resultChildId) return result;
    const nativeAudit = isJsonObject(result.nativeAuditReport) ? result.nativeAuditReport : null;
    const nativeInventory = isJsonObject(result.nativeInventoryReport) ? result.nativeInventoryReport : null;
    const native = nativeAudit?.status === "available" ? nativeAudit
      : nativeInventory?.status === "available" ? nativeInventory
        : null;
    const report = native && isJsonObject(native.report) ? native.report : null;
    if (!native || !report) return result;
    try {
      const argumentsValue = this.batches.readArguments(input.batchId, input.resultChildId);
      const redacted = await this.gateway.redactMcpEgress(
        { structuredContent: report },
        argumentsValue,
        {
          signal,
          bound: false,
          toolName: nativeAudit?.status === "available" ? NATIVE_COURSE_AUDIT_TOOL : "morrow_inventory_courses",
        },
      );
      if (redacted.isError === true || !isJsonObject(redacted.structuredContent)) {
        return {
          ...result,
          [nativeAudit?.status === "available" ? "nativeAuditReport" : "nativeInventoryReport"]: {
            status: "privacy_refused",
            childId: input.resultChildId,
            code: isJsonObject(redacted.structuredContent) ? redacted.structuredContent.code : "privacy_output_refused",
          },
        };
      }
      return {
        ...result,
        [nativeAudit?.status === "available" ? "nativeAuditReport" : "nativeInventoryReport"]: { ...native, report: redacted.structuredContent },
      };
    } catch {
      return {
        ...result,
        [nativeAudit?.status === "available" ? "nativeAuditReport" : "nativeInventoryReport"]: { status: "privacy_refused", childId: input.resultChildId, code: "privacy_output_refused" },
      };
    }
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

  /** Plan only a request whose dependent target was just bound from a verified source artifact. */
  private async planReadyResultBoundChildren(batchId: string): Promise<boolean> {
    const manifest = this.batches.getManifest(batchId);
    const bindings = new Map(manifest.children
      .filter((child) => child.resultBinding)
      .map((child) => [child.childId, child]));
    if (bindings.size === 0) return false;
    let awaitingApproval = false;
    let offset = 0;
    for (;;) {
      const page = this.batches.listChildren(batchId, offset, 500);
      for (const child of page.children) {
        if (child.state !== "pending" || child.gatewayOperationId || !child.hasBoundRequest || !bindings.has(child.childId)) continue;
        const argumentsValue = this.batches.readArguments(batchId, child.childId);
        const controls = isJsonObject(argumentsValue._morrow) ? argumentsValue._morrow : {};
        const authority = await this.gateway.prepareEffectAuthority(child.publicToolName, argumentsValue);
        const planned = this.gateway.planOperationWithExtensionAuthorization(
          child.publicToolName,
          {
            ...argumentsValue,
            _morrow: {
              ...controls,
              operation_id: child.sourceOperationId,
            },
          },
          authority.authorization,
          authority.bindingScope,
        );
        const operationId = gatewayOperationId(planned);
        const plannedContent = isJsonObject(planned.structuredContent) ? planned.structuredContent : {};
        const expectedState = authority.authorization.kind === "edit_scope" ? "approved" : "awaiting_approval";
        if (planned.isError === true || !operationId || plannedContent.effectState !== expectedState) {
          this.batches.quarantine(batchId);
          throw new Error(`Morrow could not freeze result-bound effect ${child.childId}`);
        }
        this.batches.bindGatewayOperation(batchId, child.childId, operationId, expectedState);
        awaitingApproval ||= expectedState === "awaiting_approval";
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return awaitingApproval;
  }

  async batchRun(input: RunGatewayBatchInput): Promise<JsonObject> {
    const sourceSummaryBefore = this.ensureSourceSettlementRows(input.batchId);
    const initialBatch = this.batches.getBatch(input.batchId);
    if (initialBatch.mode === "stage_writes") {
      const awaitingResultBoundApproval = await this.planReadyResultBoundChildren(input.batchId);
      if (awaitingResultBoundApproval) {
        const batch = this.batches.pause(input.batchId);
        const sourceSettlement = this.sourceSettlements.summary(input.batchId);
        return {
          schema: "morrow.batch-window.v1",
          batch,
          processed: 0,
          remaining: batch.pendingChildren,
          children: [],
          effectiveConcurrency: batch.concurrency,
          backoffMs: 0,
          sourceSettlementBefore: sourceSummaryBefore,
          sourceSettlement,
          sourceSettlements: [],
          providerOutcomeFinal: false,
          note: "A result-bound Canvas placement has a new exact target and requires its current review before Morrow can send it.",
        };
      }
      const resultBoundChildIds = new Set(this.batches.getManifest(input.batchId).children
        .filter((child) => child.resultBinding)
        .map((child) => child.childId));
      let offset = 0;
      for (;;) {
        const page = this.batches.listChildren(input.batchId, offset, 500);
        for (const child of page.children) {
          if (child.state !== "pending") continue;
          if (resultBoundChildIds.has(child.childId) && !child.hasBoundRequest) continue;
          if (!child.gatewayOperationId) throw new Error(`batch child ${child.childId} has no frozen outer effect`);
          const operation = this.gateway.operationGet(child.gatewayOperationId);
          if (operation.state !== "approved") {
            throw new Error(`batch child ${child.childId} requires loopback approval before dispatch`);
          }
        }
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
    }
    /**
     * Tells the caller about each child as it finishes, so a long run is not silent until it
     * returns. It counts the children this batch has settled, including the ones earlier windows
     * settled, against the children the batch froze. A child that throws is reported unknown,
     * which is the state the window records for it. A caller that asked for nothing gets the
     * unchanged executor and pays nothing.
     */
    const settleWithProgress = (executor: BatchExecutor): BatchExecutor => {
      const report = input.onChildSettled;
      if (!report) return executor;
      const courseIds = new Map(this.batches.getManifest(input.batchId).children.map(
        (child) => [child.childId, child.courseId] as const,
      ));
      const total = initialBatch.totalChildren;
      let settled = initialBatch.succeededChildren
        + initialBatch.failedChildren
        + initialBatch.unknownChildren
        + initialBatch.cancelledChildren;
      const announce = (child: BatchChildRecord, outcome: BatchExecutionResult["state"]): void => {
        settled = Math.min(settled + 1, total);
        report({
          batchId: input.batchId,
          childId: child.childId,
          courseId: courseIds.get(child.childId) || "",
          outcome,
          settled,
          total,
        });
      };
      return async (execution) => {
        try {
          const outcome = await executor(execution);
          announce(execution.child, outcome.state);
          return outcome;
        } catch (error) {
          announce(execution.child, "unknown");
          throw error;
        }
      };
    };
    const result = await runBatchWindow(
      this.batches,
      input.batchId,
      settleWithProgress(async ({ batch, child, arguments: args }) => {
        const forwarded = structuredClone(args) as Record<string, unknown>;
        if (child.sourceId === "example-legacy" && child.sourceOperationId) {
          forwarded._morrow = {
            ...(isJsonObject(forwarded._morrow) ? forwarded._morrow : {}),
            operation_id: child.sourceOperationId,
          };
        }
        const nativeInventory = batch.mode !== "stage_writes" && isNativeCourseInventoryChild(child)
          ? await collectProgramInventory(this.gateway, forwarded, { signal: input.signal })
          : undefined;
        const nativeAudit = batch.mode !== "stage_writes" && isNativeCourseAuditChild(child)
          ? await collectCourseAudit(this.gateway, forwarded, input.signal) as unknown as JsonObject
          : undefined;
        const resultValue = batch.mode === "stage_writes"
          ? await this.gateway.dispatchOperation(String(child.gatewayOperationId || ""))
          : nativeInventory
            ? boundedNativeCourseInventoryResult(await this.gateway.redactMcpEgress(
              { structuredContent: nativeInventory },
              forwarded,
              { signal: input.signal, bound: false, toolName: "morrow_inventory_courses" },
            ))
            : nativeAudit
            ? nativeAudit.isError === true
              ? nativeAudit
              : await this.gateway.redactMcpEgress(
                nativeAudit,
                forwarded,
                { signal: input.signal, bound: false, toolName: NATIVE_COURSE_AUDIT_TOOL },
              )
            : await this.gateway.callSourceOwned(child.publicToolName, forwarded);
        const outcome = isNativeCourseInventoryChild(child)
          ? nativeCourseInventoryResult(resultValue)
          : isNativeCourseAuditChild(child)
          ? nativeCourseAuditResult(resultValue)
          : childResult(this.gateway, batch, child, resultValue);
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
            } else if (outcome.state === "succeeded" && outcome.gatewayOperationId && outcome.gatewayOperationState === "verified") {
              this.sourceSettlements.markDirectVerified(
                batch.batchId,
                child.childId,
                outcome.gatewayOperationId,
              );
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
      }),
      {
        expectedCatalogDigest: this.gateway.catalog.digest,
        maxChildren: input.maxChildren,
        ...(input.courseSetDigest ? { expectedCourseSetDigest: input.courseSetDigest } : {}),
        ...(input.profileDigest ? { expectedProfileDigest: input.profileDigest } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.stopOnUnverified ? { stopOnUnverified: true } : {}),
      },
    );
    const sourceSettlement = this.sourceSettlements.summary(input.batchId);
    const finalBatch = result.batch.mode === "stage_writes" && !sourceSettlement.terminal && result.batch.pendingChildren === 0
      ? this.batches.deferSourceSettlement(input.batchId)
      : result.batch;
    return {
      ...result,
      batch: finalBatch,
      sourceSettlementBefore: sourceSummaryBefore,
      sourceSettlement,
      sourceSettlements: this.settlementPage(input.batchId, result.children),
      ...(result.batch.mode === "stage_writes"
        ? {
            providerOutcomeFinal: sourceSettlement.terminal,
            note: "Batch state records bounded orchestration. sourceSettlement records each provider effect and its independent verification result.",
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

    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const maxChildren = Math.max(1, Math.min(Math.trunc(input.maxChildren ?? 50), 500));
    const page = this.sourceSettlements.list(input.batchId, offset, maxChildren);
    const candidates = page.filter((settlement) => (
      settlement.sourceTaskId
      && (input.includeTerminal === true || !STABLE_SOURCE_SETTLEMENT_STATES.has(settlement.state))
    ));

    if (candidates.length === 0) {
      const sourceSettlement = this.sourceSettlements.summary(input.batchId);
      return {
        schema: "morrow.batch-reconciliation.v1",
        batch,
        sourceSettlementBefore,
        sourceSettlement,
        offset,
        scanned: page.length,
        processed: 0,
        nextOffset: offset + page.length < sourceSettlement.total ? offset + page.length : null,
        settlements: [],
        problems: [],
        providerOutcomeFinal: sourceSettlement.terminal,
      };
    }

    const inspectionTool = sourceTool(
      this.gateway,
      "example-legacy",
      "morrow_legacy_task_get",
    );

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
        const applied = this.sourceSettlements.applyTaskProjection(
          input.batchId,
          settlement.childId,
          projection,
          reconciliationOperationId,
        );
        if (applied.stageGatewayOperationId) {
          const outer = this.gateway.operationGet(applied.stageGatewayOperationId);
          if (outer.state === "awaiting_inner_approval") {
            if (applied.state === "succeeded") {
              await this.gateway.settleInnerOperation(applied.stageGatewayOperationId, "ready_for_readback");
            } else if (["failed_no_effect", "cancelled"].includes(applied.state)) {
              await this.gateway.settleInnerOperation(applied.stageGatewayOperationId, "failed_no_effect");
            } else if (["failed_effect_possible", "inspection_required", "unknown", "reverted"].includes(applied.state)) {
              await this.gateway.settleInnerOperation(applied.stageGatewayOperationId, "effect_unknown");
            }
          }
        }
        return {
          settlement: applied,
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
    let settledBatch = this.batches.getBatch(input.batchId);
    if (sourceSettlement.terminal) {
      const terminalState = sourceSettlement.outcome === "succeeded"
        ? "completed"
        : sourceSettlement.outcome === "cancelled"
          ? "cancelled"
          : sourceSettlement.outcome === "failed"
            ? "failed"
            : sourceSettlement.outcome === "inspection_required"
              ? "inspection_required"
              : "partial";
      settledBatch = this.batches.finalizeSourceSettlement(input.batchId, terminalState);
    }
    const nextOffset = offset + page.length < sourceSettlement.total
      ? offset + page.length
      : null;
    return {
      schema: "morrow.batch-reconciliation.v1",
      batch: settledBatch,
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
    this.batchScheduler.close();
    this.sourceSettlements.close();
    this.batches.close();
    await this.gateway.close();
  }
}
