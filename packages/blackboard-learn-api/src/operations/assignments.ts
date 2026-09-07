import { canonicalJson, isJsonObject, sha256Text, type JsonObject, type SourceCapabilityMetadata } from "@morrow/contracts";
import * as z from "zod/v4";
import type { BlackboardEffectGrant } from "../effect-grant.js";
import { safeContent, type BlackboardCourseRead, type BlackboardLearnRuntime } from "../runtime.js";
import { BLACKBOARD_ID, BlackboardApiError, withBlackboardDispatchState, type BlackboardDispatchState } from "../types.js";
import { blackboardTool, contentScopeInput, effectGrantInput, scopeInput, type BlackboardOperationModule } from "./definition.js";
import { READ_ANNOTATIONS, READ_BEHAVIOR, READ_PROFILES } from "./course-read.js";
// Morrow changes an assignment's points possible and its due date through the
// gradebook column routes in `gradebook.ts`, and adds no second writer for
// either. This module therefore reads that column through the same path, the
// same field list, the same date comparison, and the same projection those
// routes use, so the two can never disagree about one column.
import { COLUMN_FIELDS, columnPath, columnsPath, instant, safeColumn, withFields } from "./gradebook.js";

/**
 * Blackboard's Ultra assignment route. Anthology documents that it creates the
 * assignment and the gradebook column that grades it, and that its response
 * carries the ids of what it created rather than the assignment itself, so
 * everything Morrow reports about a created assignment comes from re-reading
 * those ids.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 */
const CREATE_ASSIGNMENT_ROUTE = "/learn/api/public/v1/courses/{course_id}/contents/createAssignment";
const CONTENT_ROUTE = "/learn/api/public/v1/courses/{course_id}/contents/{content_id}";
const COURSE_ROUTE = "/learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,ultraStatus,closedComplete";
const GRADEBOOK_COLUMNS_ROUTE = "/learn/api/public/v2/courses/{course_id}/gradebook/columns";

/**
 * The provider limit Morrow states plainly instead of working around it.
 * Anthology removed adding questions to an assignment through the REST API in
 * Learn 3900.98, and its public Learn REST documentation names no route for a
 * test, a question, or a question bank. Every tool in this module carries this
 * sentence, and a request that asks Morrow to add a question is refused with it
 * before anything is sent.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 */
const QUESTION_LIMIT = "Blackboard removed adding questions to an assignment through its REST API in Learn 3900.98, and its public REST documentation names no route for a test, a question, or a question bank. Morrow creates a Blackboard assignment and reads what a test is called and what it is worth. It cannot add, read, or change one question inside either. Write the questions in Blackboard.";

/**
 * The Ultra content handler a test and an assignment appear under. Anthology's
 * content-handler reference lists it as Ultra-only, and lists
 * `resource/x-bb-assignment` as the Original equivalent, which Morrow does not
 * read here.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler
 */
const TEST_LINK_HANDLER = "resource/x-bb-asmt-test-link";

/**
 * The request and response field names this module sends and reads. Anthology
 * documents the route and what it creates, and no tenant Swagger has been read,
 * so every name here is unverified against a live Learn site. Nothing treats a
 * missing field as an answer: a response that does not carry the name Morrow
 * read is a failure that names the field it looked for.
 */
const TITLE_FIELD = "title";
const INSTRUCTIONS_FIELD = "instructions";
const SCORE_FIELD = "score";
const GRADING_FIELD = "grading";
const CREATED_CONTENT_FIELD = "contentId";
const CREATED_COLUMN_FIELD = "gradebookColumnId";

/**
 * Morrow's own bounds on one reviewed assignment. They are not tenant limits: no
 * tenant Swagger has been read. They exist so a mistyped points value or a
 * pasted document is refused here, before review, instead of being sent to a
 * course.
 */
const MAX_TITLE = 255;
const MAX_INSTRUCTIONS = 5_000;
const MAX_POINTS = 1_000_000;

const SHA256 = /^[0-9a-f]{64}$/;

/** One short provider vocabulary value, such as `Ultra` or `Original`. */
const PROVIDER_ENUM = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** What every reviewed Blackboard change reports about itself, by Morrow profile. */
const WRITE_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "profile_limited", reason: "This action requires an approved Morrow effect." },
} as const;

