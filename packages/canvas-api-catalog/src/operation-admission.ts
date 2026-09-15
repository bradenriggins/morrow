import type { CanvasApiOperation } from "./index.js";
import { canvasReadbackBlocker, hasNamedCanvasReadback, planBrowserReadback, type CanvasReadbackBlocker } from "./readback-plan.js";
import { canvasLearnerScopeObjectRoute, canvasSemanticCourseTarget, type CanvasSemanticCourseTarget } from "./semantic-target.js";

export type CanvasCourseTarget =
  | {
    readonly kind: "course_path";
    readonly argument: "course_id" | "id";
  }
  | {
    readonly kind: "self_path";
    readonly resource: "bookmark" | "course_nickname";
    readonly argument?: "course_id";
  }
  | {
    readonly kind: "semantic_course_object";
    readonly target: CanvasSemanticCourseTarget;
  }
  | {
    readonly kind: "none";
  };

/**
 * Who a Canvas request acts for. A course request acts inside the one course the connection was made
 * from, and every layer compares the course it names with that course. A site request acts on the
 * connected Canvas site as the signed-in person: an account, a person's own records, an object Canvas
 * can place in any course, or more than one course. Canvas applies that person's own roles to it, so
 * it reaches exactly what they can change in Canvas themselves, and no layer narrows it to the
 * selected course. It still needs the verified connection to that site and that person.
 */
export type CanvasOperationAuthority = "course" | "site";

/**
 * Why a site request is a site request. Each class is described to the person before it is granted.
 */
export type CanvasSiteAuthorityClass =
  | "account" | "person" | "shared_object" | "learner_record" | "multi_course" | "session_credential";

export type CanvasWriteAdmission =
  | {
    readonly state: "not_applicable";
  }
  | {
    readonly state: "admitted";
  }
  | {
    readonly state: "held";
    readonly reason: "duplicate_assignment_exact_readback_unavailable" | "multi_step_upload_requires_reviewed_transfer"
      | "lti_authorization_required";
  };

export interface CanvasOperationAdmission {
  readonly courseTarget: CanvasCourseTarget;
  readonly authority: CanvasOperationAuthority;
  readonly siteClass?: CanvasSiteAuthorityClass;
  readonly write: CanvasWriteAdmission;
}

/** True when the request may be sent through the verified connection: to its course, or to its site. */
export function canvasAdmissionIsBound(admission: CanvasOperationAdmission): boolean {
  return admission.authority === "site" || canvasCourseTargetIsScoped(admission.courseTarget);
}

export function canvasCourseTargetIsScoped(target: CanvasCourseTarget): boolean {
  return target.kind === "course_path"
    || target.kind === "semantic_course_object"
    || (target.kind === "self_path" && target.argument !== undefined);
}

export type CanvasReadbackAssessment =
  | {
    readonly state: "not_applicable";
    readonly reason: "read_only" | "write_held";
  }
  | {
    readonly state: "unavailable";
    readonly reason: "no_safe_readback_route";
  }
  | {
    readonly state: "blocked";
    readonly reason: CanvasReadbackBlocker;
  }
  | {
    readonly state: "unconfirmed";
    readonly reason: "no_exact_postcondition";
  }
  | {
    readonly state: "structurally_exact";
  };

/**
 * Routes whose authority is a Canvas account or the whole Canvas instance: every account route, the
 * global outcome routes, and the developer key routes. The LTI registration routes live under an
 * account, so the account prefix already names them. Canvas decides each of them with the signed-in
 * person's account roles, so they are site requests.
 */
const ACCOUNT_AUTHORITY_ROUTE = /^\/(?:v1|lti)\/accounts(?:\/|$)|^\/v1\/global(?:\/|$)|^\/v1\/developer_keys(?:\/|$)|^\/lti\/developer_key(?:\/|$)/;

