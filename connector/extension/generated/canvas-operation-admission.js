import { canvasReadbackBlocker, hasNamedCanvasReadback, planBrowserReadback } from "./canvas-readback-plan.js";
import { canvasLearnerScopeObjectRoute, canvasSemanticCourseTarget } from "./canvas-semantic-target.js";
/**
 * Routes whose authority is a Canvas account or the whole Canvas instance: every account route, the
 * global outcome routes, and the developer key routes. The LTI registration routes live under an
 * account, so the account prefix already names them.
 */
const ACCOUNT_AUTHORITY_ROUTE = /^\/(?:v1|lti)\/accounts(?:\/|$)|^\/v1\/global(?:\/|$)|^\/v1\/developer_keys(?:\/|$)|^\/lti\/developer_key(?:\/|$)/;
/**
 * True when the route names a Canvas account, the whole Canvas instance, an LTI registration or a
 * developer key. A selected course cannot carry that authority. docs/implementation/CANVAS-ADMISSION-CLASSES.md
 * holds the contract these routes need before any of them can be admitted.
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
 * Object families Canvas keeps outside a course. Canvas can attach any of these objects to any
 * course, to an account, or to one person, so the route alone proves nothing. semantic-target.ts
 * holds the framework that proves the owning course by reading the object immediately before the
 * change is sent; it is declared so far for the two section routes, the group discussion-topic and
 * group page routes, the file rename, file delete and folder create routes, the three course
 * calendar event routes and the appointment group update, so every other route in these families
 * stays held until its reading exists. A group set stays held even though a group
 * set can be read the same way: changing one can create groups and place students in them, which is
 * not a change Morrow makes. Copying a file or a folder stays held for the same kind of reason: the
 * copy lands in a second object that the reading of the first one does not prove.
 */
const CROSS_COURSE_OBJECT_ROUTE = /^\/v1\/(?:appointment_groups|calendar_events|files|folders|group_categories|groups|outcomes|sections)(?:\/|$)/;
/**
 * Writes that ask Canvas for a sign-in token, a session, or a one-time action. Canvas answers with
 * the credential or with nothing at all and keeps no field afterwards that names what changed, so
 * Morrow has no way to read the result back.
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
 * confirms the saved file. Morrow runs all three steps only inside its reviewed course-file
 * transfer, which freezes the exact file and compares the bytes Canvas saved.
 */
const COURSE_FILE_UPLOAD_PREFLIGHT_ROUTE = /^\/v1\/courses\/\{course_id\}\/(?:[^/]+\/)*files$/;
/**
 * True when the route is a course-scoped upload pre-flight. The same first step outside a course, on
 * a section, folder, group or person, keeps its own hold: what those routes lack first is proof of
 * the course, not the rest of the upload.
 */
