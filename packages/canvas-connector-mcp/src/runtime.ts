import { randomUUID } from "node:crypto";
import { BridgeOutcomeUnknownError, BridgePortInUseError, BridgeUnavailableError, LoopbackBridgeServer, bridgeFailureResult } from "@morrow/bridge-loopback";
import {
  normalizeBridgeEditOptionsResult,
  normalizeBridgeEditPolicySet,
  normalizeBridgeMaintenanceControl,
  normalizeBridgePrivateAttachment,
  normalizeBridgePrivateAttachments,
  normalizeBridgePrivateConversation,
  splitBridgeCallArguments,
  type BridgeBinding,
  type BridgeEditPolicySet,
  type BridgeMaintenanceControl,
  type BridgePrivateAttachment,
  type BridgePrivateConversation,
  type BridgeProblem,
  type BridgeProvider,
} from "@morrow/bridge-protocol";
import { canvasAdmissionReason, canvasContextCodeCourseId, canvasOperationAdmission, canvasOperationMap, loadCanvasApiCatalog, type CanvasApiCatalog, type CanvasApiOperation, type CanvasSemanticCourseTarget } from "@morrow/canvas-api-catalog";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import {
  bridgeCatalogDigest,
  loadCanvasBrowserCatalog,
  loadMoodleBrowserCatalog,
  type CanvasBrowserCatalog,
  type CanvasBrowserOperation,
  type MoodleBrowserCatalog,
  type MoodleBrowserOperation,
} from "./browser-catalog.js";
import type { CanvasConnectorConfig } from "./config.js";

function resultObject(value: unknown): JsonObject {
  return isJsonObject(value) ? structuredClone(value) : { value: value ?? null };
}