/**
 * True when the route names a Canvas account, the whole Canvas instance, an LTI registration or a
 * developer key. A selected course cannot carry that authority, so these are site requests.
 * docs/implementation/CANVAS-ADMISSION-CLASSES.md holds the contract.
 */
export function canvasAccountAuthorityRoute(operation: { readonly path: string } | null | undefined): boolean {
  const path = String(operation?.path || "");
  return ACCOUNT_AUTHORITY_ROUTE.test(path) || path.includes("{account_id}");
}

/**
 * Routes that change one person's own record rather than course content: their submitted work and
 * the originality reports attached to it, a quiz attempt, a what-if grade, who belongs to a group,
 * or a booked appointment slot. canvasLearnerScopeObjectRoute names the same class under a section.
 */
const LEARNER_RECORD_ROUTE: readonly RegExp[] = Object.freeze([
  /^\/v1\/quiz_submissions(?:\/|$)/,
  /^\/v1\/submissions(?:\/|$)/,
  /^\/lti\/assignments\/\{[^}]+\}\/(?:files|submissions)\//,
  /^\/v1\/groups\/\{[^}]+\}\/(?:invite|memberships|users)(?:\/|$)/,
  // Both group-set routes place people in groups: one assigns everyone who has no group yet, and
  // the import applies a roster file as the difference between the saved groups and the file.
  /^\/v1\/group_categories\/\{[^}]+\}\/(?:assign_unassigned_members|import)$/,
  /^\/v1\/calendar_events\/\{[^}]+\}\/reservations(?:\/|$)/,
]);

/**
 * Course paths prove which course Canvas will change, but they do not grant authority over a
 * learner's work or participation. These are the course-nested forms of the learner records above:
 * submissions and grades, quiz attempts, enrollments, assignment overrides, group membership, and
 * learner progress.
 *
 * The course path binds these to the selected course. The same records reached through a section,
 * group, quiz attempt or booking name no course, so those forms are site requests.
 */
const COURSE_LEARNER_RECORD_ROUTE: readonly RegExp[] = Object.freeze([
  // Assignment overrides and module overrides can name students, groups, or sections.
  /^\/v1\/courses\/\{course_id\}\/assignments\/(?:overrides(?:\/|$)|\{[^}]+\}\/overrides(?:\/|$))/,
  /^\/v1\/courses\/\{course_id\}\/modules\/\{[^}]+\}\/assignment_overrides$/,
  // Assignment submissions include grades, comments, peer reviews, moderation, and extensions.
  /^\/v1\/courses\/\{course_id\}\/assignments\/\{[^}]+\}\/(?:allocate|anonymous_submissions|extensions|moderated_students|provisional_grades|submissions)(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/submissions(?:\/|$)/,
  // A quiz extension or submission changes one or more learner attempts.
  /^\/v1\/courses\/\{course_id\}\/quizzes\/\{[^}]+\}\/(?:extensions|submissions)(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/quiz_extensions(?:\/|$)/,
  // Enrollment and direct gradebook or assessment data belong to learners, not course content.
  /^\/v1\/courses\/\{course_id\}\/enrollments(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/users\/\{[^}]+\}\/last_attended$/,
  /^\/v1\/courses\/\{course_id\}\/custom_gradebook_column_data(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/custom_gradebook_columns\/\{[^}]+\}\/data\/\{[^}]+\}$/,
  /^\/v1\/courses\/\{course_id\}\/live_assessments\/\{[^}]+\}\/results$/,
  /^\/v1\/courses\/\{course_id\}\/rubric_associations\/\{[^}]+\}\/rubric_assessments(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/what_if_grades(?:\/|$)/,
  // These routes directly change a learner's progress or group membership.
  /^\/v1\/courses\/\{course_id\}\/modules\/\{[^}]+\}\/(?:relock|items\/\{[^}]+\}\/(?:done|mark_read|select_mastery_path))$/,
  /^\/v1\/courses\/\{course_id\}\/group_categories(?:\/|$)/,
  // These operations carry the learner target in request data or in the saved object's meaning.
  /^\/quiz\/v1\/courses\/\{course_id\}(?:\/quizzes\/\{[^}]+\})?\/accommodations$/,
  /^\/v1\/courses\/\{course_id\}\/course_pacing(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/ai_experiences\/\{[^}]+\}\/conversations(?:\/|$)/,
  /^\/v1\/courses\/\{course_id\}\/enqueue_outcome_rollup_calculation$/,
  /^\/v1\/courses\/\{course_id\}\/quizzes\/\{[^}]+\}\/submission_users\/message$/,
  /^\/v1\/courses\/\{course_id\}\/discussion_topics\/read_all$/,
  /^\/v1\/courses\/\{course_id\}\/discussion_topics(?:\/|$).*(?:\/entries(?:\/|$)|\/read(?:\/|$)|\/read_all$|\/subscribed$|\/rating$|\/summaries\/\{[^}]+\}\/feedback$)/,
]);

