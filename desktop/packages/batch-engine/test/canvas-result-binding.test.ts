import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json, type JsonObject } from "@morrow/contracts";
import { GatewayOperationJournal, ProviderEffectBroker } from "@morrow/operation-journal";
import {
  CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
  DurableBatchStore,
  canvasResultBindingArtifactFromVerifiedConnector,
  decryptCanvasResultBindingArtifact,
  encryptCanvasResultBindingArtifact,
  recoverBatchState,
  type CanvasResultBindingArtifact,
} from "../src/public.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const catalogDigest = "a".repeat(64);
const profileDigest = "b".repeat(64);
const sourceBindingId = "canvas:school:42";

function verifiedCreateResult(tool: "canvas_create_page_courses" | "canvas_create_assignment", data: JsonObject): JsonObject {
  return {
    content: [{ type: "text", text: "Canvas confirmed the change." }],
    structuredContent: {
      schema: "morrow.result.v1",
      tool,
      effectState: "verified",
      verification: { status: "verified", evidence: [] },
      data: {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        provider: "canvas",
        toolName: tool,
        commandKind: "invoke_write",
        result: { data },
      },
    },
  };
}

function createBoundBatch(store: DurableBatchStore, kind: "page" | "assignment" = "page") {
  const sourceTool = kind === "page" ? "canvas_create_page_courses" : "canvas_create_assignment";
  const targetField = kind === "page" ? "module_item_page_url" : "module_item_content_id";
  return store.create({
    name: `Bind ${kind} after verified create`,
    mode: "stage_writes",
    catalogDigest,
    concurrency: 1,
    profileDigest,
    expiresAt: "2030-01-01T00:00:00.000Z",
    courseSet: { source: "explicit", courseIds: ["42"], complete: true, paginationComplete: true },
    children: [
      {
        childId: "create",
        courseId: "42",
        publicToolName: sourceTool,
        sourceId: "canvas-connector",
        sourceToolName: sourceTool,
        readOnly: false,
        arguments: kind === "page"
          ? { course_id: "42", wiki_page_title: "Private Cell Notes", _morrow: { source_binding_id: sourceBindingId } }
          : { course_id: "42", assignment_name: "Private reflection", _morrow: { source_binding_id: sourceBindingId } },
      },
      {
        childId: "place",
        courseId: "42",
        publicToolName: "canvas_create_module_item",
        sourceId: "canvas-connector",
        sourceToolName: "canvas_create_module_item",
        readOnly: false,
        arguments: {
          course_id: "42",
          module_id: "9",
          module_item_type: kind === "page" ? "Page" : "Assignment",
          module_item_title: "Keep this text",
          _morrow: { source_binding_id: sourceBindingId },
        },
        dependencyChildIds: ["create"],
        resultBinding: {
          schema: "morrow.canvas-result-binding.v1",
          sourceChildId: "create",
          kind: kind === "page"
            ? "canvas_page_url_to_module_item_page_url"
            : "canvas_assignment_id_to_module_item_content_id",
        },
      },
    ],
  });
}

function begin(store: DurableBatchStore, batchId: string, courseSetDigest: string): void {
  store.beginRun(batchId, catalogDigest, { courseSetDigest, profileDigest });
}