const COMPARATOR_PROFILES = {
  "private-full": { state: "supported" },
  "public-canvas": { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  sandbox: { state: "profile_limited", reason: "This action needs a configured Blackboard REST tenant." },
  "read-only": { state: "private_only", reason: "Gateway-only Blackboard verification." },
} as const;

const EVIDENCE = {
  live: { state: "unknown", reason: "api_configured_live_untested" },
  credentialBoundary: { state: "known" },
} as const;

/**
 * A caller may name questions in a request. The field exists so the refusal
 * below is the answer, rather than an unreadable schema error: an assistant that
 * asks Morrow to build a Blackboard quiz reads the provider limit and what
 * Morrow does instead.
 */
const questionsInput = z.array(z.unknown()).max(500).optional();

const assignmentInput = {
  title: z.string().min(1).max(MAX_TITLE),
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS),
  points_possible: z.number(),
  due: z.string().min(1).max(64),
  questions: questionsInput,
};

const assessmentInput = contentScopeInput;
const assignmentPlanInput = scopeInput.extend(assignmentInput);
const assignmentApplyInput = assignmentPlanInput.extend({
  expected_plan_digest: z.string().regex(SHA256),
  _morrow: z.strictObject({ outer_grant: effectGrantInput }),
});

type AssignmentPlanInput = z.output<typeof assignmentPlanInput>;

/** The one assignment a plan carries, with every Morrow bound already applied. */
interface ReviewedAssignment {
  readonly title: string;
  readonly instructions: string;
  readonly pointsPossible: number;
  readonly due: string;
}

function contentsPath(courseId: string): string {
  return `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents`;
}

function contentPath(courseId: string, contentId: string): string {
  return `${contentsPath(courseId)}/${encodeURIComponent(contentId)}`;
}

function coursePath(courseId: string): string {
  return `/learn/api/public/v3/courses/${encodeURIComponent(courseId)}?fields=id,courseId,name,ultraStatus,closedComplete`;
}

function createAssignmentPath(courseId: string): string {
  return `${contentsPath(courseId)}/createAssignment`;
}

/** One Blackboard record identifier Morrow can name a record by, or `null`. */
function exactId(value: unknown): string | null {
  return typeof value === "string" && BLACKBOARD_ID.test(value) ? value : null;
}

/** One reviewed text value. Morrow sends the text it was given, with nothing trimmed off it. */
function reviewedText(value: string, label: string, max: number): string {
  if (!value || value.length > max || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new BlackboardApiError("blackboard_response_invalid", `The Blackboard ${label} is invalid.`);
  }
  return value;
}

/**
 * The exact assignment one plan reviews and one dispatch sends. A request that
 * names questions is refused here, before any Blackboard request, with the
 * provider limit as the reason.
 */
function reviewedAssignment(input: AssignmentPlanInput): ReviewedAssignment {
  if (input.questions !== undefined) {
    throw new BlackboardApiError("blackboard_operation_unavailable", QUESTION_LIMIT);
  }
  const due = instant(input.due);
  if (!due) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      "Morrow sets one due date on a Blackboard assignment, written as one exact instant such as 2026-09-30T23:59:00.000Z.",
    );
  }
  if (!Number.isFinite(input.points_possible) || input.points_possible < 0 || input.points_possible > MAX_POINTS) {
    throw new BlackboardApiError(
      "blackboard_response_invalid",
      `Morrow sets the points possible on a Blackboard assignment to one number between 0 and ${MAX_POINTS}.`,
    );
  }
  return {
    title: reviewedText(input.title, "assignment title", MAX_TITLE),
    instructions: reviewedText(input.instructions, "assignment instructions", MAX_INSTRUCTIONS),
    pointsPossible: input.points_possible,
    due,
  };
}

/**
 * The exact request one approved dispatch sends. Anthology documents this route
 * and what it creates; it does not state this request shape field by field, and
 * no tenant Swagger has been read, so a site that stores something else fails
 * the readback below rather than being reported as a saved assignment.
 */
function createRequest(assignment: ReviewedAssignment): JsonObject {
  return {
    [TITLE_FIELD]: assignment.title,
    [INSTRUCTIONS_FIELD]: assignment.instructions,
    [SCORE_FIELD]: { possible: assignment.pointsPossible },
    [GRADING_FIELD]: { due: assignment.due },
  };
}