/**
 * Writes whose course path names only one part of their effect. Each operation can read from, move,
 * associate, or write another course or account named in its request data. A selected-course grant
 * cannot authorize that second scope, so these are site requests.
 */
const MULTI_COURSE_ROUTE: readonly RegExp[] = Object.freeze([
  /^\/v1\/courses\/\{course_id\}\/blueprint_templates\/\{[^}]+\}\/(?:migrations|update_associations)$/,
  /^\/v1\/courses\/\{course_id\}\/course_copy$/,
  /^\/v1\/courses\/\{course_id\}\/content_migrations$/,
  /^\/v1\/courses\/\{course_id\}\/outcome_groups\/\{[^}]+\}\/import$/,
  /^\/v1\/courses\/\{course_id\}\/outcome_groups\/\{[^}]+\}\/outcomes(?:\/\{[^}]+\})?$/,
]);

/**
 * Object families Canvas keeps outside a course. Canvas can attach any of these objects to any
 * course, to an account, or to one person, so the route alone proves nothing. semantic-target.ts
 * holds the framework that proves the owning course by reading the object immediately before the
 * change is sent; it is declared so far for the two section routes, the group discussion-topic and
 * group page routes, the file rename, file delete and folder create routes, the three course
 * calendar event routes and the appointment group update. Those stay course requests. Every other
 * route in these families is a site request: Canvas decides it with the signed-in person's own roles,
 * wherever the object lives.
 */
const CROSS_COURSE_OBJECT_ROUTE = /^\/v1\/(?:appointment_groups|calendar_events|files|folders|group_categories|groups|outcomes|sections)(?:\/|$)/;

/**
 * Writes that ask Canvas for a sign-in token, a session, or a one-time action. Canvas answers with
 * the credential or with nothing at all and keeps no field afterwards that names what changed, so
 * Morrow has no way to read the result back. Privacy keeps any returned credential out of results.
 */
const NO_READABLE_PROVIDER_EFFECT_ROUTE: readonly string[] = Object.freeze([
  "/v1/discovery_pages/token",
  "/v1/error_reports",
  "/v1/inst_access_tokens",
  "/v1/jwts",
  "/v1/jwts/refresh",
  "/v1/services/kaltura_session",
  "/v1/users/reset_password",
  "/v1/users/self/pandata_events_token",
  "/v1/users/{user_id}/observer_pairing_codes",
]);

/**
 * The first step of a Canvas file upload. This request creates no file: Canvas answers with an
 * address to send the bytes to, the bytes go there in a second request, and a third request
 * confirms the saved file. The same first step exists for a course, a folder, a group, a section
 * submission and a person. Morrow runs all three steps only inside its reviewed file transfer, which
 * freezes the exact file and compares the bytes Canvas saved.
 */
