import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeBridgeBindings,
  normalizeBridgeEditOptionsResult,
  normalizeBridgePrivateConversation,
  type BridgeBinding,
  type BridgePrivateAttachment,
  type BridgePrivateConversation,
} from "@morrow/bridge-protocol";
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  upstreamCatalogDigest,
  type CatalogSnapshot,
  type CatalogSource,
  type CatalogTool,
  type GatewayCallMeta,
  type GatewayHealth,
  type JsonObject,
  type McpRuntimeHealth,
  type PublicationPolicyHealth,
  type RequestedByIdentity,
  type RuntimeProfile,
  type SourceAttestationHealth,
  type ToolAnnotations,
} from "@morrow/contracts";
import {
  applyPublicationPolicy,
  ArtifactGenerationRegistry,
  LearnerRoster,
  LearnerVault,
  canonicalMorrowResult,
  mergeCatalog,
  normalizeLearnerIdentity,
  normalizeUpstreamResult,
  redactLearnerEgress,
  resolveLearnerTokens,
  safeUpstreamFailure,
  type LearnerIdentity,
  type LearnerScope,
  type LearnerTextRedactionContext,
} from "@morrow/gateway-core";
import {
  evaluateBrowserReadback,
  matchesReadbackAssertions,
  readbackFieldValue,
  type BrowserReadbackAssertion,
  type BrowserReadbackPlan,
  type BrowserReadbackResult,
  type CanvasRecoveryDescriptor,
  type CanvasRecoveryRead,
} from "@morrow/canvas-api-catalog";
import {
  GatewayOperationConflictError,
  GatewayOperationJournal,
  ProviderEffectBroker,
  ProviderEffectTargetConflictError,
  ProviderEffectTargetIdentityVersionError,
  ProviderEffectTargetScopeUnknownError,
  classifySourceResult,
  effectOperationProjection,
  operationRecordProjection,
  type EffectOperationRecord,
  type EffectAuthoritySnapshot,
  type EffectAuthorization,
  type FrozenReadbackPlan,
  type GatewayOperationRecord,
  type GatewayOperationState,
} from "@morrow/operation-journal";
import { StdioMcpUpstream } from "@morrow/upstream-mcp";
import { FileStageStore, MAX_STAGED_FILE_BYTES, type FileStageBinding, type FileStageScope } from "./file-staging.js";
import {
  CANVAS_COURSE_FILE_TRANSFER_TOOL,
  CANVAS_FILE_APPROVAL_TTL_MS,
  canvasCourseFileUploadInputSchema,
  canvasFileScope,
  contentTypeForCanvasFile,
  isCanvasCourseFileTransfer,
  readWorkspaceMaterial,
} from "./canvas-file-transfer.js";
import {
  assertNoPrivateAttachmentInput,
  isMoodleStagedFile,
  moodleStagedFileCapability,
  MOODLE_STAGED_FILE_CAPABILITIES,
  moodleStagedFileCapabilityForMapping,
  moodleStagedFileScope,
  moodleFolderFilesInputSchema,
  moodleResourceFileInputSchema,
  moodleResourceFileReplacementInputSchema,
  readWorkspaceFile,
  RESOURCE_FILE_APPROVAL_TTL_MS,
  type MoodleStagedFileKind,
} from "./moodle-resource-file.js";
import {
  MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION,
  MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL,
  projectMoodleAssignmentSubmissionSummaryBrowserResult,
} from "./moodle-assignment-submissions.js";
import {
  MOODLE_ASSIGNMENT_FEEDBACK_OPERATION,
  MOODLE_ASSIGNMENT_FEEDBACK_TOOL,
  MOODLE_ASSIGNMENT_SUBMISSION_OPERATION,
  MOODLE_ASSIGNMENT_SUBMISSION_TOOL,
  projectMoodleAssignmentFeedbackBrowserResult,
  projectMoodleAssignmentSubmissionBrowserResult,
  projectPublicMoodleAssignmentFeedbackResult,
  projectPublicMoodleAssignmentSubmissionResult,
} from "./moodle-assignment-submission-detail.js";
import {
  CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_OPERATION,
  CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL,
  projectCanvasClassicQuizSubmissionSummaryBrowserResult,
} from "./canvas-classic-quiz-submissions.js";
import { canvasCourseSummaryRoute, type CanvasCourseSummaryRoute } from "./canvas-course-summaries.js";
import {
  MOODLE_QUIZ_ATTEMPT_SUMMARY_OPERATION,
  MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL,
  projectMoodleQuizAttemptSummaryBrowserResult,
} from "./moodle-quiz-attempt-summaries.js";
import {
  MOODLE_QUIZ_ATTEMPT_OPERATION,
  MOODLE_QUIZ_ATTEMPT_TOOL,
  MOODLE_QUIZ_MANUAL_GRADING_QUEUE_OPERATION,
  MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL,
  MOODLE_QUIZ_REGRADE_REPORT_OPERATION,
  MOODLE_QUIZ_REGRADE_REPORT_TOOL,
  projectMoodleQuizAttemptBrowserResult,
  projectMoodleQuizManualGradingQueueBrowserResult,
  projectMoodleQuizRegradeReportBrowserResult,
  projectPublicMoodleQuizAttemptResult,
} from "./moodle-quiz-attempt-detail.js";
import {
  MOODLE_FORUM_ACTIVITY_SUMMARY_OPERATION,
  MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL,
  projectMoodleForumActivitySummaryBrowserResult,
  projectPublicMoodleForumActivitySummaryResult,
} from "./moodle-forum-activity-summaries.js";
import {
  moodleActivityContentReadByTool,
  projectMoodleActivityContentBrowserResult,
  type MoodleActivityContentRead,
} from "./moodle-activity-content.js";
import {
  MOODLE_SCORM_ATTEMPT_SUMMARY_OPERATION,
  MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL,
  MOODLE_SCORM_LEARNER_REPORT_OPERATION,
  MOODLE_SCORM_LEARNER_REPORT_TOOL,
  projectMoodleScormAttemptSummaryBrowserResult,
  projectMoodleScormLearnerReportBrowserResult,
  projectPublicMoodleScormLearnerReportResult,
} from "./moodle-scorm-reports.js";
import {
  MOODLE_GRADE_REPORT_SUMMARY_OPERATION,
  MOODLE_GRADE_REPORT_SUMMARY_TOOL,
  MOODLE_LEARNER_GRADE_REPORT_OPERATION,
  MOODLE_LEARNER_GRADE_REPORT_TOOL,
  projectMoodleGradeReportSummaryBrowserResult,
  projectMoodleLearnerGradeReportBrowserResult,
  projectPublicMoodleLearnerGradeReportResult,
} from "./moodle-grade-reports.js";
import {
  MOODLE_COURSE_PARTICIPANTS_OPERATION,
  MOODLE_COURSE_PARTICIPANTS_TOOL,
  MOODLE_ENROLMENT_METHODS_OPERATION,
  MOODLE_ENROLMENT_METHODS_TOOL,
  MOODLE_PARTICIPANT_ENROLMENT_OPERATION,
  MOODLE_PARTICIPANT_ENROLMENT_TOOL,
  projectMoodleCourseParticipantsBrowserResult,
  projectMoodleEnrolmentMethodsBrowserResult,
  projectMoodleParticipantEnrolmentBrowserResult,
  projectPublicMoodleCourseParticipantsResult,
  projectPublicMoodleParticipantEnrolmentResult,
} from "./moodle-participants.js";
import {
  type MoodleCourseReportRead,
  moodleCourseReportReadByTool,
  projectMoodleCourseReportBrowserResult,
  projectPublicMoodleCourseReportResult,
} from "./moodle-reports.js";
import {
  type MoodleSiteAdministrationRead,
  moodleSiteAdministrationReadByTool,
  projectMoodleSiteAdministrationBrowserResult,
} from "./moodle-site-inventory.js";
import {
  MOODLE_QUESTION_BANK_IMPACT_SCOPE_OPERATION,
  MOODLE_QUESTION_BANK_IMPACT_SCOPE_TOOL,
  projectMoodleQuestionBankImpactScopeBrowserResult,
} from "./moodle-question-impact.js";
import {
  MOODLE_LESSON_PAGE_LIST_OPERATION,
  MOODLE_LESSON_PAGE_LIST_TOOL,
  MOODLE_LESSON_PAGE_OPERATION,
  MOODLE_LESSON_PAGE_TOOL,
  projectMoodleLessonPageBrowserResult,
  projectMoodleLessonPageListBrowserResult,
} from "./moodle-lesson-pages.js";
import {
  CANVAS_CONVERSATION_PLAN_SCHEMA,
  CANVAS_CONVERSATION_TRANSFER_OPERATION,
  canvasConversationInputSchema,
  canvasConversationPlan,
  isCanvasConversationTransfer,
  type CanvasConversationInput,
} from "./canvas-conversations.js";
import type { GatewayConfig } from "./config.js";
import { signBlackboardEffectGrant } from "@morrow/blackboard-learn-api";
import {
  BLACKBOARD_CONTENT_PATCH_APPLY_TOOL,
  BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL,
  BLACKBOARD_CONTENT_PATCH_PLAN_TOOL,
  BLACKBOARD_CONTENT_PATCH_VERIFY_TOOL,
  blackboardContentPatchInputSchema,
  type BlackboardContentPatchInput,
} from "./blackboard-content-patch.js";
import { BLACKBOARD_ACTIONS, BLACKBOARD_ATTACHMENT_APPLY_TOOL } from "./blackboard-actions.js";
import { resolveResultArtifact, ResultArtifactStore } from "./result-artifacts.js";
import { loadExamplePlatformCatalogTruth } from "./meridian-catalog-truth.js";
import {
  verifyLocalGitSourceAttestation,
  verifyRemoteGitSshSourceAttestation,
} from "./source-attestation.js";
import {
  resolveApprovalReviewContext,
  type ApprovalReviewReadCache,
  type ApprovalReviewContext,
} from "./approval-context.js";

export const MORROW_NATIVE_TOOL_NAMES = Object.freeze([
  "morrow_health",
  "morrow_activity",
  "morrow_check_new_quiz",
  "morrow_review_lesson",
  "morrow_audit_course",
  "morrow_catalog",
  "morrow_catalog_search",
  "morrow_capability_get",
  "morrow_capability_read",
  "morrow_capability_change",
  "morrow_request_edit_access",
  ...Object.values(MOODLE_STAGED_FILE_CAPABILITIES).map((capability) => capability.publicPlanToolName),
  "morrow_plan_canvas_file_upload",
  "morrow_plan_canvas_conversation",
  "morrow_plan_classic_quiz_description_image_alt_repair",
  "morrow_plan_blackboard_content_patch",
  ...BLACKBOARD_ACTIONS.map((action) => action.publicName),
  "morrow_profile_status",
  "morrow_operation_get",
  "morrow_operations_recent",
  "morrow_operation_list",
  "morrow_operation_dispatch",
  "morrow_operation_cancel",
  "morrow_operation_reconcile",
  "morrow_operation_verify",
  "morrow_operation_close_unresolved",
  "morrow_operation_undo",
  "morrow_operation_approve",
  "morrow_result_page",
] as const);

const INTERNAL_SOURCE_TOOL_NAMES = Object.freeze([
  "morrow_browser_edit_policy_set",
  "morrow_bridge_maintenance",
] as const);

/**
 * These helpers stay in the merged catalog so Morrow can make source-owned
 * privacy calls. They are never capabilities an MCP client can discover or
 * invoke. This list is what hides them. A private browser-catalog entry also
 * carries `morrowPrivate: true`, and
 * `packages/mcp-server/test/moodle-private-tools.test.ts` holds the Moodle side
 * of the two to the same set.
 */
export const PRIVATE_SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "moodle_get_course_participant_roster",
  "canvas_get_all_quiz_submissions",
  "canvas_transfer_course_file",
  "canvas_send_private_conversation",
  // The connector publishes this one route only as the guarded image
  // alternative-text repair (packages/canvas-connector-mcp/src/server.ts).
  // morrow_plan_item_bank_question_image_alt_repair is the only way in, because
  // the guard it builds needs a fresh reading of the exact question and a
  // confirmed list of every course the bank reaches.
  "canvas_item_bank_update_item",
  "blackboard_plan_course_group",
  "blackboard_apply_reviewed_course_group",
  "blackboard_verify_course_group",
  "blackboard_plan_course_group_patch",
  "blackboard_apply_reviewed_course_group_patch",
  "blackboard_verify_course_group_patch",
  "blackboard_plan_group_membership",
  "blackboard_apply_reviewed_group_membership",
  "blackboard_verify_group_membership",
  "blackboard_plan_group_membership_removal",
  "blackboard_apply_reviewed_group_membership_removal",
  "blackboard_verify_group_membership_removal",
  "blackboard_plan_content_patch",
  "blackboard_apply_reviewed_content_patch",
  "blackboard_verify_content_patch",
  "blackboard_plan_content_attachment",
  "blackboard_apply_reviewed_content_attachment",
  "blackboard_verify_content_attachment",
  "blackboard_plan_membership_patch",
  "blackboard_apply_reviewed_membership_patch",
  "blackboard_verify_membership_patch",
  "blackboard_plan_gradebook_column_patch",
  "blackboard_apply_reviewed_gradebook_column_patch",
  "blackboard_verify_gradebook_column_patch",
  "blackboard_plan_gradebook_grade_patch",
  "blackboard_apply_reviewed_gradebook_grade_patch",
  "blackboard_verify_gradebook_grade_patch",
  "blackboard_plan_ultra_assignment",
  "blackboard_apply_reviewed_ultra_assignment",
  "blackboard_verify_ultra_assignment",
  "blackboard_plan_course_announcement",
  "blackboard_apply_reviewed_course_announcement",
  "blackboard_verify_course_announcement",
  "blackboard_plan_course_announcement_patch",
  "blackboard_apply_reviewed_course_announcement_patch",
  "blackboard_verify_course_announcement_patch",
  "blackboard_plan_course_availability",
  "blackboard_apply_reviewed_course_availability",
  "blackboard_verify_course_availability",
  "blackboard_plan_content_dated_visibility",
  "blackboard_apply_reviewed_content_dated_visibility",
  "blackboard_verify_content_dated_visibility",
  "blackboard_course_copy",
]);

export function isPrivateSourceTool(tool: Pick<CatalogTool, "upstreamName">): boolean {
  return PRIVATE_SOURCE_TOOL_NAMES.has(tool.upstreamName);
}

const PRIVATE_EGRESS_FIELD_KEYS = new Set(["privateattachment", "bytesbase64"]);
const MAX_INVENTORY_EGRESS_CONTEXTS = 4;
const MAX_BROWSER_BINDING_EGRESS_CONTEXTS = 4;
const MCP_RUNTIME_HEALTH_SCHEMA = "morrow.mcp-runtime.health.v1";
const MCP_RUNTIME_MANIFEST_SCHEMA = "morrow.mcp-runtime-manifest.v1";
const MCP_RUNTIME_PACKAGE_NAME = "@morrow-lms/gateway";
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function normalizeMcpRuntimeHealth(value: unknown): McpRuntimeHealth | undefined {
  if (!isJsonObject(value)
    || Object.keys(value).length !== 3
    || value.schema !== MCP_RUNTIME_HEALTH_SCHEMA
    || typeof value.packageVersion !== "string" || !VERSION.test(value.packageVersion)
    || typeof value.manifestSha256 !== "string" || !SHA256.test(value.manifestSha256)) return undefined;
  return {
    schema: MCP_RUNTIME_HEALTH_SCHEMA,
    packageVersion: value.packageVersion,
    manifestSha256: value.manifestSha256,
  };
}

/**
 * Reads the sealed MCP runtime manifest of the payload this process is running
 * from. A packaged install keeps it at `app/mcp-runtime-manifest.json`, three
 * directories above `app/packages/mcp-server/dist`, and the digest reported
 * here is computed from that file's own bytes. The caller supplies nothing, so
 * the value in gateway health states which payload actually started rather
 * than repeating what the parent process asked for. A source checkout has no
 * such manifest and reports no MCP runtime identity.
 */