/**
 * One digest over the tenant, the course connection, the course, and the exact
 * reviewed assignment. A create has no earlier record to freeze, so this is the
 * whole precondition: nothing already in the course decides whether this
 * assignment can be added to it. The conditions the course itself sets are
 * checked again inside the dispatch, against a fresh read.
 */
function assignmentPlanDigest(read: BlackboardCourseRead, assignment: ReviewedAssignment): string {
  return sha256Text(canonicalJson({
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    assignment: {
      title: assignment.title,
      instructions: assignment.instructions,
      pointsPossible: assignment.pointsPossible,
      due: assignment.due,
    },
  }));
}

/**
 * The Ultra mode this route needs. Anthology documents `createAssignment` as the
 * Ultra assignment route, and its content-handler reference gives Original
 * courses a separate assignment handler that Morrow does not write. A course
 * Blackboard reports as anything but Ultra is therefore refused here, before the
 * create request, and the refusal names what the site reported.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 */
const ULTRA_STATUS = "Ultra";

/** One course read that proves this course takes an Ultra assignment at all. */
async function assertUltraCourse(read: BlackboardCourseRead, signal?: AbortSignal): Promise<void> {
  const course = await read.client.get(coursePath(read.courseId), signal);
  if (course.id !== read.courseId) {
    throw new BlackboardApiError("blackboard_course_unavailable", "Blackboard returned a different course for this exact course connection.");
  }
  if (course.ultraStatus !== ULTRA_STATUS) {
    const reported = typeof course.ultraStatus === "string" && PROVIDER_ENUM.test(course.ultraStatus) ? course.ultraStatus : "no course mode";
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      `Morrow creates a Blackboard Ultra assignment, which needs a course Blackboard reports as ${ULTRA_STATUS}. Blackboard reports this course as ${reported}.`,
    );
  }
}

/**
 * Every gradebook column this course already holds, read immediately before the
 * create request. It is what lets the dispatch refuse to report a column that
 * was in the course before this change as the one Blackboard generated for this
 * assignment. The read is complete or it refuses, so this check has no gap.
 */
async function existingColumnIds(read: BlackboardCourseRead, signal?: AbortSignal): Promise<readonly string[]> {
  const columns = await read.client.collect(columnsPath(read.courseId), { label: "gradebook column", fields: COLUMN_FIELDS, signal });
  return columns.map((column) => exactId(column.id)).filter((id): id is string => id !== null);
}

function mismatch(detail: string, dispatchState: BlackboardDispatchState): BlackboardApiError {
  return new BlackboardApiError("blackboard_content_mismatch", detail, undefined, dispatchState);
}

/**
 * One test or assignment as this module returns it: the content projection every
 * other Morrow content read returns, plus the handler that says what kind of
 * item it is.
 */
function safeAssessment(record: JsonObject, read: BlackboardCourseRead): JsonObject {
  const output = safeContent(record, read.roster);
  output.contentHandler = { id: TEST_LINK_HANDLER };
  return output;
}

/**
 * The item has to be one Blackboard returned for this exact course, under the
 * Ultra test and assignment handler. Morrow reports what a test is called and
 * what it is worth; it does not claim to read or author anything inside it.
 */
function assertAssessment(record: JsonObject, courseId: string, contentId: string): JsonObject {
  if (record.id !== contentId) {
    throw new BlackboardApiError("blackboard_content_mismatch", "Blackboard returned a different content item than the one Morrow asked for.");
  }
  if (record.courseId !== courseId) {
    throw new BlackboardApiError("blackboard_scope_binding_mismatch", "Blackboard did not return this content item as part of the selected course.");
  }
  const handler = isJsonObject(record.contentHandler) && typeof record.contentHandler.id === "string" ? record.contentHandler.id : "";
  if (handler !== TEST_LINK_HANDLER) {
    throw new BlackboardApiError(
      "blackboard_operation_unavailable",
      handler
        ? `This Blackboard item is ${handler}. Morrow reads a test or an assignment here, which Blackboard returns as ${TEST_LINK_HANDLER}.`
        : "Blackboard did not name a content handler for this item, so Morrow cannot tell whether it is a test or an assignment.",
    );
  }
  return record;
}

/**
 * What the readback after one create proves, in plain words. Every value comes
 * from re-reading the two records Blackboard named, by the ids it returned.
 */