const FILE_UPLOAD_PREFLIGHT_ROUTE = /^\/v1\/(?:courses|folders|groups|sections|users)\/\{[^}]+\}\/(?:[^/]+\/)*files$/;
const COURSE_RUBRIC_CSV_UPLOAD_ROUTE = "/v1/courses/{course_id}/rubrics/upload";

/**
 * True when the route needs file bytes the generic operation cannot safely carry. This covers the
 * course upload pre-flights and the CSV Rubric import whose generated schema exposes no file input.
 */
function reviewedFileTransferRoute(operation: CanvasApiOperation): boolean {
  return operation.method === "POST" && (
    FILE_UPLOAD_PREFLIGHT_ROUTE.test(operation.path)
    || operation.path === COURSE_RUBRIC_CSV_UPLOAD_ROUTE
  );
}

function learnerRecordRoute(operation: CanvasApiOperation): boolean {
  // Deleting an appointment group cancels every time slot students have already booked in it, so it
  // changes their own records and not only the sign-up sheet. The route that changes the sheet
  // itself is admitted above, through the reading that proves the selected course owns it.
  if (operation.method === "DELETE" && /^\/v1\/appointment_groups\/\{[^}]+\}$/.test(operation.path)) return true;
  // Deleting a course discussion topic removes the posts under it with the topic. That is a course
  // content change the course Edit permission governs, sent as a destructive action with an exact
  // absence readback. A topic addressed without its course, or through a group, stays held here.
  if (operation.method === "DELETE" && /^\/v1\/discussion_topics\/\{[^}]+\}$/.test(operation.path)) return true;
  if (operation.method === "DELETE" && /^\/v1\/groups\/\{group_id\}\/discussion_topics\/\{topic_id\}$/.test(operation.path)) return true;
  if (operation.method === "DELETE" && operation.path === "/v1/courses/{course_id}/custom_gradebook_columns/{id}") return true;
  if (operation.method === "DELETE" && operation.path === "/v1/courses/{id}") return true;
  return canvasLearnerScopeObjectRoute(operation)
    || LEARNER_RECORD_ROUTE.some((route) => route.test(operation.path))
    || COURSE_LEARNER_RECORD_ROUTE.some((route) => route.test(operation.path));
}

function multiCourseRoute(operation: CanvasApiOperation): boolean {
  if (operation.method === "PUT" && operation.path === "/v1/courses/{id}") return true;
  if (operation.method === "POST" && operation.path === "/v1/courses/{course_id}/reset_content") return true;
  if (operation.method === "DELETE" && operation.path === "/v1/courses/{course_id}/outcome_groups/{id}") return true;
  return MULTI_COURSE_ROUTE.some((route) => route.test(operation.path));
}

function crossCourseObjectRoute(operation: CanvasApiOperation): boolean {
  // The enabled account calendars are the signed-in person's own list of calendars to display. It
  // shares the calendar route prefix and names no object a course can own.
  if (operation.path === "/v1/calendar_events/save_enabled_account_calendars") return false;
  return CROSS_COURSE_OBJECT_ROUTE.test(operation.path);
}

function courseTarget(operation: CanvasApiOperation): CanvasCourseTarget {
  if (operation.service === "item_bank") return { kind: "course_path", argument: "course_id" };
  const direct = operation.path.match(/\/courses\/\{(course_id|id)\}(?:\/|$)/);
  if (direct) return { kind: "course_path", argument: direct[1] as "course_id" | "id" };
  const semantic = canvasSemanticCourseTarget(operation);
  if (semantic) return { kind: "semantic_course_object", target: semantic };
  if (/^\/v1\/users\/self\/bookmarks(?:\/\{id\})?$/.test(operation.path)) {
    return { kind: "self_path", resource: "bookmark" };
  }
  if (operation.path === "/v1/users/self/course_nicknames") {
    return { kind: "self_path", resource: "course_nickname" };
  }
  // The single-nickname route names one course. Its write is held with every other self-scoped
  // write; its read stays bound to the selected course through this argument.
  if (operation.path === "/v1/users/self/course_nicknames/{course_id}") {
    return { kind: "self_path", resource: "course_nickname", argument: "course_id" };
  }
  return { kind: "none" };
}

