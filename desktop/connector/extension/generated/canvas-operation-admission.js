import { canvasReadbackBlocker, hasNamedCanvasReadback, planBrowserReadback } from "./canvas-readback-plan.js";
import { canvasLearnerScopeObjectRoute, canvasSemanticCourseTarget } from "./canvas-semantic-target.js";
/** True when the request may be sent through the verified connection: to its course, or to its site. */
export function canvasAdmissionIsBound(admission) {
    return admission.authority === "site" || canvasCourseTargetIsScoped(admission.courseTarget);
}
export function canvasCourseTargetIsScoped(target) {
    return target.kind === "course_path"
        || target.kind === "semantic_course_object"
        || (target.kind === "self_path" && target.argument !== undefined);
}
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
export function canvasAccountAuthorityRoute(operation) {
    const path = String(operation?.path || "");
    return ACCOUNT_AUTHORITY_ROUTE.test(path) || path.includes("{account_id}");
}
/**
 * Routes that change one person's own record rather than course content: their submitted work and
 * the originality reports attached to it, a quiz attempt, a what-if grade, who belongs to a group,
 * or a booked appointment slot. canvasLearnerScopeObjectRoute names the same class under a section.
 */
const LEARNER_RECORD_ROUTE = Object.freeze([
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
const COURSE_LEARNER_RECORD_ROUTE = Object.freeze([
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
const MULTI_COURSE_ROUTE = Object.freeze([
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
const NO_READABLE_PROVIDER_EFFECT_ROUTE = Object.freeze([
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
const RUBRIC_CSV_UPLOAD_ROUTE = /^\/v1\/(?:accounts|courses)\/\{(?:account_id|course_id)\}\/rubrics\/upload$/;
/**
 * True when the route needs file bytes the generic operation cannot safely carry. This covers every
 * upload first step and the CSV Rubric imports whose generated schema exposes no file input.
 */
function reviewedFileTransferRoute(operation) {
    return operation.method === "POST" && (FILE_UPLOAD_PREFLIGHT_ROUTE.test(operation.path)
        || RUBRIC_CSV_UPLOAD_ROUTE.test(operation.path));
}
/**
 * Every Canvas upload route Morrow's reviewed file transfer carries, by tool name, with its route.
 * A side that holds no Canvas catalog, such as the gateway planning an upload, reads the route here.
 * `packages/canvas-api-catalog/test/catalog.test.ts` holds this table equal to the catalog's own
 * upload routes, so it cannot drift from them.
 */
export const CANVAS_REVIEWED_UPLOAD_ROUTES = Object.freeze({
    canvas_creates_rubric_using_csv_file_accounts: "/v1/accounts/{account_id}/rubrics/upload",
    canvas_creates_rubric_using_csv_file_courses: "/v1/courses/{course_id}/rubrics/upload",
    canvas_upload_file_courses: "/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/files",
    canvas_upload_file_quiz_id_submissions_self_files_post: "/v1/courses/{course_id}/quizzes/{quiz_id}/submissions/self/files",
    canvas_upload_file_sections: "/v1/sections/{section_id}/assignments/{assignment_id}/submissions/{user_id}/files",
    canvas_upload_file_submissions_user_id_comments_files_post: "/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}/comments/files",
    canvas_upload_file_v1_courses_course_id_files_post: "/v1/courses/{course_id}/files",
    canvas_upload_file_v1_folders_folder_id_files_post: "/v1/folders/{folder_id}/files",
    canvas_upload_file_v1_groups_group_id_files_post: "/v1/groups/{group_id}/files",
    canvas_upload_file_v1_users_user_id_files_post: "/v1/users/{user_id}/files",
});
/** The route one reviewed upload names by tool, as an operation shape the path builder reads. */
export function canvasReviewedUploadRoute(toolName) {
    const path = Object.hasOwn(CANVAS_REVIEWED_UPLOAD_ROUTES, toolName) ? CANVAS_REVIEWED_UPLOAD_ROUTES[toolName] : "";
    if (!path)
        return undefined;
    const names = [...path.matchAll(/\{([a-z_]+)\}/g)].map((entry) => entry[1]);
    return { method: "POST", path, readOnly: false, parameters: names.map((name) => ({ inputName: name, wireName: name, location: "path" })) };
}
/** What Morrow's reviewed file transfer does with one upload route: store a file, or import a rubric CSV. */
export function canvasReviewedUploadKind(operation) {
    if (!operation || operation.readOnly || !reviewedFileTransferRoute(operation))
        return undefined;
    return RUBRIC_CSV_UPLOAD_ROUTE.test(operation.path) ? "rubric_csv" : "file";
}
/**
 * The exact Canvas address one reviewed upload sends its first request to, built from the upload
 * route and the ids that name its target, or "" when the ids do not name exactly that route's path
 * inputs. Every id is a positive decimal; a person's own upload may name `self`.
 */
/**
 * The Canvas listing that shows a file saved at one upload target. A reviewed
 * transfer whose own proof could not answer is settled by reading this listing
 * for the file it sent, so an upload never stays unresolved for want of a check.
 * A target Canvas offers no listing for, such as a submission comment, has none.
 */
export function canvasUploadListingRead(uploadPath) {
    const listings = [
        // Canvas routes are named with and without the API prefix, so both forms are read here.
        [/^(?:\/api)?\/v1\/folders\/([1-9][0-9]{0,18})\/files$/, "canvas_list_files_folders", "id"],
        [/^(?:\/api)?\/v1\/courses\/([1-9][0-9]{0,18})\/files$/, "canvas_list_files_courses", "course_id"],
        [/^(?:\/api)?\/v1\/users\/([1-9][0-9]{0,18}|self)\/files$/, "canvas_list_files_users", "user_id"],
        [/^(?:\/api)?\/v1\/groups\/([1-9][0-9]{0,18})\/files$/, "canvas_list_files_groups", "group_id"],
    ];
    for (const [route, readTool, inputName] of listings) {
        const match = route.exec(String(uploadPath || ""));
        if (match)
            return { readTool, arguments: Object.freeze({ [inputName]: match[1] }) };
    }
    return null;
}
export function canvasReviewedUploadPath(operation, uploadArguments) {
    if (!canvasReviewedUploadKind(operation) || !uploadArguments || typeof uploadArguments !== "object" || Array.isArray(uploadArguments))
        return "";
    const values = uploadArguments;
    const pathParameters = (operation.parameters || []).filter((parameter) => parameter.location === "path");
    if (pathParameters.length === 0 || Object.keys(values).length !== pathParameters.length)
        return "";
    let path = operation.path;
    for (const parameter of pathParameters) {
        if (!Object.hasOwn(values, parameter.inputName))
            return "";
        const raw = values[parameter.inputName];
        const text = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? String(raw) : raw;
        const valid = typeof text === "string" && (/^[1-9][0-9]{0,18}$/.test(text) || (text === "self" && parameter.inputName === "user_id"));
        if (!valid || !path.includes(`{${parameter.wireName}}`))
            return "";
        path = path.replace(`{${parameter.wireName}}`, text);
    }
    return /\{[^}]+\}/.test(path) ? "" : path;
}
function learnerRecordRoute(operation) {
    // Deleting an appointment group cancels every time slot students have already booked in it, so it
    // changes their own records and not only the sign-up sheet. The route that changes the sheet
    // itself is admitted above, through the reading that proves the selected course owns it.
    if (operation.method === "DELETE" && /^\/v1\/appointment_groups\/\{[^}]+\}$/.test(operation.path))
        return true;
    // Deleting a course discussion topic removes the posts under it with the topic. That is a course
    // content change the course Edit permission governs, sent as a destructive action with an exact
    // absence readback. A topic addressed without its course, or through a group, stays held here.
    if (operation.method === "DELETE" && /^\/v1\/discussion_topics\/\{[^}]+\}$/.test(operation.path))
        return true;
    if (operation.method === "DELETE" && /^\/v1\/groups\/\{group_id\}\/discussion_topics\/\{topic_id\}$/.test(operation.path))
        return true;
    if (operation.method === "DELETE" && operation.path === "/v1/courses/{course_id}/custom_gradebook_columns/{id}")
        return true;
    if (operation.method === "DELETE" && operation.path === "/v1/courses/{id}")
        return true;
    return canvasLearnerScopeObjectRoute(operation)
        || LEARNER_RECORD_ROUTE.some((route) => route.test(operation.path))
        || COURSE_LEARNER_RECORD_ROUTE.some((route) => route.test(operation.path));
}
function multiCourseRoute(operation) {
    if (operation.method === "PUT" && operation.path === "/v1/courses/{id}")
        return true;
    if (operation.method === "POST" && operation.path === "/v1/courses/{course_id}/reset_content")
        return true;
    if (operation.method === "DELETE" && operation.path === "/v1/courses/{course_id}/outcome_groups/{id}")
        return true;
    return MULTI_COURSE_ROUTE.some((route) => route.test(operation.path));
}
function crossCourseObjectRoute(operation) {
    // The enabled account calendars are the signed-in person's own list of calendars to display. It
    // shares the calendar route prefix and names no object a course can own.
    if (operation.path === "/v1/calendar_events/save_enabled_account_calendars")
        return false;
    return CROSS_COURSE_OBJECT_ROUTE.test(operation.path);
}
function courseTarget(operation) {
    if (operation.service === "item_bank")
        return { kind: "course_path", argument: "course_id" };
    const direct = operation.path.match(/\/courses\/\{(course_id|id)\}(?:\/|$)/);
    if (direct)
        return { kind: "course_path", argument: direct[1] };
    const semantic = canvasSemanticCourseTarget(operation);
    if (semantic)
        return { kind: "semantic_course_object", target: semantic };
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
function siteAuthorityClass(operation, target) {
    if (operation.service === "item_bank")
        return undefined;
    if (canvasAccountAuthorityRoute(operation))
        return "account";
    if (learnerRecordRoute(operation) && target.kind !== "course_path")
        return "learner_record";
    if (multiCourseRoute(operation))
        return "multi_course";
    if (target.kind === "course_path" || target.kind === "semantic_course_object")
        return undefined;
    if (target.kind === "self_path")
        return target.argument === undefined || !operation.readOnly ? "person" : undefined;
    if (crossCourseObjectRoute(operation))
        return "shared_object";
    if (NO_READABLE_PROVIDER_EFFECT_ROUTE.includes(operation.path))
        return "session_credential";
    return "person";
}
export function canvasOperationAdmission(operation) {
    const target = courseTarget(operation);
    const siteClass = siteAuthorityClass(operation, target);
    const scope = siteClass
        ? { courseTarget: target, authority: "site", siteClass }
        : { courseTarget: target, authority: "course" };
    if (operation.readOnly)
        return { ...scope, write: { state: "not_applicable" } };
    if (operation.service === "item_bank")
        return { ...scope, write: { state: "admitted" } };
    // These routes need file bytes that only a reviewed transfer may carry. A generic call would either
    // start an unfinished upload or send an empty CSV import, so the transfer hold runs first.
    if (reviewedFileTransferRoute(operation)) {
        return { ...scope, write: { state: "held", reason: "multi_step_upload_requires_reviewed_transfer" } };
    }
    return { ...scope, write: { state: "admitted" } };
}
function structuralArguments(operation) {
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
const NEW_QUIZ_RESPONSE_BOUND_READBACKS = [
    "canvas_set_course_level_accommodations",
    "canvas_set_quiz_level_accommodations",
    "canvas_create_quiz_report_course_id_quizzes_assignment_id_reports_post",
];
/**
 * A Canvas read whose documented answer is a redirect to the object itself, such
 * as `/v1/courses/{course_id}/root_outcome_group`. Canvas sends these within its
 * own site and answers the followed request with the object, so the Bridge
 * follows one hop and refuses anything that leaves the Canvas origin.
 */
export function canvasRedirectRead(operation) {
    return operation.readOnly === true && operation.responseType === "void"
        && /redirect/iu.test(`${operation.summary || ""} ${operation.description || ""}`);
}
export function canvasExecutorOwnedReadback(operation) {
    if (operation.readOnly)
        return false;
    return operation.service === "item_bank" || NEW_QUIZ_RESPONSE_BOUND_READBACKS.includes(operation.toolName);
}
export function canvasReadbackAssessment(operations, operation, admission = canvasOperationAdmission(operation)) {
    if (operation.readOnly)
        return { state: "not_applicable", reason: "read_only" };
    if (admission.write.state !== "admitted")
        return { state: "not_applicable", reason: "write_held" };
    if (canvasExecutorOwnedReadback(operation))
        return { state: "structurally_exact" };
    const blocker = canvasReadbackBlocker(operation);
    if (blocker)
        return { state: "blocked", reason: blocker };
    if (hasNamedCanvasReadback(operation))
        return { state: "structurally_exact" };
    const plan = planBrowserReadback(operations, operation, structuralArguments(operation), {
        id: "1",
        page_id: "1",
        rubric_id: "1",
        url: "morrow-structural-target",
    });
    if (!plan)
        return { state: "unavailable", reason: "no_safe_readback_route" };
    if (!plan.targetId && plan.assertions.length === 0
        && !["deleted-resource", "deleted-or-archived-resource", "collection-empty"].includes(plan.strategy)) {
        return { state: "unconfirmed", reason: "no_exact_postcondition" };
    }
    return { state: "structurally_exact" };
}
/**
 * The plain sentence for a held write, shown to the person who asked for the change: what the change
 * would do, why Morrow holds it, and what they can do instead. The catalog carries no Canvas LTI
 * service write (scripts/generate-canvas-api-catalog.mjs), so the reviewed file transfer is the one
 * held class.
 */
export function canvasAdmissionReason(admission) {
    if (admission.state !== "held")
        return undefined;
    return "Canvas takes a file's bytes in a later request that this route cannot carry, so Morrow sends every file through its reviewed file transfer, which checks the saved file and its bytes. Ask Morrow to prepare the file upload for this same target.";
}
/**
 * One plain sentence for each site class, shown before a site action is granted and at approval: what
 * the change reaches beyond the selected course, and whose Canvas permissions decide it.
 */
export function canvasSiteAuthorityNote(siteClass) {
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