function fileUploadPreflightRoute(operation) {
    return operation.method === "POST" && COURSE_FILE_UPLOAD_PREFLIGHT_ROUTE.test(operation.path);
}
function learnerRecordRoute(operation) {
    // Deleting an appointment group cancels every time slot students have already booked in it, so it
    // changes their own records and not only the sign-up sheet. The route that changes the sheet
    // itself is admitted above, through the reading that proves the selected course owns it.
    if (operation.method === "DELETE" && /^\/v1\/appointment_groups\/\{[^}]+\}$/.test(operation.path))
        return true;
    return canvasLearnerScopeObjectRoute(operation) || LEARNER_RECORD_ROUTE.some((route) => route.test(operation.path));
}
function crossCourseObjectRoute(operation) {
    // The enabled account calendars are the signed-in person's own list of calendars to display. It
    // shares the calendar route prefix and names no object a course can own.
    if (operation.path === "/v1/calendar_events/save_enabled_account_calendars")
        return false;
    return CROSS_COURSE_OBJECT_ROUTE.test(operation.path);
}
function courseTarget(operation) {
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
export function canvasOperationAdmission(operation) {
    const target = courseTarget(operation);
    if (operation.readOnly)
        return { courseTarget: target, write: { state: "not_applicable" } };
    // One Item Bank question can be changed, and only through the guarded image
    // alternative-text repair. That repair carries a complete fan-out record of
    // every course the bank reaches, an acknowledgement of every course outside
    // the selected one, and a fresh in-frame reading of the exact question. The
    // generic write stays held, so the curated Edit category is the only path.
    if (operation.service === "item_bank" && operation.nickname === "update_item") {
        return { courseTarget: target, write: { state: "held", reason: "item_bank_fan_out_and_guard_required" } };
    }
    if (operation.service === "item_bank" && operation.nickname !== "create_bank") {
        return { courseTarget: target, write: { state: "held", reason: "item_bank_dependency_review_required" } };
    }
    // A bank belongs to the Canvas account, not to a course. The in-frame session
    // does prove one course, but the bank it creates is not held inside that
    // course, so this hold is about the object, not about a missing binding.
    if (operation.service === "item_bank") {
        return { courseTarget: target, write: { state: "held", reason: "item_bank_account_scope_not_course_scope" } };
    }
    // An account route needs account authority. The selected course cannot grant it, so the write
    // stays held even when the same route also names a course.
    if (canvasAccountAuthorityRoute(operation)) {
        return { courseTarget: target, write: { state: "held", reason: "account_authority_required" } };
    }
    // The course is named, so scope is not what is missing. What is missing is the rest of the upload:
    // this route only asks Canvas where to send the bytes, and the two steps that store and confirm
    // them exist only in Morrow's reviewed file transfer. Sending this step alone would leave an
    // unfinished upload behind, so it is held before the course path admits it.
    if (fileUploadPreflightRoute(operation)) {
        return { courseTarget: target, write: { state: "held", reason: "multi_step_upload_requires_reviewed_transfer" } };
    }
    if (target.kind === "course_path")
        return { courseTarget: target, write: { state: "admitted" } };
    // The route names one object, and the catalog knows which read proves the course that owns it.
    // Every enforcement layer refuses this write until that reading is taken and frozen.
    if (target.kind === "semantic_course_object")
        return { courseTarget: target, write: { state: "admitted" } };
    if (target.kind === "self_path")
        return { courseTarget: target, write: { state: "held", reason: "self_scope_not_supported" } };
    // The remaining classes are ordered from the most specific fact about the route to the least: a
    // person's own record, then an object Canvas can place in any course, then a request with no
    // readable effect, and last the plain absence of a course.
    if (learnerRecordRoute(operation)) {
        return { courseTarget: target, write: { state: "held", reason: "learner_scope_requires_separate_authority" } };
    }
    if (crossCourseObjectRoute(operation)) {
        return { courseTarget: target, write: { state: "held", reason: "cross_course_object_requires_resolution" } };
    }
    if (NO_READABLE_PROVIDER_EFFECT_ROUTE.includes(operation.path)) {
        return { courseTarget: target, write: { state: "held", reason: "provider_contract_incomplete" } };
    }
    return { courseTarget: target, write: { state: "held", reason: "course_scope_required" } };
}
function structuralArguments(operation) {
    return Object.fromEntries((operation.parameters || []).map((parameter) => [parameter.inputName, "1"]));
}
export function canvasReadbackAssessment(operations, operation, admission = canvasOperationAdmission(operation)) {
    if (operation.readOnly)
        return { state: "not_applicable", reason: "read_only" };
    if (admission.write.state !== "admitted")
        return { state: "not_applicable", reason: "write_held" };
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
 * One plain sentence for each held class, shown to the person who asked for the change: what the
 * change would do, why Morrow holds it, and what they can do instead. Every class has its own
 * sentence; no two classes share one.
 */
export function canvasAdmissionReason(admission) {
    if (admission.state !== "held")
        return undefined;
    if (admission.reason === "account_authority_required") {
        return "This change affects a whole Canvas account, not one course. Morrow does not yet have an account permission, so it will not send it.";
    }
    if (admission.reason === "multi_step_upload_requires_reviewed_transfer") {
        return "Adding a file to Canvas needs Morrow's reviewed file transfer, which checks the file and its saved bytes. Morrow will not start a partial upload.";
    }
    if (admission.reason === "item_bank_dependency_review_required") {
        return "Existing Item Bank mutations require complete dependency and affected-course evidence that is not yet available.";
    }
    if (admission.reason === "item_bank_fan_out_and_guard_required") {
        return "Morrow changes one Item Bank question only through its focused image alternative-text repair. That repair lists every course the bank reaches and asks you to confirm them before it sends the change.";
    }
    if (admission.reason === "item_bank_account_scope_not_course_scope") {
        return "A Canvas Item Bank belongs to the account, not to one course, so a bank Morrow creates would not stay inside the selected course.";
    }
    if (admission.reason === "cross_course_object_requires_resolution") {
        return "Canvas can attach this group, file, folder, calendar item or outcome to any course, and Morrow cannot yet prove that this one belongs to the course you selected. Change it in Canvas, or ask for the same change from inside the course.";
    }
    if (admission.reason === "learner_scope_requires_separate_authority") {
        return "Morrow does not change a student's own record: their submitted work, a quiz attempt, a grade, an enrollment, who is in a group, or a booked time slot. Those need their own permission, so make that change in Canvas.";
    }
    if (admission.reason === "provider_contract_incomplete") {
        return "This asks Canvas for a sign-in token, a session or a one-time action, and Canvas keeps nothing afterwards that Morrow can read back to show you what happened. Morrow does not send a change it cannot check, so make this one in Canvas.";
    }
    if (admission.reason === "self_scope_not_supported") {
        return "Morrow does not change your personal Canvas bookmarks or course nicknames. It only changes content inside a selected course.";
    }
    return "Morrow only changes things that live inside the one course you selected, and this change is not attached to any course. Make it in Canvas yourself, or ask for the same change on a page, assignment, file or other item inside the course.";
}