function siteAuthorityClass(operation: CanvasApiOperation, target: CanvasCourseTarget): CanvasSiteAuthorityClass | undefined {
  if (operation.service === "item_bank") return undefined;
  if (canvasAccountAuthorityRoute(operation)) return "account";
  if (learnerRecordRoute(operation) && target.kind !== "course_path") return "learner_record";
  if (multiCourseRoute(operation)) return "multi_course";
  if (target.kind === "course_path" || target.kind === "semantic_course_object") return undefined;
  if (target.kind === "self_path") return target.argument === undefined || !operation.readOnly ? "person" : undefined;
  if (crossCourseObjectRoute(operation)) return "shared_object";
  if (NO_READABLE_PROVIDER_EFFECT_ROUTE.includes(operation.path)) return "session_credential";
  return "person";
}

export function canvasOperationAdmission(operation: CanvasApiOperation): CanvasOperationAdmission {
  const target = courseTarget(operation);
  const siteClass = siteAuthorityClass(operation, target);
  const scope = siteClass
    ? { courseTarget: target, authority: "site" as const, siteClass }
    : { courseTarget: target, authority: "course" as const };
  if (operation.readOnly) return { ...scope, write: { state: "not_applicable" } };
  if (operation.service === "item_bank") return { ...scope, write: { state: "admitted" } };
  // These routes need file bytes that only a reviewed transfer may carry. A generic call would either
  // start an unfinished upload or send an empty CSV import, so the transfer hold runs first.
  if (reviewedFileTransferRoute(operation)) {
    return { ...scope, write: { state: "held", reason: "multi_step_upload_requires_reviewed_transfer" } };
  }
  if (operation.path === "/v1/courses/{course_id}/assignments/{assignment_id}/duplicate") {
    return { ...scope, write: { state: "held", reason: "duplicate_assignment_exact_readback_unavailable" } };
  }
  // An LTI service, including the account and developer key routes under it, accepts only the tool's
  // own LTI authorization. The signed-in browser session cannot present it.
  if (operation.path.startsWith("/lti/")) {
    return { ...scope, write: { state: "held", reason: "lti_authorization_required" } };
  }
  return { ...scope, write: { state: "admitted" } };
}

function structuralArguments(operation: CanvasApiOperation): Readonly<Record<string, unknown>> {
  return Object.fromEntries((operation.parameters || []).map((parameter) => [parameter.inputName, "1"]));
}

/**
 * Writes whose saved result is proved by a reviewed executor rather than by the
 * generic browser readback planner. This is a third state, not an exemption:
 * the readback exists and is exact, it is simply not the planner's.
 *
 * Item Bank changes are reread inside the Item Banks frame, the only place the
 * private `/api/banks` surface answers, by
 * `connector/extension/src/item-bank-executor.js` and
 * `connector/extension/src/quiz-bank-draw-executor.js`. The three New Quizzes
 * requests below are bound to their own response evaluators in the service
 * worker. `planBrowserReadback` returns nothing for any of them, which is
 * correct: a generic plan would query the wrong route.
 *
 * `scripts/test/canvas-verification.test.mjs` proves that every operation named
 * here really has that readback in the executor that owns it, so a future
 * admitted write cannot fall into this state by accident.
 */
// Named by tool, not by nickname: `create_quiz_report` is the nickname of two
// different routes, and only the New Quizzes one has a response evaluator. The
// Classic Quizzes report of the same name has none and is judged by the
// planner like any other write.
const NEW_QUIZ_RESPONSE_BOUND_READBACKS: readonly string[] = [
  "canvas_set_course_level_accommodations",
  "canvas_set_quiz_level_accommodations",
  "canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post",
];