export function mcpRuntimeHealthFromPayload(
  entrypointDirectory: string = dirname(fileURLToPath(import.meta.url)),
): McpRuntimeHealth | undefined {
  let bytes: Buffer;
  let manifest: unknown;
  try {
    bytes = readFileSync(resolve(entrypointDirectory, "../../../mcp-runtime-manifest.json"));
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isJsonObject(manifest) || manifest.schema !== MCP_RUNTIME_MANIFEST_SCHEMA) return undefined;
  const packaged = manifest.package;
  if (!isJsonObject(packaged) || packaged.name !== MCP_RUNTIME_PACKAGE_NAME) return undefined;
  return normalizeMcpRuntimeHealth({
    schema: MCP_RUNTIME_HEALTH_SCHEMA,
    packageVersion: packaged.version,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function mapBounded<T, R>(
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

export interface CatalogSearchInput {
  readonly query?: string;
  readonly source?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface CatalogSearchTool {
  readonly publicName: string;
  readonly upstreamId: string;
  readonly upstreamName: string;
  readonly title?: string;
  readonly description?: string;
  readonly descriptionSha256?: string;
  readonly inputSchemaSha256: string;
  readonly outputSchemaSha256?: string;
  readonly annotations?: ToolAnnotations;
}

export interface CatalogSearchResult {
  readonly schema: "morrow.catalog.search.v1";
  readonly catalogDigest: string;
  readonly totalMatches: number;
  readonly offset: number;
  readonly returned: number;
  readonly nextOffset: number | null;
  readonly tools: readonly CatalogSearchTool[];
  readonly collisionCount: number;
  readonly collisions: CatalogSnapshot["collisions"];
  readonly excludedCount: number;
}

export interface RecentOperationsInput {
  readonly source?: string;
  readonly tool?: string;
  readonly state?: GatewayOperationState;
  readonly limit?: number;
}

export interface BrowserEditAccessSelectionInput {
  readonly sourceBindingId: string;
  readonly enabledCategories?: readonly string[];
}

export interface BrowserEditAccessSelection {
  readonly sourceBindingId: string;
  readonly provider: "canvas" | "moodle";
  readonly courseId: string;
  readonly courseName: string;
  readonly site: string;
  readonly principalFingerprint: string;
  readonly sessionGeneration: number;
  readonly catalogDigest: string;
  readonly expectedPolicyRevision: number;
  readonly enabledCategories: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[];
}

export interface BrowserEditAccessPrepared {
  readonly mode: "edit" | "plan";
  readonly selections: readonly BrowserEditAccessSelection[];
}

export interface BrowserEditAccessResult {
  readonly mode: "edit" | "plan";
  readonly command: JsonObject | null;
  readonly bindings: readonly JsonObject[];
  readonly outcome: "received" | "unknown" | "not_sent";
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function truncateText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function projectCatalogTool(tool: CatalogTool): CatalogSearchTool {
  const description = truncateText(tool.description, 800);
  const title = truncateText(tool.title, 200);
  return {
    publicName: tool.publicName,
    upstreamId: tool.upstreamId,
    upstreamName: tool.upstreamName,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(tool.description ? { descriptionSha256: sha256Text(tool.description) } : {}),
    inputSchemaSha256: sha256Json(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchemaSha256: sha256Json(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

function legacyRouting(args: Readonly<Record<string, unknown>>): {
  readonly suppliedOperationId?: string;
  readonly sourceBindingId?: string;
} {
  if (!isJsonObject(args._morrow)) return {};
  const suppliedOperationId = typeof args._morrow.operation_id === "string"
    ? args._morrow.operation_id.trim()
    : "";
  const sourceBindingId = typeof args._morrow.source_binding_id === "string"
    ? args._morrow.source_binding_id.trim()
    : "";
  return {
    ...(suppliedOperationId ? { suppliedOperationId } : {}),
    ...(sourceBindingId ? { sourceBindingId } : {}),
  };
}

function withSourceOperationId(
  mapping: CatalogTool,
  args: Readonly<Record<string, unknown>>,
): {
  readonly forwarded: Readonly<Record<string, unknown>>;
  readonly sourceOperationId?: string;
  readonly idempotencyKey?: string;
} {
  const forwarded = structuredClone(args) as Record<string, unknown>;
  const bridgeControlled = mapping.upstreamId === "example-legacy"
    || usesEmbeddedReadback(mapping);
  if (!bridgeControlled) {
    // Blackboard is the only REST source that accepts a Gateway-private
    // dispatch envelope. It still cannot be called without an outer effect
    // reservation, and the child verifies this exact signed envelope.
    if (isBlackboardApply(mapping)
      && isJsonObject(forwarded._morrow)
      && isJsonObject(forwarded._morrow.outer_grant)) {
      forwarded._morrow = { outer_grant: forwarded._morrow.outer_grant };
      return { forwarded };
    }
    delete forwarded._morrow;
    return { forwarded };
  }

  if (mapping.annotations?.readOnlyHint === true) {
    if (isJsonObject(forwarded._morrow)) {
      const routing = { ...forwarded._morrow };
      delete routing.operation_id;
      delete routing.readback;
      delete routing.approval_ttl_ms;
      delete routing.outer_grant;
      if (Object.keys(routing).length > 0) forwarded._morrow = routing;
      else delete forwarded._morrow;
    }
    return { forwarded };
  }

  const routing = legacyRouting(args);
  const sourceOperationId = routing.suppliedOperationId || `operation:${randomUUID()}`;
  forwarded._morrow = {
    ...(isJsonObject(forwarded._morrow) ? forwarded._morrow : {}),
    operation_id: sourceOperationId,
  };
  return {
    forwarded,
    sourceOperationId,
    ...(routing.suppliedOperationId ? { idempotencyKey: routing.suppliedOperationId } : {}),
  };
}

interface OuterOperationControls {
  readonly request: JsonObject;
  readonly readback?: FrozenReadbackPlan;
  readonly approvalTtlMs?: number;
}

function outerOperationControls(args: Readonly<Record<string, unknown>>): OuterOperationControls {
  assertNoPrivateAttachmentInput(args);
  const request = structuredClone(args) as JsonObject;
  if (!isJsonObject(request._morrow)) return { request };
  const routing = { ...request._morrow };
  const rawReadback = routing.readback;
  const rawTtl = routing.approval_ttl_ms;
  delete routing.readback;
  delete routing.approval_ttl_ms;
  delete routing.outer_grant;
  if (Object.keys(routing).length > 0) request._morrow = routing;
  else delete request._morrow;

  let readback: FrozenReadbackPlan | undefined;
  if (rawReadback !== undefined) {
    if (!isJsonObject(rawReadback) || typeof rawReadback.tool !== "string" || !isJsonObject(rawReadback.arguments)
      || typeof rawReadback.expected_digest !== "string" || !/^[0-9a-f]{64}$/.test(rawReadback.expected_digest)) {
      throw new TypeError("_morrow.readback requires tool, arguments, and expected_digest");
    }
    readback = {
      tool: rawReadback.tool,
      arguments: structuredClone(rawReadback.arguments),
      expectedDigest: rawReadback.expected_digest,
    };
  }
  const approvalTtlMs = rawTtl === undefined
    ? undefined
    : typeof rawTtl === "number" && Number.isInteger(rawTtl) && rawTtl >= 60_000 && rawTtl <= 24 * 60 * 60_000
      ? rawTtl
      : (() => { throw new TypeError("_morrow.approval_ttl_ms must be 60000 through 86400000"); })();
  return { request, ...(readback ? { readback } : {}), ...(approvalTtlMs ? { approvalTtlMs } : {}) };
}

function resultComparable(value: JsonObject): JsonObject {
  if (isJsonObject(value.structuredContent)) return structuredClone(value.structuredContent);
  return {
    content: Array.isArray(value.content) ? structuredClone(value.content) : [],
    isError: value.isError === true,
  };
}

function isCanvasConnector(mapping: CatalogTool): boolean {
  return mapping.capability?.route?.backend === "canvas-connector";
}

function isLmsApiRoute(mapping: CatalogTool): boolean {
  return mapping.capability?.route?.backend === "lms-api";
}

function isBlackboardContentPatchApply(mapping: CatalogTool): boolean {
  return mapping.upstreamId === "blackboard-rest"
    && mapping.upstreamName === BLACKBOARD_CONTENT_PATCH_APPLY_TOOL
    && mapping.annotations?.readOnlyHint === false
    && mapping.capability?.provider === "blackboard"
    && mapping.capability.route.backend === "lms-api";
}

function isBlackboardApply(mapping: CatalogTool): boolean {
  return isBlackboardContentPatchApply(mapping) || (mapping.upstreamId === "blackboard-rest"
    && mapping.annotations?.readOnlyHint === false
    && mapping.capability?.provider === "blackboard"
    && mapping.capability.route.backend === "lms-api"
    && BLACKBOARD_ACTIONS.some((action) => action.apply.name === mapping.upstreamName));
}

function isBlackboardAttachment(mapping: CatalogTool): boolean {
  return isBlackboardApply(mapping) && mapping.upstreamName === BLACKBOARD_ATTACHMENT_APPLY_TOOL;
}

function isBlackboardContentPatchPlan(mapping: CatalogTool): boolean {
  return mapping.upstreamId === "blackboard-rest"
    && mapping.upstreamName === BLACKBOARD_CONTENT_PATCH_PLAN_TOOL
    && mapping.annotations?.readOnlyHint === true
    && mapping.capability?.provider === "blackboard"
    && mapping.capability.route.backend === "lms-api";
}

function isBlackboardContentPatchVerify(mapping: CatalogTool): boolean {
  return mapping.upstreamId === "blackboard-rest"
    && mapping.upstreamName === BLACKBOARD_CONTENT_PATCH_VERIFY_TOOL
    && mapping.annotations?.readOnlyHint === true
    && mapping.capability?.provider === "blackboard"
    && mapping.capability.route.backend === "lms-api";
}

const REVIEW_AUTHORIZATION: EffectAuthorization = { kind: "review" };
const EDIT_POLICY_STRUCTURAL_FIELDS = new Set([
  "course_id",
  "url_or_id",
  "module_id",
  "section_id",
  "target_section_id",
  "expected_digest",
  "chapter_id",
  "after_chapter_id",
  "category_id",
  "grade_item_id",
  "slot_id",
  "section_number",
  "section_name",
]);

function browserEditFields(mapping: CatalogTool, request: JsonObject): readonly string[] {
  const pathFields = new Set([...(mappingOperationKey(mapping) || "").matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1]!));
  return Object.keys(request)
    .filter((field) => field !== "_morrow" && !EDIT_POLICY_STRUCTURAL_FIELDS.has(field)
      && !pathFields.has(field))
    .sort();
}

function requestCourseId(request: JsonObject): string | null {
  // Every Item Bank route names a bank, never a course. The one guarded Item
  // Bank change carries the selected course inside its guard, and the connector
  // reads it from the same place (`courseScope` in
  // packages/canvas-connector-mcp/src/runtime.ts), so the two layers lock, bind
  // and approve the same course.
  const guard = request.morrow_item_bank_guard;
  const value = isJsonObject(guard) && guard.course_id !== undefined ? guard.course_id : request.course_id;
  if (typeof value === "string" && (/^[1-9][0-9]{0,18}$/.test(value) || /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/.test(value))) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function browserBindingContent(result: JsonObject): readonly JsonObject[] {
  if (result.isError === true || !isJsonObject(result.structuredContent)) return [];
  const content = result.structuredContent;
  if (content.schema !== "morrow.browser-bindings.v1" || !Array.isArray(content.bindings)) return [];
  return content.bindings.filter(isJsonObject);
}

function mappingOperationKey(mapping: CatalogTool): string | null {
  const keys = new Set((mapping.capability?.sourceImplementations || [])
    .filter((entry) => entry.toolName === mapping.upstreamName)
    .map((entry) => entry.sourceExport)
    .filter((entry) => typeof entry === "string" && entry.length > 0));
  return keys.size === 1 ? [...keys][0]! : null;
}

function canvasConversationInputFromFrozenRequest(
  mapping: CatalogTool,
  request: JsonObject,
): CanvasConversationInput {
  const routing = isJsonObject(request._morrow) ? request._morrow : null;
  const control = routing && isJsonObject(routing.canvas_conversation) ? routing.canvas_conversation : null;
  if (!isCanvasConversationTransfer(mapping) || mappingOperationKey(mapping) !== CANVAS_CONVERSATION_TRANSFER_OPERATION
    || !control || control.schema !== CANVAS_CONVERSATION_PLAN_SCHEMA) {
    throw new TypeError("canvas_conversation_plan_invalid");
  }
  const action = control.action;
  const allowed = action === "create"
    ? ["schema", "action", "recipient_tokens", "recipient_contexts", "body", "subject", "group_conversation", "force_new"]
    : ["schema", "action", "recipient_tokens", "recipient_contexts", "body", "conversation_id"];
  if ((action !== "create" && action !== "reply") || Object.keys(control).some((field) => !allowed.includes(field))) {
    throw new TypeError("canvas_conversation_plan_invalid");
  }
  const sourceBindingId = legacyRouting(request).sourceBindingId;
  if (!sourceBindingId) throw new TypeError("canvas_conversation_plan_invalid");
  return canvasConversationInputSchema.parse({
    action,
    source_binding_id: sourceBindingId,
    course_id: request.course_id,
    recipient_tokens: control.recipient_tokens,
    recipient_contexts: control.recipient_contexts,
    body: control.body,
    ...(action === "create"
      ? {
          ...(control.subject === undefined ? {} : { subject: control.subject }),
          ...(control.group_conversation === undefined ? {} : { group_conversation: control.group_conversation }),
          ...(control.force_new === undefined ? {} : { force_new: control.force_new }),
        }
      : { conversation_id: control.conversation_id }),
  });
}

function withoutCanvasConversationControl(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const forwarded = structuredClone(value) as Record<string, unknown>;
  if (!isJsonObject(forwarded._morrow)) throw new TypeError("canvas_conversation_plan_invalid");
  const routing = { ...forwarded._morrow };
  delete routing.canvas_conversation;
  if (Object.keys(routing).length > 0) forwarded._morrow = routing;
  else delete forwarded._morrow;
  return forwarded;
}

function targetIdentityValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized && normalized.length <= 500) return normalized;
  }
  return null;
}

const FALLBACK_PROVIDER_OBJECT_FIELDS: readonly (readonly [string, string])[] = [
  ["page_id", "pages"],
  ["url_or_id", "pages"],
  ["module_id", "modules"],
  ["section_id", "sections"],
  ["assignment_id", "assignments"],
  ["topic_id", "discussion_topics"],
  ["discussion_id", "discussion_topics"],
  ["quiz_id", "quizzes"],
  ["question_id", "questions"],
  ["item_id", "items"],
  ["resource_id", "resources"],
  ["file_id", "files"],
  ["content_id", "content"],
  ["activity_id", "activities"],
] as const;

function canonicalProviderTarget(
  mapping: CatalogTool,
  request: JsonObject,
  readbackArguments?: JsonObject,
): {
  readonly courseId?: string;
  readonly path: readonly { readonly resource: string; readonly id: string }[];
} {
  const operationKey = mappingOperationKey(mapping);
  const operationPath = operationKey && /^[A-Z]+ ([^#\s]+)(?:#|$)/.exec(operationKey)?.[1];
  if (!operationPath) {
    for (const [field, resource] of FALLBACK_PROVIDER_OBJECT_FIELDS) {
      const id = targetIdentityValue(request[field])
        || (readbackArguments ? targetIdentityValue(readbackArguments[field]) : null);
      if (id) return { path: [{ resource, id }] };
    }
    return { path: [] };
  }
  const segments = operationPath.split("/").filter(Boolean);
  const path: { resource: string; id: string }[] = [];
  let courseId: string | undefined;
  for (let index = 1; index < segments.length; index += 1) {
    const placeholder = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segments[index]!);
    if (!placeholder) continue;
    const resource = segments[index - 1]!;
    const id = targetIdentityValue(request[placeholder[1]!])
      || (readbackArguments ? targetIdentityValue(readbackArguments[placeholder[1]!]) : null);
    if (!id) continue;
    if (placeholder[1] === "course_id" || resource === "courses") {
      courseId ||= id;
      continue;
    }
    path.push({ resource, id });
  }
  return { ...(courseId ? { courseId } : {}), path };
}

function courseIdFromCourseTarget(mapping: CatalogTool, request: JsonObject): string | null {
  const target = canonicalProviderTarget(mapping, request);
  return target.courseId || target.path.find((entry) => entry.resource === "courses")?.id || null;
}

export interface EffectTargetProviderScope {
  readonly provider: "canvas" | "moodle" | "blackboard" | "local" | "mindtap" | "connect" | "unknown";
  readonly origin: string;
  readonly siteUrl?: string;
}

export interface EffectBindingScope extends EffectTargetProviderScope {
  readonly sourceBindingId: string;
  readonly principalFingerprint: string;
  readonly sessionGeneration: number;
}

export interface PreparedEffectAuthority {
  readonly authorization: EffectAuthorization;
  readonly bindingScope?: EffectBindingScope;
}

export function stableEffectTargetIdentity(
  mapping: CatalogTool,
  request: JsonObject,
  readback: FrozenReadbackPlan | undefined,
  providerScope: EffectTargetProviderScope,
  legacyTargetNamespace?: string,
): string {
  const readbackArguments = readback?.arguments;
  const canonicalTarget = canonicalProviderTarget(mapping, request, readbackArguments);
  const courseId = requestCourseId(request)
    || (readbackArguments ? requestCourseId(readbackArguments) : null)
    || canonicalTarget.courseId
    // Browser course favorites names the course as `{id}` instead of `course_id`.
    || canonicalTarget.path.find((entry) => entry.resource === "courses")?.id;
  if (!courseId) throw new TypeError("Morrow needs an exact course identity before it can plan a provider effect.");
  // A configured API tenant names the site, so the lock is the tenant, the
  // course, and the object: `{tenantId, courseId, contentId}`, which is the key
  // the Blackboard source keys its own record of an unconfirmed change on
  // (packages/blackboard-learn-api/src/runtime.ts). The connection, account
  // fingerprint, and credential session stay out of it, so a rotated secret or
  // a second assistant's course connection cannot release an item that an
  // earlier change may already have reached.
  const tenantId = isLmsApiRoute(mapping)
    ? targetIdentityValue(request.tenant_id)
      || (readbackArguments ? targetIdentityValue(readbackArguments.tenant_id) : null)
    : null;
  if (isLmsApiRoute(mapping) && !tenantId) {
    throw new TypeError("Morrow needs an exact tenant identity before it can plan a provider effect.");
  }
  return sha256Json({
    schema: "morrow.effect-target.v3",
    ...(isCanvasConnector(mapping)
      ? {
          provider: providerScope.provider,
          origin: providerScope.origin,
          ...(providerScope.siteUrl ? { siteUrl: providerScope.siteUrl } : {}),
        }
      : tenantId
      ? { provider: providerScope.provider, tenantId }
      : {
          legacyTargetNamespace: legacyTargetNamespace || sha256Json({
            sourceId: mapping.upstreamId,
            provider: providerScope.provider,
            origin: providerScope.origin,
            ...(providerScope.siteUrl ? { siteUrl: providerScope.siteUrl } : {}),
          }),
        }),
    courseId,
    // The path omits method and action names. Thus update and delete lock the
    // same provider object while independent sibling objects remain concurrent.
    entity: canonicalTarget.path.length > 0
      ? canonicalTarget.path
      : [{ resource: "courses", id: courseId }],
  });
}

function currentEditAuthorization(
  mapping: CatalogTool,
  request: JsonObject,
  binding: JsonObject,
): EffectAuthorization {
  const routing = legacyRouting(request);
  if (!routing.sourceBindingId
    || binding.sourceBindingId !== routing.sourceBindingId
    || binding.runtimeVerified !== true
    || binding.provider !== mapping.capability?.provider
    || binding.courseId !== (requestCourseId(request) || canonicalProviderTarget(mapping, request).courseId)) return REVIEW_AUTHORIZATION;
  const permission = isJsonObject(binding.editPermission) ? binding.editPermission : null;
  const operationKey = mappingOperationKey(mapping);
  if (!permission
    || permission.schema !== "morrow.bridge.edit-permission.v1"
    || permission.sourceBindingId !== routing.sourceBindingId
    || typeof permission.scopeDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(permission.scopeDigest)
    || !Number.isSafeInteger(permission.revision)
    || Number(permission.revision) < 1
    || (permission.expiresAt !== undefined && (!Number.isSafeInteger(permission.expiresAt) || Number(permission.expiresAt) <= Date.now()))
    || !Array.isArray(permission.rules)
    || !operationKey) return REVIEW_AUTHORIZATION;
  const control = isJsonObject(request._morrow) ? request._morrow : {};
  if (control.page_guard !== undefined && control.canvas_content_guard !== undefined) return REVIEW_AUTHORIZATION;
  const guard = control.canvas_content_guard ?? control.page_guard;
  const legacyGuard = control.page_guard !== undefined;
  if (guard !== undefined && !isJsonObject(guard)) return REVIEW_AUTHORIZATION;
  const guardKind = isJsonObject(guard)
    ? legacyGuard ? guard.kind === "text" ? "page_text" : guard.kind === "image_alt" ? "page_image_alt" : null : guard.kind
    : undefined;
  const quizKinds = new Set(["new_quiz_item_image_alt", "new_quiz_choice_image_alt", "new_quiz_answer_feedback_image_alt", "new_quiz_feedback_image_alt"]);
  const kinds = new Set(["page_text", "page_image_alt", "assignment_image_alt", "discussion_image_alt", ...quizKinds]);
  if (guardKind !== undefined && (typeof guardKind !== "string" || !kinds.has(guardKind))) return REVIEW_AUTHORIZATION;
  const ruleKind = (candidate: JsonObject): unknown => candidate.canvasContentGuardKind
    ?? (candidate.pageGuardKind === "text" ? "page_text" : candidate.pageGuardKind === "image_alt" ? "page_image_alt" : candidate.pageGuardKind);
  const rules = permission.rules.filter((candidate) => (
    isJsonObject(candidate)
    && candidate.operationKey === operationKey
    && candidate.toolName === mapping.upstreamName
    && ruleKind(candidate) === guardKind
  ));
  if (rules.length !== 1) return REVIEW_AUTHORIZATION;
  const rule = rules[0]!;
  if (typeof rule.operationKey !== "string" || !rule.operationKey
    || !Array.isArray(rule.allowedChangedFields)
    || rule.allowedChangedFields.some((field: unknown) => typeof field !== "string")
    || (rule.requiresPageGuard !== undefined && rule.requiresPageGuard !== true && rule.requiresPageGuard !== false)
    || (rule.pageGuardKind !== undefined && rule.pageGuardKind !== "text" && rule.pageGuardKind !== "image_alt")
    || (rule.requiresCanvasContentGuard !== undefined && rule.requiresCanvasContentGuard !== true && rule.requiresCanvasContentGuard !== false)
    || (rule.canvasContentGuardKind !== undefined && (typeof rule.canvasContentGuardKind !== "string" || !kinds.has(rule.canvasContentGuardKind)))
    || (rule.pageGuardKind !== undefined && rule.canvasContentGuardKind !== undefined)) {
    return REVIEW_AUTHORIZATION;
  }
  const requiresGuard = rule.requiresCanvasContentGuard === true || rule.requiresPageGuard === true;
  if (requiresGuard !== (guardKind !== undefined)) return REVIEW_AUTHORIZATION;
  if (requiresGuard && (guardKind === "assignment_image_alt" ? mapping.upstreamName !== "canvas_edit_assignment"
    : guardKind === "discussion_image_alt" ? mapping.upstreamName !== "canvas_update_topic_courses"
      : quizKinds.has(String(guardKind)) ? mapping.upstreamName !== "canvas_update_quiz_item"
      : mapping.upstreamName !== "canvas_update_create_page_courses")) return REVIEW_AUTHORIZATION;
  const fields = browserEditFields(mapping, request);
  const allowed = new Set(rule.allowedChangedFields as string[]);
  if (allowed.size > 0 && fields.length === 0 && !requiresGuard) return REVIEW_AUTHORIZATION;
  if (!fields.every((field) => allowed.has(field))) return REVIEW_AUTHORIZATION;
  return {
    kind: "edit_scope",
    policyDigest: permission.scopeDigest,
    policyRevision: Number(permission.revision),
  };
}

function frozenEffectAuthorization(plan: JsonObject): EffectAuthorization {
  if (plan.authorization === undefined) return REVIEW_AUTHORIZATION;
  if (!isJsonObject(plan.authorization)) throw new TypeError("frozen effect authorization is invalid");
  if (plan.authorization.kind === "review") return REVIEW_AUTHORIZATION;
  if (plan.authorization.kind !== "edit_scope"
    || typeof plan.authorization.policyDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(plan.authorization.policyDigest)
    || !Number.isSafeInteger(plan.authorization.policyRevision)
    || Number(plan.authorization.policyRevision) < 1) {
    throw new TypeError("frozen effect authorization is invalid");
  }
  return {
    kind: "edit_scope",
    policyDigest: plan.authorization.policyDigest,
    policyRevision: Number(plan.authorization.policyRevision),
  };
}

function usesEmbeddedReadback(mapping: CatalogTool): boolean {
  return isCanvasConnector(mapping);
}

function connectorReadback(mapping: CatalogTool, request: JsonObject): FrozenReadbackPlan {
  const policy = {
    schema: "morrow.connector-readback-policy.v1",
    source: mapping.upstreamId,
    tool: mapping.publicName,
    sourceTool: mapping.upstreamName,
    requestDigest: sha256Json(request),
  };
  return {
    tool: "morrow_connector_embedded_readback",
    arguments: policy,
    expectedDigest: sha256Json(policy),
  };
}

function isConnectorReadbackPolicy(readback: FrozenReadbackPlan | null | undefined): boolean {
  return readback?.tool === "morrow_connector_embedded_readback";
}

const CONNECTOR_READBACK_RECOVERY_LIMITATION = "Morrow did not keep a read-only check for this change, so it cannot check the result for you. Open the item in Canvas and see whether the change is there. If it is missing, ask Morrow for a new review; Morrow will not send this change again.";
const VERIFIED_CONNECTOR_READBACK_LIMITATION = "This change is already confirmed. Morrow does not repeat a confirmed check.";
const CONNECTOR_RECOVERY_BINDING_CHANGED_LIMITATION = "Morrow did not check this change because the connected Canvas course, sign-in or session is not the one the change was sent from. Open that course in Chrome, connect it again, then ask Morrow to check this saved request.";
const CONNECTOR_RECOVERY_UNRESOLVED_LIMITATION = "The Canvas read did not prove this change. The saved request stays open and Morrow will not send it again. Open the item in Canvas and check it yourself, then ask Morrow for a new review if it still needs the change.";
const CONNECTOR_RECOVERY_DUPLICATE_LIMITATION = "Canvas holds more than one record that matches this request from the time it was sent, so the change may have been created twice. Open the course in Canvas and delete the copies you do not want. Morrow will not send or remove anything for you.";
const CONNECTOR_RECOVERY_READ_ONLY_NOTE = "This check only reads Canvas. It never sends the change again.";
const CONNECTOR_READBACK_NOT_SENT_LIMITATION = "Morrow has not sent this change to Canvas, so there is no saved result to check.";
const PERSON_CLOSED_LIMITATION = "Morrow did not check this change itself. It is closed because a person read the item and confirmed the saved state.";
const PERSON_CLOSE_READ_REQUIRED_LIMITATION = "Read the item with Morrow first, then close this request with the digest that read returns. Morrow closes nothing on a description of the result.";

function canvasRecoveryReadDescriptor(value: unknown): CanvasRecoveryRead | null {
  if (!isJsonObject(value) || typeof value.readTool !== "string" || !isJsonObject(value.arguments)) return null;
  const argumentsValue: Record<string, string | readonly string[]> = {};
  for (const [name, entry] of Object.entries(value.arguments)) {
    if (typeof entry === "string") argumentsValue[name] = entry;
    else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) argumentsValue[name] = entry as string[];
    else return null;
  }
  return {
    readTool: value.readTool,
    ...(typeof value.readOperationKey === "string" ? { readOperationKey: value.readOperationKey } : {}),
    arguments: argumentsValue,
  };
}

function canvasRecoveryAssertions(value: unknown): readonly BrowserReadbackAssertion[] | null {
  if (!Array.isArray(value)) return null;
  const assertions: BrowserReadbackAssertion[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry) || typeof entry.inputName !== "string" || !Array.isArray(entry.paths)) return null;
    const paths = entry.paths.map((path) => (
      Array.isArray(path) && path.every((part) => typeof part === "string") ? path as string[] : null
    ));
    if (paths.some((path) => path === null)) return null;
    assertions.push({ inputName: entry.inputName, paths: paths as string[][], expected: entry.expected });
  }
  return assertions;
}

/**
 * Reads the retained read-only comparator back off an operation record. Anything
 * that does not parse exactly leaves the record unresolved; nothing is guessed.
 */
function canvasRecoveryDescriptorOf(value: unknown): CanvasRecoveryDescriptor | null {
  if (!isJsonObject(value) || value.schema !== "morrow.canvas-recovery-descriptor.v1"
    || typeof value.strategy !== "string" || typeof value.writeMethod !== "string") return null;
  const assertions = canvasRecoveryAssertions(value.assertions);
  if (!assertions) return null;
  const read = value.read === undefined ? null : canvasRecoveryReadDescriptor(value.read);
  if (value.read !== undefined && !read) return null;
  const collection = value.collection === undefined ? null : canvasRecoveryReadDescriptor(value.collection);
  if (value.collection !== undefined && !collection) return null;
  if (!read && !collection) return null;
  const targetPath = isJsonObject(value.read) && Array.isArray(value.read.targetPath)
    && value.read.targetPath.every((part) => typeof part === "string")
    ? value.read.targetPath as string[]
    : undefined;
  return {
    schema: "morrow.canvas-recovery-descriptor.v1",
    strategy: value.strategy,
    writeMethod: value.writeMethod,
    assertions,
    ...(read ? {
      read: {
        ...read,
        ...(isJsonObject(value.read) && typeof value.read.targetId === "string" ? { targetId: value.read.targetId } : {}),
        ...(isJsonObject(value.read) && typeof value.read.targetField === "string" ? { targetField: value.read.targetField } : {}),
        ...(targetPath ? { targetPath } : {}),
      },
    } : {}),
    ...(collection ? { collection } : {}),
  };
}

/**
 * Pulls the connector's retained comparator out of one dispatch result. It is
 * present on a confirmed write and on a write whose outcome is unknown, which is
 * the case a later check has to resolve.
 */
function connectorReadDescriptor(mapping: CatalogTool, value: JsonObject): CanvasRecoveryDescriptor | null {
  const connector = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  if (!connector || connector.schema !== "morrow.canvas-connector.result.v1"
    || connector.provider !== mapping.capability?.provider) return null;
  const browser = isJsonObject(connector.result) ? connector.result : null;
  return canvasRecoveryDescriptorOf(browser?.readDescriptor ?? connector.readDescriptor);
}

function connectorVerification(mapping: CatalogTool, value: JsonObject): JsonObject | null {
  const connector = isJsonObject(value.structuredContent) ? value.structuredContent : null;
  if (!connector || connector.schema !== "morrow.canvas-connector.result.v1" || connector.ok !== true
    || connector.provider !== mapping.capability?.provider) return null;
  const browser = isJsonObject(connector.result) ? connector.result : null;
  const verification = browser && isJsonObject(browser.verification) ? browser.verification : null;
  if (!verification || verification.schema !== "morrow.browser-verification.v1") return null;
  if (!new Set(["verified", "mismatch", "unconfirmed"]).has(String(verification.status))) return null;
  return structuredClone(verification);
}

function attachOperationMeta(
  result: JsonObject,
  mapping: CatalogTool,
  catalogDigest: string,
  operation: GatewayOperationRecord,
  profile: RuntimeProfile,
): JsonObject {
  const output = structuredClone(result);
  const existingMeta = isJsonObject(output._meta) ? output._meta : {};
  const existingGatewayValue = existingMeta["io.morrow/gateway"];
  const upstreamResultSha256 = isJsonObject(existingGatewayValue)
    && typeof existingGatewayValue.upstreamResultSha256 === "string"
    ? existingGatewayValue.upstreamResultSha256
    : null;
  output._meta = {
    ...existingMeta,
    "io.morrow/gateway": {
      schema: "morrow.gateway.call.v1",
      publicToolName: mapping.publicName,
      upstreamId: mapping.upstreamId,
      upstreamToolName: mapping.upstreamName,
      catalogDigest,
      upstreamResultSha256: upstreamResultSha256
        || operation.upstreamResultDigest
        || operation.errorDigest
        || sha256Json(result),
      gatewayOperationId: operation.operationId,
      gatewayOperationState: operation.state,
      ...(operation.sourceOperationId ? { sourceOperationId: operation.sourceOperationId } : {}),
      ...(operation.sourceResultState ? { sourceResultState: operation.sourceResultState } : {}),
      ...(operation.sourceTaskId ? { sourceTaskId: operation.sourceTaskId } : {}),
      profile,
      authorityDigest: sha256Json({
        profile,
        publicToolName: mapping.publicName,
        upstreamId: mapping.upstreamId,
        upstreamToolName: mapping.upstreamName,
        catalogDigest,
      }),
    } satisfies GatewayCallMeta,
  };
  return output;
}

function replayResult(
  mapping: CatalogTool,
  catalogDigest: string,
  operation: GatewayOperationRecord,
  profile: RuntimeProfile,
): JsonObject {
  return attachOperationMeta({
    content: [{
      type: "text",
      text: `Morrow did not resend ${mapping.publicName}; the supplied operation identity already has a gateway record.`,
    }],
    isError: true,
    structuredContent: {
      schema: "morrow.problem.v1",
      code: "operation_already_recorded",
      recoverable: operation.state === "failed_before_send",
      operation: operationRecordProjection(operation),
    },
  }, mapping, catalogDigest, operation, profile);
}

function verifyConfiguredSources(
  config: GatewayConfig,
): ReadonlyMap<string, SourceAttestationHealth> {
  const evidence = new Map<string, SourceAttestationHealth>();
  for (const source of config.upstreams) {
    if (!source.attestation) continue;
    const verified = source.attestation.kind === "remote-git-ssh"
      ? verifyRemoteGitSshSourceAttestation(
          source.id,
          source.repository,
          source.attestation,
        )
      : verifyLocalGitSourceAttestation(
          source.id,
          source.repository,
          source.attestation,
        );
    evidence.set(source.id, verified);
  }
  return evidence;
}

function readPublicationManifest(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Morrow could not read publication policy ${path}`, { cause: error });
  }
}

function applyProfileAvailability(catalog: CatalogSnapshot, profile: RuntimeProfile): CatalogSnapshot {
  const unavailable = catalog.tools
    .filter((tool) => tool.capability?.profiles[profile]?.state !== "supported")
    .map((tool) => ({
      upstreamId: tool.upstreamId,
      upstreamName: tool.upstreamName,
      reason: "profile_unavailable" as const,
      detail:
        tool.capability?.profiles[profile]?.reason ??
        `Unavailable in the ${profile} profile.`,
    }));
  if (unavailable.length === 0) return catalog;
  const tools = catalog.tools.filter((tool) => tool.capability?.profiles[profile]?.state === "supported");
  return {
    ...catalog,
    tools,
    excluded: [...catalog.excluded, ...unavailable].sort((left, right) => (
      compareAscii(left.upstreamId, right.upstreamId)
      || compareAscii(left.upstreamName, right.upstreamName)
      || compareAscii(left.reason, right.reason)
    )),
    countsBySource: Object.fromEntries(
      Object.keys(catalog.countsBySource).map((sourceId) => [
        sourceId,
        tools.filter((tool) => tool.upstreamId === sourceId).length,
      ]),
    ),
  };
}

async function closeStartupResources(
  upstreams: ReadonlyMap<string, StdioMcpUpstream>,
  journal: GatewayOperationJournal,
  effects: ProviderEffectBroker,
): Promise<void> {
  await Promise.allSettled([...upstreams.values()].map((candidate) => candidate.close()));
  journal.close();
  effects.close();
}

export class GatewayRuntime {
  readonly config: GatewayConfig;
  readonly catalog: CatalogSnapshot;

  private readonly upstreams: ReadonlyMap<string, StdioMcpUpstream>;
  private readonly toolByPublicName: ReadonlyMap<string, CatalogTool>;
  private readonly journal: GatewayOperationJournal;
  private readonly effects: ProviderEffectBroker;
  private readonly resultArtifacts = new ResultArtifactStore();
  private readonly fileStages = new FileStageStore();
  private readonly operationFileStages = new Map<string, readonly FileStageBinding[]>();
  private readonly publicationPolicy: PublicationPolicyHealth | undefined;
  private readonly learnerVault: LearnerVault;
  private readonly mcpRuntime: McpRuntimeHealth | undefined;
  private readonly learnerRoster = new LearnerRoster();
  private readonly artifacts: ArtifactGenerationRegistry;
  private approvalBaseUrl: string | null = null;
  /**
   * The requesting assistant for the tool call running on this async stack. One
   * runtime serves every connected assistant, so the identity travels with the
   * call rather than with the runtime.
   */
  private readonly requester = new AsyncLocalStorage<RequestedByIdentity>();
  private readonly gatewayProcessId = `gateway:${randomUUID()}`;
  private readonly blackboardEffectDispatchSecret: string;

  private constructor(
    config: GatewayConfig,
    upstreams: ReadonlyMap<string, StdioMcpUpstream>,
    catalog: CatalogSnapshot,
    journal: GatewayOperationJournal,
    effects: ProviderEffectBroker,
    publicationPolicy?: PublicationPolicyHealth,
    learnerVault = new LearnerVault(":memory:"),
    artifacts = new ArtifactGenerationRegistry(),
    mcpRuntime?: McpRuntimeHealth,
    blackboardEffectDispatchSecret = randomBytes(32).toString("base64url"),
  ) {
    this.config = config;
    this.upstreams = upstreams;
    this.catalog = catalog;
    this.journal = journal;
    this.effects = effects;
    this.publicationPolicy = publicationPolicy;
    this.learnerVault = learnerVault;
    this.artifacts = artifacts;
    this.mcpRuntime = mcpRuntime;
    this.blackboardEffectDispatchSecret = blackboardEffectDispatchSecret;
    this.toolByPublicName = new Map(catalog.tools.map((tool) => [tool.publicName, tool]));
  }

  static async connect(
    config: GatewayConfig,
    options: { readonly journalPath?: string; readonly mcpRuntime?: McpRuntimeHealth } = {},
  ): Promise<GatewayRuntime> {
    const sourceAttestations = verifyConfiguredSources(config);
    const catalogTruth = new Map<string, ReturnType<typeof loadExamplePlatformCatalogTruth>>(config.upstreams
      .filter((source) => source.kind === "meridian-ssh")
      .map((source) => [
        source.id,
        loadExamplePlatformCatalogTruth(source, config.filters),
      ]));
    const journal = new GatewayOperationJournal({
      path: options.journalPath || config.operationJournal.path,
    });
    const learnerVault = new LearnerVault(
      (options.journalPath || config.operationJournal.path) === ":memory:"
        ? ":memory:"
        : config.privacy.learnerVaultPath,
    );
    const effects = new ProviderEffectBroker({
      path: options.journalPath || config.operationJournal.path,
    });
    const upstreams = new Map<string, StdioMcpUpstream>();
    const sources: CatalogSource[] = [];
    const excludedSourceNames = new Set([...config.filters.excludeNames, ...INTERNAL_SOURCE_TOOL_NAMES]);
    const blackboardEffectDispatchSecret = randomBytes(32).toString("base64url");

    for (const upstreamConfig of [...config.upstreams].sort((left, right) => (
      right.priority - left.priority || compareAscii(left.id, right.id)
    ))) {
      const attestation = sourceAttestations.get(upstreamConfig.id);
      const truth = catalogTruth.get(upstreamConfig.id);
      const privateAdapterModule = "./meridian-runtime-adapter.js";
      const upstreamEnvironment = upstreamConfig.kind === "mcp-stdio"
        ? {
            ...upstreamConfig.env,
            ...(upstreamConfig.id === "blackboard-rest" ? {
              MORROW_BLACKBOARD_GATEWAY_INTERNAL: "1",
              MORROW_BLACKBOARD_EFFECT_DISPATCH_SECRET: blackboardEffectDispatchSecret,
            } : {}),
          }
        : undefined;
      const launch = upstreamConfig.kind === "meridian-ssh"
        ? (await import(privateAdapterModule)).buildExamplePlatformSshLaunch({
            host: upstreamConfig.host,
            remoteRoot: upstreamConfig.remoteRoot,
            serverPath: upstreamConfig.serverPath,
            runtimeProfile: upstreamConfig.runtimeProfile,
          })
        : {
            command: upstreamConfig.command,
            args: upstreamConfig.args,
            ...(upstreamConfig.cwd ? { cwd: upstreamConfig.cwd } : {}),
            env: upstreamEnvironment,
          };
      const upstream = new StdioMcpUpstream({
        id: upstreamConfig.id,
        label: upstreamConfig.label,
        command: launch.command,
        args: launch.args,
        ...(upstreamConfig.kind === "mcp-stdio" && upstreamConfig.cwd
          ? { cwd: upstreamConfig.cwd }
          : {}),
        ...(upstreamConfig.kind === "mcp-stdio" ? { env: upstreamEnvironment } : {}),
        ...(upstreamConfig.kind === "meridian-ssh" ? { stderr: "ignore" as const } : {}),
        priority: upstreamConfig.priority,
        required: upstreamConfig.required,
        ...(truth
          ? { expectedToolCount: truth.health.totalToolCount }
          : upstreamConfig.attestation?.kind === "local-git"
            && upstreamConfig.attestation.expectedToolCount !== undefined
          ? { expectedToolCount: upstreamConfig.attestation.expectedToolCount }
          : {}),
        ...(truth
          ? { expectedCatalogDigest: truth.health.upstreamCatalogDigest }
          : upstreamConfig.attestation?.kind === "local-git"
            && upstreamConfig.attestation.expectedCatalogDigest
          ? { expectedCatalogDigest: upstreamConfig.attestation.expectedCatalogDigest }
          : {}),
        ...(attestation ? { sourceAttestation: attestation } : {}),
        ...(truth ? { catalogTruth: truth.health } : {}),
        ...(upstreamConfig.kind === "meridian-ssh"
          ? {
              supervision: upstreamConfig.supervision,
              beforeConnect: () => {
                verifyRemoteGitSshSourceAttestation(
                  upstreamConfig.id,
                  upstreamConfig.repository,
                  upstreamConfig.attestation,
                );
              },
            }
          : {}),
      });
      upstreams.set(upstream.id, upstream);

      try {
        const tools = await upstream.connect();
        if (truth) {
          const eligibleTools = tools.filter((tool) => (
            !excludedSourceNames.has(tool.name)
            && !config.filters.excludePrefixes.some((prefix) => tool.name.startsWith(prefix))
          ));
          if (
            eligibleTools.length !== truth.health.eligibleToolCount
            || upstreamCatalogDigest(upstream.id, eligibleTools) !== truth.health.eligibleCatalogDigest
          ) {
            throw new Error(`Source ${upstream.id} eligible catalog does not match generated truth.`);
          }
        }
        sources.push({
          id: upstream.id,
          label: upstream.label,
          priority: upstream.priority,
          ...(upstreamConfig.revision ? { revision: upstreamConfig.revision } : {}),
          tools,
        });
      } catch (error) {
        if (upstream.required) {
          await closeStartupResources(upstreams, journal, effects);
          throw new Error(
            `Required upstream ${upstream.id} failed to connect`,
            { cause: error },
          );
        }
      }
    }

    try {
      const mergedCatalog = mergeCatalog(sources, {
        excludePrefixes: config.filters.excludePrefixes,
        excludeNames: [...excludedSourceNames],
        reservedNames: MORROW_NATIVE_TOOL_NAMES,
      });
      for (const [sourceId, truth] of catalogTruth) {
        if ((mergedCatalog.countsBySource[sourceId] ?? 0) !== truth.health.eligibleToolCount) {
          throw new Error(`Source ${sourceId} eligible catalog does not match generated truth.`);
        }
      }
      let catalog = mergedCatalog;
      let publicationPolicy: PublicationPolicyHealth | undefined;

      if (config.profile === "public-canvas") {
        const policyPath = config.publicationPolicy.path;
        if (!policyPath) throw new Error("public-canvas profile has no publication policy path");
        const sourceEvidence = [...upstreams.values()].map((upstream) => {
          const health = upstream.health();
          if (!health.connected || !health.catalogDigest) {
            throw new Error(`Publication source ${health.id} lacks a normalized catalog digest`);
          }
          return {
            sourceId: health.id,
            catalogDigest: health.catalogDigest,
            toolCount: health.toolCount,
          };
        });
        const applied = applyPublicationPolicy(
          mergedCatalog,
          readPublicationManifest(policyPath),
          sourceEvidence,
          {
            reservedNames: MORROW_NATIVE_TOOL_NAMES,
            deniedPrefixes: config.filters.excludePrefixes,
          },
        );
        catalog = applied.catalog;
        publicationPolicy = applied.receipt;
      }
      catalog = applyProfileAvailability(catalog, config.profile);

      if (catalog.tools.length > config.maxCatalogTools) {
        throw new Error(
          `Catalog contains ${catalog.tools.length} tools, above maxCatalogTools=${config.maxCatalogTools}`,
        );
      }

      const mcpRuntime = options.mcpRuntime === undefined
        ? mcpRuntimeHealthFromPayload()
        : normalizeMcpRuntimeHealth(options.mcpRuntime);
      if (options.mcpRuntime !== undefined && !mcpRuntime) throw new TypeError("MCP runtime health binding is invalid");
      return new GatewayRuntime(
        config,
        upstreams,
        catalog,
        journal,
        effects,
        publicationPolicy,
        learnerVault,
        undefined,
        mcpRuntime,
        blackboardEffectDispatchSecret,
      );
    } catch (error) {
      await closeStartupResources(upstreams, journal, effects);
      throw error;
    }
  }

  health(): GatewayHealth {
    const sources = [...this.upstreams.values()].map((upstream) => upstream.health());
    return {
      schema: "morrow.health.v1",
      version: "1.0.0",
      ready: sources.every((source) => (
        !source.required
        || (
          source.connected
          && source.catalogAttested !== false
        )
      )),
      profile: this.config.profile,
      catalogDigest: this.catalog.digest,
      publicToolCount: this.catalog.tools.filter((tool) => !isPrivateSourceTool(tool)).length,
      collisionCount: this.catalog.collisions.length,
      excludedToolCount: this.catalog.excluded.length,
      sources,
      operationJournal: this.journal.health(),
      ...(this.mcpRuntime ? { mcpRuntime: this.mcpRuntime } : {}),
      ...(this.publicationPolicy ? { publicationPolicy: this.publicationPolicy } : {}),
      ...(this.config.runtimeLimitations?.length ? { limitations: [...this.config.runtimeLimitations] } : {}),
    };
  }

  effectHealth(): JsonObject {
    const recent = this.effects.list(200);
    const unresolved = recent.filter((operation) => (
      !["verified", "failed", "cancelled", "closed_by_person"].includes(operation.state)
    ));
    return {
      schema: "morrow.effect-broker.health.v1",
      open: true,
      recentOperationCount: recent.length,
      recentCoverageComplete: recent.length < 200,
      unresolvedOperationCount: unresolved.length,
      appliedOrUnknownCount: recent.filter((operation) => operation.state === "applied_or_unknown").length,
      dispatchingCount: recent.filter((operation) => operation.state === "dispatching").length,
    };
  }

  hasActiveWork(): boolean {
    const journal = this.journal.health();
    return journal.unresolvedOperations > 0
      || this.effects.hasActiveOperations();
  }

  searchCatalog(input: CatalogSearchInput = {}): CatalogSearchResult {
    const query = input.query?.trim().toLowerCase() ?? "";
    const source = input.source?.trim().toLowerCase() ?? "";
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const matches = this.catalog.tools.filter((tool) => {
      if (isPrivateSourceTool(tool)) return false;
      if (source && tool.upstreamId !== source) return false;
      if (!query) return true;
      return [tool.publicName, tool.upstreamName, tool.title, tool.description]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(query));
    });
    const page = matches.slice(offset, offset + limit);
    const nextOffset = offset + page.length < matches.length
      ? offset + page.length
      : null;

    return {
      schema: "morrow.catalog.search.v1",
      catalogDigest: this.catalog.digest,
      totalMatches: matches.length,
      offset,
      returned: page.length,
      nextOffset,
      tools: page.map(projectCatalogTool),
      collisionCount: this.catalog.collisions.length,
      collisions: this.catalog.collisions.slice(0, 50),
      excludedCount: this.catalog.excluded.length,
    };
  }

  capabilityGet(name: string): JsonObject {
    const mapping = this.toolByPublicName.get(name.trim());
    const capability = mapping?.capability;
    if (!capability || (mapping && isPrivateSourceTool(mapping))) {
      return {
        schema: "morrow.problem.v1",
        code: "capability_not_found",
        profile: this.config.profile,
      };
    }
    return {
      schema: "morrow.capability-get.v1",
      profile: this.config.profile,
      descriptor: capability,
    };
  }

  profileStatus(): JsonObject {
    const profile = this.config.profile;
    const supported = this.catalog.tools.filter((tool) => (
      !isPrivateSourceTool(tool) && tool.capability?.profiles[profile]?.state === "supported"
    ));
    const unavailable = this.catalog.excluded.filter((tool) => tool.reason === "profile_unavailable");
    return {
      schema: "morrow.profile-status.v1",
      profile,
      authorityDigest: sha256Json({
        profile,
        catalogDigest: this.catalog.digest,
        supported: supported.map((tool) => tool.publicName),
      }),
      supportedToolCount: supported.length,
      unavailableToolCount: unavailable.length,
      unavailable,
    };
  }

  operationGet(operationId: string): JsonObject {
    if (operationId.startsWith("op:")) {
      return effectOperationProjection(this.effects.get(operationId));
    }
    return operationRecordProjection(this.journal.get(operationId));
  }

  async operationReviewContext(
    operationId: string,
    cache?: ApprovalReviewReadCache,
  ): Promise<ApprovalReviewContext> {
    try {
      const operation = this.effects.get(operationId);
      return resolveApprovalReviewContext({
        operation,
        tools: this.catalog.tools,
        ...(cache ? { cache } : {}),
        read: async (publicName, args, signal) => this.resolveResultArtifact(
          await this.callSourceOwned(publicName, args, { signal }),
        ),
      });
    } catch {
      return { targets: [] };
    }
  }

  operationsRecent(input: RecentOperationsInput = {}): JsonObject {
    const operations = this.journal.list({
      ...(input.source ? { sourceId: input.source } : {}),
      ...(input.tool ? { publicToolName: input.tool } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }).map(operationRecordProjection);
    return {
      schema: "morrow.gateway-operations.list.v1",
      returned: operations.length,
      operations,
    };
  }

  /** Runs one tool call with the identity of the assistant that asked for it. */
  runAsRequester<T>(identity: RequestedByIdentity | undefined, body: () => T): T {
    return identity ? this.requester.run(identity, body) : body();
  }

  /** The assistant that asked for the call now running, when one is known. */
  get requestedBy(): RequestedByIdentity | undefined {
    return this.requester.getStore();
  }

  operationList(limit = 50): JsonObject {
    const operations = this.effects.list(limit).map(effectOperationProjection);
    return {
      schema: "morrow.operations.list.v1",
      returned: operations.length,
      operations,
    };
  }

  approvalUrl(operationId: string): string | null {
    return this.approvalBaseUrl ? `${this.approvalBaseUrl}/operations/${encodeURIComponent(operationId)}` : null;
  }

  setApprovalBaseUrl(baseUrl: string): void {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      throw new TypeError("approval service must use the loopback address");
    }
    this.approvalBaseUrl = parsed.origin;
  }

  approveOperation(operationId: string): JsonObject {
    return effectOperationProjection(this.effects.approve(operationId));
  }

  cancelOperation(operationId: string): JsonObject {
    const cancelled = this.effects.cancel(operationId);
    const stages = this.operationFileStages.get(operationId);
    for (const stage of stages || []) this.fileStages.discard(stage.handle);
    this.operationFileStages.delete(operationId);
    return effectOperationProjection(cancelled);
  }

  private async currentMoodleStagedFileScope(
    mapping: CatalogTool,
    sourceBindingId: string,
    courseId: number,
    signal?: AbortSignal,
  ): Promise<FileStageScope> {
    const capability = moodleStagedFileCapabilityForMapping(mapping);
    if (!capability) throw new Error("The Moodle staged-file capability is unavailable or ambiguous.");
    const source = this.browserBindingsTool(mapping);
    if (!source) throw new Error("The Moodle browser connection is unavailable or ambiguous.");
    const response = await this.callSourceOwned(source.publicName, {}, { signal });
    const bindings = browserBindingContent(response).filter((entry) => entry.sourceBindingId === sourceBindingId);
    if (bindings.length !== 1) throw new Error("The selected Moodle course connection is unavailable or ambiguous.");
    return moodleStagedFileScope(bindings[0]!, sourceBindingId, courseId, capability);
  }

  private async currentCanvasFileScope(
    mapping: CatalogTool,
    sourceBindingId: string,
    courseId: number,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<FileStageScope> {
    const source = this.browserBindingsTool(mapping);
    if (!source) throw new Error("The Canvas browser connection is unavailable or ambiguous.");
    const response = await this.callSourceOwned(source.publicName, {}, { signal });
    const bindings = browserBindingContent(response).filter((entry) => entry.sourceBindingId === sourceBindingId);
    if (bindings.length !== 1) throw new Error("The selected Canvas course connection is unavailable or ambiguous.");
    return canvasFileScope(bindings[0]!, sourceBindingId, courseId, contentType);
  }

  private resourceFileEffectScope(scope: FileStageScope): EffectBindingScope {
    return {
      provider: scope.provider,
      sourceBindingId: scope.sourceBindingId,
      origin: scope.origin,
      siteUrl: scope.siteUrl,
      principalFingerprint: scope.principalFingerprint,
      sessionGeneration: scope.sessionGeneration,
    };
  }

  async planMoodleStagedFile(
    value: unknown,
    kind: MoodleStagedFileKind,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    const capability = moodleStagedFileCapability(kind);
    const stageHandles: string[] = [];
    let operation: EffectOperationRecord | undefined;
    try {
      const parsed = capability.planMode === "create"
        ? moodleResourceFileInputSchema.parse(value)
        : capability.planMode === "folder_add"
          ? moodleFolderFilesInputSchema.parse(value)
          : moodleResourceFileReplacementInputSchema.parse(value);
      const input = parsed as {
        source_binding_id: string; course_id: number; section_id?: number; module_id?: number; name?: string;
        file_path?: string; file_paths?: string[]; folder_path?: string;
      };
      options.signal?.throwIfAborted();
      const matches = this.catalog.tools.filter((entry) => moodleStagedFileCapabilityForMapping(entry)?.kind === kind);
      if (matches.length !== 1) throw new Error(`The Moodle ${capability.noun} file capability is unavailable or ambiguous.`);
      const mapping = matches[0]!;
      const reads = this.catalog.tools.filter((entry) => entry.upstreamId === mapping.upstreamId
        && entry.upstreamName === capability.preparationReadToolName && entry.annotations?.readOnlyHint === true);
      if (reads.length !== 1) throw new Error(`The Moodle ${capability.noun} preparation read is unavailable or ambiguous.`);
      const scope = await this.currentMoodleStagedFileScope(mapping, input.source_binding_id, input.course_id, options.signal);
      const preparationArguments: JsonObject = capability.planMode === "create"
        ? { course_id: input.course_id, section_id: input.section_id, _morrow: { source_binding_id: input.source_binding_id } }
        : { course_id: input.course_id, module_id: input.module_id, _morrow: { source_binding_id: input.source_binding_id } };
      const preparation = this.resolveResultArtifact(await this.callSourceOwned(reads[0]!.publicName, preparationArguments, options));
      const envelope = isJsonObject(preparation.structuredContent) ? preparation.structuredContent : {};
      const result = isJsonObject(envelope.result) ? envelope.result : {};
      const data = isJsonObject(result.data) ? result.data : {};
      const exactTarget = capability.planMode === "create"
        ? data.course_id === input.course_id && data.section_id === input.section_id
        : data.course_id === input.course_id && data.module_id === input.module_id;
      if (preparation.isError === true || envelope.schema !== "morrow.canvas-connector.result.v1" || envelope.provider !== "moodle"
        || envelope.ok !== true || result.ok !== true || result.sent !== true || !exactTarget
        || typeof result.snapshot_digest !== "string" || !/^[a-f0-9]{64}$/.test(result.snapshot_digest)) {
        throw new Error(`Moodle did not return the exact current ${capability.noun} state.`);
      }
      const freshScope = await this.currentMoodleStagedFileScope(mapping, input.source_binding_id, input.course_id, options.signal);
      if (sha256Json(scope) !== sha256Json(freshScope)) throw new Error("The Moodle course connection changed during preparation.");
      if (typeof options.workspaceRoot !== "string" || !options.workspaceRoot) {
        throw new Error("A trusted assistant workspace is unavailable for this session.");
      }
      const paths = capability.planMode === "folder_add" ? input.file_paths! : [input.file_path!];
      const locals: Array<{ filename: string; bytes: Buffer }> = [];
      let stages: Array<{ handle: string; manifest: { filename: string; sizeBytes: number; sha256: string } }> = [];
      try {
        for (const path of paths) locals.push(await readWorkspaceFile(path, options.workspaceRoot));
        if (new Set(locals.map((local) => local.filename)).size !== locals.length) {
          throw new Error("Each reviewed Moodle Folder file must have a different file name.");
        }
        if (locals.reduce((total, local) => total + local.bytes.byteLength, 0) > MAX_STAGED_FILE_BYTES) {
          throw new Error("The reviewed Moodle Folder files together must be at most 1 MiB.");
        }
        if ((kind === "scorm" || kind === "scorm_replacement") && !/\.zip$/i.test(locals[0]!.filename)) {
          throw new Error("A SCORM package file name must end in .zip.");
        }
        if (kind === "h5p" && !/\.h5p$/i.test(locals[0]!.filename)) {
          throw new Error("An H5P package file name must end in .h5p.");
        }
        options.signal?.throwIfAborted();
        stages = locals.map((local) => this.fileStages.stage({
          ...local,
          scope,
          expiresAt: Date.now() + RESOURCE_FILE_APPROVAL_TTL_MS + 1_000,
        }));
        stageHandles.push(...stages.map((stage) => stage.handle));
      } finally {
        for (const local of locals) local.bytes.fill(0);
      }
      const request: JsonObject = capability.planMode === "create"
        ? {
            course_id: input.course_id, section_id: input.section_id, name: input.name,
            filename: stages[0]!.manifest.filename, size_bytes: stages[0]!.manifest.sizeBytes, sha256: stages[0]!.manifest.sha256,
            expected_digest: result.snapshot_digest, _morrow: { source_binding_id: input.source_binding_id },
          }
        : capability.planMode === "folder_add"
          ? {
              course_id: input.course_id, module_id: input.module_id, folder_path: input.folder_path,
              files: stages.map((stage) => ({ filename: stage.manifest.filename, size_bytes: stage.manifest.sizeBytes, sha256: stage.manifest.sha256 })),
              expected_digest: result.snapshot_digest, _morrow: { source_binding_id: input.source_binding_id },
            }
          : {
              course_id: input.course_id, module_id: input.module_id,
              filename: stages[0]!.manifest.filename, size_bytes: stages[0]!.manifest.sizeBytes, sha256: stages[0]!.manifest.sha256,
              expected_digest: result.snapshot_digest, _morrow: { source_binding_id: input.source_binding_id },
            };
      operation = this.planEffect(mapping, {
        request,
        readback: connectorReadback(mapping, request),
        approvalTtlMs: RESOURCE_FILE_APPROVAL_TTL_MS,
      }, REVIEW_AUTHORIZATION, undefined, this.resourceFileEffectScope(scope));
      const bound = stages.map((stage): FileStageBinding => ({ handle: stage.handle, manifest: stage.manifest, scope, operationId: operation!.operationId }));
      for (const entry of bound) this.fileStages.bind(entry);
      this.operationFileStages.set(operation.operationId, bound);
      return this.effectResult(operation, "planned");
    } catch (error) {
      for (const handle of stageHandles) this.fileStages.discard(handle);
      if (operation) this.effects.cancel(operation.operationId);
      return this.planOperationRejected(capability.publicPlanToolName, error);
    }
  }

  async planMoodleResourceFile(
    value: unknown,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    return await this.planMoodleStagedFile(value, "resource", options);
  }

  async planMoodleFolderFile(
    value: unknown,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    return await this.planMoodleStagedFile(value, "folder", options);
  }

  async planMoodleImscpPackage(
    value: unknown,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    return await this.planMoodleStagedFile(value, "imscp", options);
  }

  async planMoodleScormPackage(
    value: unknown,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    return await this.planMoodleStagedFile(value, "scorm", options);
  }

  async planCanvasCourseFileUpload(
    value: unknown,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    let stageHandle: string | undefined;
    let operation: EffectOperationRecord | undefined;
    try {
      const input = canvasCourseFileUploadInputSchema.parse(value);
      options.signal?.throwIfAborted();
      const matches = this.catalog.tools.filter(isCanvasCourseFileTransfer);
      if (matches.length !== 1) throw new Error("The Canvas file-transfer capability is unavailable or ambiguous.");
      const mapping = matches[0]!;
      if (typeof options.workspaceRoot !== "string" || !options.workspaceRoot) {
        throw new Error("A trusted assistant workspace is unavailable for this session.");
      }
      const local = await readWorkspaceMaterial(input.material_path, options.workspaceRoot);
      const contentType = contentTypeForCanvasFile(local.filename);
      const scope = await this.currentCanvasFileScope(mapping, input.source_binding_id, input.course_id, contentType, options.signal);
      let stage;
      try {
        options.signal?.throwIfAborted();
        stage = this.fileStages.stage({
          ...local,
          scope,
          expiresAt: Date.now() + CANVAS_FILE_APPROVAL_TTL_MS + 1_000,
        });
      } finally {
        local.bytes.fill(0);
      }
      stageHandle = stage.handle;
      const freshScope = await this.currentCanvasFileScope(mapping, input.source_binding_id, input.course_id, contentType, options.signal);
      if (sha256Json(scope) !== sha256Json(freshScope)) throw new Error("The Canvas course connection changed during preparation.");
      const request: JsonObject = {
        course_id: input.course_id,
        folder_id: input.folder_id,
        filename: stage.manifest.filename,
        size_bytes: stage.manifest.sizeBytes,
        sha256: stage.manifest.sha256,
        content_type: contentType,
        _morrow: { source_binding_id: input.source_binding_id },
      };
      operation = this.planEffect(mapping, {
        request,
        readback: connectorReadback(mapping, request),
        approvalTtlMs: CANVAS_FILE_APPROVAL_TTL_MS,
      }, REVIEW_AUTHORIZATION, undefined, this.resourceFileEffectScope(scope));
      const bound: FileStageBinding = { handle: stage.handle, manifest: stage.manifest, scope, operationId: operation.operationId };
      this.fileStages.bind(bound);
      this.operationFileStages.set(operation.operationId, [bound]);
      return this.effectResult(operation, "planned");
    } catch (error) {
      if (stageHandle) this.fileStages.discard(stageHandle);
      if (operation) this.effects.cancel(operation.operationId);
      return this.planOperationRejected("morrow_plan_canvas_file_upload", error);
    }
  }

  async planCanvasConversation(
    value: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    try {
      const input = canvasConversationInputSchema.parse(value);
      options.signal?.throwIfAborted();
      const matches = this.catalog.tools.filter(isCanvasConversationTransfer);
      if (matches.length !== 1) throw new Error("The Canvas Inbox capability is unavailable or ambiguous.");
      const mapping = matches[0]!;
      const request: JsonObject = {
        course_id: input.course_id,
        _morrow: {
          source_binding_id: input.source_binding_id,
          canvas_conversation: canvasConversationPlan(input),
        },
      };
      const current = await this.currentEffectAuthority(mapping, request);
      return this.effectResult(this.planEffect(mapping, {
        request,
        readback: connectorReadback(mapping, request),
      }, current.authorization, undefined, current.bindingScope), "planned");
    } catch (error) {
      return this.planOperationRejected("morrow_plan_canvas_conversation", error);
    }
  }

  /**
   * The Blackboard effect binding scope, held to the same shape as a browser
   * course connection: one exact site, connection, account fingerprint, and a
   * session generation of 1 or more. The Blackboard source counts that
   * generation from its own durable record of the account and credential it
   * acts as, so a rotated secret or a repointed integration account raises it.
   * The generation frozen here travels with the reserved change and the source
   * refuses to dispatch it under any other session.
   */
  private blackboardEffectScope(value: unknown, input: { source_binding_id: string }): EffectBindingScope {
    const sessionGeneration = isJsonObject(value) ? value.sessionGeneration : undefined;
    if (!isJsonObject(value)
      || value.provider !== "blackboard"
      || value.sourceBindingId !== input.source_binding_id
      || typeof value.origin !== "string"
      || typeof value.principalFingerprint !== "string"
      || !/^[0-9a-f]{64}$/.test(value.principalFingerprint)
      || !Number.isSafeInteger(sessionGeneration) || Number(sessionGeneration) < 1) {
      throw new Error("Blackboard did not return the exact selected effect scope.");
    }
    let origin: URL;
    try { origin = new URL(value.origin); } catch { throw new Error("Blackboard did not return the exact selected effect scope."); }
    if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error("Blackboard did not return the exact selected effect scope.");
    }
    return {
      provider: "blackboard",
      sourceBindingId: input.source_binding_id,
      origin: value.origin,
      principalFingerprint: value.principalFingerprint,
      sessionGeneration: Number(sessionGeneration),
    };
  }

  async planBlackboardContentPatch(
    value: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    try {
      const input = blackboardContentPatchInputSchema.parse(value);
      options.signal?.throwIfAborted();
      const planMappings = this.catalog.tools.filter(isBlackboardContentPatchPlan);
      const applyMappings = this.catalog.tools.filter(isBlackboardContentPatchApply);
      const verifyMappings = this.catalog.tools.filter(isBlackboardContentPatchVerify);
      if (planMappings.length !== 1 || applyMappings.length !== 1 || verifyMappings.length !== 1
        || planMappings[0]!.upstreamId !== applyMappings[0]!.upstreamId
        || planMappings[0]!.upstreamId !== verifyMappings[0]!.upstreamId) {
        throw new Error("The configured Blackboard content-update route is unavailable or ambiguous.");
      }
      const sourcePlanResult = this.resolveResultArtifact(await this.callSourceOwned(planMappings[0]!.publicName, input, options));
      const sourcePlan = isJsonObject(sourcePlanResult.structuredContent) ? sourcePlanResult.structuredContent : null;
      if (sourcePlanResult.isError === true || !sourcePlan
        || sourcePlan.schema !== "morrow.blackboard.content-patch.plan.v1"
        || sourcePlan.ok !== true
        || sourcePlan.tenantId !== input.tenant_id
        || sourcePlan.sourceBindingId !== input.source_binding_id
        || sourcePlan.courseId !== input.course_id
        || sourcePlan.contentId !== input.content_id
        || typeof sourcePlan.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(sourcePlan.planDigest)
        || typeof sourcePlan.beforeDigest !== "string" || !/^[0-9a-f]{64}$/.test(sourcePlan.beforeDigest)
        || !isJsonObject(sourcePlan.patch)
        || sha256Json(sourcePlan.patch) !== sha256Json(input.patch)
        || !isJsonObject(sourcePlan.effect_scope)) {
        throw new Error("Blackboard did not return the exact reviewed content-update plan.");
      }
      const bindingScope = this.blackboardEffectScope(sourcePlan.effect_scope, input);
      const request: JsonObject = {
        tenant_id: input.tenant_id,
        source_binding_id: input.source_binding_id,
        course_id: input.course_id,
        content_id: input.content_id,
        patch: sourcePlan.patch,
        expected_plan_digest: sourcePlan.planDigest,
        // The reviewed Blackboard connection, frozen into the durable operation.
        // The source compares it against the account and credential it acts as
        // when this change is dispatched, and refuses to send under another one.
        expected_connection: {
          principal_fingerprint: bindingScope.principalFingerprint,
          session_generation: bindingScope.sessionGeneration,
        },
        _morrow: { source_binding_id: input.source_binding_id },
      };
      const readback: FrozenReadbackPlan = {
        tool: verifyMappings[0]!.publicName,
        arguments: {
          tenant_id: input.tenant_id,
          source_binding_id: input.source_binding_id,
          course_id: input.course_id,
          content_id: input.content_id,
          patch: sourcePlan.patch,
        },
        expectedDigest: sha256Json({
          schema: "morrow.blackboard.content-patch.comparator.v1",
          ok: true,
          tenantId: input.tenant_id,
          sourceBindingId: input.source_binding_id,
          courseId: input.course_id,
          contentId: input.content_id,
          verified: true,
          status: "api_configured_live_untested",
        }),
      };
      const operation = this.planEffect(applyMappings[0]!, { request, readback }, REVIEW_AUTHORIZATION, undefined, bindingScope);
      return this.effectResult(operation, "planned", undefined, [
        "Blackboard REST configuration is present, but this integration has not received a live Blackboard validation claim.",
      ]);
    } catch (error) {
      return this.planOperationRejected("morrow_plan_blackboard_content_patch", error);
    }
  }

  async planBlackboardAction(
    publicName: string,
    value: unknown,
    options: { readonly signal?: AbortSignal; readonly workspaceRoot?: string } = {},
  ): Promise<JsonObject> {
    let stageHandle: string | undefined;
    let operation: EffectOperationRecord | undefined;
    let local: Awaited<ReturnType<typeof readWorkspaceFile>> | undefined;
    try {
      const action = BLACKBOARD_ACTIONS.find((entry) => entry.publicName === publicName);
      if (!action) throw new Error("The Blackboard action is unavailable.");
      const publicInput = action.inputSchema.parse(value) as JsonObject;
      const prepared = { ...publicInput };
      if (action.attachment) {
        if (!options.workspaceRoot || typeof publicInput.file_path !== "string") throw new Error("A trusted assistant workspace is unavailable.");
        local = await readWorkspaceFile(publicInput.file_path, options.workspaceRoot);
        delete prepared.file_path;
        Object.assign(prepared, { filename: local.filename, size_bytes: local.bytes.byteLength, sha256: createHash("sha256").update(local.bytes).digest("hex") });
      }
      const input = action.plan.inputSchema.parse(prepared) as JsonObject;
      const route = (name: string, readOnly: boolean): CatalogTool => {
        const matches = this.catalog.tools.filter((entry) => entry.upstreamId === "blackboard-rest"
          && entry.upstreamName === name && entry.annotations?.readOnlyHint === readOnly
          && entry.capability?.provider === "blackboard" && entry.capability.route.backend === "lms-api");
        if (matches.length !== 1) throw new Error("The configured Blackboard action is unavailable or ambiguous.");
        return matches[0]!;
      };
      const planMapping = route(action.plan.name, true);
      const applyMapping = route(action.apply.name, false);
      const verifyMapping = route(action.verify.name, true);
      const planned = this.resolveResultArtifact(await this.callSourceOwned(planMapping.publicName, input, options));
      const sourcePlan = isJsonObject(planned.structuredContent) ? planned.structuredContent : null;
      const exactScope = (result: JsonObject | null): result is JsonObject => Boolean(result && result.ok === true
        && result.tenantId === input.tenant_id && result.sourceBindingId === input.source_binding_id && result.courseId === input.course_id);
      if (planned.isError === true || !exactScope(sourcePlan)
        || typeof sourcePlan.schema !== "string" || !sourcePlan.schema.endsWith(".plan.v1")
        || typeof sourcePlan.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(sourcePlan.planDigest)) {
        throw new Error("Blackboard did not return the selected action's reviewed plan.");
      }
      const bindingScope = this.blackboardEffectScope(sourcePlan.effect_scope, { source_binding_id: String(input.source_binding_id) });
      const comparison = this.resolveResultArtifact(await this.callSourceOwned(verifyMapping.publicName, input, options));
      const comparator = isJsonObject(comparison.structuredContent) ? comparison.structuredContent : null;
      if (comparison.isError === true || !exactScope(comparator)
        || typeof comparator.schema !== "string" || !comparator.schema.endsWith(".comparator.v1")
        || typeof comparator.verified !== "boolean") throw new Error("Blackboard did not return the selected action's readback contract.");
      const request: JsonObject = {
        ...input,
        expected_plan_digest: sourcePlan.planDigest,
        expected_connection: { principal_fingerprint: bindingScope.principalFingerprint, session_generation: bindingScope.sessionGeneration },
        _morrow: { source_binding_id: input.source_binding_id! },
      };
      let staged: FileStageBinding | undefined;
      if (local) {
        const scope: FileStageScope = {
          provider: "blackboard", sourceBindingId: bindingScope.sourceBindingId, origin: bindingScope.origin,
          siteUrl: `${bindingScope.origin}/`, principalFingerprint: bindingScope.principalFingerprint,
          sessionGeneration: bindingScope.sessionGeneration, catalogDigest: this.catalog.digest,
          courseId: String(input.course_id), toolName: applyMapping.upstreamName, operationKey: applyMapping.upstreamName,
          contentType: String(input.content_type),
        };
        const stage = this.fileStages.stage({ ...local, scope, expiresAt: Date.now() + RESOURCE_FILE_APPROVAL_TTL_MS + 1_000 });
        stageHandle = stage.handle;
        staged = { handle: stage.handle, scope, manifest: stage.manifest, operationId: "pending" };
      }
      operation = this.planEffect(applyMapping, {
        request,
        readback: { tool: verifyMapping.publicName, arguments: input, expectedDigest: sha256Json({ ...comparator, verified: true }) },
        ...(staged ? { approvalTtlMs: RESOURCE_FILE_APPROVAL_TTL_MS } : {}),
      }, REVIEW_AUTHORIZATION, undefined, bindingScope);
      if (staged) {
        const bound = { ...staged, operationId: operation.operationId };
        this.fileStages.bind(bound);
        this.operationFileStages.set(operation.operationId, [bound]);
      }
      return this.effectResult(operation, "planned", undefined, [
        "Blackboard API behavior is fixture-tested. Live Blackboard tenant validation is not available.",
        ...(typeof sourcePlan.recallLimit === "string" ? [sourcePlan.recallLimit] : []),
      ]);
    } catch (error) {
      if (stageHandle) this.fileStages.discard(stageHandle);
      if (operation) this.effects.cancel(operation.operationId);
      return this.planOperationRejected(publicName, error);
    } finally {
      local?.bytes.fill(0);
    }
  }

  private effectResult(
    record: EffectOperationRecord,
    phase: string,
    result?: JsonObject,
    additionalLimitations: readonly string[] = [],
  ): JsonObject {
    const verificationStatus = record.verificationStatus === "verified"
      ? "verified"
      : record.readback ? "unconfirmed" : "not_requested";
    const stateLimitations = record.state === "awaiting_inner_approval"
      ? ["The source still requires its own human approval. Morrow did not infer provider completion."]
      : record.state === "awaiting_verification"
        ? ["A fresh, frozen readback comparator is required before Morrow can report verified."]
        : record.state === "applied_or_unknown"
          ? ["Morrow will not replay this operation because the provider effect may have occurred."]
          : record.state === "closed_by_person"
            ? [PERSON_CLOSED_LIMITATION]
            : [];
    return canonicalMorrowResult({
      ...(result ? { result } : {}),
      operationId: record.operationId,
      tool: record.publicToolName,
      backend: record.sourceId,
      provider: this.toolByPublicName.get(record.publicToolName)?.capability?.provider,
      phase,
      effectState: record.state,
      verificationStatus,
      attention: record.attention,
      limitations: [...stateLimitations, ...additionalLimitations].length
        ? [...stateLimitations, ...additionalLimitations]
        : undefined,
      receipts: {
        planDigest: record.planDigest,
        ...(record.approvalGrantDigest ? { approvalGrantDigest: record.approvalGrantDigest } : {}),
        ...(record.effectReceiptId ? { effectReceiptId: record.effectReceiptId } : {}),
        dispatchAttempt: record.dispatchAttempt,
        ...(record.readbackDigest ? { readbackDigest: record.readbackDigest } : {}),
        ...(this.approvalUrl(record.operationId) && record.state === "awaiting_approval"
          ? { approvalUrl: this.approvalUrl(record.operationId) }
          : {}),
        ...(frozenEffectAuthorization(record.plan).kind === "edit_scope" && this.approvalUrl(record.operationId)
          ? { statusUrl: this.approvalUrl(record.operationId) }
          : {}),
      },
    });
  }

  private planEffect(
    mapping: CatalogTool,
    controls: OuterOperationControls,
    authorization: EffectAuthorization = REVIEW_AUTHORIZATION,
    correctionOf?: string,
    bindingScope?: EffectBindingScope,
  ): EffectOperationRecord {
    const routed = withSourceOperationId(mapping, controls.request);
    const routing = legacyRouting(controls.request);
    return this.effects.create({
      publicToolName: mapping.publicName,
      sourceId: mapping.upstreamId,
      sourceToolName: mapping.upstreamName,
      catalogDigest: this.catalog.digest,
      authority: this.effectAuthority(mapping, controls.request, authorization, controls.readback, bindingScope),
      authorization,
      ...(this.requestedBy ? { requestedBy: this.requestedBy } : {}),
      request: controls.request,
      forwardedRequest: routed.forwarded as JsonObject,
      ...(routed.sourceOperationId ? { sourceOperationId: routed.sourceOperationId } : {}),
      ...(routing.sourceBindingId ? { sourceBindingId: routing.sourceBindingId } : {}),
      ...(controls.readback ? { readback: controls.readback } : {}),
      ...(controls.approvalTtlMs ? { approvalTtlMs: controls.approvalTtlMs } : {}),
      ...(correctionOf ? { correctionOf } : {}),
    });
  }

  private effectAuthority(
    mapping: CatalogTool,
    request: JsonObject,
    authorization: EffectAuthorization = REVIEW_AUTHORIZATION,
    readback?: FrozenReadbackPlan,
    bindingScope?: EffectBindingScope,
  ): EffectAuthoritySnapshot {
    const source = this.upstreams.get(mapping.upstreamId)?.health();
    const approvalClass = mapping.capability?.authority.approvalClass
      || (mapping.annotations?.destructiveHint ? "destructive" : "standard");
    const providerScope: EffectTargetProviderScope = bindingScope || {
      provider: mapping.capability?.provider || "unknown",
      origin: this.config.privacy.canvasOrigin,
    };
    const legacyTargetNamespace = isCanvasConnector(mapping)
      ? undefined
      : sha256Json({
          sourceId: mapping.upstreamId,
          provider: providerScope.provider,
          origin: providerScope.origin,
          ...(providerScope.siteUrl ? { siteUrl: providerScope.siteUrl } : {}),
          ...(bindingScope
            ? {
                sourceBindingId: bindingScope.sourceBindingId,
                principalFingerprint: bindingScope.principalFingerprint,
                sessionGeneration: bindingScope.sessionGeneration,
              }
            : {
                account: this.config.privacy.account,
                principal: this.config.privacy.principal,
              }),
        });
    return {
      profileDigest: sha256Json({
        profile: this.config.profile,
        filters: this.config.filters,
        sources: this.config.upstreams.map((entry) => ({ id: entry.id, revision: entry.revision || null })),
      }),
      actorDigest: sha256Json({
        account: this.config.privacy.account,
        principal: this.config.privacy.principal,
        ...(bindingScope ? { bindingScope } : {}),
      }),
      // This binds the frozen provider site. Target conflict serialization uses
      // targetSetDigest, so different principals can still lock one object.
      providerPrincipalDigest: sha256Json(providerScope),
      connectionGeneration: source?.connectionGeneration || 0,
      catalogDigest: this.catalog.digest,
      approvalClass,
      targetSetDigest: stableEffectTargetIdentity(
        mapping,
        request,
        readback,
        providerScope,
        legacyTargetNamespace,
      ),
      ...(authorization.kind === "edit_scope" ? {
        editPolicyDigest: authorization.policyDigest,
        editPolicyRevision: authorization.policyRevision,
      } : {}),
    };
  }

  private browserBindingsTool(mapping: CatalogTool): CatalogTool | null {
    const matches = this.catalog.tools.filter((candidate) => (
      candidate.upstreamId === mapping.upstreamId
      && candidate.upstreamName === "morrow_browser_bindings"
      && candidate.annotations?.readOnlyHint === true
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  private effectBindingScope(
    mapping: CatalogTool,
    request: JsonObject,
    binding: JsonObject,
  ): EffectBindingScope {
    const routing = legacyRouting(request);
    const sourceBindingId = routing.sourceBindingId;
    const provider = binding.provider;
    const origin = this.exactString(binding.origin, 500);
    const expectedCourseId = requestCourseId(request) || canonicalProviderTarget(mapping, request).courseId;
    const principalFingerprint = typeof binding.principalFingerprint === "string" ? binding.principalFingerprint : "";
    const sessionGeneration = binding.sessionGeneration;
    if (!sourceBindingId || (provider !== "canvas" && provider !== "moodle" && provider !== "blackboard")
      || mapping.capability?.provider !== provider || binding.sourceBindingId !== sourceBindingId
      || binding.runtimeVerified !== true || !origin || !expectedCourseId
      || binding.courseId !== expectedCourseId || !/^[0-9a-f]{64}$/.test(principalFingerprint)
      || !Number.isSafeInteger(sessionGeneration) || Number(sessionGeneration) < 1) {
      throw new Error("The selected browser course connection changed. Read current course connections and try again.");
    }
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error("The selected browser course connection changed. Read current course connections and try again.");
    }
    if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) {
      throw new Error("The selected browser course connection changed. Read current course connections and try again.");
    }
    const siteUrl = provider === "moodle" ? this.exactString(binding.siteUrl, 500) : undefined;
    if (provider === "moodle") {
      try {
        if (!siteUrl || new URL(siteUrl).origin !== origin) throw new Error("site mismatch");
      } catch {
        throw new Error("The selected browser course connection changed. Read current course connections and try again.");
      }
    }
    return {
      provider,
      sourceBindingId,
      origin,
      ...(siteUrl ? { siteUrl } : {}),
      principalFingerprint,
      sessionGeneration: Number(sessionGeneration),
    };
  }

  private async currentBrowserEffectAuthority(
    mapping: CatalogTool,
    request: JsonObject,
  ): Promise<PreparedEffectAuthority> {
    const bindingsTool = this.browserBindingsTool(mapping);
    if (!bindingsTool) {
      throw new Error("The current browser connection is unavailable or ambiguous.");
    }
    const sourceBindingId = legacyRouting(request).sourceBindingId;
    if (!sourceBindingId) {
      throw new Error("Browser connector writes require one exact source_binding_id from morrow_browser_bindings");
    }
    const result = await this.callSourceOwned(bindingsTool.publicName, {});
    if (result.isError === true) {
      throw new Error("The current browser connection could not be read.");
    }
    const matches = browserBindingContent(result).filter((binding) => binding.sourceBindingId === sourceBindingId);
    if (matches.length !== 1) {
      throw new Error("The selected browser course connection changed. Read current course connections and try again.");
    }
    const binding = matches[0]!;
    const permission = isJsonObject(binding.editPermission) ? binding.editPermission : null;
    const current = permission && !Array.isArray(permission.rules)
      ? await this.browserEditOptions(bindingsTool, binding)
      : binding;
    return {
      authorization: currentEditAuthorization(mapping, request, current),
      bindingScope: this.effectBindingScope(mapping, request, current),
    };
  }

  private async currentEffectAuthority(
    mapping: CatalogTool,
    request: JsonObject,
  ): Promise<PreparedEffectAuthority> {
    return isCanvasConnector(mapping)
      ? this.currentBrowserEffectAuthority(mapping, request)
      : { authorization: REVIEW_AUTHORIZATION };
  }

  async prepareEffectAuthority(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<PreparedEffectAuthority> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping || mapping.annotations?.readOnlyHint === true) {
      throw new Error("Morrow can only prepare one current mutating capability.");
    }
    return this.currentEffectAuthority(mapping, outerOperationControls(args).request);
  }

  private editAccessBindingsTool(): CatalogTool | null {
    const matches = this.catalog.tools.filter((candidate) => (
      candidate.upstreamName === "morrow_browser_bindings"
      && candidate.annotations?.readOnlyHint === true
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  private async browserEditOptions(source: CatalogTool, binding: JsonObject): Promise<JsonObject> {
    const candidates = this.catalog.tools.filter((candidate) => candidate.upstreamId === source.upstreamId
      && candidate.upstreamName === "morrow_browser_edit_options" && candidate.annotations?.readOnlyHint === true);
    if (candidates.length === 0 && binding.editOptionsAvailable !== true) return binding;
    if (candidates.length !== 1) throw new Error("The selected course Edit options are unavailable or ambiguous.");
    const result = await this.callSourceOwned(candidates[0]!.publicName, { source_binding_id: binding.sourceBindingId! });
    const options = isJsonObject(result.structuredContent) ? result.structuredContent : null;
    if (result.isError === true || !options || options.schema !== "morrow.bridge.edit-options.v1"
      || options.sourceBindingId !== binding.sourceBindingId || options.provider !== binding.provider
      || options.catalogDigest !== binding.catalogDigest || options.policyRevision !== binding.editPolicyRevision
      || options.runtimeVerified !== binding.runtimeVerified || !Array.isArray(options.options)) {
      throw new Error("The selected course Edit options changed. Read the current course connection and try again.");
    }
    const currentPermission = isJsonObject(binding.editPermission) ? binding.editPermission : null;
    const fullPermission = isJsonObject(options.editPermission) ? options.editPermission : null;
    if (Boolean(currentPermission) !== Boolean(fullPermission)
      || (currentPermission && fullPermission && (currentPermission.scopeDigest !== fullPermission.scopeDigest
        || currentPermission.revision !== fullPermission.revision
        || currentPermission.catalogDigest !== fullPermission.catalogDigest
        || currentPermission.sourceBindingId !== fullPermission.sourceBindingId
        || currentPermission.expiresAt !== fullPermission.expiresAt))) {
      throw new Error("The selected course Edit permission changed. Read the current course connection and try again.");
    }
    const hydrated: JsonObject = { ...binding, editCategories: options.options };
    if (fullPermission) hydrated.editPermission = fullPermission;
    return hydrated;
  }

  private async currentEditAccessBindings(includePolicyForIds: readonly string[] = []): Promise<{
    readonly source: CatalogTool;
    readonly bindings: readonly JsonObject[];
  }> {
    const source = this.editAccessBindingsTool();
    if (!source) throw new Error("The current browser connection is unavailable or ambiguous.");
    const result = await this.callSourceOwned(source.publicName, {});
    if (result.isError === true) throw new Error("The current browser connection could not be read.");
    const bindings = [...browserBindingContent(result)];
    const selected = new Set(includePolicyForIds);
    const pending = bindings.map((binding, index) => ({ binding, index })).filter(({ binding }) => selected.has(String(binding.sourceBindingId)));
    for (let offset = 0; offset < pending.length; offset += 4) {
      const group = pending.slice(offset, offset + 4);
      const detailed = await Promise.all(group.map(({ binding }) => this.browserEditOptions(source, binding)));
      group.forEach(({ index }, item) => { bindings[index] = detailed[item]!; });
    }
    return { source, bindings };
  }

  private browserEditAccessSelection(
    binding: JsonObject,
    input: BrowserEditAccessSelectionInput,
    mode: BrowserEditAccessPrepared["mode"],
  ): BrowserEditAccessSelection {
    const sourceBindingId = typeof binding.sourceBindingId === "string" ? binding.sourceBindingId : "";
    const provider = binding.provider;
    const courseId = typeof binding.courseId === "string" ? binding.courseId : "";
    const courseName = typeof binding.courseName === "string" ? binding.courseName : "";
    const site = provider === "canvas"
      ? typeof binding.origin === "string" ? binding.origin : ""
      : typeof binding.siteUrl === "string" ? binding.siteUrl : "";
    const principalFingerprint = typeof binding.principalFingerprint === "string" ? binding.principalFingerprint : "";
    const sessionGeneration = typeof binding.sessionGeneration === "number" ? binding.sessionGeneration : -1;
    const catalogDigest = typeof binding.catalogDigest === "string" ? binding.catalogDigest : "";
    const expectedPolicyRevision = typeof binding.editPolicyRevision === "number" ? binding.editPolicyRevision : -1;
    if (input.sourceBindingId !== sourceBindingId || (provider !== "canvas" && provider !== "moodle")
      || !/^[1-9][0-9]{0,18}$/.test(courseId) || !courseName || courseName.length > 300
      || !/^https:\/\//.test(site) || site.length > 500
      || !/^[0-9a-f]{64}$/.test(principalFingerprint)
      || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1
      || !/^[0-9a-f]{64}$/.test(catalogDigest)
      || !Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 0) {
      throw new Error("The selected browser course connection changed. Read current course connections and try again.");
    }
    const categories = Array.isArray(binding.editCategories) ? binding.editCategories : [];
    const available = new Map<string, { readonly id: string; readonly label: string; readonly description: string }>();
    for (const category of categories) {
      if (!isJsonObject(category) || typeof category.id !== "string" || typeof category.label !== "string"
        || typeof category.description !== "string" || !category.id || !category.label || !category.description
        || category.id.length > 160 || category.label.length > 300 || category.description.length > 1_000
        || (category.availability !== undefined && category.availability !== "edit" && category.availability !== "review")
        || available.has(category.id)) {
        throw new Error("The selected browser course categories changed. Read current course connections and try again.");
      }
      if (category.availability !== "review") available.set(category.id, { id: category.id, label: category.label, description: category.description });
    }
    const selectedIds = input.enabledCategories ? [...input.enabledCategories] : [];
    if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !/^[A-Za-z0-9_.:@-]{1,160}$/.test(id))) {
      throw new Error("The selected Edit categories are invalid.");
    }
    const enabledCategories = selectedIds.sort(compareAscii).map((id) => available.get(id));
    if (mode === "edit" && (binding.runtimeVerified !== true || enabledCategories.length === 0 || enabledCategories.some((category) => !category))) {
      throw new Error("The selected browser course cannot receive Edit access. Read current course connections and try again.");
    }
    if (mode === "plan" && input.enabledCategories !== undefined) {
      throw new Error("Plan access does not accept Edit categories.");
    }
    return {
      sourceBindingId,
      provider,
      courseId,
      courseName,
      site,
      principalFingerprint,
      sessionGeneration,
      catalogDigest,
      expectedPolicyRevision,
      enabledCategories: enabledCategories.filter((category): category is { readonly id: string; readonly label: string; readonly description: string } => Boolean(category)),
    };
  }

  async prepareBrowserEditAccess(
    mode: BrowserEditAccessPrepared["mode"],
    inputs: readonly BrowserEditAccessSelectionInput[],
  ): Promise<BrowserEditAccessPrepared> {
    if ((mode !== "edit" && mode !== "plan") || inputs.length === 0 || inputs.length > 500) {
      throw new Error("Select one to 500 exact browser course connections.");
    }
    const ids = inputs.map((input) => input.sourceBindingId);
    if (ids.some((id) => !/^[A-Za-z0-9_.:@-]{1,160}$/.test(id)) || new Set(ids).size !== ids.length) {
      throw new Error("Each selected browser course connection must be unique.");
    }
    const { bindings } = await this.currentEditAccessBindings(mode === "edit" ? ids : []);
    const byId = new Map(bindings.map((binding) => [binding.sourceBindingId, binding]));
    const selections = inputs.map((input) => {
      const binding = byId.get(input.sourceBindingId);
      if (!binding) throw new Error("A selected browser course connection is unavailable. Read current course connections and try again.");
      return this.browserEditAccessSelection(binding, input, mode);
    }).sort((left, right) => compareAscii(left.sourceBindingId, right.sourceBindingId));
    return { mode, selections };
  }

  async applyBrowserEditAccess(prepared: BrowserEditAccessPrepared): Promise<BrowserEditAccessResult> {
    const refreshed = await this.prepareBrowserEditAccess(prepared.mode, prepared.selections.map((selection) => ({
      sourceBindingId: selection.sourceBindingId,
      ...(prepared.mode === "edit" ? { enabledCategories: selection.enabledCategories.map((category) => category.id) } : {}),
    })));
    if (sha256Json(refreshed) !== sha256Json(prepared)) {
      throw new Error("The selected browser course connection changed before confirmation. Read current course connections and try again.");
    }
    const source = this.editAccessBindingsTool();
    const upstream = source ? this.upstreams.get(source.upstreamId) : undefined;
    if (!source || !upstream) throw new Error("The current browser connection is unavailable.");
    const command = {
      mode: prepared.mode,
      selections: prepared.selections.map((selection) => ({
        sourceBindingId: selection.sourceBindingId,
        expectedPolicyRevision: selection.expectedPolicyRevision,
        ...(prepared.mode === "edit" ? { enabledCategories: selection.enabledCategories.map((category) => category.id) } : {}),
      })),
    };
    let result: unknown;
    let outcome: BrowserEditAccessResult["outcome"] = "received";
    const selectedIds = prepared.selections.map((selection) => selection.sourceBindingId);
    try {
      result = await upstream.callTool("morrow_browser_edit_policy_set", command, { safeToRetry: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = message.includes("disconnected before dispatch") ? "not_sent" : "unknown";
      const latest = await this.currentEditAccessBindings(selectedIds).catch(() => ({ bindings: [] as readonly JsonObject[] }));
      return { mode: prepared.mode, command: null, bindings: latest.bindings, outcome };
    }
    const raw = isJsonObject(result) && isJsonObject(result.structuredContent) ? result.structuredContent : null;
    if (!raw || raw.schema !== "morrow.browser-edit-policy-set.v1") {
      const latest = await this.currentEditAccessBindings(selectedIds).catch(() => ({ bindings: [] as readonly JsonObject[] }));
      return { mode: prepared.mode, command: raw, bindings: latest.bindings, outcome: "unknown" };
    }
    if (raw.resultState === "unknown") outcome = "unknown";
    if (raw.resultState === "not_sent") outcome = "not_sent";
    const latest = await this.currentEditAccessBindings(selectedIds).catch(() => ({ bindings: [] as readonly JsonObject[] }));
    return { mode: prepared.mode, command: raw, bindings: latest.bindings, outcome };
  }

  private async resolveCurrentEditAuthorization(
    mapping: CatalogTool,
    request: JsonObject,
  ): Promise<EffectAuthorization> {
    try {
      return (await this.currentEffectAuthority(mapping, request)).authorization;
    } catch {
      return REVIEW_AUTHORIZATION;
    }
  }

  resultPage(handle: string, offset?: number, limit?: number, audience?: string): JsonObject {
    return this.resultArtifacts.page(handle, offset, limit, audience) as unknown as JsonObject;
  }

  bindResultArtifactAudience(value: JsonObject, audience: string): JsonObject {
    this.resultArtifacts.bindAudience(value, audience);
    return value;
  }

  private resolveResultArtifact(result: JsonObject): JsonObject {
    return resolveResultArtifact(result, (handle, offset) => this.resultArtifacts.page(handle, offset));
  }

  private outputPrivacy(mapping: CatalogTool) {
    const upstream = this.config.upstreams.find((candidate) => candidate.id === mapping.upstreamId);
    return upstream?.outputPrivacy[mapping.upstreamName] || upstream?.outputPrivacyDefault;
  }

  private exactString(value: unknown, maximum = 500): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized && normalized.length <= maximum ? normalized : null;
  }

  private requestCourseId(value: Readonly<Record<string, unknown>>): string | null {
    const candidate = value.course_id ?? value.courseId;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return String(candidate);
    const normalized = this.exactString(candidate, 30);
    return normalized && (/^[1-9][0-9]{0,18}$/u.test(normalized) || /^_[1-9][0-9]{0,18}_[1-9][0-9]{0,18}$/u.test(normalized)) ? normalized : null;
  }

  private requestSourceBindingId(value: Readonly<Record<string, unknown>>): string | null {
    const direct = this.exactString(value.source_binding_id ?? value.sourceBindingId, 160);
    if (direct) return direct;
    const routing = isJsonObject(value._morrow) ? value._morrow : null;
    return routing ? this.exactString(routing.source_binding_id ?? routing.sourceBindingId, 160) : null;
  }

  private canvasRosterTool(mapping: CatalogTool): CatalogTool | null {
    const matches = this.catalog.tools.filter((candidate) => (
      candidate.upstreamId === mapping.upstreamId
      && candidate.upstreamName === "canvas_list_users_in_course_users"
      && candidate.annotations?.readOnlyHint === true
      && candidate.capability?.route.backend === "canvas-connector"
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  private moodleRosterTool(mapping: CatalogTool): CatalogTool | null {
    const matches = this.catalog.tools.filter((candidate) => (
      candidate.upstreamId === mapping.upstreamId
      && candidate.upstreamName === "moodle_get_course_participant_roster"
      && candidate.annotations?.readOnlyHint === true
      && candidate.capability?.provider === "moodle"
      && candidate.capability?.route.backend === "canvas-connector"
    ));
    return matches.length === 1 ? matches[0]! : null;
  }

  private isCanvasClassicQuizSubmissionSummary(mapping: CatalogTool): boolean {
    return mapping.upstreamName === CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "canvas"
      && isCanvasConnector(mapping);
  }

  private canvasClassicQuizSubmissionSummaryRequest(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; quizId: number }> | null {
    const courseId = this.requestCourseId(request);
    const quizId = request.quiz_id;
    return courseId && Number.isSafeInteger(quizId) && Number(quizId) > 0 && Number.isSafeInteger(Number(courseId))
      ? { courseId, quizId: Number(quizId) }
      : null;
  }

  private async publicCanvasClassicQuizSubmissionSummary(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.canvasClassicQuizSubmissionSummaryRequest(request);
    if (!target) throw new Error("canvas_classic_quiz_submission_summary_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "canvas");
    if (binding.courseId !== target.courseId) throw new Error("canvas_classic_quiz_submission_summary_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "canvas" || source.toolName !== CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL
      || source.operationKey !== CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "canvas" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("canvas_classic_quiz_submission_summary_invalid");
    }
    const summary = projectCanvasClassicQuizSubmissionSummaryBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      quizId: target.quizId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Canvas Classic Quiz submission summary." }],
        structuredContent: summary,
      },
    });
  }

  private isCanvasClassicQuizSubmissionSummaryEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL
      && isJsonObject(result.data);
  }

  private publicCanvasClassicQuizSubmissionSummaryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.canvasClassicQuizSubmissionSummaryRequest(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("canvas_classic_quiz_submission_summary_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL
      || !isJsonObject(result.data)) throw new Error("canvas_classic_quiz_submission_summary_result_invalid");
    const summary = projectCanvasClassicQuizSubmissionSummaryBrowserResult(result.data, {
      courseId: Number(target.courseId),
      quizId: target.quizId,
    });
    const output = canonicalMorrowResult({
      tool: CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Canvas Classic Quiz submission summary." }],
        structuredContent: summary,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  /**
   * The three aggregate-only Canvas course reads share one dispatch. Each one
   * returns counts that the page produced before anything crossed the bridge,
   * and the projection below rebuilds the aggregate from fixed fields, so a
   * browser result that still carried a learner row could not publish it.
   */
  private canvasCourseSummaryRouteFor(mapping: CatalogTool): CanvasCourseSummaryRoute | null {
    return mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "canvas"
      && isCanvasConnector(mapping)
      ? canvasCourseSummaryRoute(mapping.upstreamName)
      : null;
  }

  private canvasCourseSummaryTarget(
    route: CanvasCourseSummaryRoute,
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; expected: ReturnType<CanvasCourseSummaryRoute["expectation"]> }> | null {
    const courseId = this.requestCourseId(request);
    if (!courseId || !Number.isSafeInteger(Number(courseId))) return null;
    const expected = route.expectation(Number(courseId), request);
    return expected ? { courseId, expected } : null;
  }

  private async publicCanvasCourseSummary(
    route: CanvasCourseSummaryRoute,
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.canvasCourseSummaryTarget(route, request);
    if (!target?.expected) throw new Error(`${route.tool}_invalid`);
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "canvas");
    if (binding.courseId !== target.courseId) throw new Error(`${route.tool}_invalid`);
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "canvas" || source.toolName !== route.tool
      || source.operationKey !== route.operation || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "canvas" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(`${route.tool}_invalid`);
    }
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: route.text }],
        structuredContent: route.project(browser.data, target.expected),
      },
    });
  }

  private canvasCourseSummaryEgressRoute(value: JsonObject): CanvasCourseSummaryRoute | null {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    const route = structured ? canvasCourseSummaryRoute(structured.tool) : null;
    return route && structured?.schema === "morrow.result.v1" && result?.schema === "morrow.result.v1"
      && result.tool === route.tool && isJsonObject(result.data)
      ? route
      : null;
  }

  private publicCanvasCourseSummaryEgress(
    route: CanvasCourseSummaryRoute,
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.canvasCourseSummaryTarget(route, request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target?.expected) throw new Error(`${route.tool}_request_invalid`);
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== route.tool
      || !result || result.schema !== "morrow.result.v1" || result.tool !== route.tool
      || !isJsonObject(result.data)) throw new Error(`${route.tool}_result_invalid`);
    const output = canonicalMorrowResult({
      tool: route.tool,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: route.text }],
        structuredContent: route.project(result.data, target.expected),
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleAssignmentSubmissionSummary(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private async publicMoodleAssignmentSubmissionSummary(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    if (!courseId || moduleId === null || moduleId < 1 || !Number.isSafeInteger(Number(courseId))) {
      throw new Error("moodle_assignment_submission_summary_invalid");
    }
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== courseId) throw new Error("moodle_assignment_submission_summary_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL
      || source.operationKey !== MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_assignment_submission_summary_invalid");
    }
    const summary = projectMoodleAssignmentSubmissionSummaryBrowserResult(browser.data, {
      courseId: Number(courseId),
      moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle Assignment submission summary." }],
        structuredContent: summary,
      },
    });
  }

  private isMoodleAssignmentSubmissionSummaryEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleAssignmentSubmissionSummaryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!courseId || moduleId === null || moduleId < 1 || !Number.isSafeInteger(Number(courseId))) {
      throw new Error("moodle_assignment_submission_summary_request_invalid");
    }
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_assignment_submission_summary_result_invalid");
    const summary = projectMoodleAssignmentSubmissionSummaryBrowserResult(result.data, {
      courseId: Number(courseId),
      moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle Assignment submission summary." }],
        structuredContent: summary,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleQuizAttemptSummary(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private async publicMoodleQuizAttemptSummary(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    if (!courseId || moduleId === null || moduleId < 1 || !Number.isSafeInteger(Number(courseId))) {
      throw new Error("moodle_quiz_attempt_summary_invalid");
    }
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== courseId) throw new Error("moodle_quiz_attempt_summary_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL
      || source.operationKey !== MOODLE_QUIZ_ATTEMPT_SUMMARY_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_quiz_attempt_summary_invalid");
    }
    const summary = projectMoodleQuizAttemptSummaryBrowserResult(browser.data, {
      courseId: Number(courseId),
      moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle Quiz attempt summary." }],
        structuredContent: summary,
      },
    });
  }

  private isMoodleQuizAttemptSummaryEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleQuizAttemptSummaryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!courseId || moduleId === null || moduleId < 1 || !Number.isSafeInteger(Number(courseId))) {
      throw new Error("moodle_quiz_attempt_summary_request_invalid");
    }
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_quiz_attempt_summary_result_invalid");
    const summary = projectMoodleQuizAttemptSummaryBrowserResult(result.data, {
      courseId: Number(courseId),
      moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_QUIZ_ATTEMPT_SUMMARY_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle Quiz attempt summary." }],
        structuredContent: summary,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private moodleQuizModuleTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; moduleId: number }> | null {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    return courseId && moduleId !== null && moduleId > 0 && Number.isSafeInteger(Number(courseId))
      ? { courseId, moduleId }
      : null;
  }

  private moodleQuizAttemptTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; moduleId: number; attemptId: number }> | null {
    const target = this.moodleQuizModuleTarget(request);
    const requestedAttemptId = request.attempt_id;
    const attemptId = typeof requestedAttemptId === "number" && Number.isSafeInteger(requestedAttemptId)
      ? requestedAttemptId
      : null;
    return target && attemptId !== null && attemptId > 0 ? { ...target, attemptId } : null;
  }

  private isMoodleQuizAttempt(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_QUIZ_ATTEMPT_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The only Moodle Quiz read that names one attempt, and so one learner. The
   * browser result keeps the Moodle user ID inside `learner`; this dispatch
   * registers the complete course roster first, then projects that identity to
   * a vault token. An identity that is not on the roster fails closed in the
   * roster boundary, so no attempt record is returned for a user Morrow cannot
   * place in this course.
   */
  private async publicMoodleQuizAttempt(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleQuizAttemptTarget(request);
    if (!target) throw new Error("moodle_quiz_attempt_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_quiz_attempt_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_QUIZ_ATTEMPT_TOOL
      || source.operationKey !== MOODLE_QUIZ_ATTEMPT_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_quiz_attempt_invalid");
    }
    const expected = { courseId: Number(target.courseId), moduleId: target.moduleId, attemptId: target.attemptId };
    const bound = projectMoodleQuizAttemptBrowserResult(browser.data, expected);
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const record = projectPublicMoodleQuizAttemptResult(redactLearnerEgress(bound, learner) as JsonObject, expected);
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read one exact Moodle Quiz attempt from the Quiz report route." }],
        structuredContent: record,
      },
    });
  }

  private isMoodleQuizAttemptEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_QUIZ_ATTEMPT_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_QUIZ_ATTEMPT_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleQuizAttemptEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleQuizAttemptTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_quiz_attempt_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_QUIZ_ATTEMPT_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_QUIZ_ATTEMPT_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_quiz_attempt_result_invalid");
    // The public record carries a vault token and no Moodle user ID, so egress
    // proves the bounded record and the token shape, not the requested user.
    const record = projectPublicMoodleQuizAttemptResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
      attemptId: target.attemptId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_QUIZ_ATTEMPT_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read one exact Moodle Quiz attempt from the Quiz report route." }],
        structuredContent: record,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleQuizManualGradingQueue(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The manual grading index names no learner, so this read stays aggregate:
   * the projection rebuilds every count from the listed question rows and
   * carries no other source field.
   */
  private async publicMoodleQuizManualGradingQueue(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleQuizModuleTarget(request);
    if (!target) throw new Error("moodle_quiz_manual_grading_queue_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_quiz_manual_grading_queue_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL
      || source.operationKey !== MOODLE_QUIZ_MANUAL_GRADING_QUEUE_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_quiz_manual_grading_queue_invalid");
    }
    const queue = projectMoodleQuizManualGradingQueueBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Quiz manual grading queue." }],
        structuredContent: queue,
      },
    });
  }

  private isMoodleQuizManualGradingQueueEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleQuizManualGradingQueueEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleQuizModuleTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_quiz_manual_grading_queue_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_quiz_manual_grading_queue_result_invalid");
    const queue = projectMoodleQuizManualGradingQueueBrowserResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_QUIZ_MANUAL_GRADING_QUEUE_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Quiz manual grading queue." }],
        structuredContent: queue,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleQuizRegradeReport(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_QUIZ_REGRADE_REPORT_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The regrade read names no learner and no attempt. The projection requires
   * the browser to state that it sent no session key and no regrade parameter,
   * which is what keeps this route a read.
   */
  private async publicMoodleQuizRegradeReport(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleQuizModuleTarget(request);
    if (!target) throw new Error("moodle_quiz_regrade_report_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_quiz_regrade_report_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_QUIZ_REGRADE_REPORT_TOOL
      || source.operationKey !== MOODLE_QUIZ_REGRADE_REPORT_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_quiz_regrade_report_invalid");
    }
    const report = projectMoodleQuizRegradeReportBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Quiz regrade state. It started no regrade." }],
        structuredContent: report,
      },
    });
  }

  private isMoodleQuizRegradeReportEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_QUIZ_REGRADE_REPORT_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_QUIZ_REGRADE_REPORT_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleQuizRegradeReportEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleQuizModuleTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_quiz_regrade_report_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_QUIZ_REGRADE_REPORT_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_QUIZ_REGRADE_REPORT_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_quiz_regrade_report_result_invalid");
    const report = projectMoodleQuizRegradeReportBrowserResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_QUIZ_REGRADE_REPORT_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Quiz regrade state. It started no regrade." }],
        structuredContent: report,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleForumActivitySummary(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private async publicMoodleForumActivitySummary(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    if (!courseId || moduleId === null || moduleId < 1 || !Number.isSafeInteger(Number(courseId))) {
      throw new Error("moodle_forum_activity_summary_invalid");
    }
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== courseId) throw new Error("moodle_forum_activity_summary_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL
      || source.operationKey !== MOODLE_FORUM_ACTIVITY_SUMMARY_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_forum_activity_summary_invalid");
    }
    const summary = projectMoodleForumActivitySummaryBrowserResult(browser.data, {
      courseId: Number(courseId),
      moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle Forum activity summary." }],
        structuredContent: summary,
      },
    });
  }

  private isMoodleForumActivitySummaryEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleForumActivitySummaryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!courseId || moduleId === null || moduleId < 1 || !Number.isSafeInteger(Number(courseId))) {
      throw new Error("moodle_forum_activity_summary_request_invalid");
    }
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_forum_activity_summary_result_invalid");
    // The public summary carries no course, module, or Forum identifier, so the request
    // target is checked for shape here and compared against the source only at dispatch.
    const summary = projectPublicMoodleForumActivitySummaryResult(result.data);
    const output = canonicalMorrowResult({
      tool: MOODLE_FORUM_ACTIVITY_SUMMARY_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle Forum activity summary." }],
        structuredContent: summary,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleQuestionBankImpactScope(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_QUESTION_BANK_IMPACT_SCOPE_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * Re-validates the enumerated Question Bank impact scope before it leaves the
   * runtime. The projection recomputes the incomplete verdict from the slots
   * themselves, so a browser result cannot report a complete scope that its own
   * stored references contradict. A complete scope authorizes no write; every
   * Question Bank creation and update stays held in the connector.
   */
  private async publicMoodleQuestionBankImpactScope(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const courseId = this.requestCourseId(request);
    if (!courseId || !Number.isSafeInteger(Number(courseId))) throw new Error("moodle_question_bank_impact_scope_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== courseId) throw new Error("moodle_question_bank_impact_scope_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_QUESTION_BANK_IMPACT_SCOPE_TOOL
      || source.operationKey !== MOODLE_QUESTION_BANK_IMPACT_SCOPE_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_question_bank_impact_scope_invalid");
    }
    const scope = projectMoodleQuestionBankImpactScopeBrowserResult(browser.data, { courseId: Number(courseId) });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{
          type: "text",
          text: scope.status === "complete"
            ? "Morrow enumerated every stored Moodle Question Bank reference it could read in this course. Question Bank writes stay held."
            : "Morrow could not enumerate every stored Moodle Question Bank reference in this course. The result names each gap. Question Bank writes stay held.",
        }],
        structuredContent: scope,
      },
    });
  }

  /**
   * The Moodle Choice, Feedback, and Database child-record reads. Each one
   * returns course content or aggregate counts, so one projection covers them
   * all; the projection rebuilds every field and refuses a per-learner
   * projection of an anonymous Feedback by name.
   */
  private moodleActivityContentRead(mapping: CatalogTool): MoodleActivityContentRead | null {
    const read = moodleActivityContentReadByTool(mapping.upstreamName);
    return read && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle" && isCanvasConnector(mapping)
      ? read
      : null;
  }

  private async publicMoodleActivityContentRead(
    read: MoodleActivityContentRead,
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const invalid = `${read.tool.replace(/^moodle_get_/u, "moodle_")}_invalid`;
    // These reads take the same {course_id, module_id} target as the SCORM reads.
    const target = this.moodleScormModuleTarget(request);
    if (!target) throw new Error(invalid);
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error(invalid);
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== read.tool
      || source.operationKey !== read.operation || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(invalid);
    }
    const projected = projectMoodleActivityContentBrowserResult(read, browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: read.summary }],
        structuredContent: projected,
      },
    });
  }

  private moodleActivityContentReadEgress(value: JsonObject): MoodleActivityContentRead | null {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (structured?.schema !== "morrow.result.v1" || result?.schema !== "morrow.result.v1"
      || !isJsonObject(result.data) || structured.tool !== result.tool) return null;
    const read = moodleActivityContentReadByTool(structured.tool);
    return read && read.learnerAggregate ? read : null;
  }

  private publicMoodleActivityContentReadEgress(
    read: MoodleActivityContentRead,
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const prefix = read.tool.replace(/^moodle_get_/u, "moodle_");
    const target = this.moodleScormModuleTarget(request);
    if (!target) throw new Error(`${prefix}_request_invalid`);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!structured || !result || !isJsonObject(result.data)) throw new Error(`${prefix}_result_invalid`);
    const projected = projectMoodleActivityContentBrowserResult(read, result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: read.tool,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: read.summary }],
        structuredContent: projected,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private moodleCourseReportRead(mapping: CatalogTool): MoodleCourseReportRead | null {
    const read = moodleCourseReportReadByTool(mapping.upstreamName);
    return read && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle" && isCanvasConnector(mapping)
      ? read
      : null;
  }

  private moodleCourseReportTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string }> | null {
    const courseId = this.requestCourseId(request);
    return courseId && Number.isSafeInteger(Number(courseId)) ? { courseId } : null;
  }

  /**
   * One of Moodle's own course reports. Four of the five are aggregate and name
   * nobody. The participation report can list the people it counted, and only
   * when the request asked for it; that request registers the complete course
   * roster first and projects every identity to a vault token, so a person the
   * roster cannot place in this course fails the whole report closed.
   */
  private async publicMoodleCourseReportRead(
    read: MoodleCourseReportRead,
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const invalid = `${read.prefix}_invalid`;
    const target = this.moodleCourseReportTarget(request);
    if (!target) throw new Error(invalid);
    const namesLearners = read.learnerRows && request.include_participants === true;
    const sourceBindingId = namesLearners ? this.requestSourceBindingId(request) : null;
    if (namesLearners && !sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error(invalid);
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== read.tool
      || source.operationKey !== read.operation || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(this.moodleReadFailureCode(raw, `${read.prefix}_`, invalid));
    }
    const expected = { courseId: Number(target.courseId) };
    const bound = projectMoodleCourseReportBrowserResult(read, browser.data, expected);
    if (!namesLearners) {
      return canonicalMorrowResult({
        tool: mapping.publicName,
        backend: mapping.upstreamId,
        phase: "read",
        verificationStatus: "not_applicable",
        result: { content: [{ type: "text", text: read.summary }], structuredContent: bound },
      });
    }
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId!, target.courseId, binding, options);
    const projected = projectPublicMoodleCourseReportResult(read, redactLearnerEgress(bound, learner) as JsonObject, expected);
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: { content: [{ type: "text", text: read.summary }], structuredContent: projected },
    });
  }

  private moodleCourseReportReadEgress(value: JsonObject): MoodleCourseReportRead | null {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (structured?.schema !== "morrow.result.v1" || result?.schema !== "morrow.result.v1"
      || !isJsonObject(result.data) || structured.tool !== result.tool) return null;
    return moodleCourseReportReadByTool(structured.tool);
  }

  private publicMoodleCourseReportReadEgress(
    read: MoodleCourseReportRead,
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleCourseReportTarget(request);
    if (!target) throw new Error(`${read.prefix}_request_invalid`);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!structured || !result || !isJsonObject(result.data)) throw new Error(`${read.prefix}_result_invalid`);
    // A participation report that names people carries vault tokens by the time
    // MCP egress sees it, so egress proves the bounded report and the token
    // shape, never a Moodle user ID.
    const projected = read.learnerRows && request.include_participants === true
      ? projectPublicMoodleCourseReportResult(read, result.data, { courseId: Number(target.courseId) })
      : projectMoodleCourseReportBrowserResult(read, result.data, { courseId: Number(target.courseId) });
    const output = canonicalMorrowResult({
      tool: read.tool,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: { content: [{ type: "text", text: read.summary }], structuredContent: projected },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private moodleSiteAdministrationRead(mapping: CatalogTool): MoodleSiteAdministrationRead | null {
    const read = moodleSiteAdministrationReadByTool(mapping.upstreamName);
    return read && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle" && isCanvasConnector(mapping)
      ? read
      : null;
  }

  private moodleSiteAdministrationTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; roleId: number | null }> | null {
    const courseId = this.requestCourseId(request);
    if (!courseId || !Number.isSafeInteger(Number(courseId))) return null;
    if (request.role_id === undefined) return { courseId, roleId: null };
    const roleId = typeof request.role_id === "number" && Number.isSafeInteger(request.role_id) ? request.role_id : null;
    return roleId !== null && roleId > 0 ? { courseId, roleId } : null;
  }

  /**
   * One of Moodle's two read-only system administration reads. Neither carries
   * a learner identity, so neither needs the roster boundary; both fail closed
   * in the page when Moodle does not serve the administration page, and this
   * projection rebuilds every field from a fixed vocabulary.
   */
  private async publicMoodleSiteAdministrationRead(
    read: MoodleSiteAdministrationRead,
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const invalid = `${read.prefix}_invalid`;
    const target = this.moodleSiteAdministrationTarget(request);
    if (!target) throw new Error(invalid);
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error(invalid);
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== read.tool
      || source.operationKey !== read.operation || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(this.moodleReadFailureCode(raw, `${read.prefix}_`, invalid));
    }
    const projected = projectMoodleSiteAdministrationBrowserResult(read, browser.data, {
      courseId: Number(target.courseId),
      roleId: target.roleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: { content: [{ type: "text", text: read.summary }], structuredContent: projected },
    });
  }

  private moodleSiteAdministrationReadEgress(value: JsonObject): MoodleSiteAdministrationRead | null {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (structured?.schema !== "morrow.result.v1" || result?.schema !== "morrow.result.v1"
      || !isJsonObject(result.data) || structured.tool !== result.tool) return null;
    return moodleSiteAdministrationReadByTool(structured.tool);
  }

  private publicMoodleSiteAdministrationReadEgress(
    read: MoodleSiteAdministrationRead,
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleSiteAdministrationTarget(request);
    if (!target) throw new Error(`${read.prefix}_request_invalid`);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!structured || !result || !isJsonObject(result.data)) throw new Error(`${read.prefix}_result_invalid`);
    const projected = projectMoodleSiteAdministrationBrowserResult(read, result.data, {
      courseId: Number(target.courseId),
      roleId: target.roleId,
    });
    const output = canonicalMorrowResult({
      tool: read.tool,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: { content: [{ type: "text", text: read.summary }], structuredContent: projected },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleLessonPageList(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_LESSON_PAGE_LIST_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private moodleLessonModuleTarget(
    request: Readonly<Record<string, unknown>>,
  ): { courseId: string; moduleId: number } | null {
    const courseId = this.requestCourseId(request);
    const moduleId = request.module_id;
    if (!courseId || !Number.isSafeInteger(Number(courseId))
      || typeof moduleId !== "number" || !Number.isSafeInteger(moduleId) || moduleId < 1) return null;
    return { courseId, moduleId };
  }

  /**
   * Re-validates the complete Lesson page graph before it leaves the runtime.
   * The projection recomputes every position, jump and branch target from the
   * pages themselves, so a browser result cannot report a graph its own pages
   * contradict. The list carries no page content.
   */
  private async publicMoodleLessonPageList(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleLessonModuleTarget(request);
    if (!target) throw new Error("moodle_lesson_pages_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_lesson_pages_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_LESSON_PAGE_LIST_TOOL
      || source.operationKey !== MOODLE_LESSON_PAGE_LIST_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_lesson_pages_invalid");
    }
    const pages = projectMoodleLessonPageListBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{
          type: "text",
          text: "Morrow read the complete Moodle Lesson page order with every jump resolved. It returned no page content.",
        }],
        structuredContent: pages,
      },
    });
  }

  private isMoodleLessonPage(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_LESSON_PAGE_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * Re-validates one exact Lesson page before it leaves the runtime, including
   * the draft-file and embedded-media refusal the browser reader applies, so a
   * page that carries a file reference is refused here as well.
   */
  private async publicMoodleLessonPage(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleLessonModuleTarget(request);
    const pageId = request.page_id;
    if (!target || typeof pageId !== "number" || !Number.isSafeInteger(pageId) || pageId < 1) {
      throw new Error("moodle_lesson_page_invalid");
    }
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_lesson_page_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_LESSON_PAGE_TOOL
      || source.operationKey !== MOODLE_LESSON_PAGE_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_lesson_page_invalid");
    }
    const page = projectMoodleLessonPageBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
      pageId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read one Moodle Lesson page with its answers, responses, scores and jumps." }],
        structuredContent: page,
      },
    });
  }

  private isMoodleScormAttemptSummary(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private moodleScormModuleTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; moduleId: number }> | null {
    const courseId = this.requestCourseId(request);
    const requestedModuleId = request.module_id;
    const moduleId = typeof requestedModuleId === "number" && Number.isSafeInteger(requestedModuleId)
      ? requestedModuleId
      : null;
    return courseId && moduleId !== null && moduleId > 0 && Number.isSafeInteger(Number(courseId))
      ? { courseId, moduleId }
      : null;
  }

  private moodleScormLearnerTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; moduleId: number; userId: number }> | null {
    const target = this.moodleScormModuleTarget(request);
    const requestedUserId = request.user_id;
    const userId = typeof requestedUserId === "number" && Number.isSafeInteger(requestedUserId)
      ? requestedUserId
      : null;
    return target && userId !== null && userId > 0 ? { ...target, userId } : null;
  }

  private async publicMoodleScormAttemptSummary(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleScormModuleTarget(request);
    if (!target) throw new Error("moodle_scorm_attempt_summary_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_scorm_attempt_summary_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL
      || source.operationKey !== MOODLE_SCORM_ATTEMPT_SUMMARY_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_scorm_attempt_summary_invalid");
    }
    const summary = projectMoodleScormAttemptSummaryBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle SCORM attempt summary." }],
        structuredContent: summary,
      },
    });
  }

  private isMoodleScormAttemptSummaryEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleScormAttemptSummaryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleScormModuleTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_scorm_attempt_summary_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_scorm_attempt_summary_result_invalid");
    const summary = projectMoodleScormAttemptSummaryBrowserResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_SCORM_ATTEMPT_SUMMARY_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle SCORM attempt summary." }],
        structuredContent: summary,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleScormLearnerReport(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_SCORM_LEARNER_REPORT_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The only Moodle SCORM read that names one learner. The browser result keeps
   * the Moodle user ID inside `learner`; this dispatch registers the complete
   * course roster first, then projects that identity to a vault token. An
   * identity that is not on the roster fails closed in the roster boundary, so
   * no report is returned for a user Morrow cannot place in this course.
   */
  private async publicMoodleScormLearnerReport(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleScormLearnerTarget(request);
    if (!target) throw new Error("moodle_scorm_learner_report_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_scorm_learner_report_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_SCORM_LEARNER_REPORT_TOOL
      || source.operationKey !== MOODLE_SCORM_LEARNER_REPORT_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_scorm_learner_report_invalid");
    }
    const bound = projectMoodleScormLearnerReportBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
      userId: target.userId,
    });
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const report = projectPublicMoodleScormLearnerReportResult(redactLearnerEgress(bound, learner) as JsonObject, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle SCORM tracking for one exact learner." }],
        structuredContent: report,
      },
    });
  }

  private isMoodleScormLearnerReportEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_SCORM_LEARNER_REPORT_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_SCORM_LEARNER_REPORT_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleScormLearnerReportEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleScormLearnerTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_scorm_learner_report_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_SCORM_LEARNER_REPORT_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_SCORM_LEARNER_REPORT_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_scorm_learner_report_result_invalid");
    // The public report carries a vault token and no Moodle user ID, so egress
    // proves the bounded report and the token shape, not the requested user.
    const report = projectPublicMoodleScormLearnerReportResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_SCORM_LEARNER_REPORT_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle SCORM tracking for one exact learner." }],
        structuredContent: report,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleGradeReportSummary(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_GRADE_REPORT_SUMMARY_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private moodleGradeReportCourseTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string }> | null {
    const courseId = this.requestCourseId(request);
    return courseId && Number.isSafeInteger(Number(courseId)) ? { courseId } : null;
  }

  private moodleLearnerGradeReportTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; userId: number }> | null {
    const target = this.moodleGradeReportCourseTarget(request);
    const requestedUserId = request.user_id;
    const userId = typeof requestedUserId === "number" && Number.isSafeInteger(requestedUserId)
      ? requestedUserId
      : null;
    return target && userId !== null && userId > 0 ? { ...target, userId } : null;
  }

  private async publicMoodleGradeReportSummary(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleGradeReportCourseTarget(request);
    if (!target) throw new Error("moodle_grade_report_summary_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_grade_report_summary_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_GRADE_REPORT_SUMMARY_TOOL
      || source.operationKey !== MOODLE_GRADE_REPORT_SUMMARY_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_grade_report_summary_invalid");
    }
    const summary = projectMoodleGradeReportSummaryBrowserResult(browser.data, { courseId: Number(target.courseId) });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle grader report for this course." }],
        structuredContent: summary,
      },
    });
  }

  private isMoodleGradeReportSummaryEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_GRADE_REPORT_SUMMARY_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_GRADE_REPORT_SUMMARY_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleGradeReportSummaryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleGradeReportCourseTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_grade_report_summary_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_GRADE_REPORT_SUMMARY_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_GRADE_REPORT_SUMMARY_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_grade_report_summary_result_invalid");
    const summary = projectMoodleGradeReportSummaryBrowserResult(result.data, { courseId: Number(target.courseId) });
    const output = canonicalMorrowResult({
      tool: MOODLE_GRADE_REPORT_SUMMARY_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current aggregate Moodle grader report for this course." }],
        structuredContent: summary,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleLearnerGradeReport(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_LEARNER_GRADE_REPORT_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The only Moodle gradebook read that names one learner and returns grade
   * values. The browser result keeps the Moodle user ID inside `learner`; this
   * dispatch registers the complete course roster first, then projects that
   * identity to a vault token. An identity that is not on the roster fails
   * closed in the roster boundary, so no grades are returned for a user Morrow
   * cannot place in this course.
   */
  private async publicMoodleLearnerGradeReport(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleLearnerGradeReportTarget(request);
    if (!target) throw new Error("moodle_learner_grade_report_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_learner_grade_report_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_LEARNER_GRADE_REPORT_TOOL
      || source.operationKey !== MOODLE_LEARNER_GRADE_REPORT_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_learner_grade_report_invalid");
    }
    const bound = projectMoodleLearnerGradeReportBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      userId: target.userId,
    });
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const report = projectPublicMoodleLearnerGradeReportResult(redactLearnerEgress(bound, learner) as JsonObject, {
      courseId: Number(target.courseId),
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle grader-report row for one exact learner." }],
        structuredContent: report,
      },
    });
  }

  private isMoodleLearnerGradeReportEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_LEARNER_GRADE_REPORT_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_LEARNER_GRADE_REPORT_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleLearnerGradeReportEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleLearnerGradeReportTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_learner_grade_report_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_LEARNER_GRADE_REPORT_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_LEARNER_GRADE_REPORT_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_learner_grade_report_result_invalid");
    // The public report carries a vault token and no Moodle user ID, so egress
    // proves the bounded report and the token shape, not the requested user.
    const report = projectPublicMoodleLearnerGradeReportResult(result.data, { courseId: Number(target.courseId) });
    const output = canonicalMorrowResult({
      tool: MOODLE_LEARNER_GRADE_REPORT_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle grader-report row for one exact learner." }],
        structuredContent: report,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private moodleParticipantCourseTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string }> | null {
    const courseId = this.requestCourseId(request);
    return courseId && Number.isSafeInteger(Number(courseId)) ? { courseId } : null;
  }

  private moodleParticipantLearnerTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; userId: number }> | null {
    const target = this.moodleParticipantCourseTarget(request);
    const requestedUserId = request.user_id;
    const userId = typeof requestedUserId === "number" && Number.isSafeInteger(requestedUserId)
      ? requestedUserId
      : null;
    return target && userId !== null && userId > 0 ? { ...target, userId } : null;
  }

  /**
   * The page world states its own reason when a participant read stops at a
   * bound or cannot see the enrolment column. That reason is the useful one, so
   * a connector problem carrying one of the operation's own codes is raised
   * unchanged. Anything else stays the generic refusal, and the codes here are
   * a fixed set the connector writes, never source text.
   */
  private moodleReadFailureCode(raw: JsonObject, prefix: string, fallback: string): string {
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const problem = source && isJsonObject(source.problem) ? source.problem : null;
    const message = problem && typeof problem.message === "string" ? problem.message : "";
    return message.startsWith(prefix) && /^[a-z0-9_]{1,120}$/u.test(message) ? message : fallback;
  }

  private isMoodleCourseParticipants(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_COURSE_PARTICIPANTS_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The bounded participant list of one course. The browser result keeps a
   * Moodle user ID for every row; this dispatch registers the complete course
   * roster first, then projects each of those identities to a vault token. One
   * row Morrow cannot place in this course fails the whole list closed, so a
   * participant list can never carry an identity the roster does not hold.
   */
  private async publicMoodleCourseParticipants(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleParticipantCourseTarget(request);
    if (!target) throw new Error("moodle_course_participants_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_course_participants_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_COURSE_PARTICIPANTS_TOOL
      || source.operationKey !== MOODLE_COURSE_PARTICIPANTS_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(this.moodleReadFailureCode(raw, "moodle_course_participants_", "moodle_course_participants_invalid"));
    }
    const bound = projectMoodleCourseParticipantsBrowserResult(browser.data, { courseId: Number(target.courseId) });
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const participants = projectPublicMoodleCourseParticipantsResult(redactLearnerEgress(bound, learner) as JsonObject, {
      courseId: Number(target.courseId),
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle participant list for this course." }],
        structuredContent: participants,
      },
    });
  }

  private isMoodleCourseParticipantsEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_COURSE_PARTICIPANTS_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_COURSE_PARTICIPANTS_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleCourseParticipantsEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleParticipantCourseTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_course_participants_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_COURSE_PARTICIPANTS_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_COURSE_PARTICIPANTS_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_course_participants_result_invalid");
    // The public list carries a vault token per row and no Moodle user ID, so
    // egress proves the bounded list and the token shape, not the identities.
    const participants = projectPublicMoodleCourseParticipantsResult(result.data, { courseId: Number(target.courseId) });
    const output = canonicalMorrowResult({
      tool: MOODLE_COURSE_PARTICIPANTS_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle participant list for this course." }],
        structuredContent: participants,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleEnrolmentMethods(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_ENROLMENT_METHODS_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private async publicMoodleEnrolmentMethods(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleParticipantCourseTarget(request);
    if (!target) throw new Error("moodle_enrolment_methods_invalid");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_enrolment_methods_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_ENROLMENT_METHODS_TOOL
      || source.operationKey !== MOODLE_ENROLMENT_METHODS_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(this.moodleReadFailureCode(raw, "moodle_enrolment_methods_", "moodle_enrolment_methods_invalid"));
    }
    const methods = projectMoodleEnrolmentMethodsBrowserResult(browser.data, { courseId: Number(target.courseId) });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle enrolment methods for this course." }],
        structuredContent: methods,
      },
    });
  }

  private isMoodleEnrolmentMethodsEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_ENROLMENT_METHODS_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_ENROLMENT_METHODS_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleEnrolmentMethodsEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleParticipantCourseTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_enrolment_methods_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_ENROLMENT_METHODS_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_ENROLMENT_METHODS_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_enrolment_methods_result_invalid");
    const methods = projectMoodleEnrolmentMethodsBrowserResult(result.data, { courseId: Number(target.courseId) });
    const output = canonicalMorrowResult({
      tool: MOODLE_ENROLMENT_METHODS_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle enrolment methods for this course." }],
        structuredContent: methods,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleParticipantEnrolment(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_PARTICIPANT_ENROLMENT_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  private async publicMoodleParticipantEnrolment(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleParticipantLearnerTarget(request);
    if (!target) throw new Error("moodle_participant_enrolment_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_participant_enrolment_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_PARTICIPANT_ENROLMENT_TOOL
      || source.operationKey !== MOODLE_PARTICIPANT_ENROLMENT_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error(this.moodleReadFailureCode(raw, "moodle_participant_enrolment_", "moodle_participant_enrolment_invalid"));
    }
    const bound = projectMoodleParticipantEnrolmentBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      userId: target.userId,
    });
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const record = projectPublicMoodleParticipantEnrolmentResult(redactLearnerEgress(bound, learner) as JsonObject, {
      courseId: Number(target.courseId),
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle enrolment record for one exact learner." }],
        structuredContent: record,
      },
    });
  }

  private isMoodleParticipantEnrolmentEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_PARTICIPANT_ENROLMENT_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_PARTICIPANT_ENROLMENT_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleParticipantEnrolmentEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleParticipantLearnerTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_participant_enrolment_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_PARTICIPANT_ENROLMENT_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_PARTICIPANT_ENROLMENT_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_participant_enrolment_result_invalid");
    const record = projectPublicMoodleParticipantEnrolmentResult(result.data, { courseId: Number(target.courseId) });
    const output = canonicalMorrowResult({
      tool: MOODLE_PARTICIPANT_ENROLMENT_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle enrolment record for one exact learner." }],
        structuredContent: record,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private moodleAssignmentLearnerTarget(
    request: Readonly<Record<string, unknown>>,
  ): Readonly<{ courseId: string; moduleId: number; userId: number }> | null {
    const courseId = this.requestCourseId(request);
    const moduleId = typeof request.module_id === "number" && Number.isSafeInteger(request.module_id) ? request.module_id : null;
    const userId = typeof request.user_id === "number" && Number.isSafeInteger(request.user_id) ? request.user_id : null;
    return courseId && Number.isSafeInteger(Number(courseId)) && moduleId !== null && moduleId > 0 && userId !== null && userId > 0
      ? { courseId, moduleId, userId }
      : null;
  }

  private isMoodleAssignmentSubmission(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_ASSIGNMENT_SUBMISSION_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /**
   * The Moodle Assignment read that names one learner. The browser result keeps
   * the Moodle user ID inside `learner`; this dispatch registers the complete
   * course roster first, then projects that identity to a vault token. An
   * identity that is not on the roster fails closed in the roster boundary, so
   * no submission record is returned for a user Morrow cannot place in this
   * course.
   */
  private async publicMoodleAssignmentSubmission(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleAssignmentLearnerTarget(request);
    if (!target) throw new Error("moodle_assignment_submission_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_assignment_submission_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_ASSIGNMENT_SUBMISSION_TOOL
      || source.operationKey !== MOODLE_ASSIGNMENT_SUBMISSION_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_assignment_submission_invalid");
    }
    const bound = projectMoodleAssignmentSubmissionBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
      userId: target.userId,
    });
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const record = projectPublicMoodleAssignmentSubmissionResult(redactLearnerEgress(bound, learner) as JsonObject, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Assignment submission record for one exact learner." }],
        structuredContent: record,
      },
    });
  }

  private isMoodleAssignmentSubmissionEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_ASSIGNMENT_SUBMISSION_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_ASSIGNMENT_SUBMISSION_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleAssignmentSubmissionEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleAssignmentLearnerTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_assignment_submission_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_ASSIGNMENT_SUBMISSION_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_ASSIGNMENT_SUBMISSION_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_assignment_submission_result_invalid");
    // The public record carries a vault token and no Moodle user ID, so egress
    // proves the bounded record and the token shape, not the requested user.
    const record = projectPublicMoodleAssignmentSubmissionResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_ASSIGNMENT_SUBMISSION_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Assignment submission record for one exact learner." }],
        structuredContent: record,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isMoodleAssignmentFeedback(mapping: CatalogTool): boolean {
    return mapping.upstreamName === MOODLE_ASSIGNMENT_FEEDBACK_TOOL
      && mapping.annotations?.readOnlyHint === true
      && mapping.capability?.provider === "moodle"
      && isCanvasConnector(mapping);
  }

  /** The grading half of the same learner boundary as the submission read above. */
  private async publicMoodleAssignmentFeedback(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const target = this.moodleAssignmentLearnerTarget(request);
    if (!target) throw new Error("moodle_assignment_feedback_invalid");
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    if (binding.courseId !== target.courseId) throw new Error("moodle_assignment_feedback_invalid");
    const source = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    const browser = source && isJsonObject(source.result) ? source.result : null;
    if (!source || source.schema !== "morrow.canvas-connector.result.v1" || source.ok !== true
      || source.provider !== "moodle" || source.toolName !== MOODLE_ASSIGNMENT_FEEDBACK_TOOL
      || source.operationKey !== MOODLE_ASSIGNMENT_FEEDBACK_OPERATION || source.commandKind !== "invoke_read"
      || !browser || browser.schema !== "morrow.canvas-browser-result.v1" || browser.ok !== true
      || browser.sent !== false || browser.provider !== "moodle" || browser.complete !== true
      || !isJsonObject(browser.data) || typeof browser.snapshot_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(browser.snapshot_digest)) {
      throw new Error("moodle_assignment_feedback_invalid");
    }
    const bound = projectMoodleAssignmentFeedbackBrowserResult(browser.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
      userId: target.userId,
    });
    const learner = await this.moodleLearnerContextForBinding(mapping, sourceBindingId, target.courseId, binding, options);
    const record = projectPublicMoodleAssignmentFeedbackResult(redactLearnerEgress(bound, learner) as JsonObject, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    return canonicalMorrowResult({
      tool: mapping.publicName,
      backend: mapping.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Assignment grading and feedback record for one exact learner." }],
        structuredContent: record,
      },
    });
  }

  private isMoodleAssignmentFeedbackEgress(value: JsonObject): boolean {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    return structured?.schema === "morrow.result.v1"
      && structured.tool === MOODLE_ASSIGNMENT_FEEDBACK_TOOL
      && result?.schema === "morrow.result.v1"
      && result.tool === MOODLE_ASSIGNMENT_FEEDBACK_TOOL
      && isJsonObject(result.data);
  }

  private publicMoodleAssignmentFeedbackEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const target = this.moodleAssignmentLearnerTarget(request);
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const result = structured && isJsonObject(structured.data) ? structured.data : null;
    if (!target) throw new Error("moodle_assignment_feedback_request_invalid");
    if (!structured || structured.schema !== "morrow.result.v1" || structured.tool !== MOODLE_ASSIGNMENT_FEEDBACK_TOOL
      || !result || result.schema !== "morrow.result.v1" || result.tool !== MOODLE_ASSIGNMENT_FEEDBACK_TOOL
      || !isJsonObject(result.data)) throw new Error("moodle_assignment_feedback_result_invalid");
    const record = projectPublicMoodleAssignmentFeedbackResult(result.data, {
      courseId: Number(target.courseId),
      moduleId: target.moduleId,
    });
    const output = canonicalMorrowResult({
      tool: MOODLE_ASSIGNMENT_FEEDBACK_TOOL,
      backend: typeof structured.backend === "string" ? structured.backend : "gateway",
      phase: "read",
      verificationStatus: "not_applicable",
      result: {
        content: [{ type: "text", text: "Morrow read the current Moodle Assignment grading and feedback record for one exact learner." }],
        structuredContent: record,
      },
    });
    const meta = isJsonObject(value._meta) && isJsonObject(value._meta["io.morrow/gateway"])
      ? value._meta["io.morrow/gateway"]
      : null;
    if (meta) output._meta = { "io.morrow/gateway": structuredClone(meta) };
    return output;
  }

  private isBrowserEditOptions(mapping: CatalogTool): boolean {
    return mapping.upstreamName === "morrow_browser_edit_options"
      && mapping.annotations?.readOnlyHint === true
      // The connector exposes this source-owned metadata tool without a
      // catalog capability annotation, so its merged route is generic.
      && this.catalog.tools.some((candidate) => candidate.upstreamId === mapping.upstreamId && isCanvasConnector(candidate));
  }

  private isBrowserBindings(mapping: CatalogTool): boolean {
    return mapping.upstreamName === "morrow_browser_bindings"
      && this.catalog.tools.some((candidate) => candidate.upstreamId === mapping.upstreamId && isCanvasConnector(candidate));
  }

  private publicBrowserBindingIdentity(binding: BridgeBinding): JsonObject {
    return {
      sourceBindingId: binding.sourceBindingId,
      provider: binding.provider,
      ...(binding.courseId ? { courseId: binding.courseId } : {}),
      ...(binding.origin ? { origin: binding.origin } : {}),
      ...(binding.siteUrl ? { siteUrl: binding.siteUrl } : {}),
      ...(binding.principalFingerprint ? { principalFingerprint: binding.principalFingerprint } : {}),
      ...(binding.sessionGeneration !== undefined ? { sessionGeneration: binding.sessionGeneration } : {}),
      ...(binding.catalogDigest ? { catalogDigest: binding.catalogDigest } : {}),
      ...(binding.editPolicyRevision !== undefined ? { editPolicyRevision: binding.editPolicyRevision } : {}),
      ...(binding.editOptionsAvailable ? { editOptionsAvailable: true } : {}),
      runtimeVerified: binding.runtimeVerified,
    };
  }

  private async publicBrowserBindingMetadata(
    mapping: CatalogTool,
    binding: BridgeBinding,
    options: { readonly signal?: AbortSignal },
  ): Promise<JsonObject> {
    const output = this.publicBrowserBindingIdentity(binding);
    if (!binding.courseName || !binding.courseId || binding.runtimeVerified !== true) return output;
    const sourceBindingId = binding.sourceBindingId;
    const bindingObject = binding as unknown as JsonObject;
    try {
      const context = binding.provider === "canvas"
        ? await this.canvasLearnerContextForBinding(mapping, sourceBindingId, binding.courseId, bindingObject, options)
        : binding.provider === "moodle"
          ? await this.moodleLearnerContextForBinding(mapping, sourceBindingId, binding.courseId, bindingObject, options)
          : undefined;
      if (!context) return output;
      const courseName = redactLearnerEgress(binding.courseName, context);
      if (typeof courseName !== "string") throw new Error("privacy_browser_bindings_invalid");
      output.courseName = courseName;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // A connection id remains usable without free-text metadata. Do not
      // combine rosters or surface an unredacted name from another scope.
    }
    return output;
  }

  private async publicBrowserBindings(
    mapping: CatalogTool,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const content = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    if (raw.isError === true || !content || content.schema !== "morrow.browser-bindings.v1"
      || content.ok !== true || !Array.isArray(content.bindings)
      || !Number.isSafeInteger(content.count) || Number(content.count) !== content.bindings.length) {
      throw new Error("privacy_browser_bindings_invalid");
    }
    let bindings: readonly BridgeBinding[];
    try {
      bindings = normalizeBridgeBindings(content.bindings);
    } catch {
      throw new Error("privacy_browser_bindings_invalid");
    }
    const projected = await mapBounded(bindings, MAX_BROWSER_BINDING_EGRESS_CONTEXTS, async (binding) => (
      this.publicBrowserBindingMetadata(mapping, binding, options)
    ));
    return this.resultArtifacts.bound({
      content: [{ type: "text", text: "Morrow read the current browser course connections." }],
      structuredContent: {
        schema: "morrow.browser-bindings.v1",
        ok: true,
        count: projected.length,
        bindings: projected,
      },
    });
  }

  /**
   * The Edit-options source call addresses a binding directly. It cannot use
   * verifiedBrowserBinding because it intentionally has no course_id input.
   */
  private async verifiedBrowserBindingBySource(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    if (!this.catalog.tools.some((candidate) => candidate.upstreamId === mapping.upstreamId && isCanvasConnector(candidate))) {
      throw new Error("learner_roster_source_unavailable");
    }
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) throw new Error("learner_roster_binding_unavailable");
    const bindingTool = this.browserBindingsTool(mapping);
    if (!bindingTool) throw new Error("learner_roster_source_unavailable");
    const bindings = await this.callSourceOwned(bindingTool.publicName, {}, options);
    if (bindings.isError === true) throw new Error("learner_roster_binding_unavailable");
    const matches = browserBindingContent(bindings).filter((binding) => {
      const provider = this.exactString(binding.provider, 30);
      return binding.runtimeVerified === true
        && binding.sourceBindingId === sourceBindingId
        && (provider === "canvas" || provider === "moodle" || provider === "blackboard")
        && this.exactString(binding.courseId, 160) !== null
        && typeof binding.origin === "string"
        && /^https:\/\//u.test(binding.origin)
        && typeof binding.principalFingerprint === "string"
        && /^[a-f0-9]{64}$/u.test(binding.principalFingerprint)
        && Number.isSafeInteger(binding.sessionGeneration)
        && Number(binding.sessionGeneration) >= 1
        && typeof binding.catalogDigest === "string"
        && /^[a-f0-9]{64}$/u.test(binding.catalogDigest)
        && Number.isSafeInteger(binding.editPolicyRevision)
        && Number(binding.editPolicyRevision) >= 0;
    });
    if (matches.length !== 1) throw new Error("learner_roster_binding_unavailable");
    return matches[0]!;
  }

  private canonicalBrowserEditOptions(
    binding: JsonObject,
    value: unknown,
    expectedSourceBindingId: string,
  ): JsonObject {
    const options = normalizeBridgeEditOptionsResult(value, expectedSourceBindingId);
    const bindingPermission = isJsonObject(binding.editPermission) ? binding.editPermission : null;
    const detailPermission = options.editPermission as unknown as JsonObject | undefined;
    if (options.runtimeVerified !== true
      || options.provider !== binding.provider
      || options.catalogDigest !== binding.catalogDigest
      || options.policyRevision !== binding.editPolicyRevision
      || Boolean(bindingPermission) !== Boolean(detailPermission)) {
      throw new Error("learner_roster_binding_unavailable");
    }
    if (bindingPermission && detailPermission) {
      const fields = ["schema", "revision", "scopeDigest", "catalogDigest", "sourceBindingId", "expiresAt"] as const;
      if (fields.some((field) => bindingPermission[field] !== detailPermission[field])
        || detailPermission.catalogDigest !== options.catalogDigest) {
        throw new Error("learner_roster_binding_unavailable");
      }
    }
    return options as unknown as JsonObject;
  }

  private async publicBrowserEditOptions(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const sourceBindingId = this.requestSourceBindingId(request);
    const structured = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    if (raw.isError === true || !sourceBindingId || !structured) {
      throw new Error("learner_roster_binding_unavailable");
    }
    const binding = await this.verifiedBrowserBindingBySource(mapping, request, options);
    const publicOptions = this.canonicalBrowserEditOptions(binding, structured, sourceBindingId);
    return this.resultArtifacts.bound({
      content: [{ type: "text", text: "Morrow read the available Edit actions for this saved browser connection." }],
      structuredContent: publicOptions,
    });
  }

  private async verifiedBrowserBinding(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
    expectedProvider?: "canvas" | "moodle",
  ): Promise<JsonObject> {
    if (!isCanvasConnector(mapping)) throw new Error("learner_roster_source_unavailable");
    const bindingTool = this.browserBindingsTool(mapping);
    if (!bindingTool) throw new Error("learner_roster_source_unavailable");
    const bindings = await this.callSourceOwned(bindingTool.publicName, {}, options);
    if (bindings.isError === true) throw new Error("learner_roster_binding_unavailable");
    return this.matchVerifiedBrowserBinding(browserBindingContent(bindings), request, expectedProvider);
  }

  private matchVerifiedBrowserBinding(
    bindings: readonly JsonObject[],
    request: Readonly<Record<string, unknown>>,
    expectedProvider?: "canvas" | "moodle",
  ): JsonObject {
    const sourceBindingId = this.requestSourceBindingId(request);
    const courseId = this.requestCourseId(request);
    if (!sourceBindingId || !courseId) throw new Error("learner_roster_binding_unavailable");
    const matches = bindings.filter((binding) => {
      const provider = this.exactString(binding.provider, 30);
      return binding.runtimeVerified === true
        && binding.sourceBindingId === sourceBindingId
        && binding.courseId === courseId
        && (provider === "canvas" || provider === "moodle")
        && (!expectedProvider || provider === expectedProvider)
        && typeof binding.origin === "string"
        && /^https:\/\//u.test(binding.origin)
        && typeof binding.principalFingerprint === "string"
        && /^[a-f0-9]{64}$/u.test(binding.principalFingerprint)
        && Number.isSafeInteger(binding.sessionGeneration)
        && Number(binding.sessionGeneration) >= 1
        && typeof binding.catalogDigest === "string"
        && /^[a-f0-9]{64}$/u.test(binding.catalogDigest);
    });
    if (matches.length !== 1) throw new Error("learner_roster_binding_unavailable");
    return matches[0]!;
  }

  private canvasBindingScope(binding: JsonObject, sourceBindingId: string, courseId: string): LearnerScope | null {
    const provider = this.exactString(binding.provider, 30);
    const bindingId = this.exactString(binding.sourceBindingId, 160);
    const boundCourse = this.exactString(binding.courseId, 30);
    const origin = this.exactString(binding.origin, 500);
    const principalFingerprint = this.exactString(binding.principalFingerprint, 500);
    const sessionGeneration = binding.sessionGeneration;
    if (provider !== "canvas" || binding.runtimeVerified !== true || bindingId !== sourceBindingId
      || boundCourse !== courseId || !origin || !principalFingerprint
      || !Number.isSafeInteger(sessionGeneration) || Number(sessionGeneration) < 0) return null;
    return {
      canvasOrigin: origin,
      account: sourceBindingId,
      course: courseId,
      principal: `${principalFingerprint}:${sessionGeneration}`,
      profile: this.config.profile,
    };
  }

  private moodleBindingScope(binding: JsonObject, sourceBindingId: string, courseId: string): LearnerScope | null {
    const provider = this.exactString(binding.provider, 30);
    const bindingId = this.exactString(binding.sourceBindingId, 160);
    const boundCourse = this.exactString(binding.courseId, 30);
    const origin = this.exactString(binding.origin, 500);
    const siteUrl = this.exactString(binding.siteUrl, 500);
    const principalFingerprint = this.exactString(binding.principalFingerprint, 500);
    const sessionGeneration = binding.sessionGeneration;
    if (provider !== "moodle" || binding.runtimeVerified !== true || bindingId !== sourceBindingId
      || boundCourse !== courseId || !origin || !siteUrl || !principalFingerprint
      || !Number.isSafeInteger(sessionGeneration) || Number(sessionGeneration) < 0) return null;
    try {
      const site = new URL(siteUrl);
      if (site.protocol !== "https:" || site.origin !== origin || site.search || site.hash || site.username || site.password) return null;
    } catch {
      return null;
    }
    return {
      canvasOrigin: siteUrl,
      account: sourceBindingId,
      course: courseId,
      principal: `${principalFingerprint}:${sessionGeneration}`,
      profile: this.config.profile,
    };
  }

  private hasLearnerToken(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((candidate) => this.hasLearnerToken(candidate));
    if (!isJsonObject(value)) return false;
    return Object.entries(value).some(([key, candidate]) => (
      key === "learner_token" || key === "learnerToken" || this.hasLearnerToken(candidate)
    ));
  }

  private rosterIdentities(value: unknown): readonly LearnerIdentity[] {
    if (!Array.isArray(value)) throw new Error("learner_roster_result_invalid");
    return value.map((candidate) => {
      if (!isJsonObject(candidate)) throw new Error("learner_roster_result_invalid");
      const id = candidate.id;
      if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim()) {
        throw new Error("learner_roster_result_invalid");
      }
      const text = (field: string): string | undefined => {
        const raw = candidate[field];
        return typeof raw === "string" && raw.trim() && raw.trim().length <= 500 ? raw.trim() : undefined;
      };
      return normalizeLearnerIdentity({
        id: String(id),
        ...(text("name") ? { name: text("name") } : {}),
        ...(text("email") ? { email: text("email") } : {}),
        ...(text("login_id") ? { loginId: text("login_id") } : {}),
        ...(text("sis_user_id") ? { sisUserId: text("sis_user_id") } : {}),
      });
    });
  }

  private completeCanvasRoster(result: JsonObject): readonly LearnerIdentity[] {
    const content = isJsonObject(result.structuredContent) ? result.structuredContent : null;
    const browser = content && content.schema === "morrow.canvas-connector.result.v1" && isJsonObject(content.result)
      ? content.result
      : null;
    if (!browser || content!.ok !== true || content!.commandKind !== "invoke_read"
      || browser.ok !== true || browser.sent !== true || browser.truncated !== false) {
      throw new Error("learner_roster_result_incomplete");
    }
    return this.rosterIdentities(browser.data);
  }

  private completeMoodleRoster(result: JsonObject, binding: JsonObject): readonly LearnerIdentity[] {
    const content = isJsonObject(result.structuredContent) ? result.structuredContent : null;
    const browser = content && content.schema === "morrow.canvas-connector.result.v1" && isJsonObject(content.result)
      ? content.result
      : null;
    if (!browser || content!.ok !== true || content!.commandKind !== "invoke_read"
      || browser.schema !== "morrow.moodle-browser-result.v1" || browser.ok !== true
      || browser.sent !== true || !isJsonObject(browser.data)
      || browser.data.schema !== "morrow.moodle-course-roster.v1") {
      throw new Error("learner_roster_source_unavailable");
    }
    if (browser.truncated !== false) {
      throw new Error("learner_roster_result_incomplete");
    }
    const roster = browser.data;
    const expected = ["sourceBindingId", "courseId", "origin", "siteUrl", "principalFingerprint", "sessionGeneration", "catalogDigest"] as const;
    if (roster.schema !== "morrow.moodle-course-roster.v1" || roster.status !== "complete" || roster.complete !== true
      || expected.some((field) => roster[field] !== binding[field])) {
      throw new Error("learner_roster_result_mismatch");
    }
    return this.rosterIdentities(roster.identities);
  }

  private async canvasLearnerContext(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LearnerTextRedactionContext | undefined> {
    if (!isCanvasConnector(mapping) || mapping.capability?.provider !== "canvas") return undefined;
    const sourceBindingId = this.requestSourceBindingId(request);
    const requestedCourseId = this.requestCourseId(request);
    if (!sourceBindingId || !requestedCourseId) return undefined;
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "canvas");
    return this.canvasLearnerContextForBinding(
      mapping,
      sourceBindingId,
      requestedCourseId,
      binding,
      options,
    );
  }

  private async canvasLearnerContextForBinding(
    mapping: CatalogTool,
    sourceBindingId: string,
    requestedCourseId: string,
    binding: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LearnerTextRedactionContext> {
    const rosterTool = this.canvasRosterTool(mapping);
    if (!rosterTool) throw new Error("learner_roster_source_unavailable");
    const scope = this.canvasBindingScope(binding, sourceBindingId, requestedCourseId);
    if (!scope) throw new Error("learner_roster_binding_unavailable");
    const roster = await this.callSourceOwned(rosterTool.publicName, {
      course_id: scope.course,
      enrollment_type: ["student"],
      enrollment_state: ["active", "invited", "completed", "inactive"],
      morrow_max_pages: 50,
      _morrow: { source_binding_id: sourceBindingId },
    }, options);
    if (roster.isError === true) throw new Error("learner_roster_result_incomplete");
    // Register only after the source supplied a complete, validated roster.
    this.learnerRoster.register(scope, this.completeCanvasRoster(roster));
    return { learnerRoster: this.learnerRoster, learnerVault: this.learnerVault, learnerScope: scope };
  }

  private async moodleLearnerContext(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LearnerTextRedactionContext | undefined> {
    if (!isCanvasConnector(mapping)) return undefined;
    const sourceBindingId = this.requestSourceBindingId(request);
    const requestedCourseId = this.requestCourseId(request);
    if (!sourceBindingId || !requestedCourseId) return undefined;
    const binding = await this.verifiedBrowserBinding(mapping, request, options, "moodle");
    return this.moodleLearnerContextForBinding(mapping, sourceBindingId, requestedCourseId, binding, options);
  }

  private async moodleLearnerContextForBinding(
    mapping: CatalogTool,
    sourceBindingId: string,
    requestedCourseId: string,
    binding: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LearnerTextRedactionContext> {
    const rosterTool = this.moodleRosterTool(mapping);
    if (!rosterTool) throw new Error("learner_roster_source_unavailable");
    const scope = this.moodleBindingScope(binding, sourceBindingId, requestedCourseId);
    if (!scope) throw new Error("learner_roster_binding_unavailable");
    const roster = await this.callSourceOwned(rosterTool.publicName, {
      course_id: Number(scope.course),
      _morrow: { source_binding_id: sourceBindingId },
    }, options);
    if (roster.isError === true) throw new Error("learner_roster_result_incomplete");
    this.learnerRoster.register(scope, this.completeMoodleRoster(roster, binding));
    return { learnerRoster: this.learnerRoster, learnerVault: this.learnerVault, learnerScope: scope };
  }

  private privacyContext(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    learner: LearnerTextRedactionContext | undefined,
  ) {
    const course = this.requestCourseId(request);
    return {
      descriptor: this.outputPrivacy(mapping),
      learnerVault: this.learnerVault,
      // The Blackboard Learn REST source holds its course roster inside its own
      // process and returns learner tokens, never learner identities. Morrow's
      // roster boundary is a browser-session one: it has no binding for this
      // source and can register no roster for it, so requiring one here would
      // refuse every Blackboard result instead of protecting one.
      // `scopedNativeEgress` states the same for the MCP boundary.
      ...(mapping.upstreamId === "blackboard-rest" ? { learnerBoundary: "source" as const } : {}),
      ...(learner ? { learnerRoster: learner.learnerRoster, learnerScope: learner.learnerScope } : {
        learnerScope: {
          canvasOrigin: this.config.privacy.canvasOrigin,
          account: this.config.privacy.account,
          course: course || "unbound",
          principal: this.config.privacy.principal,
          profile: this.config.profile,
        },
      }),
      artifacts: this.artifacts,
    };
  }

  private privacyFailure(error: unknown): JsonObject {
    const code = error instanceof Error && (/^learner_roster_|^privacy_|^moodle_assignment_submission_summary_|^moodle_quiz_attempt_summary_|^moodle_quiz_attempt_|^moodle_quiz_manual_grading_queue_|^moodle_quiz_regrade_report_|^moodle_forum_activity_summary_|^moodle_scorm_attempt_summary_|^moodle_scorm_learner_report_|^moodle_grade_report_summary_|^moodle_learner_grade_report_|^moodle_course_participants_|^moodle_enrolment_methods_|^moodle_participant_enrolment_|^moodle_question_bank_impact_scope_|^moodle_course_activity_report_|^moodle_course_participation_report_|^moodle_course_completion_report_|^moodle_course_log_summary_|^moodle_course_dates_report_/u.test(error.message))
      ? error.message
      : "privacy_output_refused";
    return {
      content: [{ type: "text", text: "Morrow did not return this result because its learner privacy boundary could not be established." }],
      isError: true,
      structuredContent: { schema: "morrow.problem.v1", code },
    };
  }

  private async publicSourceResult(
    mapping: CatalogTool,
    request: Readonly<Record<string, unknown>>,
    raw: JsonObject,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const rawMeta = isJsonObject(raw._meta) ? raw._meta : null;
    const operationMeta = rawMeta && isJsonObject(rawMeta["io.morrow/gateway"])
      ? rawMeta["io.morrow/gateway"]
      : null;
    const rawProblem = isJsonObject(raw.structuredContent) ? raw.structuredContent : null;
    // This result is generated before any source call. Rebuild it from the
    // gateway's fixed fields so ordinary cancellation retains its safe state.
    if (options.signal?.aborted && raw.isError === true
      && rawProblem?.schema === "morrow.problem.v1"
      && rawProblem.code === "request_cancelled_before_dispatch") {
      return {
        content: [{ type: "text", text: `Morrow cancelled ${mapping.publicName} before source dispatch.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "request_cancelled_before_dispatch",
          recoverable: true,
        },
        ...(operationMeta ? { _meta: { "io.morrow/gateway": structuredClone(operationMeta) } } : {}),
      };
    }
    try {
      if (this.isBrowserBindings(mapping)) {
        return await this.publicBrowserBindings(mapping, raw, options);
      }
      if (this.isBrowserEditOptions(mapping)) {
        return await this.publicBrowserEditOptions(mapping, request, raw, options);
      }
      if (this.isCanvasClassicQuizSubmissionSummary(mapping)) {
        const projected = await this.publicCanvasClassicQuizSubmissionSummary(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return projected;
      }
      const courseSummaryRoute = this.canvasCourseSummaryRouteFor(mapping);
      if (courseSummaryRoute) {
        const projected = await this.publicCanvasCourseSummary(courseSummaryRoute, mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleAssignmentSubmissionSummary(mapping)) {
        const projected = await this.publicMoodleAssignmentSubmissionSummary(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleAssignmentSubmission(mapping)) {
        const projected = await this.publicMoodleAssignmentSubmission(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleAssignmentFeedback(mapping)) {
        const projected = await this.publicMoodleAssignmentFeedback(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleQuizAttemptSummary(mapping)) {
        const projected = await this.publicMoodleQuizAttemptSummary(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleQuizAttempt(mapping)) {
        const projected = await this.publicMoodleQuizAttempt(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleQuizManualGradingQueue(mapping)) {
        const projected = await this.publicMoodleQuizManualGradingQueue(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleQuizRegradeReport(mapping)) {
        const projected = await this.publicMoodleQuizRegradeReport(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleQuestionBankImpactScope(mapping)) {
        const projected = await this.publicMoodleQuestionBankImpactScope(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleLessonPageList(mapping)) {
        const projected = await this.publicMoodleLessonPageList(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleLessonPage(mapping)) {
        const projected = await this.publicMoodleLessonPage(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      const activityContentRead = this.moodleActivityContentRead(mapping);
      if (activityContentRead) {
        const projected = await this.publicMoodleActivityContentRead(activityContentRead, mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleScormAttemptSummary(mapping)) {
        const projected = await this.publicMoodleScormAttemptSummary(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleScormLearnerReport(mapping)) {
        const projected = await this.publicMoodleScormLearnerReport(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleGradeReportSummary(mapping)) {
        const projected = await this.publicMoodleGradeReportSummary(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleLearnerGradeReport(mapping)) {
        const projected = await this.publicMoodleLearnerGradeReport(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleCourseParticipants(mapping)) {
        const projected = await this.publicMoodleCourseParticipants(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleEnrolmentMethods(mapping)) {
        const projected = await this.publicMoodleEnrolmentMethods(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleParticipantEnrolment(mapping)) {
        const projected = await this.publicMoodleParticipantEnrolment(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      const courseReportRead = this.moodleCourseReportRead(mapping);
      if (courseReportRead) {
        const projected = await this.publicMoodleCourseReportRead(courseReportRead, mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      const siteAdministrationRead = this.moodleSiteAdministrationRead(mapping);
      if (siteAdministrationRead) {
        const projected = await this.publicMoodleSiteAdministrationRead(siteAdministrationRead, mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      if (this.isMoodleForumActivitySummary(mapping)) {
        const projected = await this.publicMoodleForumActivitySummary(mapping, request, raw, options);
        if (operationMeta) {
          projected._meta = {
            ...(isJsonObject(projected._meta) ? projected._meta : {}),
            "io.morrow/gateway": structuredClone(operationMeta),
          };
        }
        return this.resultArtifacts.bound(projected);
      }
      const learner = mapping.capability?.provider === "moodle"
        ? await this.moodleLearnerContext(mapping, request, options)
        : await this.canvasLearnerContext(mapping, request, options);
      if (isCanvasConnector(mapping) && !learner) throw new Error("learner_roster_binding_unavailable");
      const normalized = normalizeUpstreamResult(raw, {
        mapping,
        catalogDigest: this.catalog.digest,
        privacy: this.privacyContext(mapping, request, learner),
      });
      if (operationMeta) {
        normalized._meta = {
          ...(isJsonObject(normalized._meta) ? normalized._meta : {}),
          "io.morrow/gateway": structuredClone(operationMeta),
        };
      }
      return this.resultArtifacts.bound(normalized, learner
        ? (value) => redactLearnerEgress(value, learner) as JsonObject
        : undefined);
    } catch (error) {
      return this.privacyFailure(error);
    }
  }

  /** The frozen source tool one saved operation was planned for, while that record exists. */
  private frozenOperationToolName(operationId: string | null): string | null {
    if (!operationId?.startsWith("op:")) return null;
    try {
      return this.effects.get(operationId).publicToolName;
    } catch {
      return null;
    }
  }

  /**
   * Final native-tool boundary. Native handlers can keep raw Canvas evidence
   * while they validate it, but must use this method before MCP serializes it.
   */
  private egressRequest(request: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    if (this.requestSourceBindingId(request)) return request;
    const operationId = this.exactString(request.operation_id ?? request.operationId, 160);
    if (!operationId?.startsWith("op:")) return request;
    try {
      const operation = this.effects.get(operationId);
      return isJsonObject(operation.plan.arguments) ? operation.plan.arguments : request;
    } catch {
      return request;
    }
  }

  private strictNativeEgress(value: unknown, depth = 0, allowBlackboardReferences = false): unknown {
    if (depth > 12) return "[redacted]";
    if (typeof value === "string") {
      return /(?:bearer\s+|cookie=|csrf|token=|(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|<[^>]+(?:hidden|display\s*:\s*none))/iu.test(value)
        ? "[redacted]"
        : value;
    }
    if (Array.isArray(value)) return value.map((entry) => this.strictNativeEgress(entry, depth + 1, allowBlackboardReferences));
    if (!isJsonObject(value)) return value;
    const normalizedKeys = new Set(Object.keys(value).map((key) => key.normalize("NFKC").replace(/[\s_-]/gu, "").toLocaleLowerCase("en-US")));
    const identityLike = (
      ["email", "primaryemail", "loginid", "sisuserid", "sispersonid", "pseudonymid", "avatarimageurl"].some((key) => normalizedKeys.has(key))
      && ["id", "userid", "learnerid", "studentid", "canvasuserid", "name", "displayname", "fullname", "studentname"].some((key) => normalizedKeys.has(key))
    );
    if (identityLike) return "[redacted]";
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.normalize("NFKC").replace(/[\s_-]/gu, "").toLocaleLowerCase("en-US");
      if (/^(?:authorization|bearer|accesstoken|refreshtoken|csrf|cookie|secret|credential|jwt)$/u.test(normalized)
        || PRIVATE_EGRESS_FIELD_KEYS.has(normalized)
        || ["email", "primaryemail", "loginid", "sisuserid", "sispersonid", "pseudonymid"].includes(normalized)) continue;
      if (normalized === "blob" && typeof child === "string") {
        throw new Error("privacy_resource_blob_refused");
      }
      if (["learner", "learners", "student", "students", "user", "users", "person", "people", "enrollment", "enrollments", "submission", "submissions", "gradebook", "recipients", "members"].includes(normalized)) {
        if (allowBlackboardReferences && ["learners", "members"].includes(normalized) && Array.isArray(child)
          && child.every((entry) => isJsonObject(entry)
            && typeof entry.learnerToken === "string" && /^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.learnerToken)
            && Object.keys(entry).every((field) => ["learnerToken", "courseRoleId", "availability"].includes(field))
            && [entry.courseRoleId, entry.availability].every((field) => field === undefined || (typeof field === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(field))))) {
          output[key] = child;
          continue;
        }
        output[key] = "[redacted]";
        continue;
      }
      output[key] = this.strictNativeEgress(child, depth + 1, allowBlackboardReferences);
    }
    return output;
  }

  private isMoodleStagedFileMetadata(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
    toolName?: string,
  ): boolean {
    const sourceBindingId = this.requestSourceBindingId(request);
    const courseId = this.requestCourseId(request);
    if (!sourceBindingId || !courseId) return false;
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const plan = isJsonObject(value.plan)
      ? value.plan
      : structured && isJsonObject(structured.plan)
        ? structured.plan
        : null;
    const planTool = this.exactString(plan?.tool, 160);
    const stagedTools = new Set(Object.values(MOODLE_STAGED_FILE_CAPABILITIES).map((capability) => capability.toolName));
    const planTools = new Set(Object.values(MOODLE_STAGED_FILE_CAPABILITIES).map((capability) => capability.publicPlanToolName));
    return (typeof toolName === "string" && planTools.has(toolName))
      || (typeof structured?.tool === "string" && planTools.has(structured.tool))
      || (typeof value.publicToolName === "string" && stagedTools.has(value.publicToolName))
      || (typeof structured?.publicToolName === "string" && stagedTools.has(structured.publicToolName))
      || (planTool !== null && stagedTools.has(planTool));
  }

  private browserEditOptionsResult(value: JsonObject): JsonObject | null {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const data = structured && isJsonObject(structured.data) ? structured.data : null;
    const candidates = this.catalog.tools.filter((candidate) => this.isBrowserEditOptions(candidate));
    if (!structured || candidates.length !== 1
      || structured.schema !== "morrow.result.v1"
      || structured.tool !== candidates[0]!.publicName
      || structured.backend !== candidates[0]!.upstreamId
      || !data || data.schema !== "morrow.bridge.edit-options.v1") return null;
    return data;
  }

  private async redactBrowserEditOptionsEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const sourceBindingId = this.requestSourceBindingId(request);
    const candidates = this.catalog.tools.filter((candidate) => this.isBrowserEditOptions(candidate));
    if (!sourceBindingId || candidates.length !== 1) throw new Error("learner_roster_binding_unavailable");
    const data = this.browserEditOptionsResult(value);
    if (!data) throw new Error("learner_roster_binding_unavailable");
    const binding = await this.verifiedBrowserBindingBySource(candidates[0]!, request, options);
    const publicOptions = this.canonicalBrowserEditOptions(binding, data, sourceBindingId);
    return canonicalMorrowResult({
      result: {
        content: [{ type: "text", text: "Morrow read the available Edit actions for this saved browser connection." }],
        structuredContent: publicOptions,
      },
      tool: candidates[0]!.publicName,
      backend: candidates[0]!.upstreamId,
      phase: "read",
      verificationStatus: "not_applicable",
    });
  }

  private async scopedNativeEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal; readonly toolName?: string },
  ): Promise<JsonObject> {
    const sourceBindingId = this.requestSourceBindingId(request);
    if (!sourceBindingId) return this.strictNativeEgress(value) as JsonObject;
    // Blackboard Learn's local API source creates learner tokens and removes
    // learner identifiers before returning its bounded result. It has no
    // Chrome binding or browser roster route, so applying the Canvas/Moodle
    // roster lookup below would reject a safe Blackboard plan at MCP egress.
    // The exemption is now bound to the source that produced this value, not
    // to the request: `source_binding_id` is caller-supplied, so a `blackboard:`
    // prefix on a Canvas call must not skip the roster lookup. `options.toolName`
    // is the tool the MCP boundary invoked. A tool that names an operation
    // rather than a capability, such as morrow_operation_dispatch, is resolved
    // through the capability Morrow stamped on its own canonical result.
    const blackboardRestSource = (candidate: CatalogTool): boolean => (
      candidate.upstreamId === "blackboard-rest"
      && candidate.capability?.provider === "blackboard"
      && candidate.capability.route.backend === "lms-api"
    );
    const invokedBlackboardSource = (name: string | null | undefined): boolean => {
      if (!name) return false;
      const invoked = this.toolByPublicName.get(name);
      // Morrow's own Blackboard plan tool has no catalog entry of its own. It
      // reaches the Blackboard source and no other, including when it refuses.
      // morrow_audit_course routes on its own validated `provider` field, so a
      // `blackboard` audit reads the Blackboard source and no other; a Canvas or
      // Moodle audit keeps the roster lookup below whatever binding it was given.
      if (!invoked) {
        const nativeBlackboardTool = name === BLACKBOARD_CONTENT_PATCH_PLAN_NATIVE_TOOL
          || BLACKBOARD_ACTIONS.some((action) => action.publicName === name)
          || (name === "morrow_audit_course" && request.provider === "blackboard");
        return nativeBlackboardTool && this.catalog.tools.some(blackboardRestSource);
      }
      return blackboardRestSource(invoked);
    };
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const stampedTool = structured?.schema === "morrow.result.v1"
      ? this.exactString(structured.tool, 128)
      : null;
    // A refusal Morrow raises before it reserves a dispatch, such as the target
    // an unresolved change still holds, stamps the tool the assistant called
    // rather than the frozen source tool. The saved operation that result names
    // resolves the source the change was frozen for, so that refusal reaches the
    // person with its own words instead of a privacy-boundary message.
    const frozenOperationTool = structured?.schema === "morrow.result.v1"
      ? this.frozenOperationToolName(this.exactString(structured.operationId, 160))
      : null;
    if (invokedBlackboardSource(options.toolName) || invokedBlackboardSource(stampedTool)
      || invokedBlackboardSource(frozenOperationTool)) {
      return this.strictNativeEgress(value, 0, true) as JsonObject;
    }
    const candidates = this.catalog.tools.filter((candidate) => isCanvasConnector(candidate));
    const sourceIds = [...new Set(candidates.map((candidate) => candidate.upstreamId))];
    if (sourceIds.length !== 1) throw new Error("learner_roster_source_unavailable");
    const mapping = candidates.find((candidate) => candidate.upstreamId === sourceIds[0])!;
    const binding = await this.verifiedBrowserBinding(mapping, request, options);
    if (binding.provider === "moodle") {
      if (this.isMoodleStagedFileMetadata(value, request, options.toolName)) {
        return this.strictNativeEgress(value) as JsonObject;
      }
      const context = await this.moodleLearnerContext(mapping, request, options);
      if (!context) throw new Error("learner_roster_binding_unavailable");
      return redactLearnerEgress(value, context) as JsonObject;
    }
    const context = await this.canvasLearnerContext(mapping, request, options);
    if (!context) throw new Error("learner_roster_binding_unavailable");
    return redactLearnerEgress(value, context) as JsonObject;
  }

  private operationVerificationStatus(record: EffectOperationRecord): "not_requested" | "unconfirmed" | "verified" {
    return record.verificationStatus === "verified" || record.verificationStatus === "unconfirmed"
      ? record.verificationStatus
      : "not_requested";
  }

  /**
   * A persisted browser operation may outlive its authenticated learner scope.
   * This recovery shape intentionally contains only durable control state.
   */
  private historicalOperationControl(record: EffectOperationRecord): JsonObject {
    return {
      schema: "morrow.operation-control.v1",
      operationId: record.operationId,
      state: record.state,
      dispatchAttempt: record.dispatchAttempt,
      verification: { status: this.operationVerificationStatus(record) },
      contentOmittedReason: "historical_learner_scope_unavailable",
    };
  }

  private historicalOperationControlResult(record: EffectOperationRecord, toolName: string): JsonObject {
    const control = this.historicalOperationControl(record);
    if (toolName !== "morrow_operation_cancel") {
      return {
        content: [{ type: "text", text: "Morrow retained only local operation control status because historical learner content is unavailable." }],
        structuredContent: control,
      };
    }
    return canonicalMorrowResult({
      operationId: record.operationId,
      tool: "morrow_operation_cancel",
      phase: "cancelled",
      effectState: record.state,
      verificationStatus: this.operationVerificationStatus(record),
      result: {
        content: [{ type: "text", text: `Cancelled Morrow operation ${record.operationId} before dispatch.` }],
        structuredContent: control,
      },
    });
  }

  /**
   * Canvas Inbox message text and recipient references remain private after
   * planning. Public operation controls expose only their durable state; the
   * local approval loopback continues to read the raw operation record.
   */
  private isPrivateCanvasConversationOperation(record: EffectOperationRecord): boolean {
    const mapping = this.toolByPublicName.get(record.publicToolName);
    return mapping !== undefined && isCanvasConversationTransfer(mapping);
  }

  private historicalConnectorRecord(record: EffectOperationRecord): {
    readonly mapping: CatalogTool;
    readonly request: JsonObject;
    readonly frozenActorDigest: string;
  } | "unavailable" | null {
    const mapping = this.toolByPublicName.get(record.publicToolName);
    // An unavailable frozen mapping cannot prove that this persisted operation
    // has no connector learner scope. Keep its content closed.
    if (!mapping) return "unavailable";
    if (!isCanvasConnector(mapping)) return null;
    const request = isJsonObject(record.plan.arguments) ? record.plan.arguments : null;
    const sourceBindingId = request ? this.requestSourceBindingId(request) : null;
    const authority = isJsonObject(record.plan.authority) ? record.plan.authority : null;
    const frozenActorDigest = authority ? this.exactString(authority.actorDigest, 64) : null;
    if (!record.sourceBindingId || !request || !sourceBindingId
      || record.sourceBindingId !== sourceBindingId
      || !frozenActorDigest || !/^[0-9a-f]{64}$/u.test(frozenActorDigest)) {
      return "unavailable";
    }
    return { mapping, request, frozenActorDigest };
  }

  private async historicalEffectEgress(
    value: JsonObject,
    record: EffectOperationRecord,
    options: { readonly signal?: AbortSignal; readonly toolName?: string },
  ): Promise<{ readonly value?: JsonObject; readonly unavailable: boolean; readonly ordinary?: true }> {
    const historical = this.historicalConnectorRecord(record);
    // Non-browser operations have no learner binding to reconstruct. Their
    // normal bounded projection remains available without a control fallback.
    if (historical === null) return { unavailable: false, ordinary: true };
    if (historical === "unavailable") return { unavailable: true };
    try {
      const current = await this.currentBrowserEffectAuthority(historical.mapping, historical.request);
      const authority = this.effectAuthority(
        historical.mapping,
        historical.request,
        current.authorization,
        record.readback || undefined,
        current.bindingScope,
      );
      if (authority.actorDigest !== historical.frozenActorDigest) return { unavailable: true };
      return {
        unavailable: false,
        value: await this.scopedNativeEgress(value, historical.request, options),
      };
    } catch {
      // The operation already exists, and callers handle operation errors before
      // reaching this path. Any error here means the frozen current authority or
      // learner scope could not be established, so historical content is unsafe.
      return { unavailable: true };
    }
  }

  private historicalOperationPrivacyFailure(): JsonObject {
    return this.privacyFailure(new Error("historical operation egress unavailable"));
  }

  /** Rebuild the one fixed local cancellation failure without its input payload. */
  private boundedOperationUnavailable(value: JsonObject, toolName: string): JsonObject | null {
    const structured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const data = structured && isJsonObject(structured.data) ? structured.data : null;
    if (value.isError !== true || structured?.schema !== "morrow.result.v1" || structured.phase !== "rejected"
      || data?.schema !== "morrow.problem.v1" || data.code !== "operation_unavailable") return null;
    return canonicalMorrowResult({
      tool: toolName,
      phase: "rejected",
      verificationStatus: "not_requested",
      result: {
        content: [{ type: "text", text: "Morrow could not cancel this request. Check the saved request before trying again." }],
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code: "operation_unavailable" },
      },
    });
  }

  private async redactHistoricalOperationGetEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal; readonly toolName?: string },
  ): Promise<JsonObject> {
    if (value.isError === true) return this.boundedOperationUnavailable(value, "morrow_operation_get")
      || this.historicalOperationPrivacyFailure();
    const operationId = this.exactString(request.operation_id ?? request.operationId, 160);
    if (!operationId?.startsWith("op:")) return this.strictNativeEgress(value) as JsonObject;
    try {
      const record = this.effects.get(operationId);
      if (this.isPrivateCanvasConversationOperation(record)) {
        return this.historicalOperationControlResult(record, "morrow_operation_get");
      }
      const egress = await this.historicalEffectEgress(value, record, options);
      if (egress.unavailable || (!egress.value && !egress.ordinary)) return this.historicalOperationControlResult(record, "morrow_operation_get");
      return egress.ordinary ? this.strictNativeEgress(value) as JsonObject : egress.value!;
    } catch {
      return this.historicalOperationPrivacyFailure();
    }
  }

  private async redactHistoricalOperationCancelEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal; readonly toolName?: string },
  ): Promise<JsonObject> {
    if (value.isError === true) return this.boundedOperationUnavailable(value, "morrow_operation_cancel")
      || this.historicalOperationPrivacyFailure();
    const operationId = this.exactString(request.operation_id ?? request.operationId, 160);
    if (!operationId?.startsWith("op:")) return this.strictNativeEgress(value) as JsonObject;
    try {
      const record = this.effects.get(operationId);
      if (record.state !== "cancelled") return this.historicalOperationPrivacyFailure();
      if (this.isPrivateCanvasConversationOperation(record)) {
        return this.historicalOperationControlResult(record, "morrow_operation_cancel");
      }
      const egress = await this.historicalEffectEgress(value, record, options);
      if (egress.unavailable || (!egress.value && !egress.ordinary)) return this.historicalOperationControlResult(record, "morrow_operation_cancel");
      return egress.ordinary ? this.strictNativeEgress(value) as JsonObject : egress.value!;
    } catch {
      return this.historicalOperationPrivacyFailure();
    }
  }

  private inventorySelections(value: Readonly<Record<string, unknown>>): ReadonlyMap<string, JsonObject> {
    const provider = value.provider === "canvas" || value.provider === "moodle" ? value.provider : null;
    if (!provider) return new Map();
    const courses = Array.isArray(value.courses) ? value.courses : [];
    const selections = new Map<string, JsonObject>();
    for (const course of courses) {
      if (!isJsonObject(course)) continue;
      const courseId = this.requestCourseId(course);
      const sourceBindingId = this.requestSourceBindingId(course);
      if (!courseId || !sourceBindingId) continue;
      selections.set(this.inventorySelectionKey(provider, sourceBindingId, courseId), {
        provider,
        course_id: courseId,
        source_binding_id: sourceBindingId,
      });
    }
    return selections;
  }

  private inventorySelectionKey(provider: "canvas" | "moodle", sourceBindingId: string, courseId: string): string {
    return sha256Json({ provider, sourceBindingId, courseId });
  }

  private inventoryContextKey(
    mapping: CatalogTool,
    provider: "canvas" | "moodle",
    binding: JsonObject,
    sourceBindingId: string,
    courseId: string,
  ): string {
    const scope = provider === "canvas"
      ? this.canvasBindingScope(binding, sourceBindingId, courseId)
      : this.moodleBindingScope(binding, sourceBindingId, courseId);
    const catalogDigest = this.exactString(binding.catalogDigest, 64);
    const sessionGeneration = binding.sessionGeneration;
    if (!scope || !catalogDigest || !Number.isSafeInteger(sessionGeneration) || Number(sessionGeneration) < 1) {
      throw new Error("learner_roster_binding_unavailable");
    }
    return sha256Json({
      schema: "morrow.inventory-learner-context.v1",
      provider,
      source: mapping.upstreamId,
      origin: scope.canvasOrigin,
      account: scope.account,
      course: scope.course,
      profile: scope.profile,
      binding: sourceBindingId,
      principal: scope.principal,
      sessionGeneration,
      catalogDigest,
    });
  }

  private async redactInventoryEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal },
  ): Promise<JsonObject> {
    const selections = this.inventorySelections(request);
    const provider = request.provider === "canvas" || request.provider === "moodle" ? request.provider : null;
    if (!provider || selections.size === 0) throw new Error("learner_roster_binding_unavailable");
    const strict = this.strictNativeEgress(value) as JsonObject;
    const rawStructured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const structured = isJsonObject(strict.structuredContent) ? strict.structuredContent : null;
    if (!rawStructured || !structured || rawStructured.provider !== provider || !Array.isArray(rawStructured.courses)) {
      throw new Error("privacy_inventory_shape_unavailable");
    }
    const sourceIds = [...new Set(this.catalog.tools.filter(isCanvasConnector).map((candidate) => candidate.upstreamId))];
    if (sourceIds.length !== 1) throw new Error("learner_roster_source_unavailable");
    const mapping = this.catalog.tools.find((candidate) => (
      candidate.upstreamId === sourceIds[0] && candidate.capability?.provider === provider && isCanvasConnector(candidate)
    ));
    if (!mapping) throw new Error("learner_roster_source_unavailable");

    const matchEntries = (entries: readonly unknown[], auditEntries = false) => entries.map((entry) => {
      if (!isJsonObject(entry)) throw new Error("privacy_inventory_shape_unavailable");
      const courseId = this.requestCourseId(entry);
      const sourceBindingId = this.requestSourceBindingId(entry);
      const selection = courseId && sourceBindingId
        ? selections.get(this.inventorySelectionKey(provider, sourceBindingId, courseId))
        : undefined;
      if (!selection) throw new Error("learner_roster_binding_unavailable");
      if (auditEntries) {
        const argumentsValue = isJsonObject(entry.arguments) ? entry.arguments : null;
        if (!argumentsValue || argumentsValue.provider !== provider) throw new Error("privacy_inventory_shape_unavailable");
      }
      return {
        entry,
        selection,
        selectionKey: this.inventorySelectionKey(provider, sourceBindingId!, courseId!),
      };
    });
    const courseEntries = matchEntries(rawStructured.courses);
    const auditEntries = Array.isArray(rawStructured.audit_children)
      ? matchEntries(rawStructured.audit_children, true)
      : [];
    const scopeRequests = new Map<string, JsonObject>();
    for (const matched of [...courseEntries, ...auditEntries]) {
      scopeRequests.set(matched.selectionKey, matched.selection);
    }

    const bindingsTool = this.browserBindingsTool(mapping);
    if (!bindingsTool) throw new Error("learner_roster_source_unavailable");
    const bindingsResult = await this.callSourceOwned(bindingsTool.publicName, {}, options);
    if (bindingsResult.isError === true) throw new Error("learner_roster_binding_unavailable");
    const bindings = browserBindingContent(bindingsResult);
    const pendingContexts = new Map<string, {
      readonly binding: JsonObject;
      readonly sourceBindingId: string;
      readonly courseId: string;
      selectionKeys: string[];
    }>();
    for (const [selectionKey, selection] of scopeRequests) {
      const sourceBindingId = this.requestSourceBindingId(selection);
      const courseId = this.requestCourseId(selection);
      if (!sourceBindingId || !courseId) throw new Error("learner_roster_binding_unavailable");
      const binding = this.matchVerifiedBrowserBinding(bindings, selection, provider);
      const contextKey = this.inventoryContextKey(mapping, provider, binding, sourceBindingId, courseId);
      const pending = pendingContexts.get(contextKey);
      if (pending) pending.selectionKeys.push(selectionKey);
      else pendingContexts.set(contextKey, { binding, sourceBindingId, courseId, selectionKeys: [selectionKey] });
    }
    const contextsByScope = new Map<string, LearnerTextRedactionContext>();
    const resolved = await mapBounded([...pendingContexts.values()], MAX_INVENTORY_EGRESS_CONTEXTS, async (pending) => {
      const context = provider === "canvas"
        ? await this.canvasLearnerContextForBinding(mapping, pending.sourceBindingId, pending.courseId, pending.binding, options)
        : await this.moodleLearnerContextForBinding(mapping, pending.sourceBindingId, pending.courseId, pending.binding, options);
      return { selectionKeys: pending.selectionKeys, context };
    });
    for (const item of resolved) {
      for (const selectionKey of item.selectionKeys) contextsByScope.set(selectionKey, item.context);
    }
    const redactEntries = (entries: readonly { readonly entry: JsonObject; readonly selectionKey: string }[]): JsonObject[] => (
      entries.map((matched) => {
        const context = contextsByScope.get(matched.selectionKey);
        if (!context) throw new Error("learner_roster_binding_unavailable");
        return redactLearnerEgress(matched.entry, context) as JsonObject;
      })
    );
    const redactedCourses = redactEntries(courseEntries);
    const redactedAudits = redactEntries(auditEntries);
    const targetKey = (courseId: string, sourceBindingId: string, target: JsonObject): string => (
      sha256Json({ schema: "morrow.inventory-target.v1", provider, courseId, sourceBindingId, target })
    );
    const rawTargetKey = (entry: JsonObject): string => {
      const courseId = this.requestCourseId(entry);
      const sourceBindingId = this.requestSourceBindingId(entry);
      const argumentsValue = isJsonObject(entry.arguments) ? entry.arguments : null;
      const target = argumentsValue && isJsonObject(argumentsValue.target) ? argumentsValue.target : null;
      if (!courseId || !sourceBindingId || !target || argumentsValue?.provider !== provider) throw new Error("privacy_inventory_shape_unavailable");
      return targetKey(courseId, sourceBindingId, target);
    };
    const rawCourseTargetKey = (course: JsonObject, target: JsonObject): string => {
      const courseId = this.requestCourseId(course);
      const sourceBindingId = this.requestSourceBindingId(course);
      const targetValue = isJsonObject(target.target) ? target.target : null;
      if (!courseId || !sourceBindingId || !targetValue) throw new Error("privacy_inventory_shape_unavailable");
      return targetKey(courseId, sourceBindingId, targetValue);
    };
    const knownTargets = new Set<string>();
    for (const matched of courseEntries) {
      const targets = matched.entry.targets;
      if (!Array.isArray(targets)) throw new Error("privacy_inventory_shape_unavailable");
      for (const target of targets) {
        if (!isJsonObject(target)) throw new Error("privacy_inventory_shape_unavailable");
        const key = rawCourseTargetKey(matched.entry, target);
        if (knownTargets.has(key)) throw new Error("privacy_inventory_shape_unavailable");
        knownTargets.add(key);
      }
    }
    const blockedTargets = new Set<string>();
    const safeAudits: JsonObject[] = [];
    for (const [index, raw] of auditEntries.entries()) {
      const rawArguments = isJsonObject(raw.entry.arguments) ? raw.entry.arguments : null;
      const redactedArguments = isJsonObject(redactedAudits[index]?.arguments) ? redactedAudits[index]!.arguments : null;
      if (!rawArguments || !redactedArguments) throw new Error("privacy_inventory_shape_unavailable");
      if (sha256Json(rawArguments) !== sha256Json(redactedArguments)) {
        const key = rawTargetKey(raw.entry);
        if (!knownTargets.has(key)) throw new Error("privacy_inventory_shape_unavailable");
        blockedTargets.add(key);
      } else {
        safeAudits.push(redactedAudits[index]!);
      }
    }
    for (const [courseIndex, raw] of courseEntries.entries()) {
      const redacted = redactedCourses[courseIndex]!;
      const rawTargets = raw.entry.targets;
      const redactedTargets = redacted.targets;
      if (!Array.isArray(rawTargets) || !Array.isArray(redactedTargets) || rawTargets.length !== redactedTargets.length) {
        throw new Error("privacy_inventory_shape_unavailable");
      }
      const safeTargets: JsonObject[] = [];
      let blockedCount = 0;
      for (const [targetIndex, rawTarget] of rawTargets.entries()) {
        if (!isJsonObject(rawTarget) || !isJsonObject(redactedTargets[targetIndex])) {
          throw new Error("privacy_inventory_shape_unavailable");
        }
        if (blockedTargets.has(rawCourseTargetKey(raw.entry, rawTarget))) {
          blockedCount += 1;
          continue;
        }
        safeTargets.push(redactedTargets[targetIndex]!);
      }
      if (blockedCount > 0) {
        if (!Array.isArray(redacted.coverage_gaps)) throw new Error("privacy_inventory_shape_unavailable");
        redacted.coverage_gaps.push({
          code: "target_identifier_redacted",
          list: "privacy",
          reason: "An exact audit target identifier matched learner text and could not be retained safely.",
          blocking: true,
          affected_record_count: blockedCount,
          sample_record_ids: [],
        });
        redacted.status = "inventory_incomplete";
      }
      redacted.targets = safeTargets;
    }
    if (blockedTargets.size > 0) {
      if (!isJsonObject(structured.coverage)) throw new Error("privacy_inventory_shape_unavailable");
      structured.coverage.status = "inventory_incomplete";
      structured.coverage.complete = false;
      structured.coverage.audit_child_count = safeAudits.length;
    }
    structured.courses = redactedCourses;
    if (Array.isArray(rawStructured.audit_children)) structured.audit_children = safeAudits;
    return strict;
  }

  private async redactOperationCollectionEgress(
    value: JsonObject,
    options: { readonly signal?: AbortSignal },
  ): Promise<JsonObject> {
    const strict = this.strictNativeEgress(value) as JsonObject;
    const rawStructured = isJsonObject(value.structuredContent) ? value.structuredContent : null;
    const structured = isJsonObject(strict.structuredContent) ? strict.structuredContent : null;
    if (!rawStructured || !structured || !Array.isArray(rawStructured.operations)) return strict;
    structured.operations = await Promise.all(rawStructured.operations.map(async (entry) => {
      if (!isJsonObject(entry)) return this.strictNativeEgress(entry) as JsonObject;
      const operationId = this.exactString(entry.operationId, 160);
      if (!operationId?.startsWith("op:")) return this.strictNativeEgress(entry) as JsonObject;
      try {
        const operation = this.effects.get(operationId);
        if (this.isPrivateCanvasConversationOperation(operation)) {
          return this.historicalOperationControl(operation);
        }
        const egress = await this.historicalEffectEgress(entry, operation, options);
        return egress.unavailable || (!egress.value && !egress.ordinary)
          ? this.historicalOperationControl(operation)
          : egress.ordinary ? this.strictNativeEgress(entry) as JsonObject : egress.value!;
      } catch {
        return this.historicalOperationPrivacyFailure();
      }
    }));
    return strict;
  }

  async redactMcpEgress(
    value: JsonObject,
    request: Readonly<Record<string, unknown>> = {},
    options: { readonly signal?: AbortSignal; readonly bound?: boolean; readonly toolName?: string } = {},
  ): Promise<JsonObject> {
    const finish = (result: JsonObject): JsonObject => options.bound === false
      ? structuredClone(result)
      : this.resultArtifacts.bound(result);
    try {
      if (this.isMoodleQuizAttemptSummaryEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleQuizAttemptSummaryEgress(value, capabilityRequest));
      }
      if (this.isMoodleQuizAttemptEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleQuizAttemptEgress(value, capabilityRequest));
      }
      if (this.isMoodleQuizManualGradingQueueEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleQuizManualGradingQueueEgress(value, capabilityRequest));
      }
      if (this.isMoodleQuizRegradeReportEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleQuizRegradeReportEgress(value, capabilityRequest));
      }
      if (this.isCanvasClassicQuizSubmissionSummaryEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicCanvasClassicQuizSubmissionSummaryEgress(value, capabilityRequest));
      }
      const courseSummaryEgressRoute = this.canvasCourseSummaryEgressRoute(value);
      if (courseSummaryEgressRoute) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicCanvasCourseSummaryEgress(courseSummaryEgressRoute, value, capabilityRequest));
      }
      if (this.isMoodleAssignmentSubmissionSummaryEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleAssignmentSubmissionSummaryEgress(value, capabilityRequest));
      }
      if (this.isMoodleAssignmentSubmissionEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleAssignmentSubmissionEgress(value, capabilityRequest));
      }
      if (this.isMoodleAssignmentFeedbackEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleAssignmentFeedbackEgress(value, capabilityRequest));
      }
      if (this.isMoodleForumActivitySummaryEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleForumActivitySummaryEgress(value, capabilityRequest));
      }
      const activityContentReadEgress = this.moodleActivityContentReadEgress(value);
      if (activityContentReadEgress) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleActivityContentReadEgress(activityContentReadEgress, value, capabilityRequest));
      }
      if (this.isMoodleScormAttemptSummaryEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleScormAttemptSummaryEgress(value, capabilityRequest));
      }
      if (this.isMoodleScormLearnerReportEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleScormLearnerReportEgress(value, capabilityRequest));
      }
      if (this.isMoodleGradeReportSummaryEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleGradeReportSummaryEgress(value, capabilityRequest));
      }
      if (this.isMoodleLearnerGradeReportEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleLearnerGradeReportEgress(value, capabilityRequest));
      }
      if (this.isMoodleCourseParticipantsEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleCourseParticipantsEgress(value, capabilityRequest));
      }
      if (this.isMoodleEnrolmentMethodsEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleEnrolmentMethodsEgress(value, capabilityRequest));
      }
      if (this.isMoodleParticipantEnrolmentEgress(value)) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleParticipantEnrolmentEgress(value, capabilityRequest));
      }
      const courseReportEgress = this.moodleCourseReportReadEgress(value);
      if (courseReportEgress) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleCourseReportReadEgress(courseReportEgress, value, capabilityRequest));
      }
      const siteAdministrationEgress = this.moodleSiteAdministrationReadEgress(value);
      if (siteAdministrationEgress) {
        const capabilityRequest = isJsonObject(request.arguments)
          ? request.arguments
          : this.egressRequest(request);
        return finish(this.publicMoodleSiteAdministrationReadEgress(siteAdministrationEgress, value, capabilityRequest));
      }
      if (this.browserEditOptionsResult(value)) {
        return finish(await this.redactBrowserEditOptionsEgress(value, this.egressRequest(request), options));
      }
      if (options.toolName === "morrow_inventory_courses") {
        return finish(await this.redactInventoryEgress(value, request, options));
      }
      if (options.toolName === "morrow_operation_get") {
        return finish(await this.redactHistoricalOperationGetEgress(value, request, options));
      }
      if (options.toolName === "morrow_operation_cancel") {
        return finish(await this.redactHistoricalOperationCancelEgress(value, request, options));
      }
      if (["morrow_operation_list", "morrow_operations_recent"].includes(options.toolName || "")) {
        return finish(await this.redactOperationCollectionEgress(value, options));
      }
      return finish(await this.scopedNativeEgress(value, this.egressRequest(request), options));
    } catch (error) {
      return this.privacyFailure(error);
    }
  }

  async call(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping) {
      return canonicalMorrowResult({
        tool: publicName,
        phase: "rejected",
        verificationStatus: "not_applicable",
        result: {
        content: [{ type: "text", text: `Unknown Morrow tool ${publicName}.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "tool_not_found",
        },
        },
      });
    }
    if (mapping.annotations?.readOnlyHint === true) {
      const raw = await this.callSourceOwned(publicName, args, options);
      const result = await this.publicSourceResult(mapping, args, raw, options);
      return canonicalMorrowResult({
        result,
        tool: publicName,
        backend: mapping.upstreamId,
        phase: "read",
        verificationStatus: "not_applicable",
      });
    }
    const planned = await this.planOperationWithCurrentEditPermission(publicName, args);
    const content = isJsonObject(planned.structuredContent) ? planned.structuredContent : {};
    if (planned.isError === true || content.effectState !== "approved" || typeof content.operationId !== "string") {
      return planned;
    }
    const dispatched = await this.dispatchOperation(content.operationId);
    return this.redactMcpEgress(dispatched, args, options);
  }

  planOperation(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
  ): JsonObject {
    return this.planOperationWithAuthorization(publicName, args, REVIEW_AUTHORIZATION);
  }

  async planOperationWithCurrentEditPermission(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<JsonObject> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping || mapping.annotations?.readOnlyHint === true) {
      return canonicalMorrowResult({
        tool: publicName,
        phase: "rejected",
        verificationStatus: "not_requested",
        result: {
          content: [{ type: "text", text: "Morrow can only plan one current mutating capability." }],
          isError: true,
          structuredContent: { schema: "morrow.problem.v1", code: "write_plan_unavailable" },
        },
      });
    }
    try {
      const supplied = outerOperationControls(args);
      const prepared = await this.prepareEffectAuthority(publicName, supplied.request);
      return this.planOperationWithControls(publicName, mapping, supplied, prepared.authorization, prepared.bindingScope);
    } catch (error) {
      return this.planOperationRejected(publicName, error);
    }
  }

  async editAuthorizationFor(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<EffectAuthorization> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping || mapping.annotations?.readOnlyHint === true) return REVIEW_AUTHORIZATION;
    try {
      return (await this.prepareEffectAuthority(publicName, args)).authorization;
    } catch {
      return REVIEW_AUTHORIZATION;
    }
  }

  planOperationWithExtensionAuthorization(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    authorization: EffectAuthorization,
    bindingScope?: EffectBindingScope,
  ): JsonObject {
    return this.planOperationWithAuthorization(publicName, args, authorization, bindingScope);
  }

  private planOperationWithAuthorization(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    authorization: EffectAuthorization,
    bindingScope?: EffectBindingScope,
  ): JsonObject {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping || mapping.annotations?.readOnlyHint === true) {
      return canonicalMorrowResult({
        tool: publicName,
        phase: "rejected",
        verificationStatus: "not_requested",
        result: {
          content: [{ type: "text", text: "Morrow can only plan one current mutating capability." }],
          isError: true,
          structuredContent: { schema: "morrow.problem.v1", code: "write_plan_unavailable" },
        },
      });
    }
    try {
      return this.planOperationWithControls(publicName, mapping, outerOperationControls(args), authorization, bindingScope);
    } catch (error) {
      return this.planOperationRejected(publicName, error);
    }
  }

  private planOperationWithControls(
    publicName: string,
    mapping: CatalogTool,
    supplied: OuterOperationControls,
    authorization: EffectAuthorization,
    bindingScope?: EffectBindingScope,
  ): JsonObject {
      if (isMoodleStagedFile(mapping) || isCanvasCourseFileTransfer(mapping)) {
        throw new TypeError("Prepare the local file with its exact Morrow file planner before review.");
      }
      if (isCanvasConversationTransfer(mapping)) {
        throw new TypeError("Prepare Canvas Inbox messages with morrow_plan_canvas_conversation before review.");
      }
      if (isCanvasConnector(mapping) && !legacyRouting(supplied.request).sourceBindingId) {
        throw new TypeError("Browser connector writes require one exact source_binding_id from morrow_browser_bindings");
      }
      if (isCanvasConnector(mapping) && !bindingScope) {
        throw new TypeError("Browser connector writes require a freshly prepared course connection.");
      }
      if (mapping.capability?.provider === "moodle" && !/^[0-9a-f]{64}$/.test(String(supplied.request.expected_digest || ""))) {
        throw new TypeError("Moodle browser writes require expected_digest from the exact preceding read");
      }
      const controls: OuterOperationControls = supplied.readback || !usesEmbeddedReadback(mapping)
        ? supplied
        : { ...supplied, readback: connectorReadback(mapping, supplied.request) };
      if (!controls.readback) {
        return canonicalMorrowResult({
          tool: publicName,
          phase: "rejected",
          verificationStatus: "not_requested",
          result: {
            content: [{ type: "text", text: "Morrow refused a write without a frozen fresh-readback comparator." }],
            isError: true,
            structuredContent: { schema: "morrow.problem.v1", code: "write_readback_required" },
          },
        });
      }
      const operation = this.planEffect(mapping, controls, authorization, undefined, bindingScope);
      return this.effectResult(operation, "planned");
  }

  private planOperationRejected(publicName: string, error: unknown): JsonObject {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return canonicalMorrowResult({
      tool: publicName,
      phase: "rejected",
      verificationStatus: "not_requested",
      result: {
        content: [{ type: "text", text: "Morrow could not freeze this operation plan." }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "operation_plan_invalid",
          detailDigest: sha256Text(detail),
        },
      },
    });
  }

  async dispatchOperation(operationId: string): Promise<JsonObject> {
    let reserved: EffectOperationRecord;
    let fileStages: readonly FileStageBinding[] | undefined;
    let checkingFileStage = false;
    try {
      const pending = this.effects.get(operationId);
      const pendingMapping = this.toolByPublicName.get(pending.publicToolName);
      if (!pendingMapping) throw new Error("frozen tool mapping is unavailable");
      const authorization = frozenEffectAuthorization(pending.plan);
      const request = pending.plan.arguments as JsonObject;
      let bindingScope: EffectBindingScope | undefined;
      let currentAuthorization = REVIEW_AUTHORIZATION;
      checkingFileStage = isBlackboardAttachment(pendingMapping) || isMoodleStagedFile(pendingMapping) || isCanvasCourseFileTransfer(pendingMapping);
      if (isBlackboardAttachment(pendingMapping)) {
        const staged = this.operationFileStages.get(operationId)?.[0];
        if (!staged || this.operationFileStages.get(operationId)?.length !== 1 || authorization.kind !== "review" || request.course_id !== staged.scope.courseId
          || request.source_binding_id !== staged.scope.sourceBindingId
          || request.filename !== staged.manifest.filename || request.size_bytes !== staged.manifest.sizeBytes
          || request.sha256 !== staged.manifest.sha256 || request.content_type !== staged.scope.contentType) {
          throw new Error("The reviewed Blackboard file is unavailable. Prepare and approve a new file plan.");
        }
        this.fileStages.verify(staged);
        fileStages = [staged];
      } else if (isMoodleStagedFile(pendingMapping) || isCanvasCourseFileTransfer(pendingMapping)) {
        const staged = this.operationFileStages.get(operationId);
        const capability = moodleStagedFileCapabilityForMapping(pendingMapping);
        const multiple = capability?.planMode === "folder_add";
        const sourceBindingId = staged?.[0]?.scope.sourceBindingId;
        const exactSingle = staged?.length === 1 && request.filename === staged[0]!.manifest.filename
          && request.size_bytes === staged[0]!.manifest.sizeBytes && request.sha256 === staged[0]!.manifest.sha256;
        const exactMultiple = staged !== undefined && Array.isArray(request.files) && request.files.length === staged.length
          && request.files.every((file, index) => isJsonObject(file)
            && file.filename === staged[index]?.manifest.filename && file.size_bytes === staged[index]?.manifest.sizeBytes
            && file.sha256 === staged[index]?.manifest.sha256);
        if (!staged || !sourceBindingId || authorization.kind !== "review" || typeof request.course_id !== "number"
          || !(multiple ? exactMultiple && typeof request.folder_path === "string" : exactSingle)
          || legacyRouting(request).sourceBindingId !== sourceBindingId) {
          throw new Error("The reviewed local file is unavailable. Prepare and approve a new file plan.");
        }
        const scope = isCanvasCourseFileTransfer(pendingMapping)
          ? await this.currentCanvasFileScope(
            pendingMapping,
            sourceBindingId,
            request.course_id,
            typeof request.content_type === "string" ? request.content_type : "",
          )
          : await this.currentMoodleStagedFileScope(pendingMapping, sourceBindingId, request.course_id);
        if (isCanvasCourseFileTransfer(pendingMapping)
          && (typeof request.folder_id !== "number" || !Number.isSafeInteger(request.folder_id) || request.folder_id < 1
            || request.content_type !== staged[0]!.scope.contentType)) {
          throw new Error("The reviewed Canvas file target is unavailable. Prepare and approve a new file plan.");
        }
        fileStages = staged.map((entry) => ({ ...entry, scope }));
        for (const stage of fileStages) this.fileStages.verify(stage);
        bindingScope = this.resourceFileEffectScope(scope);
      } else if (isCanvasConnector(pendingMapping)) {
        const current = await this.currentEffectAuthority(pendingMapping, request);
        bindingScope = current.bindingScope;
        if (authorization.kind === "edit_scope") currentAuthorization = current.authorization;
      } else if (authorization.kind === "edit_scope") {
        currentAuthorization = await this.resolveCurrentEditAuthorization(pendingMapping, request);
      }
      checkingFileStage = false;
      reserved = this.effects.reserveDispatch(
        operationId,
        // Blackboard's signed child grant binds the reserved outer digest and
        // its fresh source plan performs the account, course, roster, and
        // content checks before PATCH. Its original scope is not a browser
        // binding and therefore cannot be reconstructed from the Gateway's
        // Canvas/Moodle privacy configuration here.
        isBlackboardApply(pendingMapping)
          ? undefined
          : this.effectAuthority(pendingMapping, request, currentAuthorization, pending.readback || undefined, bindingScope),
        { enforceHistoricalTargetScopeBarrier: isCanvasConnector(pendingMapping) },
      );
    } catch (error) {
      let filePlanCancelled = false;
      if (checkingFileStage) {
        const current = this.effects.get(operationId);
        if (current.dispatchAttempt === 0 && ["awaiting_approval", "approved"].includes(current.state)) {
          this.cancelOperation(operationId);
          filePlanCancelled = true;
        }
      }
      const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      const targetConflict = error instanceof ProviderEffectTargetConflictError;
      const historicalTargetScopeUnknown = error instanceof ProviderEffectTargetScopeUnknownError;
      const targetIdentityReplanRequired = error instanceof ProviderEffectTargetIdentityVersionError;
      // The person cannot resolve a block they cannot name, so the record that
      // holds the target travels with the refusal.
      const blockingOperationId = targetConflict || historicalTargetScopeUnknown
        ? (error as ProviderEffectTargetConflictError | ProviderEffectTargetScopeUnknownError).operationId
        : null;
      if (targetConflict || historicalTargetScopeUnknown) {
        this.effects.recordTargetConflict(operationId, historicalTargetScopeUnknown
          ? "provider_effect_target_scope_unknown"
          : "provider_effect_target_conflict");
      }
      return canonicalMorrowResult({
        operationId,
        tool: "morrow_operation_dispatch",
        phase: "rejected",
        verificationStatus: "not_requested",
        result: {
          content: [{ type: "text", text: targetConflict
            ? `Morrow did not send this change because an earlier change to the same target is still unresolved. Check that earlier request (${blockingOperationId}) before continuing.`
            : historicalTargetScopeUnknown
              ? `Morrow did not send this change because an earlier connector change from an older Morrow version has an unverified target scope. Check that earlier request (${blockingOperationId}) before continuing.`
            : targetIdentityReplanRequired
              ? "Morrow did not send this saved change because it needs a new review before it can use the current target protection."
            : filePlanCancelled
              ? "Morrow cancelled this file plan before sending it because the reviewed file or connection is no longer available. Prepare and approve a new file plan."
            : "Morrow did not dispatch this operation." }],
          isError: true,
          structuredContent: {
            schema: "morrow.problem.v1", code: "operation_dispatch_refused", detailDigest: sha256Text(detail),
            ...(filePlanCancelled ? { reason: "reviewed_file_unavailable", recoverable: true } : {}),
            ...(targetConflict || historicalTargetScopeUnknown ? {
              reason: historicalTargetScopeUnknown
                ? "provider_effect_target_scope_unknown"
                : "provider_effect_target_conflict",
              blockingOperationId,
              recoverable: true,
            } : targetIdentityReplanRequired ? {
              reason: "provider_effect_target_identity_replan_required",
              recoverable: true,
            } : {}),
          },
        },
      });
    }
    if (reserved.state !== "dispatching") return this.effectResult(reserved, "dispatch_refused");
    const mapping = this.toolByPublicName.get(reserved.publicToolName);
    if (!mapping) {
      const settled = this.effects.settleFailure(reserved.operationId, "frozen_tool_mapping_missing", false);
      return this.effectResult(settled, "dispatch_failed");
    }
    let forwarded = structuredClone(reserved.forwardedRequest) as Record<string, unknown>;
    const authorization = frozenEffectAuthorization(reserved.plan);
    if (isBlackboardApply(mapping)) {
      const sourcePlanDigest = typeof forwarded.expected_plan_digest === "string" && /^[0-9a-f]{64}$/.test(forwarded.expected_plan_digest)
        ? forwarded.expected_plan_digest
        : null;
      if (!sourcePlanDigest || !reserved.approvalGrantDigest || !reserved.effectReceiptId || reserved.dispatchAttempt < 1) {
        const settled = this.effects.settleFailure(reserved.operationId, "blackboard_effect_grant_unavailable", false);
        return this.effectResult(settled, "dispatch_failed");
      }
      const unsignedGrant = {
        schema: "morrow.blackboard.effect-grant.v1" as const,
        operationId: reserved.operationId,
        // The source checks this exact source-plan digest before its fresh precondition read or PATCH.
        planDigest: sourcePlanDigest,
        // The HMAC also binds the unique durable outer operation plan that was approved and reserved.
        outerPlanDigest: reserved.planDigest,
        approvalGrantDigest: reserved.approvalGrantDigest,
        effectReceiptId: reserved.effectReceiptId,
        dispatchAttempt: reserved.dispatchAttempt,
        gatewayProcessId: this.gatewayProcessId,
      };
      forwarded._morrow = {
        outer_grant: {
          schema: unsignedGrant.schema,
          operation_id: unsignedGrant.operationId,
          plan_digest: unsignedGrant.planDigest,
          outer_plan_digest: unsignedGrant.outerPlanDigest,
          approval_grant_digest: unsignedGrant.approvalGrantDigest,
          effect_receipt_id: unsignedGrant.effectReceiptId,
          dispatch_attempt: unsignedGrant.dispatchAttempt,
          gateway_process_id: unsignedGrant.gatewayProcessId,
          dispatch_token: signBlackboardEffectGrant(this.blackboardEffectDispatchSecret, unsignedGrant),
        },
      };
    } else if (mapping.upstreamId === "example-legacy" || usesEmbeddedReadback(mapping)) {
      forwarded._morrow = {
        ...(isJsonObject(forwarded._morrow) ? forwarded._morrow : {}),
        operation_id: reserved.sourceOperationId || reserved.operationId,
        outer_grant: {
          plan_digest: reserved.planDigest,
          approval_grant_digest: reserved.approvalGrantDigest,
          effect_receipt_id: reserved.effectReceiptId,
          dispatch_attempt: reserved.dispatchAttempt,
          gateway_process_id: this.gatewayProcessId,
          authorization: authorization.kind === "review"
            ? { kind: "review" }
            : {
                kind: "edit_scope",
                policy_digest: authorization.policyDigest,
                policy_revision: authorization.policyRevision,
              },
        },
      };
    }
    let operationUpstream: StdioMcpUpstream | undefined;
    try {
      if (mapping.upstreamId === "meridian") {
        operationUpstream = await this.meridianOperationUpstream(reserved);
      }
    } catch (error) {
      const settled = this.effects.settleFailure(reserved.operationId, error, false);
      return this.effectResult(settled, "dispatch_failed");
    }
    let result: JsonObject;
    let privateAttachment: BridgePrivateAttachment | undefined;
    let privateAttachments: readonly BridgePrivateAttachment[] | undefined;
    let privateConversation: BridgePrivateConversation | undefined;
    if (fileStages) {
      try {
        const attachments: BridgePrivateAttachment[] = [];
        try {
          for (const fileStage of fileStages) {
            const staged = this.fileStages.consume(fileStage);
            try {
              attachments.push({
                schema: "morrow.private-file-attachment.v1",
                handle: fileStage.handle,
                manifest: { filename: staged.manifest.filename, size_bytes: staged.manifest.sizeBytes, sha256: staged.manifest.sha256 },
                ...(fileStage.scope.provider !== "moodle" ? { content_type: fileStage.scope.contentType } : {}),
                bytes_base64: Buffer.from(staged.bytes).toString("base64"),
              });
            } finally {
              staged.bytes.fill(0);
            }
          }
          if (attachments.length === 1) privateAttachment = attachments[0];
          else privateAttachments = attachments;
        } finally {
          this.operationFileStages.delete(reserved.operationId);
        }
      } catch (error) {
        const settled = this.effects.settleFailure(reserved.operationId, error, false);
        return this.effectResult(settled, "dispatch_failed");
      }
    }
    try {
      if (isCanvasConversationTransfer(mapping)) {
        const input = canvasConversationInputFromFrozenRequest(mapping, reserved.plan.arguments as JsonObject);
        const context = await this.canvasLearnerContext(mapping, reserved.plan.arguments as JsonObject);
        if (!context) throw new Error("learner_roster_source_unavailable");
        const resolved = resolveLearnerTokens({
          recipients: (input.recipient_tokens || []).map((learner_token) => ({ learner_token })),
        }, context.learnerVault, context.learnerScope);
        const recipientIds = Array.isArray(resolved.recipients)
          ? resolved.recipients.map((entry) => isJsonObject(entry) && typeof entry.learner_id === "string" ? entry.learner_id : "")
          : [];
        if (recipientIds.length !== (input.recipient_tokens || []).length || recipientIds.some((entry) => !entry)) {
          throw new Error("learner_token_unavailable");
        }
        privateConversation = normalizeBridgePrivateConversation({
          schema: "morrow.canvas-conversation.private.v1",
          action: input.action,
          courseId: String(input.course_id),
          recipients: [...recipientIds, ...(input.recipient_contexts || [])],
          body: input.body,
          ...(input.action === "create"
            ? {
                ...(input.subject === undefined ? {} : { subject: input.subject }),
                ...(input.group_conversation === undefined ? {} : { groupConversation: input.group_conversation }),
                ...(input.force_new === undefined ? {} : { forceNew: input.force_new }),
              }
            : { conversationId: input.conversation_id }),
        });
        forwarded = withoutCanvasConversationControl(forwarded);
      }
    } catch (error) {
      privateAttachment = undefined;
      privateAttachments = undefined;
      await operationUpstream?.close();
      const settled = this.effects.settleFailure(reserved.operationId, error, false);
      return this.effectResult(settled, "dispatch_failed");
    }
    try {
      result = await this.callSourceOwned(mapping.publicName, forwarded, {
        authorizedEffectOperationId: reserved.operationId,
        ...(privateAttachment ? { privateAttachment } : {}),
        ...(privateAttachments ? { privateAttachments } : {}),
        ...(privateConversation ? { privateConversation } : {}),
        ...(operationUpstream ? { sourceOverride: operationUpstream } : {}),
      });
    } finally {
      privateAttachment = undefined;
      privateAttachments = undefined;
      privateConversation = undefined;
      await operationUpstream?.close();
    }
    const source = classifySourceResult(result);
    if (result.isError === true) {
      const meta = isJsonObject(result._meta) && isJsonObject(result._meta["io.morrow/gateway"])
        ? result._meta["io.morrow/gateway"] : {};
      const innerOperationId = typeof meta.gatewayOperationId === "string"
        ? meta.gatewayOperationId
        : "";
      const innerOperation = innerOperationId
        ? this.journal.get(innerOperationId)
        : undefined;
      const definitelyNotSent = meta.gatewayOperationState === "failed_before_send"
        || source.state === "not_sent"
        || innerOperation?.sourceResultState === "not_sent";
      const settled = this.effects.settleFailure(reserved.operationId, result, !definitelyNotSent);
      const unresolved = settled.state === "applied_or_unknown" && usesEmbeddedReadback(mapping)
        ? connectorReadDescriptor(mapping, this.resolveResultArtifact(result))
        : null;
      return this.effectResult(
        unresolved ? this.effects.recordConnectorReadDescriptor(settled.operationId, unresolved) : settled,
        "dispatch_failed",
        result,
      );
    }
    const innerApprovalRequired = /awaiting.*approval|pending.*approval|staged/i.test(source.state || "")
      || (mapping.upstreamId === "example-legacy" && Boolean(source.taskId));
    const settled = this.effects.settleResponse(reserved.operationId, {
      upstreamResultDigest: sha256Json(result),
      ...(source.state ? { sourceResultState: source.state } : {}),
      ...(source.taskId ? { sourceTaskId: source.taskId } : {}),
      innerApprovalRequired,
    });
    if (settled.state === "awaiting_verification") {
      if (usesEmbeddedReadback(mapping)) {
        const artifact = this.resolveResultArtifact(result);
        const verification = connectorVerification(mapping, artifact) || {
          schema: "morrow.browser-verification.v1",
          status: "unconfirmed",
          reason: "connector_verification_missing",
        };
        const verified = verification.status === "verified";
        // The connector's own read comparator is kept with the record so an
        // unresolved change can be checked later without being sent again.
        const descriptor = connectorReadDescriptor(mapping, artifact);
        if (descriptor) this.effects.recordConnectorReadDescriptor(settled.operationId, descriptor);
        const readbackSettled = this.effects.recordReadback(
          settled.operationId,
          sha256Json(verification),
          verified,
        );
        return this.effectResult(
          readbackSettled,
          verified ? "verified_readback" : "readback_unconfirmed",
          result,
        );
      }
      return this.verifyOperation(settled.operationId);
    }
    return this.effectResult(settled, "dispatched", result);
  }

  private async meridianOperationUpstream(
    operation: EffectOperationRecord,
  ): Promise<StdioMcpUpstream> {
    const sourceConfig = this.config.upstreams.find((source) => source.id === operation.sourceId);
    if (!sourceConfig || sourceConfig.kind !== "meridian-ssh") {
      throw new Error("ExamplePlatform operation source configuration is unavailable");
    }
    if (sourceConfig.runtimeProfile.kind !== "private-runtime" || sourceConfig.runtimeProfile.mode !== "edit") {
      throw new Error("ExamplePlatform writes require an explicit private edit runtime profile");
    }
    const argumentsValue = isJsonObject(operation.plan.arguments) ? operation.plan.arguments : {};
    const courseId = typeof argumentsValue.course_id === "string"
      ? argumentsValue.course_id
      : typeof argumentsValue.courseId === "string"
        ? argumentsValue.courseId
        : sourceConfig.runtimeProfile.courseScope?.courseId;
    const privateAdapterModule = "./meridian-runtime-adapter.js";
    const launch = (await import(privateAdapterModule)).buildExamplePlatformSshLaunch({
      host: sourceConfig.host,
      remoteRoot: sourceConfig.remoteRoot,
      serverPath: sourceConfig.serverPath,
      runtimeProfile: {
        ...sourceConfig.runtimeProfile,
        mode: "edit",
        ...(courseId ? { courseScope: { courseId } } : {}),
        operation: {
          id: operation.operationId,
          taskContractDigest: sha256Json({
            operationId: operation.operationId,
            planDigest: operation.planDigest,
            approvalGrantDigest: operation.approvalGrantDigest,
            effectReceiptId: operation.effectReceiptId,
          }),
        },
      },
    });
    const referenceHealth = this.upstreams.get(operation.sourceId)?.health();
    const upstream = new StdioMcpUpstream({
      id: sourceConfig.id,
      label: `${sourceConfig.label} operation`,
      command: launch.command,
      args: launch.args,
      stderr: "ignore",
      priority: sourceConfig.priority,
      required: true,
      ...(referenceHealth?.expectedToolCount ? { expectedToolCount: referenceHealth.expectedToolCount } : {}),
      ...(referenceHealth?.expectedCatalogDigest ? { expectedCatalogDigest: referenceHealth.expectedCatalogDigest } : {}),
      ...(referenceHealth?.sourceAttestation ? { sourceAttestation: referenceHealth.sourceAttestation } : {}),
      ...(referenceHealth?.catalogTruth ? { catalogTruth: referenceHealth.catalogTruth } : {}),
      beforeConnect: () => {
        verifyRemoteGitSshSourceAttestation(
          sourceConfig.id,
          sourceConfig.repository,
          sourceConfig.attestation,
        );
      },
    });
    await upstream.connect();
    return upstream;
  }

  async verifyOperation(operationId: string): Promise<JsonObject> {
    const operation = this.effects.get(operationId);
    if (!operation.readback) {
      return this.effectResult(operation, "verification_unsupported");
    }
    if (isConnectorReadbackPolicy(operation.readback)) {
      return await this.connectorReadbackReconciliationResult(operation);
    }
    if (operation.state === "awaiting_inner_approval") {
      return this.effectResult(operation, "verification_requires_inner_approval");
    }
    const mapping = this.toolByPublicName.get(operation.readback.tool);
    if (!mapping || mapping.annotations?.readOnlyHint !== true) {
      return this.effectResult(operation, "verification_unsupported");
    }
    const fresh = this.resolveResultArtifact(await this.callSourceOwned(mapping.publicName, operation.readback.arguments));
    if (fresh.isError === true) return this.effectResult(operation, "verification_failed", fresh);
    const readbackDigest = sha256Json(resultComparable(fresh));
    const settled = this.effects.recordReadback(
      operation.operationId,
      readbackDigest,
      readbackDigest === operation.readback.expectedDigest,
    );
    return this.effectResult(settled, "verified_readback", fresh);
  }

  async settleInnerOperation(
    operationId: string,
    outcome: "ready_for_readback" | "failed_no_effect" | "effect_unknown",
  ): Promise<JsonObject> {
    const settled = this.effects.settleInnerApproval(operationId, outcome);
    return settled.state === "awaiting_verification"
      ? this.verifyOperation(operationId)
      : this.effectResult(settled, "inner_operation_settled");
  }

  async reconcileOperation(operationId: string): Promise<JsonObject> {
    const operation = this.effects.get(operationId);
    if (isConnectorReadbackPolicy(operation.readback)) {
      return await this.connectorReadbackReconciliationResult(operation);
    }
    if (["awaiting_verification", "applied_or_unknown"].includes(operation.state) && operation.readback) {
      return this.verifyOperation(operationId);
    }
    return this.effectResult(operation, "reconciliation_requires_provider_evidence");
  }

  /**
   * Finds the Morrow read the person actually looked at: a read-only call to the
   * same connection that answered after this change was sent, whose exact result
   * digest is the one supplied. A read from before the change, from another
   * connection, or one Morrow never made, is not evidence. Morrow searches its
   * 200 most recent answered reads for that connection.
   */
  private freshReadEvidence(
    operation: EffectOperationRecord,
    observedState: string,
  ): GatewayOperationRecord | null {
    const sentAt = Date.parse(operation.approvalConsumedAt || operation.createdAt);
    if (!Number.isFinite(sentAt)) return null;
    return this.journal.list({ sourceId: operation.sourceId, state: "response_received", limit: 200 })
      .find((record) => record.readOnly
        && record.upstreamResultDigest === observedState
        && Date.parse(record.createdAt) >= sentAt) || null;
  }

  /**
   * Closes one unresolved change after a person checked the item themselves.
   * Morrow sends nothing here and confirms nothing here: the record keeps its
   * unconfirmed verification status, and the close-out is refused unless it
   * carries an explicit person confirmation and the exact digest of a fresh
   * Morrow read. It is the exit for a change Morrow has no way to check.
   */
  closeUnresolvedOperation(
    operationId: string,
    observedState: string,
    confirmedByPerson: boolean,
  ): JsonObject {
    const refused = (
      code: string,
      text: string,
      detail: JsonObject = {},
      limitations: readonly string[] = [],
    ): JsonObject => canonicalMorrowResult({
      operationId,
      tool: "morrow_operation_close_unresolved",
      phase: "rejected",
      verificationStatus: "not_requested",
      ...(limitations.length ? { limitations: [...limitations] } : {}),
      result: {
        content: [{ type: "text", text }],
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code, recoverable: true, ...detail },
      },
    });
    if (confirmedByPerson !== true) {
      return refused(
        "person_confirmation_required",
        "Morrow closes an unresolved change only when a person says they checked the saved state themselves.",
      );
    }
    const operation = this.effects.get(operationId);
    if (!["awaiting_verification", "applied_or_unknown"].includes(operation.state)) {
      return refused(
        "operation_not_unresolved",
        "This request is already settled, so there is nothing to close.",
        { effectState: operation.state },
      );
    }
    const evidence = this.freshReadEvidence(operation, observedState);
    if (!evidence) {
      return refused(
        "observed_state_not_from_fresh_read",
        "That digest does not match any Morrow read of this connection made after the change was sent. Read the item with Morrow again and close this request with the digest that read returns.",
        {},
        [PERSON_CLOSE_READ_REQUIRED_LIMITATION],
      );
    }
    const closed = this.effects.closeAfterPersonCheck(operationId, observedState);
    return this.effectResult(closed, "closed_by_person", {
      content: [{
        type: "text",
        text: "Morrow closed this request because you checked the saved state yourself. Morrow did not confirm the change, and it will not send it again.",
      }],
      structuredContent: {
        schema: "morrow.operation-person-close.v1",
        observedState,
        readTool: evidence.publicToolName,
        readAt: evidence.createdAt,
        resentWrite: false,
      },
    });
  }

  private async connectorReadbackReconciliationResult(operation: EffectOperationRecord): Promise<JsonObject> {
    if (operation.state === "verified" && operation.verificationStatus === "verified") {
      return this.effectResult(operation, "verified_readback", undefined, [
        VERIFIED_CONNECTOR_READBACK_LIMITATION,
      ]);
    }
    if (["awaiting_verification", "applied_or_unknown"].includes(operation.state)) {
      return await this.recoverCanvasConnectorOperation(operation);
    }
    // A person already settled this record. Morrow does not check it again and
    // does not describe it as a record it failed to check.
    if (operation.state === "closed_by_person") {
      return this.effectResult(operation, "closed_by_person");
    }
    return this.effectResult(operation, "reconciliation_requires_provider_evidence", undefined, [
      operation.dispatchAttempt < 1 ? CONNECTOR_READBACK_NOT_SENT_LIMITATION : CONNECTOR_READBACK_RECOVERY_LIMITATION,
    ]);
  }

  /**
   * The provider clock is not this machine's clock. Five minutes of slack keeps
   * an honest match inside the window without widening it enough to pick up
   * unrelated course work.
   */
  private canvasRecoveryWindow(operation: EffectOperationRecord): { readonly start: number; readonly end: number } {
    const skew = 5 * 60_000;
    const started = Date.parse(operation.approvalConsumedAt || operation.createdAt);
    return {
      start: (Number.isFinite(started) ? started : Date.now()) - skew,
      end: Date.now() + skew,
    };
  }

  private async canvasRecoveryBindingMatches(mapping: CatalogTool, operation: EffectOperationRecord): Promise<boolean> {
    const frozen = isJsonObject(operation.plan.authority) ? operation.plan.authority : null;
    if (!frozen) return false;
    try {
      // effectBindingScope refuses a binding for another course, so this one
      // comparison covers course, sign-in principal and session generation.
      const prepared = await this.currentBrowserEffectAuthority(mapping, operation.plan.arguments as JsonObject);
      if (!prepared.bindingScope) return false;
      return sha256Json(prepared.bindingScope) === frozen.providerPrincipalDigest
        && sha256Json({
          account: this.config.privacy.account,
          principal: this.config.privacy.principal,
          bindingScope: prepared.bindingScope,
        }) === frozen.actorDigest;
    } catch {
      return false;
    }
  }

  private async canvasRecoveryRead(
    read: CanvasRecoveryRead,
    sourceBindingId: string | null,
  ): Promise<BrowserReadbackResult | null> {
    const mapping = this.toolByPublicName.get(read.readTool);
    // A recovery check reads and nothing else. A retained tool name that is not
    // one current read-only Canvas connector route is refused before any call.
    if (!mapping || mapping.annotations?.readOnlyHint !== true || !isCanvasConnector(mapping)) return null;
    const response = this.resolveResultArtifact(await this.callSourceOwned(mapping.publicName, {
      ...read.arguments,
      ...(sourceBindingId ? { _morrow: { source_binding_id: sourceBindingId } } : {}),
    }));
    const content = isJsonObject(response.structuredContent) ? response.structuredContent : null;
    const browser = content && isJsonObject(content.result) ? content.result : null;
    if (response.isError === true || !content || content.schema !== "morrow.canvas-connector.result.v1"
      || content.ok !== true || content.commandKind !== "invoke_read" || !browser) return null;
    return browser as BrowserReadbackResult;
  }

  private canvasRecoveryOutcome(evidence: JsonObject): JsonObject {
    return {
      content: [{ type: "text", text: "Morrow read Canvas again and confirmed the requested result." }],
      structuredContent: evidence,
    };
  }

  private canvasRecoveryPlan(descriptor: CanvasRecoveryDescriptor): BrowserReadbackPlan {
    const read = descriptor.read!;
    return {
      schema: "morrow.browser-readback-plan.v1",
      strategy: descriptor.strategy,
      readOperation: {
        toolName: read.readTool,
        ...(read.readOperationKey ? { key: read.readOperationKey } : {}),
        nickname: "",
        service: "canvas",
        method: "GET",
        path: "",
        readOnly: true,
      },
      arguments: read.arguments,
      assertions: descriptor.assertions,
      ...(read.targetId === undefined ? {} : { targetId: read.targetId }),
      ...(read.targetField === undefined ? {} : { targetField: read.targetField }),
      ...(read.targetPath === undefined ? {} : { targetPath: read.targetPath }),
    };
  }

  /**
   * A browser POST can land more than once, so a create is judged on the parent
   * collection: how many records carry the requested field set and were created
   * inside this operation's window.
   */
  private canvasDuplicateScan(
    descriptor: CanvasRecoveryDescriptor,
    browser: BrowserReadbackResult,
    window: { readonly start: number; readonly end: number },
  ): { readonly outcome: "duplicate" | "single" | "none" | "unavailable"; readonly reason: string; readonly matched: number } {
    if (descriptor.assertions.length === 0) return { outcome: "unavailable", reason: "no_requested_field_set", matched: 0 };
    if (browser.truncated === true) return { outcome: "unavailable", reason: "collection_readback_incomplete", matched: 0 };
    if (!Array.isArray(browser.data)) return { outcome: "unavailable", reason: "collection_readback_shape_invalid", matched: 0 };
    const matched = browser.data.filter((record) => matchesReadbackAssertions(record, descriptor.assertions));
    const created = matched.map((record) => Date.parse(String(readbackFieldValue(record, "created_at") ?? "")));
    if (created.some((value) => !Number.isFinite(value))) {
      // Without a creation time the window cannot separate this change from a
      // record that was already there, so a second match is reported as a
      // suspected duplicate and a single match proves nothing.
      return matched.length > 1
        ? { outcome: "duplicate", reason: "multiple_matching_records_without_creation_time", matched: matched.length }
        : { outcome: "unavailable", reason: "record_created_at_unavailable", matched: matched.length };
    }
    const inWindow = created.filter((value) => value >= window.start && value <= window.end).length;
    if (inWindow > 1) return { outcome: "duplicate", reason: "multiple_records_created_in_operation_window", matched: matched.length };
    if (inWindow === 1) return { outcome: "single", reason: "one_record_created_in_operation_window", matched: matched.length };
    return { outcome: "none", reason: "no_record_created_in_operation_window", matched: matched.length };
  }

  /**
   * Checks one unresolved Canvas change by running only its retained read-only
   * comparator against the current course connection. It never sends the change
   * again. A resolved verified result releases the target through the ordinary
   * terminal-state rule; anything else leaves the record unresolved and locked.
   */
  private async recoverCanvasConnectorOperation(operation: EffectOperationRecord): Promise<JsonObject> {
    const descriptor = canvasRecoveryDescriptorOf(operation.connectorReadDescriptor);
    const mapping = this.toolByPublicName.get(operation.publicToolName);
    if (!descriptor || !mapping || !isCanvasConnector(mapping)) {
      return this.effectResult(operation, "reconciliation_requires_provider_evidence", undefined, [
        CONNECTOR_READBACK_RECOVERY_LIMITATION,
      ]);
    }
    if (!await this.canvasRecoveryBindingMatches(mapping, operation)) {
      return this.effectResult(operation, "reconciliation_refused_binding_changed", undefined, [
        CONNECTOR_RECOVERY_BINDING_CHANGED_LIMITATION,
        CONNECTOR_RECOVERY_READ_ONLY_NOTE,
      ]);
    }
    const window = this.canvasRecoveryWindow(operation);
    const evidence: JsonObject = {
      schema: "morrow.canvas-operation-recovery.v1",
      strategy: descriptor.strategy,
      writeMethod: descriptor.writeMethod,
      resentWrite: false,
    };
    let collection: BrowserReadbackResult | null = null;
    let scan: ReturnType<GatewayRuntime["canvasDuplicateScan"]> | null = null;
    if (descriptor.collection && descriptor.writeMethod === "POST"
      && ["created-resource", "collection-contains-target"].includes(descriptor.strategy)) {
      collection = await this.canvasRecoveryRead(descriptor.collection, operation.sourceBindingId);
      scan = collection
        ? this.canvasDuplicateScan(descriptor, collection, window)
        : { outcome: "unavailable", reason: "collection_read_unavailable", matched: 0 };
      evidence.duplicateScan = {
        readTool: descriptor.collection.readTool,
        outcome: scan.outcome,
        reason: scan.reason,
        matchedRecords: scan.matched,
      };
      if (scan.outcome === "duplicate") {
        return this.effectResult(operation, "duplicate_effect_suspected", { structuredContent: evidence }, [
          CONNECTOR_RECOVERY_DUPLICATE_LIMITATION,
          CONNECTOR_RECOVERY_READ_ONLY_NOTE,
        ]);
      }
    }
    if (descriptor.read) {
      const reuse = collection && descriptor.collection
        && descriptor.collection.readTool === descriptor.read.readTool
        && sha256Json(descriptor.collection.arguments) === sha256Json(descriptor.read.arguments);
      const fresh = reuse ? collection : await this.canvasRecoveryRead(descriptor.read, operation.sourceBindingId);
      const verification = fresh
        ? evaluateBrowserReadback(this.canvasRecoveryPlan(descriptor), fresh)
        : { schema: "morrow.browser-verification.v1" as const, status: "unconfirmed" as const, reason: "fresh_readback_unavailable" };
      evidence.verification = structuredClone(verification) as unknown as JsonObject;
      const settled = this.effects.recordReadback(
        operation.operationId,
        sha256Json(verification),
        verification.status === "verified",
      );
      return verification.status === "verified"
        ? this.effectResult(settled, "verified_readback", this.canvasRecoveryOutcome(evidence), [CONNECTOR_RECOVERY_READ_ONLY_NOTE])
        : this.effectResult(settled, "readback_unconfirmed", { structuredContent: evidence }, [
          CONNECTOR_RECOVERY_UNRESOLVED_LIMITATION,
          CONNECTOR_RECOVERY_READ_ONLY_NOTE,
        ]);
    }
    if (scan?.outcome === "single" && descriptor.collection) {
      const verification = {
        schema: "morrow.browser-verification.v1" as const,
        status: "verified" as const,
        strategy: descriptor.strategy,
        readTool: descriptor.collection.readTool,
        evidence: "fresh_collection_holds_one_record_created_in_operation_window",
      };
      evidence.verification = structuredClone(verification) as unknown as JsonObject;
      const settled = this.effects.recordReadback(operation.operationId, sha256Json(verification), true);
      return this.effectResult(settled, "verified_readback", this.canvasRecoveryOutcome(evidence), [CONNECTOR_RECOVERY_READ_ONLY_NOTE]);
    }
    return this.effectResult(operation, "readback_unconfirmed", { structuredContent: evidence }, [
      CONNECTOR_RECOVERY_UNRESOLVED_LIMITATION,
      CONNECTOR_RECOVERY_READ_ONLY_NOTE,
    ]);
  }

  undoOperation(
    operationId: string,
    correctionTool: string,
    correctionArguments: Readonly<Record<string, unknown>>,
  ): JsonObject {
    const original = this.effects.get(operationId);
    const undo = isJsonObject(original.plan.undo) ? original.plan.undo : {};
    if (undo.supported !== true) {
      throw new Error("The frozen operation plan has no exact undo facts");
    }
    const mapping = this.toolByPublicName.get(correctionTool);
    if (!mapping || mapping.annotations?.readOnlyHint === true) {
      throw new Error("A correction must use one current mutating Morrow tool");
    }
    const controls = outerOperationControls(correctionArguments);
    if (!controls.readback) throw new Error("A correction requires its own frozen readback comparator");
    const correction = this.planEffect(mapping, controls, REVIEW_AUTHORIZATION, original.operationId);
    return this.effectResult(correction, "correction_planned");
  }

  async callSourceOwned(
    publicName: string,
    args: Readonly<Record<string, unknown>>,
    options: {
      readonly signal?: AbortSignal;
      readonly authorizedEffectOperationId?: string;
      readonly sourceOverride?: StdioMcpUpstream;
      readonly privateAttachment?: BridgePrivateAttachment;
      readonly privateAttachments?: readonly BridgePrivateAttachment[];
      readonly privateConversation?: BridgePrivateConversation;
    } = {},
  ): Promise<JsonObject> {
    const mapping = this.toolByPublicName.get(publicName);
    if (!mapping) {
      return {
        content: [{ type: "text", text: `Unknown Morrow tool ${publicName}.` }],
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code: "tool_not_found" },
      };
    }
    try {
      assertNoPrivateAttachmentInput(args);
      if (options.privateAttachment && (!(isMoodleStagedFile(mapping) || isCanvasCourseFileTransfer(mapping) || isBlackboardAttachment(mapping)) || !options.authorizedEffectOperationId)) {
        throw new TypeError("private_attachment_target_invalid");
      }
      if (options.privateAttachments && (!isMoodleStagedFile(mapping) || moodleStagedFileCapabilityForMapping(mapping)?.planMode !== "folder_add" || !options.authorizedEffectOperationId)) {
        throw new TypeError("private_attachments_target_invalid");
      }
      if (options.privateAttachment && options.privateAttachments) throw new TypeError("private_attachment_target_invalid");
      if (options.privateConversation && (!isCanvasConversationTransfer(mapping) || !options.authorizedEffectOperationId)) {
        throw new TypeError("private_conversation_target_invalid");
      }
    } catch {
      return {
        content: [{ type: "text", text: "Prepare a local file for review before sending it to the learning platform." }],
        isError: true,
        structuredContent: { schema: "morrow.problem.v1", code: "private_file_input_refused", resultState: "not_sent" },
      };
    }
    if (mapping.annotations?.readOnlyHint !== true && !options.authorizedEffectOperationId?.startsWith("op:")) {
      return {
        content: [{ type: "text", text: "Morrow refused a provider write without an outer effect reservation." }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "provider_effect_reservation_required",
          recoverable: false,
        },
      };
    }

    if (options.signal?.aborted) {
      return {
        content: [{ type: "text", text: `Morrow cancelled ${publicName} before source dispatch.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "request_cancelled_before_dispatch",
          recoverable: true,
        },
      };
    }

    const routed = withSourceOperationId(mapping, args);
    const requestDigest = sha256Json(args);
    const forwardedRequestDigest = sha256Json(routed.forwarded);
    let prepared;
    try {
      prepared = this.journal.prepare({
        publicToolName: mapping.publicName,
        sourceId: mapping.upstreamId,
        sourceToolName: mapping.upstreamName,
        catalogDigest: this.catalog.digest,
        requestDigest,
        forwardedRequestDigest,
        ...(routed.sourceOperationId ? { sourceOperationId: routed.sourceOperationId } : {}),
        ...(routed.idempotencyKey ? { idempotencyKey: routed.idempotencyKey } : {}),
        readOnly: mapping.annotations?.readOnlyHint === true,
      });
    } catch (error) {
      if (error instanceof GatewayOperationConflictError) {
        return {
          content: [{ type: "text", text: "The operation identity is already bound to a different exact request." }],
          isError: true,
          structuredContent: {
            schema: "morrow.problem.v1",
            code: error.code,
            recoverable: false,
            detailDigest: sha256Text(error.message),
          },
        };
      }
      throw error;
    }

    if (!prepared.created) {
      return replayResult(mapping, this.catalog.digest, prepared.record, this.config.profile);
    }

    if (options.signal?.aborted) {
      const cancelled = this.journal.recordFailedBeforeSend(
        prepared.record.operationId,
        new Error("request cancelled before source dispatch"),
      );
      return attachOperationMeta({
        content: [{ type: "text", text: `Morrow cancelled ${publicName} before source dispatch.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "request_cancelled_before_dispatch",
          recoverable: true,
        },
      }, mapping, this.catalog.digest, cancelled, this.config.profile);
    }

    const upstream = options.sourceOverride || this.upstreams.get(mapping.upstreamId);
    if (!upstream) {
      const failed = this.journal.recordFailedBeforeSend(
        prepared.record.operationId,
        new Error("upstream unavailable"),
      );
      return attachOperationMeta({
        content: [{ type: "text", text: `The source for ${publicName} is unavailable.` }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "upstream_unavailable",
          source: mapping.upstreamId,
        },
      }, mapping, this.catalog.digest, failed, this.config.profile);
    }

    const baseContext = { mapping, catalogDigest: this.catalog.digest };
    let dispatchedArguments: Record<string, unknown>;
    try {
      // A source-owned read stays private. Resolve a learner token only when
      // the request actually carries one, using the fresh binding scope.
      if (!this.hasLearnerToken(routed.forwarded)) {
        dispatchedArguments = structuredClone(routed.forwarded) as Record<string, unknown>;
      } else {
        const learner = await this.canvasLearnerContext(mapping, routed.forwarded, options);
        dispatchedArguments = learner
          ? resolveLearnerTokens(routed.forwarded, this.learnerVault, learner.learnerScope)
          : resolveLearnerTokens(routed.forwarded, this.learnerVault, {
            canvasOrigin: this.config.privacy.canvasOrigin,
            account: this.config.privacy.account,
            course: this.requestCourseId(routed.forwarded) || "unbound",
            principal: this.config.privacy.principal,
            profile: this.config.profile,
          });
      }
    } catch (error) {
      const failed = this.journal.recordFailedBeforeSend(prepared.record.operationId, error);
      return attachOperationMeta({
        content: [{ type: "text", text: "Morrow could not resolve the supplied learner token." }],
        isError: true,
        structuredContent: {
          schema: "morrow.problem.v1",
          code: "learner_token_unavailable",
          recoverable: false,
        },
      }, mapping, this.catalog.digest, failed, this.config.profile);
    }
    const dispatched = this.journal.markDispatched(prepared.record.operationId);
    try {
      if (options.privateAttachment) dispatchedArguments.privateAttachment = options.privateAttachment;
      if (options.privateAttachments) dispatchedArguments.privateAttachments = options.privateAttachments;
      if (options.privateConversation) dispatchedArguments.privateConversation = options.privateConversation;
      const result = await upstream.callTool(mapping.upstreamName, dispatchedArguments, {
        signal: options.signal,
        safeToRetry: mapping.upstreamId === "meridian"
          && mapping.annotations?.readOnlyHint === true,
      });
      if (!isJsonObject(result)) throw new Error("upstream_result_invalid");
      const source = classifySourceResult(result);
      const complete = this.journal.recordResponse(dispatched.operationId, {
        upstreamResultDigest: sha256Json(result),
        normalizedResultDigest: sha256Json(result),
        ...(source.state ? { sourceResultState: source.state } : {}),
        ...(source.taskId ? { sourceTaskId: source.taskId } : {}),
      });
      // Internal callers receive the raw source envelope. Public callers pass
      // through publicSourceResult or redactMcpEgress before MCP serialization.
      return attachOperationMeta(result, mapping, this.catalog.digest, complete, this.config.profile);
    } catch (error) {
      const unknown = this.journal.recordSourceUnknown(dispatched.operationId, error);
      const failure = safeUpstreamFailure(error, baseContext);
      if (options.signal?.aborted) {
        failure.structuredContent = {
          schema: "morrow.problem.v1",
          code: "request_cancelled_after_dispatch",
          recoverable: false,
          source: mapping.upstreamId,
          detailDigest: sha256Text(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
        };
      }
      return attachOperationMeta(failure, mapping, this.catalog.digest, unknown, this.config.profile);
    } finally {
      delete dispatchedArguments.privateAttachment;
      delete dispatchedArguments.privateAttachments;
      delete dispatchedArguments.privateConversation;
    }
  }

  /**
   * Runs the one fixed Bridge-maintenance source command for the authenticated
   * desktop owner. It deliberately has no public catalog mapping, operation
   * record, caller-selected tool name, or caller-selected upstream.
   */
  async callInternalBridgeMaintenance(
    command: Readonly<Record<string, unknown>>,
  ): Promise<JsonObject> {
    const connectorSources = new Set(this.catalog.tools
      .filter((tool) => tool.capability?.route.backend === "canvas-connector")
      .map((tool) => tool.upstreamId));
    if (connectorSources.size !== 1) {
      throw new Error("The private Bridge maintenance source is unavailable.");
    }
    const sourceId = [...connectorSources][0]!;
    const upstream = this.upstreams.get(sourceId);
    if (!upstream) throw new Error("The private Bridge maintenance source is unavailable.");
    const result = await upstream.callTool("morrow_bridge_maintenance", command, { safeToRetry: false });
    if (!isJsonObject(result)) throw new Error("The private Bridge maintenance result is invalid.");
    return structuredClone(result);
  }

  async close(): Promise<void> {
    this.fileStages.clear();
    this.operationFileStages.clear();
    await Promise.allSettled([...this.upstreams.values()].map((upstream) => upstream.close()));
    this.journal.close();
    this.effects.close();
  }

  recordGeneratedArtifact(bytes: Uint8Array): string {
    return this.artifacts.record(bytes);
  }
}