const READBACK_DETAIL = "Morrow re-read the content item Blackboard created and the gradebook column Blackboard generated for it, each by the id Blackboard returned, and compared the title, the points possible, and the due date. It compared the instructions, and the item the column grades, where the site returned each of them under that name, and says so where it did not. The gradebook column cannot be one that was already in the course before this change.";

const READBACK_STATE = "content_and_gradebook_column";

function readCapability(sourceExport: string): SourceCapabilityMetadata {
  return {
    family: "course-read",
    provider: "blackboard",
    sourceExport,
    behavior: READ_BEHAVIOR,
    authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
    route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
    profiles: READ_PROFILES,
    evidence: EVIDENCE,
  };
}

/**
 * One selected test or assignment, and the gradebook column that grades it. The
 * column is where its points possible and its due date live, and it is the one
 * place Morrow changes either: `blackboard_plan_gradebook_column_patch` reviews
 * that change and there is no second writer for it.
 */
async function readCourseAssessment(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof assessmentInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const read = await runtime.beginCourseRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const record = assertAssessment(await read.client.get(contentPath(read.courseId, input.content_id), signal), read.courseId, input.content_id);
  const columns = await read.client.collect(columnsPath(read.courseId), { label: "gradebook column", fields: COLUMN_FIELDS, signal });
  const graded = columns.filter((column) => column.contentId === input.content_id);
  return {
    schema: "morrow.blackboard.course-assessment.v1",
    ok: true,
    tenantId: read.tenantId,
    sourceBindingId: read.sourceBindingId,
    courseId: read.courseId,
    contentId: input.content_id,
    assessment: safeAssessment(record, read),
    // One column grades one item. Where a course holds none or more than one for
    // this item, Morrow names that state instead of choosing one of them.
    gradebookColumnState: graded.length === 1 ? "one" : graded.length === 0 ? "none" : "several",
    ...(graded.length === 1 ? { gradebookColumn: safeColumn(graded[0]!, read) } : {}),
    questions: "unavailable",
    questionLimit: QUESTION_LIMIT,
    status: "api_configured_live_untested",
    diagnostics: read.cost(),
  };
}

/** One reviewed Ultra assignment, frozen exactly as it will be sent. */
async function planUltraAssignment(
  runtime: BlackboardLearnRuntime,
  input: AssignmentPlanInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const assignment = reviewedAssignment(input);
  // A plan exists only to be dispatched, so it carries the write condition. An
  // instructor is refused before review instead of after approving a change
  // Morrow would then refuse to send.
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  await assertUltraCourse(write, signal);
  return {
    schema: "morrow.blackboard.ultra-assignment.plan.v1",
    ok: true,
    tenantId: write.tenantId,
    sourceBindingId: write.sourceBindingId,
    courseId: write.courseId,
    assignment: {
      title: assignment.title,
      instructions: assignment.instructions,
      pointsPossible: assignment.pointsPossible,
      due: assignment.due,
    },
    planDigest: assignmentPlanDigest(write, assignment),
    reviewRequired: true,
    limits: { assignments: 1, questions: 0, files: 0 },
    questionLimit: QUESTION_LIMIT,
    readback: READBACK_STATE,
    readbackDetail: READBACK_DETAIL,
    status: "api_configured_live_untested",
    effect_scope: runtime.effectScope({
      tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
    }),
    diagnostics: write.cost(),
  };
}

function reservedGrant(value: z.output<typeof effectGrantInput>): BlackboardEffectGrant {
  return {
    schema: value.schema,
    operationId: value.operation_id,
    planDigest: value.plan_digest,
    outerPlanDigest: value.outer_plan_digest,
    approvalGrantDigest: value.approval_grant_digest,
    effectReceiptId: value.effect_receipt_id,
    dispatchAttempt: value.dispatch_attempt,
    gatewayProcessId: value.gateway_process_id,
    dispatchToken: value.dispatch_token,
  };
}

/**
 * The one dispatch: it sends one create request and then re-reads both records
 * Blackboard named. Everything it can refuse it refuses before that request
 * leaves this process, and the one-use receipt is spent before the first
 * provider request, so two dispatches of one approval cannot both create an
 * assignment.
 *
 * A create cannot be undone through this route. Once the request has left
 * Morrow, every failure below it is reported as `applied_or_unknown`: a
 * gradebook column Blackboard did not name, a record Morrow could not read
 * back, and a value that came back different are all conditions where an
 * assignment may exist in the course.
 */