export function canvasExecutorOwnedReadback(operation: CanvasApiOperation): boolean {
  if (operation.readOnly) return false;
  return operation.service === "item_bank" || NEW_QUIZ_RESPONSE_BOUND_READBACKS.includes(operation.toolName);
}

export function canvasReadbackAssessment(
  operations: readonly CanvasApiOperation[],
  operation: CanvasApiOperation,
  admission = canvasOperationAdmission(operation),
): CanvasReadbackAssessment {
  if (operation.readOnly) return { state: "not_applicable", reason: "read_only" };
  if (admission.write.state !== "admitted") return { state: "not_applicable", reason: "write_held" };
  if (canvasExecutorOwnedReadback(operation)) return { state: "structurally_exact" };
  const blocker = canvasReadbackBlocker(operation);
  if (blocker) return { state: "blocked", reason: blocker };
  if (hasNamedCanvasReadback(operation)) return { state: "structurally_exact" };
  const plan = planBrowserReadback(operations, operation, structuralArguments(operation), {
    id: "1",
    page_id: "1",
    rubric_id: "1",
    url: "morrow-structural-target",
  });
  if (!plan) return { state: "unavailable", reason: "no_safe_readback_route" };
  if (!plan.targetId && plan.assertions.length === 0
    && !["deleted-resource", "deleted-or-archived-resource", "collection-empty"].includes(plan.strategy)) {
    return { state: "unconfirmed", reason: "no_exact_postcondition" };
  }
  return { state: "structurally_exact" };
}

/**
 * One plain sentence for each held class, shown to the person who asked for the change: what the
 * change would do, why Morrow holds it, and what they can do instead. Every class has its own
 * sentence; no two classes share one.
 */
export function canvasAdmissionReason(admission: CanvasWriteAdmission): string | undefined {
  if (admission.state !== "held") return undefined;
  if (admission.reason === "multi_step_upload_requires_reviewed_transfer") {
    return "Adding a file to Canvas needs Morrow's reviewed file transfer, which checks the file and its saved bytes. Morrow will not start a partial upload.";
  }
  if (admission.reason === "duplicate_assignment_exact_readback_unavailable") {
    return "Canvas does not say when a duplicated assignment has finished copying, and the copy carries no documented field that names it as a New Quiz, so Morrow cannot prove it read back the finished copy rather than a half-made one. Duplicate this assignment in Canvas.";
  }
  return "Canvas accepts this LTI service only with the LTI tool's own authorization, which your signed-in Canvas session does not hold. Make this change from the LTI tool.";
}

/**
 * One plain sentence for each site class, shown before a site action is granted and at approval: what
 * the change reaches beyond the selected course, and whose Canvas permissions decide it.
 */
export function canvasSiteAuthorityNote(siteClass: CanvasSiteAuthorityClass | undefined): string | undefined {
  if (siteClass === "account") {
    return "It changes a Canvas account, not one course. Canvas decides it with your own account roles on this Canvas site.";
  }
  if (siteClass === "learner_record") {
    return "It changes a person's record through a section, group, quiz attempt or booking rather than through the selected course, so it can reach a course other than the selected one. Canvas decides it with your own roles.";
  }
  if (siteClass === "multi_course") {
    return "It can read from or change a Canvas course or account besides the selected one. Canvas decides it with your own roles in each of them.";
  }
  if (siteClass === "shared_object") {
    return "Canvas can attach this group, file, folder, calendar item, section or outcome to any course, so the change is not limited to the selected course. Canvas decides it with your own roles.";
  }
  if (siteClass === "session_credential") {
    return "It asks Canvas for a sign-in token, a session or a one-time action. Morrow keeps any credential Canvas returns out of the result, and Canvas keeps no record Morrow can read back.";
  }
  if (siteClass === "person") {
    return "It changes something that belongs to you or another person on this Canvas site, not content in the selected course. Canvas decides it with your own roles.";
  }
  return undefined;
}