function interruptAfterVerifiedEffect(input: {
  readonly store: DurableBatchStore;
  readonly path: string;
  readonly key: Uint8Array;
  readonly batch: ReturnType<typeof createBoundBatch>;
  readonly artifact?: CanvasResultBindingArtifact;
}): string {
  const source = input.batch.children.find((child) => child.childId === "create")!;
  const broker = new ProviderEffectBroker({ path: input.path });
  const effect = broker.create({
    publicToolName: source.publicToolName,
    sourceId: source.sourceId,
    sourceToolName: source.sourceToolName,
    catalogDigest,
    request: input.store.readArguments(input.batch.batch.batchId, source.childId),
    forwardedRequest: input.store.readArguments(input.batch.batch.batchId, source.childId),
    sourceOperationId: source.sourceOperationId!,
    sourceBindingId,
    readback: {
      tool: source.publicToolName === "canvas_create_page_courses" ? "canvas_page_get" : "canvas_get_assignment",
      arguments: { course_id: "42" },
      expectedDigest: "d".repeat(64),
    },
    authority: {
      profileDigest,
      actorDigest: "c".repeat(64),
      providerPrincipalDigest: "d".repeat(64),
      connectionGeneration: 1,
      catalogDigest,
      approvalClass: "standard",
      targetSetDigest: "e".repeat(64),
    },
  });
  broker.registerBatch(input.batch.batch.batchId);
  broker.bindBatchOperation(input.batch.batch.batchId, source.childId, effect.operationId);
  broker.approve(effect.operationId);
  input.store.bindGatewayOperation(input.batch.batch.batchId, source.childId, effect.operationId, "approved");
  begin(input.store, input.batch.batch.batchId, input.batch.manifest.courseSet.digest);
  expect(input.store.claimPending(input.batch.batch.batchId, 1).map((child) => child.childId)).toEqual(["create"]);
  broker.reserveDispatch(effect.operationId);
  const upstreamResultDigest = "f".repeat(64);
  const readbackDigest = "d".repeat(64);
  const settled = broker.settleResponse(effect.operationId, {
    upstreamResultDigest,
    sourceResultState: "verified",
  });
  const envelope = input.artifact
    ? encryptCanvasResultBindingArtifact(input.key, {
        operationId: settled.operationId,
        publicToolName: settled.publicToolName,
        sourceId: settled.sourceId,
        sourceToolName: settled.sourceToolName,
        sourceOperationId: settled.sourceOperationId,
        sourceBindingId: settled.sourceBindingId,
        targetIdentityDigest: settled.targetIdentityDigest,
        upstreamResultDigest,
        readbackDigest,
      }, input.artifact)
    : undefined;
  broker.recordReadback(
    effect.operationId,
    readbackDigest,
    true,
    envelope ? { ...envelope } : undefined,
  );
  broker.close();
  input.store.close();
  return effect.operationId;
}