type ConnectorOperation = CanvasApiOperation | CanvasBrowserOperation | MoodleBrowserOperation;
const PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS = ["course_id", "section_id", "name", "filename", "size_bytes", "sha256", "expected_digest"];
const PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS = ["course_id", "module_id", "filename", "size_bytes", "sha256", "expected_digest"];
const PRIVATE_MOODLE_STAGED_FILE_OPERATIONS: ReadonlyArray<{ toolName: string; key: string; argumentNames: readonly string[]; attachmentMode: "single" | "multiple" }> = [
  { toolName: "moodle_create_resource_file", key: "moodle.form.course.modedit.resource.file.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { toolName: "moodle_create_folder_file", key: "moodle.form.course.modedit.folder.file.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { toolName: "moodle_create_imscp_package", key: "moodle.form.course.modedit.imscp.package.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { toolName: "moodle_create_scorm_package", key: "moodle.form.course.modedit.scorm.package.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
  { toolName: "moodle_replace_resource_file", key: "moodle.form.course.modedit.resource.file.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" },
  { toolName: "moodle_replace_scorm_package", key: "moodle.form.course.modedit.scorm.package.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" },
  { toolName: "moodle_add_folder_files", key: "moodle.form.course.modedit.folder.files.add.write.v1", argumentNames: ["course_id", "module_id", "folder_path", "files", "expected_digest"], attachmentMode: "multiple" },
  { toolName: "moodle_create_h5pactivity", key: "moodle.form.course.modedit.h5pactivity.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" },
];
const PRIVATE_CANVAS_COURSE_FILE_TOOL = "canvas_transfer_course_file";
const PRIVATE_CANVAS_COURSE_FILE_OPERATION = "canvas.private.course_file.transfer.v1";
const PRIVATE_CANVAS_COURSE_FILE_ARGUMENTS = ["course_id", "folder_id", "filename", "size_bytes", "sha256", "content_type"];
const PRIVATE_CANVAS_CONVERSATION_TOOL = "canvas_send_private_conversation";
const PRIVATE_CANVAS_CONVERSATION_OPERATION = "canvas.private.conversation.send.v1";
const PRIVATE_CANVAS_CONVERSATION_ARGUMENTS = ["course_id"];
const CANVAS_CONTENT_GUARD_OPERATIONS = [
  { kind: "page_text", toolName: "canvas_update_create_page_courses", key: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses" },
  { kind: "page_image_alt", toolName: "canvas_update_create_page_courses", key: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses" },
  { kind: "assignment_image_alt", toolName: "canvas_edit_assignment", key: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment" },
  { kind: "discussion_image_alt", toolName: "canvas_update_topic_courses", key: "PUT /v1/courses/{course_id}/discussion_topics/{topic_id}#update_topic_courses" },
  { kind: "classic_quiz_description_image_alt", toolName: "canvas_edit_quiz", key: "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz" },
  { kind: "classic_quiz_question_image_alt", toolName: "canvas_update_existing_quiz_question", key: "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question" },
  { kind: "new_quiz_item_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" },
  { kind: "new_quiz_choice_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" },
  { kind: "new_quiz_answer_feedback_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" },
  { kind: "new_quiz_feedback_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" },
] as const;

function operationProvider(operation: ConnectorOperation): BridgeProvider {
  return "provider" in operation ? operation.provider : "canvas";
}

function isCanvasOperation(operation: ConnectorOperation): operation is CanvasApiOperation {
  return !("provider" in operation);
}

function supportedCanvasContentGuardOperation(operation: ConnectorOperation, guard: JsonObject): boolean {
  if (!isCanvasOperation(operation)) return false;
  return CANVAS_CONTENT_GUARD_OPERATIONS.some((candidate) => candidate.kind === guard.kind
    && candidate.toolName === operation.toolName && candidate.key === operation.key);
}

// The one Item Bank write with an Edit path is the guarded image alternative-text repair.
// connector/extension/src/item-bank-guard.js holds the contract, and the Item Banks frame reads
// the exact question again before and after its single PATCH. This boundary check is the shape
// only, so an Item Bank write that carries no guard never reaches the bridge; the extension and
// the frame refuse a guard that carries the wrong course, question, or affected-course list.
// packages/canvas-connector-mcp/test/runtime.test.ts checks this field list against that module.
const ITEM_BANK_GUARD_KIND = "item_bank_entry_image_alt";
export const ITEM_BANK_GUARD_FIELDS: readonly string[] = [
  "kind", "course_id", "bank_id", "bank_entry_id", "item_id", "entry_type",
  "item_sha256", "protected_state_sha256", "image_index", "image_src_sha256",
  "alt_text", "fan_out", "acknowledged_course_ids",
];

function guardedItemBankUpdate(operation: ConnectorOperation, argumentsValue: Readonly<Record<string, unknown>>): boolean {
  if (!isCanvasOperation(operation) || operation.service !== "item_bank" || operation.nickname !== "update_item") return false;
  const guard = argumentsValue.morrow_item_bank_guard;
  if (!isJsonObject(guard)) return false;
  const keys = Object.keys(guard);
  return keys.length === ITEM_BANK_GUARD_FIELDS.length
    && ITEM_BANK_GUARD_FIELDS.every((field) => keys.includes(field))
    && guard.kind === ITEM_BANK_GUARD_KIND
    && guard.entry_type === "Item";
}

function exactCourseId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return undefined;
}

function courseScope(operation: ConnectorOperation, argumentsValue: JsonObject): {
  readonly scoped: boolean;
  readonly courseId?: string;
  readonly semanticTarget?: CanvasSemanticCourseTarget;
  readonly objectId?: string;
} {
  if (!isCanvasOperation(operation)) {
    return operation.toolName === "moodle_list_my_courses"
      ? { scoped: false }
      : { scoped: true, ...(exactCourseId(argumentsValue.course_id) ? { courseId: exactCourseId(argumentsValue.course_id) } : {}) };
  }
  // The Item Bank routes name a bank, never a course. The guarded question repair carries the
  // selected course in its guard, and the Item Banks frame proves that same course from its own
  // session before it sends anything, so the course named here is compared with the binding below.
  if (guardedItemBankUpdate(operation, argumentsValue)) {
    const courseId = exactCourseId((argumentsValue.morrow_item_bank_guard as JsonObject).course_id);
    return { scoped: true, ...(courseId ? { courseId } : {}) };
  }
  const target = canvasOperationAdmission(operation).courseTarget;
  // The route names one object instead of a course. The course that owns it is proved by the
  // connector, which reads the object in the bound tab immediately before it sends the change, so
  // the only thing this layer can require is one exact object id and one selected course.
  if (target.kind === "semantic_course_object") {
    // A route that creates the object names no object. The write input that names the calendar it
    // lands in is what binds it to one course, so this layer reads the course out of that input and
    // compares it with the selected binding like any other course-scoped change.
    if (target.target.createsObject) {
      const courseId = canvasContextCodeCourseId(argumentsValue[String(target.target.courseCodeParameter)]);
      return { scoped: true, ...(courseId ? { courseId } : {}) };
    }
    const objectId = exactCourseId(argumentsValue[String(target.target.objectParameter)]);
    return { scoped: true, semanticTarget: target.target, ...(objectId ? { objectId } : {}) };
  }
  const field = target.kind === "course_path" || target.kind === "self_path" ? target.argument : undefined;
  return field
    ? { scoped: true, ...(exactCourseId(argumentsValue[field]) ? { courseId: exactCourseId(argumentsValue[field]) } : {}) }
    : { scoped: false };
}

function privateMoodleStagedFileOperation(operation: ConnectorOperation): { toolName: string; key: string; argumentNames: readonly string[]; attachmentMode: "single" | "multiple" } | undefined {
  if (!("provider" in operation) || operation.provider !== "moodle") return undefined;
  return PRIVATE_MOODLE_STAGED_FILE_OPERATIONS
    .find((entry) => entry.toolName === operation.toolName && entry.key === operation.key);
}

function isPrivateMoodleStagedFileOperation(operation: ConnectorOperation): operation is MoodleBrowserOperation {
  return privateMoodleStagedFileOperation(operation) !== undefined;
}

function moodleStagedFileAttachmentMatches(argumentsValue: JsonObject, attachment: BridgePrivateAttachment, argumentNames: readonly string[]): boolean {
  if (Object.keys(argumentsValue).length !== argumentNames.length
    || argumentNames.some((field) => !Object.hasOwn(argumentsValue, field))) return false;
  return argumentsValue.filename === attachment.manifest.filename
    && argumentsValue.size_bytes === attachment.manifest.size_bytes
    && argumentsValue.sha256 === attachment.manifest.sha256;
}

function moodleStagedFileAttachmentsMatch(argumentsValue: JsonObject, attachments: readonly BridgePrivateAttachment[], argumentNames: readonly string[]): boolean {
  if (Object.keys(argumentsValue).length !== argumentNames.length
    || argumentNames.some((field) => !Object.hasOwn(argumentsValue, field))
    || !Array.isArray(argumentsValue.files) || argumentsValue.files.length !== attachments.length
    || typeof argumentsValue.folder_path !== "string" || !/^\/(?:[^\\/]+\/)*$/.test(argumentsValue.folder_path)) return false;
  return argumentsValue.files.every((file, index) => isJsonObject(file)
    && Object.keys(file).length === 3
    && file.filename === attachments[index]?.manifest.filename
    && file.size_bytes === attachments[index]?.manifest.size_bytes
    && file.sha256 === attachments[index]?.manifest.sha256);
}

function canvasFileAttachmentMatches(argumentsValue: JsonObject, attachment: BridgePrivateAttachment): boolean {
  if (Object.keys(argumentsValue).length !== PRIVATE_CANVAS_COURSE_FILE_ARGUMENTS.length
    || PRIVATE_CANVAS_COURSE_FILE_ARGUMENTS.some((field) => !Object.hasOwn(argumentsValue, field))) return false;
  return exactCourseId(argumentsValue.course_id) !== undefined
    && exactCourseId(argumentsValue.folder_id) !== undefined
    && typeof argumentsValue.filename === "string" && argumentsValue.filename === attachment.manifest.filename
    && argumentsValue.size_bytes === attachment.manifest.size_bytes
    && argumentsValue.sha256 === attachment.manifest.sha256
    && typeof argumentsValue.content_type === "string"
    && argumentsValue.content_type === attachment.content_type
    && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(argumentsValue.content_type);
}

function canvasConversationArgumentsMatch(argumentsValue: JsonObject, conversation: BridgePrivateConversation): boolean {
  return Object.keys(argumentsValue).length === PRIVATE_CANVAS_CONVERSATION_ARGUMENTS.length
    && PRIVATE_CANVAS_CONVERSATION_ARGUMENTS.every((field) => Object.hasOwn(argumentsValue, field))
    && exactCourseId(argumentsValue.course_id) === conversation.courseId;
}

function splitPrivateAttachment(value: Readonly<Record<string, unknown>>): {
  readonly publicInput: JsonObject;
  readonly privateAttachment?: BridgePrivateAttachment;
  readonly privateAttachments?: readonly BridgePrivateAttachment[];
  readonly privateConversation?: BridgePrivateConversation;
} {
  const input = { ...value };
  const rawPrivateAttachment = input.privateAttachment;
  const rawPrivateAttachments = input.privateAttachments;
  const rawPrivateConversation = input.privateConversation;
  delete input.privateAttachment;
  delete input.privateAttachments;
  delete input.privateConversation;
  if (rawPrivateAttachment === undefined && rawPrivateAttachments === undefined && rawPrivateConversation === undefined) return { publicInput: input as JsonObject };
  return {
    publicInput: input as JsonObject,
    ...(rawPrivateAttachment === undefined ? {} : { privateAttachment: normalizeBridgePrivateAttachment(rawPrivateAttachment) }),
    ...(rawPrivateAttachments === undefined ? {} : { privateAttachments: normalizeBridgePrivateAttachments(rawPrivateAttachments) }),
    ...(rawPrivateConversation === undefined ? {} : { privateConversation: normalizeBridgePrivateConversation(rawPrivateConversation) }),
  };
}

function readDescriptorOf(value: unknown): JsonObject | undefined {
  const result = isJsonObject(value) ? value.readDescriptor : undefined;
  return isJsonObject(result) && result.schema === "morrow.canvas-recovery-descriptor.v1"
    ? structuredClone(result)
    : undefined;
}

function failedProblem(
  problem: BridgeProblem | undefined,
  provider: BridgeProvider = "canvas",
  readDescriptor?: JsonObject,
): JsonObject {
  return {
    schema: "morrow.canvas-connector.result.v1",
    ok: false,
    provider,
    // A write whose outcome is unknown still returns its read-only comparator so
    // Morrow can check the saved result later instead of sending the change again.
    ...(readDescriptor ? { readDescriptor } : {}),
    // These codes are the endings that changed nothing at the provider, so the
    // gateway settles the record as failed and keeps the target unlocked.
    // canvas_request_not_sent now also carries a Canvas write the provider
    // refused with a definite-no-effect status, by the one rule in
    // connector/extension/src/canvas-write-outcome.js: a 4xx other than 408 and
    // 429 saved nothing; every other ending stays uncertain and arrives as
    // write_outcome_unknown instead.
    // canvas_binding_required is raised only by connector/extension/src/service-worker.js
    // commandContext, which runs before the change is dispatched, so a course site tab that closes
    // mid-batch fails every request in flight without sending any of them.
    ...(["canvas_request_not_sent", "canvas_binding_required", "canvas_content_guard_unavailable", "moodle_binding_required", "moodle_expected_digest_required", "moodle_binding_course_mismatch", "course_binding_required", "course_binding_course_mismatch", "course_scope_required",
      "canvas_semantic_target_course_mismatch", "canvas_semantic_target_input_refused", "canvas_semantic_target_resolution_stale",
      "multi_context_object_not_supported"].includes(problem?.code || "") ? { resultState: "not_sent" } : {}),
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
  readonly canvasBrowserCatalog: CanvasBrowserCatalog;
  readonly moodleCatalog: MoodleBrowserCatalog;
  readonly catalogDigest: string;
  readonly bridge: LoopbackBridgeServer;
  readonly operations: ReadonlyMap<string, ConnectorOperation>;

  private constructor(
    catalog: CanvasApiCatalog,
    canvasBrowserCatalog: CanvasBrowserCatalog,
    moodleCatalog: MoodleBrowserCatalog,
    bridge: LoopbackBridgeServer,
  ) {
    this.catalog = catalog;
    this.canvasBrowserCatalog = canvasBrowserCatalog;
    this.moodleCatalog = moodleCatalog;
    this.catalogDigest = bridgeCatalogDigest(catalog, canvasBrowserCatalog, moodleCatalog);
    this.bridge = bridge;
    this.operations = new Map<string, ConnectorOperation>([
      ...[...canvasOperationMap(catalog)].map(([toolName, operation]) => [toolName, operation] as const),
      ...canvasBrowserCatalog.operations.map((operation) => [operation.toolName, operation] as const),
      ...moodleCatalog.operations.map((operation) => [operation.toolName, operation] as const),
    ]);
    if (this.operations.size !== catalog.operations.length + canvasBrowserCatalog.operations.length + moodleCatalog.operations.length) {
      throw new Error("Canvas and Moodle browser catalogs contain duplicate tool names.");
    }
  }

  static async start(config: CanvasConnectorConfig): Promise<CanvasConnectorRuntime> {
    const catalog = loadCanvasApiCatalog(config.catalogPath);
    const canvasBrowserCatalog = loadCanvasBrowserCatalog();
    const moodleCatalog = loadMoodleBrowserCatalog();
    const catalogDigest = bridgeCatalogDigest(catalog, canvasBrowserCatalog, moodleCatalog);
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
      // Another Morrow already holds the Bridge port. This connector keeps
      // running so the assistant still starts and `health()` names the state.
      // The Morrow that holds the port is not touched.
      if (!(error instanceof BridgePortInUseError)) throw error;
    }
    return new CanvasConnectorRuntime(catalog, canvasBrowserCatalog, moodleCatalog, bridge);
  }

  health(): JsonObject {
    return {
      schema: "morrow.canvas-connector.health.v1",
      ready: this.bridge.health().connected,
      catalogDigest: this.catalogDigest,
      operationCount: this.operations.size,
      newQuizzesOperationCount: this.catalog.counts.newQuizzesOperations,
      itemBankOperationCount: this.catalog.counts.itemBankOperations,
      courseFileContentOperationCount: this.catalog.counts.courseFileContentOperations,
      bridge: this.bridge.health(),
    };
  }

  bindings(): readonly BridgeBinding[] {
    return this.bridge.listBindings();
  }

  canvasBindings(): readonly BridgeBinding[] {
    return this.bindings().filter((binding) => binding.provider === "canvas");
  }

  async editOptions(sourceBindingId: string): Promise<JsonObject> {
    if (typeof sourceBindingId !== "string" || !/^[A-Za-z0-9_.:@-]{1,160}$/.test(sourceBindingId)) {
      throw new TypeError("source_binding_id must identify one saved browser binding");
    }
    const response = await this.bridge.invoke({
      kind: "edit_policy_options_get",
      sourceBindingId,
      operationId: `edit-options:${randomUUID()}`,
    });
    if (!response.ok || !response.result) {
      const message = response.problem?.message || "Morrow did not receive the current course Edit actions.";
      throw new BridgeUnavailableError(message);
    }
    return normalizeBridgeEditOptionsResult(response.result, sourceBindingId) as unknown as JsonObject;
  }

  async editPolicySet(input: BridgeEditPolicySet): Promise<JsonObject> {
    let editPolicySet: BridgeEditPolicySet;
    try {
      editPolicySet = normalizeBridgeEditPolicySet(input);
    } catch (error) {
      return {
        schema: "morrow.browser-edit-policy-set.v1",
        ok: false,
        problem: {
          schema: "morrow.bridge.problem.v1",
          code: "edit_policy_set_invalid",
          message: "Morrow could not validate the selected course Edit policy.",
          recoverable: false,
        },
      };
    }
    try {
      const response = await this.bridge.invoke({
        kind: "edit_policy_set",
        editPolicySet,
        operationId: `edit-policy:${randomUUID()}`,
      });
      if (!response.ok || !isJsonObject(response.result)) {
        return {
          schema: "morrow.browser-edit-policy-set.v1",
          ok: false,
          problem: response.problem || {
            schema: "morrow.bridge.problem.v1",
            code: "edit_policy_set_result_missing",
            message: "Morrow did not receive the selected course Edit policy result.",
            recoverable: false,
          },
        };
      }
      return {
        schema: "morrow.browser-edit-policy-set.v1",
        ok: true,
        mode: editPolicySet.mode,
        selections: editPolicySet.selections,
        result: response.result,
      };
    } catch (error) {
      return {
        schema: "morrow.browser-edit-policy-set.v1",
        ok: false,
        problem: bridgeFailureResult(error),
        ...(error instanceof BridgeOutcomeUnknownError ? { resultState: "unknown" } : {}),
        ...(error instanceof BridgeUnavailableError ? { resultState: "not_sent" } : {}),
      };
    }
  }

  async bridgeMaintenance(input: BridgeMaintenanceControl): Promise<JsonObject> {
    let maintenance: BridgeMaintenanceControl;
    try {
      maintenance = normalizeBridgeMaintenanceControl(input);
    } catch {
      return {
        schema: "morrow.bridge-maintenance-result.v1",
        ok: false,
        problem: {
          schema: "morrow.bridge.problem.v1",
          code: "bridge_maintenance_control_invalid",
          message: "Morrow could not validate the private Bridge update control.",
          recoverable: false,
        },
      };
    }
    try {
      const response = await this.bridge.invoke({
        kind: "bridge_maintenance",
        maintenance,
        operationId: `bridge-maintenance:${randomUUID()}`,
      });
      if (!response.ok || !isJsonObject(response.result)) {
        return {
          schema: "morrow.bridge-maintenance-result.v1",
          ok: false,
          problem: response.problem || {
            schema: "morrow.bridge.problem.v1",
            code: "bridge_maintenance_result_missing",
            message: "Morrow did not receive the private Bridge update result.",
            recoverable: false,
          },
        };
      }
      return structuredClone(response.result);
    } catch (error) {
      return {
        schema: "morrow.bridge-maintenance-result.v1",
        ok: false,
        problem: bridgeFailureResult(error),
        ...(error instanceof BridgeOutcomeUnknownError ? { resultState: "unknown" } : {}),
        ...(error instanceof BridgeUnavailableError ? { resultState: "not_sent" } : {}),
      };
    }
  }

  private async callPrivateCanvasCourseFileTransfer(rawArguments: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    let separated: ReturnType<typeof splitPrivateAttachment>;
    try {
      separated = splitPrivateAttachment(rawArguments);
    } catch {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_attachment_invalid",
        message: "The staged private Canvas file attachment could not be verified.",
        recoverable: false,
      });
    }
    if (separated.privateConversation) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_conversation_refused",
        message: "A private Canvas Inbox payload is not valid for a course-file transfer.",
        recoverable: false,
      });
    }
    if (!separated.privateAttachment) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_attachment_required",
        message: "This reviewed Canvas course file needs its staged private attachment.",
        recoverable: true,
      });
    }
    const split = splitBridgeCallArguments(separated.publicInput);
    if (!split.options.sourceBindingId || !split.options.operationId || !split.options.outerGrant) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_file_reservation_required",
        message: "This private Canvas course-file route requires a current reviewed operation reservation.",
        recoverable: false,
      });
    }
    if (!canvasFileAttachmentMatches(split.arguments, separated.privateAttachment)) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_attachment_mismatch",
        message: "The staged private file does not match this exact Canvas course and folder.",
        recoverable: false,
      });
    }
    const courseId = exactCourseId(split.arguments.course_id);
    const binding = this.bindings().find((entry) => entry.sourceBindingId === split.options.sourceBindingId);
    if (!courseId || binding?.provider !== "canvas" || binding.courseId !== courseId || binding.runtimeVerified !== true) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "course_binding_course_mismatch",
        message: "The selected Canvas binding is for a different or changed course.",
        recoverable: true,
      });
    }
    try {
      const response = await this.bridge.invoke({
        kind: "invoke_write",
        toolName: PRIVATE_CANVAS_COURSE_FILE_TOOL,
        operationKey: PRIVATE_CANVAS_COURSE_FILE_OPERATION,
        arguments: split.arguments,
        privateAttachment: separated.privateAttachment,
        sourceBindingId: split.options.sourceBindingId,
        operationId: split.options.operationId,
        outerGrant: split.options.outerGrant,
      });
      if (!response.ok) return failedProblem(response.problem);
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        provider: "canvas",
        toolName: PRIVATE_CANVAS_COURSE_FILE_TOOL,
        operationKey: PRIVATE_CANVAS_COURSE_FILE_OPERATION,
        commandKind: "invoke_write",
        result: resultObject(response.result),
      };
    } catch (error) {
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        provider: "canvas",
        toolName: PRIVATE_CANVAS_COURSE_FILE_TOOL,
        operationKey: PRIVATE_CANVAS_COURSE_FILE_OPERATION,
        commandKind: "invoke_write",
        problem: bridgeFailureResult(error),
        ...(error instanceof BridgeOutcomeUnknownError ? { resultState: "unknown" } : {}),
        ...(error instanceof BridgeUnavailableError ? { resultState: "not_sent" } : {}),
      };
    }
  }

  private async callPrivateCanvasConversation(rawArguments: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    let separated: ReturnType<typeof splitPrivateAttachment>;
    try {
      separated = splitPrivateAttachment(rawArguments);
    } catch {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_conversation_invalid",
        message: "The private Canvas Inbox payload could not be verified.",
        recoverable: false,
      });
    }
    if (separated.privateAttachment || !separated.privateConversation) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_conversation_required",
        message: "This private Canvas Inbox route needs its sealed reviewed payload.",
        recoverable: false,
      });
    }
    const split = splitBridgeCallArguments(separated.publicInput);
    if (!canvasConversationArgumentsMatch(split.arguments, separated.privateConversation)) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_conversation_mismatch",
        message: "The reviewed Canvas Inbox payload does not match one exact current course.",
        recoverable: false,
      });
    }
    if (!split.options.sourceBindingId || !split.options.operationId || !split.options.outerGrant) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_conversation_reservation_required",
        message: "This private Canvas Inbox route requires one current reviewed operation reservation.",
        recoverable: false,
      });
    }
    const binding = this.bindings().find((entry) => entry.sourceBindingId === split.options.sourceBindingId);
    if (binding?.provider !== "canvas" || binding.courseId !== separated.privateConversation.courseId || binding.runtimeVerified !== true) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "course_binding_course_mismatch",
        message: "The selected Canvas binding is for a different or changed course.",
        recoverable: true,
      });
    }
    try {
      const response = await this.bridge.invoke({
        kind: "invoke_write",
        toolName: PRIVATE_CANVAS_CONVERSATION_TOOL,
        operationKey: PRIVATE_CANVAS_CONVERSATION_OPERATION,
        arguments: {},
        privateConversation: separated.privateConversation,
        sourceBindingId: split.options.sourceBindingId,
        operationId: split.options.operationId,
        outerGrant: split.options.outerGrant,
      });
      if (!response.ok) return failedProblem(response.problem);
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: true,
        provider: "canvas",
        toolName: PRIVATE_CANVAS_CONVERSATION_TOOL,
        operationKey: PRIVATE_CANVAS_CONVERSATION_OPERATION,
        commandKind: "invoke_write",
        result: resultObject(response.result),
      };
    } catch (error) {
      return {
        schema: "morrow.canvas-connector.result.v1",
        ok: false,
        provider: "canvas",
        toolName: PRIVATE_CANVAS_CONVERSATION_TOOL,
        operationKey: PRIVATE_CANVAS_CONVERSATION_OPERATION,
        commandKind: "invoke_write",
        problem: bridgeFailureResult(error),
        ...(error instanceof BridgeOutcomeUnknownError ? { resultState: "unknown" } : {}),
        ...(error instanceof BridgeUnavailableError ? { resultState: "not_sent" } : {}),
      };
    }
  }

  async call(toolName: string, rawArguments: Readonly<Record<string, unknown>>): Promise<JsonObject> {
    if (toolName === PRIVATE_CANVAS_COURSE_FILE_TOOL) {
      return await this.callPrivateCanvasCourseFileTransfer(rawArguments);
    }
    if (toolName === PRIVATE_CANVAS_CONVERSATION_TOOL) {
      return await this.callPrivateCanvasConversation(rawArguments);
    }
    const operation = this.operations.get(toolName);
    if (!operation) throw new Error(`Canvas connector has no operation named ${toolName}`);
    const provider = operationProvider(operation);
    if (isCanvasOperation(operation) && operation.service === "item_bank" && !operation.readOnly && operation.nickname !== "create_bank"
      && !guardedItemBankUpdate(operation, rawArguments)) {
      return failedProblem(operation.nickname === "update_item"
        ? {
          schema: "morrow.bridge.problem.v1",
          code: "item_bank_fan_out_and_guard_required",
          message: "Morrow changes one Item Bank question only through its focused image alternative-text repair, with the current question read again and every course the bank reaches confirmed first.",
          recoverable: false,
        }
        : {
          schema: "morrow.bridge.problem.v1",
          code: "item_bank_dependency_review_required",
          message: "Changes to an existing Item Bank require a complete dependency and affected-course review. This release cannot yet establish that evidence.",
          recoverable: false,
        }, provider);
    }
    let separated: ReturnType<typeof splitPrivateAttachment>;
    try {
      separated = splitPrivateAttachment(rawArguments);
    } catch {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "moodle_private_attachment_invalid",
        message: "The staged private file attachment could not be verified.",
        recoverable: false,
      }, provider);
    }
    if (separated.privateConversation) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "canvas_private_conversation_refused",
        message: "A private Canvas Inbox payload is only accepted by Morrow's internal reviewed Inbox route.",
        recoverable: false,
      }, provider);
    }
    const privateMoodleStagedFile = privateMoodleStagedFileOperation(operation);
    if ((separated.privateAttachment || separated.privateAttachments) && !privateMoodleStagedFile) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "moodle_private_attachment_refused",
        message: "A private file attachment is only accepted for one exact Moodle staged-file change.",
        recoverable: false,
      }, provider);
    }
    if (privateMoodleStagedFile && ((privateMoodleStagedFile.attachmentMode === "single" && !separated.privateAttachment)
      || (privateMoodleStagedFile.attachmentMode === "multiple" && !separated.privateAttachments)
      || (separated.privateAttachment && separated.privateAttachments))) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "moodle_private_attachment_required",
        message: "This Moodle staged-file change needs its staged private file attachment.",
        recoverable: true,
      }, provider);
    }
    const split = splitBridgeCallArguments(separated.publicInput);
    if (privateMoodleStagedFile && ((privateMoodleStagedFile.attachmentMode === "single"
      && (!separated.privateAttachment || !moodleStagedFileAttachmentMatches(split.arguments, separated.privateAttachment, privateMoodleStagedFile.argumentNames)))
      || (privateMoodleStagedFile.attachmentMode === "multiple"
        && (!separated.privateAttachments || !moodleStagedFileAttachmentsMatch(split.arguments, separated.privateAttachments, privateMoodleStagedFile.argumentNames))))) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "moodle_private_attachment_mismatch",
        message: "The staged private file does not match this exact Moodle staged-file change.",
        recoverable: false,
      }, provider);
    }
    if ("morrow_canvas_content_guard" in split.arguments || "morrow_page_guard" in split.arguments) {
      throw new TypeError("Canvas content guards must use Morrow's local controls.");
    }
    if ("morrow_list_resume" in split.arguments) {
      throw new TypeError("A bounded list resume must use Morrow's local controls.");
    }
    if (split.options.listResume && !operation.readOnly) {
      throw new TypeError("A bounded list resume belongs to a read.");
    }
    if (split.options.canvasContentGuard && split.options.pageGuard) {
      throw new TypeError("Canvas content guard controls are ambiguous.");
    }
    if (split.options.canvasContentGuard) {
      if (!supportedCanvasContentGuardOperation(operation, split.options.canvasContentGuard)
        || this.bridge.health().runtimeRevision !== "1.0.0-rc.2") {
        return failedProblem({ schema: "morrow.bridge.problem.v1", code: "canvas_content_guard_unavailable", message: "This Canvas content repair needs the current Morrow extension and a connected course.", recoverable: true }, provider);
      }
    }
    if (split.options.pageGuard && (toolName !== "canvas_update_create_page_courses" || this.bridge.health().runtimeRevision !== "1.0.0-rc.2")) {
      return failedProblem({ schema: "morrow.bridge.problem.v1", code: "canvas_content_guard_unavailable", message: "This legacy Page correction needs the current Morrow extension and a connected course.", recoverable: true }, provider);
    }
    const canvasHold = isCanvasOperation(operation) && !operation.readOnly
      ? canvasOperationAdmission(operation).write
      : undefined;
    if (canvasHold?.state === "held" && !guardedItemBankUpdate(operation, split.arguments)) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "course_scope_required",
        // The sentence for this exact hold class, the same one the published capability and the
        // extension Edit list show, so the person reads one plain reason wherever the hold appears.
        message: canvasAdmissionReason(canvasHold) || "Morrow holds this Canvas change before it is sent.",
        recoverable: true,
      }, provider);
    }
    const scopedCourse = courseScope(operation, split.arguments);
    if (!operation.readOnly && !scopedCourse.scoped) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: "course_scope_required",
        message: "This unscoped provider change remains held because Morrow cannot prove one exact course binding.",
        recoverable: true,
      }, provider);
    }
    if ((provider === "moodle" || scopedCourse.scoped) && !split.options.sourceBindingId) {
      return failedProblem({
        schema: "morrow.bridge.problem.v1",
        code: provider === "moodle" ? "moodle_binding_required" : "course_binding_required",
        message: provider === "moodle"
          ? "This Moodle action needs one exact current Moodle binding."
          : "This Canvas course action needs one exact current course binding.",
        recoverable: true,
      }, provider);
    }
    if (scopedCourse.semanticTarget) {
      const binding = this.bindings().find((entry) => entry.sourceBindingId === split.options.sourceBindingId);
      if (!scopedCourse.objectId || binding?.provider !== provider || !exactCourseId(binding.courseId)) {
        return failedProblem({
          schema: "morrow.bridge.problem.v1",
          code: "canvas_semantic_target_course_mismatch",
          message: `Morrow needs one exact Canvas ${scopedCourse.semanticTarget.object} and one selected course before it can change it.`,
          recoverable: true,
        }, provider);
      }
    } else if (scopedCourse.scoped) {
      const binding = this.bindings().find((entry) => entry.sourceBindingId === split.options.sourceBindingId);
      if (!scopedCourse.courseId || binding?.provider !== provider || binding.courseId !== scopedCourse.courseId) {
        return failedProblem({
          schema: "morrow.bridge.problem.v1",
          code: provider === "moodle" ? "moodle_binding_course_mismatch" : "course_binding_course_mismatch",
          message: provider === "moodle"
            ? "The selected Moodle binding is for a different course."
            : "The selected Canvas binding is for a different course.",
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
        arguments: {
          ...split.arguments,
          ...(split.options.canvasContentGuard ? { morrow_canvas_content_guard: split.options.canvasContentGuard } : {}),
          ...(split.options.pageGuard ? { morrow_page_guard: split.options.pageGuard } : {}),
          ...(split.options.listResume ? {
            morrow_list_resume: split.options.listResume.nextPage === undefined
              ? {}
              : { next_page: split.options.listResume.nextPage },
          } : {}),
        },
        ...(separated.privateAttachment ? { privateAttachment: separated.privateAttachment } : {}),
        ...(separated.privateAttachments ? { privateAttachments: separated.privateAttachments } : {}),
        sourceBindingId: split.options.sourceBindingId,
        operationId: split.options.operationId || `operation:${randomUUID()}`,
        ...(split.options.outerGrant ? { outerGrant: split.options.outerGrant } : {}),
      });
      if (!response.ok) return failedProblem(response.problem, provider, readDescriptorOf(response.result));
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