async function applyReviewedUltraAssignment(
  runtime: BlackboardLearnRuntime,
  input: z.output<typeof assignmentApplyInput>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const grant = reservedGrant(input._morrow.outer_grant);
  runtime.assertReservedEffectGrant(grant);
  if (grant.planDigest !== input.expected_plan_digest) {
    throw new BlackboardApiError("blackboard_patch_review_required", "The Blackboard effect grant does not match this exact reviewed plan.");
  }
  const assignment = reviewedAssignment(input);
  runtime.claimReservedEffectGrant(grant);
  const write = await runtime.beginCourseWrite({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  if (assignmentPlanDigest(write, assignment) !== input.expected_plan_digest) {
    throw new BlackboardApiError(
      "blackboard_patch_review_required",
      "This request does not describe the Blackboard assignment that was reviewed. Nothing was created.",
    );
  }
  await assertUltraCourse(write, signal);
  const existingColumns = await existingColumnIds(write, signal);
  // Morrow cannot prove a change did not land once the create request has left
  // this process. The marker is set on the line before that request, so every
  // failure from here on is reported as applied_or_unknown, and every refusal
  // raised above this point keeps not_sent.
  let dispatchState: BlackboardDispatchState = "not_sent";
  try {
    dispatchState = "applied_or_unknown";
    const created = await write.client.post(createAssignmentPath(write.courseId), createRequest(assignment), signal);
    const contentId = created ? exactId(created[CREATED_CONTENT_FIELD]) : null;
    if (!contentId) {
      throw mismatch(`Blackboard did not name the content item it created (${CREATED_CONTENT_FIELD}), so Morrow could not read the assignment back.`, dispatchState);
    }
    const columnId = created ? exactId(created[CREATED_COLUMN_FIELD]) : null;
    if (!columnId) {
      throw mismatch(`Blackboard did not name the gradebook column it generated for this assignment (${CREATED_COLUMN_FIELD}), so Morrow could not read the points possible and the due date back.`, dispatchState);
    }
    if (existingColumns.includes(columnId)) {
      throw mismatch("Blackboard named a gradebook column that was already in this course before this change.", dispatchState);
    }
    const record = await write.client.get(contentPath(write.courseId, contentId), signal);
    if (record.id !== contentId || record.courseId !== write.courseId) {
      throw mismatch("Blackboard did not return the created assignment as an item of the selected course.", dispatchState);
    }
    if (record[TITLE_FIELD] !== assignment.title) {
      throw mismatch("Blackboard returned a different title for the assignment it created.", dispatchState);
    }
    // A site that returns the instructions as rendered course markup is not
    // returning the text Morrow sent, and reporting that as a failed change
    // would be false. Morrow compares this field where the site returns it under
    // this exact name, and reports that it did not compare it where it does not.
    const returnedInstructions = record[INSTRUCTIONS_FIELD];
    if (typeof returnedInstructions === "string" && returnedInstructions !== assignment.instructions) {
      throw mismatch("Blackboard returned different instructions for the assignment it created.", dispatchState);
    }
    const column = await write.client.get(withFields(columnPath(write.courseId, columnId), COLUMN_FIELDS), signal);
    if (column.id !== columnId) {
      throw mismatch("Blackboard returned a different gradebook column than the one it named for this assignment.", dispatchState);
    }
    const possible = isJsonObject(column[SCORE_FIELD]) ? column[SCORE_FIELD].possible : undefined;
    if (possible !== assignment.pointsPossible) {
      throw mismatch("Blackboard returned different points possible on the gradebook column it generated for this assignment.", dispatchState);
    }
    const due = isJsonObject(column[GRADING_FIELD]) ? instant(column[GRADING_FIELD].due) : null;
    if (due !== assignment.due) {
      throw mismatch("Blackboard returned a different due date on the gradebook column it generated for this assignment.", dispatchState);
    }
    // The column has to be the one that grades this exact assignment, where the
    // site says which item a column grades. `safeColumn` reads that field under
    // this name; a site that returns none is reported as not compared.
    const gradedItem = exactId(column.contentId);
    if (gradedItem !== null && gradedItem !== contentId) {
      throw mismatch("Blackboard returned a gradebook column that grades a different item than the assignment it created.", dispatchState);
    }
    return {
      schema: "morrow.blackboard.ultra-assignment.readback.v1",
      ok: true,
      // Morrow's operation journal reads this marker to decide what reached
      // Blackboard. The read payloads keep `status`, which is an evidence label.
      resultState: "applied",
      tenantId: write.tenantId,
      sourceBindingId: write.sourceBindingId,
      courseId: write.courseId,
      contentId,
      gradebookColumnId: columnId,
      assignment: safeContent(record, write.roster),
      gradebookColumn: safeColumn(column, write),
      verification: {
        title: "matched",
        instructions: typeof returnedInstructions === "string" ? "matched" : "unreported",
        pointsPossible: "matched",
        due: "matched",
        gradedItem: gradedItem === null ? "unreported" : "matched",
      },
      questionLimit: QUESTION_LIMIT,
      readback: READBACK_STATE,
      readbackDetail: READBACK_DETAIL,
      status: "api_configured_live_untested",
    };
  } catch (error) {
    throw withBlackboardDispatchState(error, dispatchState);
  }
}

/**
 * The Gateway's fresh-read comparator for one reviewed assignment. It holds no
 * id from the dispatch, so it states only whether exactly one gradebook column
 * in this course now carries the reviewed title, points possible, and due date.
 * The proof that Blackboard created those two exact records belongs to the
 * dispatch above, which holds the ids Blackboard returned.
 *
 * A Learn site that names the generated column differently from the assignment
 * answers `verified: false` here. No live Blackboard tenant has been read, so
 * whether a site does that is unproven, and an unverified answer is the safe one
 * for a comparator to give.
 *
 * It prepares no roster and reads no course membership, and it carries no
 * `diagnostics`, because the Gateway freezes this exact payload when it plans
 * the operation.
 */
async function verifyUltraAssignment(
  runtime: BlackboardLearnRuntime,
  input: AssignmentPlanInput,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const assignment = reviewedAssignment(input);
  const comparator = await runtime.beginComparatorRead({
    tenantId: input.tenant_id, sourceBindingId: input.source_binding_id, courseId: input.course_id,
  }, signal);
  const columns = await comparator.client.collect(columnsPath(comparator.courseId), { label: "gradebook column", fields: COLUMN_FIELDS, signal });
  const matches = columns.filter((column) => (
    column.name === assignment.title
    && isJsonObject(column[SCORE_FIELD]) && column[SCORE_FIELD].possible === assignment.pointsPossible
    && isJsonObject(column[GRADING_FIELD]) && instant(column[GRADING_FIELD].due) === assignment.due
  ));
  return {
    schema: "morrow.blackboard.ultra-assignment.comparator.v1",
    ok: true,
    tenantId: comparator.tenantId,
    sourceBindingId: comparator.sourceBindingId,
    courseId: comparator.courseId,
    verified: matches.length === 1,
    readback: READBACK_STATE,
    status: "api_configured_live_untested",
  };
}

/**
 * Blackboard assignments and assessments. One read locates what a test or an
 * assignment is called and what it is worth. One reviewed change creates an
 * Ultra assignment, which Blackboard makes as a content item and a gradebook
 * column together.
 *
 * The provider limit is the first thing every tool here states: Anthology
 * removed adding questions to an assignment through the REST API in Learn
 * 3900.98, and its public Learn REST documentation names no route for a test, a
 * question, or a question bank. Morrow does not work around that. A request
 * that names questions is refused with `blackboard_operation_unavailable` and
 * that reason, before any Blackboard request.
 * https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments
 *
 * Changing an assignment's points possible or its due date is the gradebook
 * column change in `operations/gradebook.ts`. There is no second writer for
 * either here, and this module reads that column through the same path, field
 * list, and projection that change uses.
 *
 * A change here is three separate routes, as every Morrow provider change is:
 * the plan an instructor reviews, the dispatch the Gateway makes once against a
 * signed one-use effect grant, and the fresh-read comparator. The change is not
 * reachable: Morrow's Gateway has no public plan tool for a Blackboard
 * assignment, so nothing can plan, approve, or dispatch one.
 * docs/implementation/BLACKBOARD-REST-SCOPE.md records that.
 *
 * Anthology documents the create route and that its response names what it
 * created rather than returning the assignment. It does not state the request
 * and response shapes field by field, and no tenant Swagger has been read, so
 * every field name here is live-unverified: the readback re-reads both records
 * by the ids the site returned, and a site that stores or names something else
 * fails that readback instead of being reported as a saved assignment.
 */
export const blackboardAssignmentsModule: BlackboardOperationModule = {
  id: "assignments",
  tools: [
    blackboardTool({
      name: "blackboard_read_course_assessment",
      title: "Read one Blackboard test or assignment",
      description: `Read one selected Blackboard Learn test or assignment (${TEST_LINK_HANDLER}): what it is called, where it sits in the course, and the gradebook column that grades it, with the points possible and the due date on that column. Find these items with blackboard_inventory_course_contents. ${QUESTION_LIMIT} Changing the points possible or the due date is a change to this assignment's gradebook column, which Morrow reviews before it is sent.`,
      private: false,
      gatewayDispatchOnly: false,
      inputSchema: assessmentInput,
      annotations: READ_ANNOTATIONS,
      capability: readCapability(`GET ${CONTENT_ROUTE}`),
      rest: {
        method: "GET",
        pathTemplate: CONTENT_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => readCourseAssessment(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_plan_ultra_assignment",
      title: "Plan one Blackboard Ultra assignment",
      description: `Prepare one Blackboard Learn Ultra assignment for Morrow review: its title, its instructions, the points possible, and one due date. One approved plan creates one assignment and the gradebook column Blackboard generates for it, and attaches no file. ${QUESTION_LIMIT} This tool creates nothing.`,
      private: true,
      gatewayDispatchOnly: false,
      inputSchema: assignmentPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "assignment-create",
        provider: "blackboard",
        sourceExport: `POST ${CREATE_ASSIGNMENT_ROUTE}`,
        behavior: {
          readOnly: true, mutating: false, destructive: false, irreversible: false,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: COURSE_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => planUltraAssignment(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_apply_reviewed_ultra_assignment",
      title: "Create one reserved Blackboard Ultra assignment",
      description: "Internal Morrow dispatch route. This request requires an exact signed Gateway effect grant.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: assignmentApplyInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      capability: {
        family: "assignment-create",
        provider: "blackboard",
        sourceExport: `POST ${CREATE_ASSIGNMENT_ROUTE}`,
        behavior: {
          // Morrow holds no route that removes a Blackboard assignment, so it
          // cannot take one back once Blackboard has created it.
          readOnly: false, mutating: true, destructive: false, irreversible: true,
          supportsDryRun: false, supportsReadback: true, supportsUndo: false, supportsBatch: false,
          requiresBrowser: false, requiresLiveCanvas: false,
        },
        authority: { scopeClass: "tenant-course", approvalClass: "standard", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: WRITE_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "POST",
        pathTemplate: CREATE_ASSIGNMENT_ROUTE,
        access: "write",
        entitlement: "unknown",
        reviewRoute: "blackboard_plan_ultra_assignment",
        readbackComparator: "blackboard_verify_ultra_assignment",
      },
      run: (runtime, input, signal) => applyReviewedUltraAssignment(runtime, input, signal),
    }),
    blackboardTool({
      name: "blackboard_verify_ultra_assignment",
      title: "Verify one Blackboard Ultra assignment",
      description: "Internal Morrow fresh-read comparator for one reviewed Blackboard Ultra assignment. It re-reads the course gradebook and states whether exactly one column carries the reviewed title, points possible, and due date.",
      private: true,
      gatewayDispatchOnly: true,
      inputSchema: assignmentPlanInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      capability: {
        family: "course-read",
        provider: "blackboard",
        sourceExport: `GET ${GRADEBOOK_COLUMNS_ROUTE}`,
        behavior: READ_BEHAVIOR,
        authority: { scopeClass: "tenant-course", approvalClass: "none", dataClass: "course" },
        route: { backend: "lms-api", dispatchBackend: "blackboard-rest" },
        profiles: COMPARATOR_PROFILES,
        evidence: EVIDENCE,
      },
      rest: {
        method: "GET",
        pathTemplate: GRADEBOOK_COLUMNS_ROUTE,
        access: "read",
        entitlement: "unknown",
        reviewRoute: null,
        readbackComparator: null,
      },
      run: (runtime, input, signal) => verifyUltraAssignment(runtime, input, signal),
    }),
  ],
};