describe("Canvas result-bound batch children", () => {
  it("authenticates the artifact against the exact verified effect", () => {
    const key = randomBytes(32);
    const artifact = {
      schema: CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
      kind: "canvas_assignment_id_to_module_item_content_id" as const,
      value: "912",
    };
    const context = {
      operationId: "op:artifact-proof",
      publicToolName: "canvas_create_assignment",
      sourceId: "canvas-connector",
      sourceToolName: "canvas_create_assignment",
      sourceOperationId: "operation:artifact-proof",
      sourceBindingId,
      targetIdentityDigest: "e".repeat(64),
      upstreamResultDigest: "f".repeat(64),
      readbackDigest: "d".repeat(64),
    };
    const envelope = encryptCanvasResultBindingArtifact(key, context, artifact);
    expect(decryptCanvasResultBindingArtifact(key, context, envelope)).toEqual(artifact);
    expect(() => decryptCanvasResultBindingArtifact(key, {
      ...context,
      readbackDigest: "a".repeat(64),
    }, envelope)).toThrow();
  });

  it.each([
    {
      kind: "page" as const,
      artifact: {
        schema: CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
        kind: "canvas_page_url_to_module_item_page_url" as const,
        value: "restart-proof-page",
      },
      expected: { module_item_page_url: "restart-proof-page" },
    },
    {
      kind: "assignment" as const,
      artifact: {
        schema: CANVAS_RESULT_BINDING_ARTIFACT_SCHEMA,
        kind: "canvas_assignment_id_to_module_item_content_id" as const,
        value: "912",
      },
      expected: { module_item_content_id: "912" },
    },
  ])("recovers an authenticated $kind result binding and claims its placement in one resume", ({ kind, artifact, expected }) => {
    const directory = mkdtempSync(join(tmpdir(), `morrow-${kind}-binding-recovery-`));
    roots.push(directory);
    const path = join(directory, "batch.sqlite3");
    const key = randomBytes(32);
    new GatewayOperationJournal({ path }).close();
    const store = new DurableBatchStore({ path, encryptionKey: key });
    const created = createBoundBatch(store, kind);
    const sourceTool = kind === "page" ? "canvas_create_page_courses" : "canvas_create_assignment";
    const extracted = canvasResultBindingArtifactFromVerifiedConnector(sourceTool, {
      structuredContent: {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        provider: "canvas",
        toolName: sourceTool,
        commandKind: "invoke_write",
        result: {
          schema: "morrow.canvas-browser-result.v1",
          ok: true,
          sent: true,
          data: kind === "page" ? { url: artifact.value } : { id: artifact.value },
          verification: { schema: "morrow.browser-verification.v1", status: "verified" },
        },
      },
    });
    expect(extracted).toEqual(artifact);
    interruptAfterVerifiedEffect({ store, path, key, batch: created, artifact: extracted! });

    const interrupted = new DurableBatchStore({ path, encryptionKey: key });
    expect(interrupted.get(created.batch.batchId).children).toMatchObject([
      { childId: "create", state: "unknown" },
      { childId: "place", state: "pending", hasBoundRequest: false },
    ]);
    interrupted.close();
    const recovery = recoverBatchState({
      path,
      batchId: created.batch.batchId,
      mode: "apply_safe",
      encryptionKey: key,
    });
    expect(recovery).toMatchObject({
      stateAfter: "paused",
      applied: 1,
      inspectionRequired: 0,
      providerDispatches: 0,
      children: [{ action: "direct_effect_verified", applied: true }],
    });

    const resumed = new DurableBatchStore({ path, encryptionKey: key });
    expect(resumed.get(created.batch.batchId).children).toMatchObject([
      { childId: "create", state: "succeeded", gatewayOperationState: "verified" },
      { childId: "place", state: "pending", hasBoundRequest: true },
    ]);
    expect(resumed.readArguments(created.batch.batchId, "place")).toMatchObject(expected);
    resumed.bindGatewayOperation(created.batch.batchId, "place", `op:${kind}-placement`, "approved");
    resumed.resume(created.batch.batchId, catalogDigest, {
      courseSetDigest: created.manifest.courseSet.digest,
      profileDigest,
    });
    expect(resumed.claimPending(created.batch.batchId, 1).map((child) => child.childId)).toEqual(["place"]);
    resumed.close();
    if (kind === "page") {
      expect(readFileSync(path).includes(Buffer.from(artifact.value))).toBe(false);
    }
  });

  it("requires inspection for both source and dependent when verified recovery has no exact artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-missing-binding-recovery-"));
    roots.push(directory);
    const path = join(directory, "batch.sqlite3");
    const key = randomBytes(32);
    new GatewayOperationJournal({ path }).close();
    const store = new DurableBatchStore({ path, encryptionKey: key });
    const created = createBoundBatch(store);
    interruptAfterVerifiedEffect({ store, path, key, batch: created });
    const interrupted = new DurableBatchStore({ path, encryptionKey: key });
    interrupted.close();

    const recovery = recoverBatchState({
      path,
      batchId: created.batch.batchId,
      mode: "apply_safe",
      encryptionKey: key,
    });
    expect(recovery).toMatchObject({
      stateAfter: "inspection_required",
      applied: 1,
      inspectionRequired: 1,
      providerDispatches: 0,
      children: [{
        action: "inspection_required",
        gatewayOperationState: "verified_result_binding_inspection_required",
      }],
    });
    const inspected = new DurableBatchStore({ path, encryptionKey: key });
    expect(inspected.get(created.batch.batchId).children).toMatchObject([
      { childId: "create", state: "unknown", gatewayOperationState: "verified_result_binding_inspection_required" },
      { childId: "place", state: "unknown", gatewayOperationState: "result_binding_inspection_required", hasBoundRequest: false },
    ]);
    expect(inspected.claimPending(created.batch.batchId, 2)).toEqual([]);
    inspected.close();
  });

  it("atomically derives, encrypts, and uses a page module-item target only after verified create readback", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-canvas-result-binding-"));
    roots.push(directory);
    const path = join(directory, "batch.sqlite3");
    const key = randomBytes(32);
    const store = new DurableBatchStore({ path, encryptionKey: key });
    const created = createBoundBatch(store);
    begin(store, created.batch.batchId, created.manifest.courseSet.digest);

    const [source] = store.claimPending(created.batch.batchId, 2);
    expect(source?.childId).toBe("create");
    const sourceResult = verifiedCreateResult("canvas_create_page_courses", { url: "private-cell-notes", page_id: "88" });
    store.settleChild(created.batch.batchId, source!.childId, {
      state: "succeeded",
      resultDigest: sha256Json(sourceResult),
      resultPayload: sourceResult,
      gatewayOperationState: "verified",
    });

    const placed = store.get(created.batch.batchId).children.find((child) => child.childId === "place")!;
    expect(placed).toMatchObject({ state: "pending", hasBoundRequest: true });
    expect(store.readArguments(created.batch.batchId, "place")).toEqual({
      course_id: "42",
      module_id: "9",
      module_item_type: "Page",
      module_item_title: "Keep this text",
      module_item_page_url: "private-cell-notes",
      _morrow: { source_binding_id: sourceBindingId },
    });
    store.bindGatewayOperation(created.batch.batchId, "place", "op:bound-placement", "approved");
    expect(store.claimPending(created.batch.batchId, 2).map((child) => child.childId)).toEqual(["place"]);
    store.close();

    const stored = readFileSync(path);
    expect(stored.includes(Buffer.from("private-cell-notes"))).toBe(false);
    const reopened = new DurableBatchStore({ path, encryptionKey: key });
    expect(reopened.readArguments(created.batch.batchId, "place").module_item_page_url).toBe("private-cell-notes");
    reopened.close();
  });

  it("derives an assignment module-item content id from only the verified source artifact", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = createBoundBatch(store, "assignment");
    begin(store, created.batch.batchId, created.manifest.courseSet.digest);
    const [source] = store.claimPending(created.batch.batchId, 1);
    const sourceResult = verifiedCreateResult("canvas_create_assignment", { id: "77", name: "Private reflection" });
    store.settleChild(created.batch.batchId, source!.childId, {
      state: "succeeded",
      resultDigest: sha256Json(sourceResult),
      resultPayload: sourceResult,
      gatewayOperationState: "verified",
    });
    expect(store.readArguments(created.batch.batchId, "place")).toMatchObject({
      module_item_type: "Assignment",
      module_item_content_id: "77",
    });
    store.close();
  });

  it("moves the batch to inspection required and never claims placement when verified artifact data is absent", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = createBoundBatch(store);
    begin(store, created.batch.batchId, created.manifest.courseSet.digest);
    const [source] = store.claimPending(created.batch.batchId, 1);
    const malformed = verifiedCreateResult("canvas_create_page_courses", { page_id: "88" });
    store.settleChild(created.batch.batchId, source!.childId, {
      state: "succeeded",
      resultDigest: sha256Json(malformed),
      resultPayload: malformed,
      gatewayOperationState: "verified",
    });
    const detail = store.get(created.batch.batchId);
    expect(detail.batch.state).toBe("inspection_required");
    expect(detail.children.find((child) => child.childId === "place")).toMatchObject({
      state: "unknown",
      hasBoundRequest: false,
      gatewayOperationState: "dependency_unverified",
    });
    expect(store.claimPending(created.batch.batchId, 1)).toEqual([]);
    store.close();
  });

  it("moves the batch to inspection required without binding when the source is unconfirmed or unknown", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const created = createBoundBatch(store);
    begin(store, created.batch.batchId, created.manifest.courseSet.digest);
    const [source] = store.claimPending(created.batch.batchId, 1);
    const unconfirmed = verifiedCreateResult("canvas_create_page_courses", { url: "would-be-page" });
    store.settleChild(created.batch.batchId, source!.childId, {
      state: "unknown",
      resultDigest: sha256Json(unconfirmed),
      gatewayOperationState: "awaiting_verification",
      errorDigest: "c".repeat(64),
    });
    expect(store.get(created.batch.batchId)).toMatchObject({
      batch: { state: "inspection_required" },
      children: [
        { childId: "create", state: "unknown" },
        { childId: "place", state: "unknown", hasBoundRequest: false, gatewayOperationState: "dependency_unverified" },
      ],
    });
    expect(store.claimPending(created.batch.batchId, 1)).toEqual([]);
    store.close();
  });

  it("refuses cross-course, missing-dependency, fixed-target, and wrong-kind bindings before any child can run", () => {
    const store = new DurableBatchStore({ path: ":memory:", encryptionKey: randomBytes(32) });
    const base = {
      name: "Invalid result binding",
      mode: "stage_writes" as const,
      catalogDigest,
      concurrency: 1,
      courseSet: { source: "explicit" as const, courseIds: ["42"], complete: true, paginationComplete: true },
      children: [
        {
          childId: "create", courseId: "42", publicToolName: "canvas_create_page_courses", sourceId: "canvas-connector",
          sourceToolName: "canvas_create_page_courses", readOnly: false,
          arguments: { course_id: "42", wiki_page_title: "Page", _morrow: { source_binding_id: sourceBindingId } },
        },
        {
          childId: "place", courseId: "42", publicToolName: "canvas_create_module_item", sourceId: "canvas-connector",
          sourceToolName: "canvas_create_module_item", readOnly: false,
          arguments: { course_id: "42", module_id: "9", module_item_type: "Page", module_item_page_url: "caller-chosen", _morrow: { source_binding_id: sourceBindingId } },
          dependencyChildIds: [],
          resultBinding: { schema: "morrow.canvas-result-binding.v1" as const, sourceChildId: "create", kind: "canvas_page_url_to_module_item_page_url" as const },
        },
      ],
    };
    expect(() => store.create(base)).toThrow(/result binding/);
    store.close();
  });
});
