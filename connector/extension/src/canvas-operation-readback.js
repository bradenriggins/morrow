import { hasNamedCanvasReadback } from "../generated/canvas-readback-plan.js";

const ID = /^[1-9][0-9]{0,18}$/;
const DATE_FIELDS = Object.freeze(["due_at", "unlock_at", "lock_at"]);
const BULK_ASSIGNMENT_DATES = Object.freeze({
  toolName: "canvas_bulk_update_assignment_dates",
  key: "PUT /v1/courses/{course_id}/assignments/bulk_update#bulk_update_assignment_dates",
});
const REACTIVATE_ENROLLMENT = Object.freeze({
  toolName: "canvas_re_activate_enrollment",
  key: "PUT /v1/courses/{course_id}/enrollments/{id}/reactivate#re_activate_enrollment",
});
const LIST_ASSIGNMENTS = Object.freeze({
  toolName: "canvas_list_assignments_assignments",
  key: "GET /v1/courses/{course_id}/assignments#list_assignments_assignments",
});
const LIST_ENROLLMENTS = Object.freeze({
  toolName: "canvas_list_enrollments_courses",
  key: "GET /v1/courses/{course_id}/enrollments#list_enrollments_courses",
});
const QUERY_PROGRESS = Object.freeze({
  toolName: "canvas_query_progress_v1_progress_id_get",
  key: "GET /v1/progress/{id}#query_progress",
});

function identifier(value) {
  const text = typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
  return ID.test(text) ? text : null;
}

function exactOperation(operations, expected) {
  const matches = (operations || []).filter((operation) => operation?.toolName === expected.toolName
    && operation?.key === expected.key && operation?.readOnly === true);
  return matches.length === 1 ? matches[0] : null;
}

function sameInstant(left, right) {
  if (left === right) return true;
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function requestedDate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const base = value.base === true;
  const overrideId = identifier(value.id);
  if (base === Boolean(overrideId)) return null;
  const fields = {};
  for (const name of DATE_FIELDS) {
    if (!Object.hasOwn(value, name)) continue;
    const date = value[name];
    if (date !== null && (typeof date !== "string" || date !== date.trim() || !Number.isFinite(Date.parse(date)))) return null;
    fields[name] = date;
  }
  if (Object.keys(fields).length === 0) return null;
  return { ...(base ? { base: true } : { id: overrideId }), fields };
}

function requestedAssignment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const assignmentId = identifier(value.id);
  if (!assignmentId || !Array.isArray(value.all_dates) || value.all_dates.length < 1 || value.all_dates.length > 200) return null;
  const dates = value.all_dates.map(requestedDate);
  if (dates.some((date) => !date)) return null;
  const selectors = new Set();
  for (const date of dates) {
    const selector = date.base ? "base" : `override:${date.id}`;
    if (selectors.has(selector)) return null;
    selectors.add(selector);
  }
  return { assignmentId, dates };
}

function bulkAssignmentTargets(args) {
  const courseId = identifier(args?.course_id);
  if (!courseId || !Array.isArray(args?.assignment_dates) || args.assignment_dates.length < 1 || args.assignment_dates.length > 100) return null;
  const targets = args.assignment_dates.map(requestedAssignment);
  if (targets.some((target) => !target)) return null;
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.assignmentId)) return null;
    ids.add(target.assignmentId);
  }
  return { courseId, targets };
}

function bulkPlan(operations, operation, args, writeData) {
  if (operation?.toolName !== BULK_ASSIGNMENT_DATES.toolName || operation?.key !== BULK_ASSIGNMENT_DATES.key) return null;
  const input = bulkAssignmentTargets(args);
  const assignments = exactOperation(operations, LIST_ASSIGNMENTS);
  const progress = exactOperation(operations, QUERY_PROGRESS);
  const progressId = identifier(writeData?.id);
  if (!input || !assignments || !progress || !progressId) return null;
  return {
    schema: "morrow.browser-readback-plan.v1",
    strategy: "canvas-bulk-assignment-dates",
    readOperation: assignments,
    arguments: {
      course_id: input.courseId,
      assignment_ids: input.targets.map((target) => target.assignmentId),
      include: ["all_dates"],
      morrow_max_pages: 50,
    },
    assertions: [],
    ...(input.targets.length === 1 ? { targetId: input.targets[0].assignmentId } : {}),
    targetField: "id",
    progressReadOperation: progress,
    progressArguments: { id: progressId },
    courseId: input.courseId,
    targets: input.targets,
  };
}

function reactivationPlan(operations, operation, args, writeData) {
  if (operation?.toolName !== REACTIVATE_ENROLLMENT.toolName || operation?.key !== REACTIVATE_ENROLLMENT.key) return null;
  const courseId = identifier(args?.course_id);
  const enrollmentId = identifier(args?.id);
  const responseEnrollmentId = identifier(writeData?.id);
  const responseCourseId = identifier(writeData?.course_id);
  const userId = identifier(writeData?.user_id);
  const enrollments = exactOperation(operations, LIST_ENROLLMENTS);
  if (!courseId || !enrollmentId || !responseEnrollmentId || !responseCourseId || !userId || !enrollments
    || responseEnrollmentId !== enrollmentId || responseCourseId !== courseId) return null;
  return {
    schema: "morrow.browser-readback-plan.v1",
    strategy: "canvas-enrollment-reactivation",
    readOperation: enrollments,
    arguments: { course_id: courseId, user_id: userId, state: ["active"], morrow_max_pages: 50 },
    assertions: [{ inputName: "enrollment_state", paths: [["enrollment_state"]], expected: "active" }],
    targetId: enrollmentId,
    targetField: "id",
    courseId,
    enrollmentId,
    userId,
  };
}

export function planCanvasOperationReadback(operations, operation, args, writeData) {
  return bulkPlan(operations, operation, args, writeData)
    || reactivationPlan(operations, operation, args, writeData);
}

function verification(status, strategy, readTool, evidence) {
  return {
    schema: "morrow.browser-verification.v1",
    status,
    strategy,
    ...(readTool ? { readTool } : {}),
    evidence,
  };
}

function readFailure(plan, readResult) {
  if (!readResult || readResult.ok !== true) {
    return verification("unconfirmed", plan.strategy, plan.readOperation.toolName, `fresh_readback_http_${Number(readResult?.status || 0)}`);
  }
  if (readResult.truncated === true) {
    return verification("unconfirmed", plan.strategy, plan.readOperation.toolName, "collection_readback_incomplete");
  }
  return null;
}

function recordId(value) {
  return identifier(value?.id);
}

function exactRecord(rows, targetId) {
  const matches = rows.filter((row) => recordId(row) === targetId);
  return matches.length === 1 ? matches[0] : null;
}

function matchingDate(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return expected.base ? actual.base === true && identifier(actual.id) === null : identifier(actual.id) === expected.id;
}

function evaluateBulkAssignmentDates(plan, readResult) {
  const failed = readFailure(plan, readResult);
  if (failed) return failed;
  if (!Array.isArray(readResult.data)) {
    return verification("unconfirmed", plan.strategy, plan.readOperation.toolName, "assignment_readback_shape_invalid");
  }
  for (const target of plan.targets) {
    const assignment = exactRecord(readResult.data, target.assignmentId);
    if (!assignment) {
      return verification("mismatch", plan.strategy, plan.readOperation.toolName, "requested_assignment_missing_or_ambiguous");
    }
    if (identifier(assignment.course_id) !== plan.courseId) {
      return verification("mismatch", plan.strategy, plan.readOperation.toolName, "assignment_course_mismatch");
    }
    if (!Array.isArray(assignment.all_dates)) {
      return verification("unconfirmed", plan.strategy, plan.readOperation.toolName, "assignment_dates_not_returned");
    }
    for (const expectedDate of target.dates) {
      const matches = assignment.all_dates.filter((date) => matchingDate(date, expectedDate));
      if (matches.length !== 1) {
        return verification("mismatch", plan.strategy, plan.readOperation.toolName, "requested_assignment_date_missing_or_ambiguous");
      }
      for (const [field, expectedValue] of Object.entries(expectedDate.fields)) {
        if (!Object.hasOwn(matches[0], field) || !sameInstant(matches[0][field], expectedValue)) {
          return verification("mismatch", plan.strategy, plan.readOperation.toolName, `assignment_date_mismatch:${field}`);
        }
      }
    }
  }
  return verification("verified", plan.strategy, plan.readOperation.toolName, "fresh_all_requested_assignment_dates_match");
}

function evaluateEnrollmentReactivation(plan, readResult) {
  const failed = readFailure(plan, readResult);
  if (failed) return failed;
  if (!Array.isArray(readResult.data)) {
    return verification("unconfirmed", plan.strategy, plan.readOperation.toolName, "enrollment_readback_shape_invalid");
  }
  const enrollment = exactRecord(readResult.data, plan.enrollmentId);
  if (!enrollment) {
    return verification("mismatch", plan.strategy, plan.readOperation.toolName, "reactivated_enrollment_missing_or_ambiguous");
  }
  if (identifier(enrollment.course_id) !== plan.courseId || identifier(enrollment.user_id) !== plan.userId) {
    return verification("mismatch", plan.strategy, plan.readOperation.toolName, "enrollment_subject_or_course_mismatch");
  }
  if (!Object.hasOwn(enrollment, "enrollment_state")) {
    return verification("unconfirmed", plan.strategy, plan.readOperation.toolName, "enrollment_state_not_returned");
  }
  if (enrollment.enrollment_state !== "active") {
    return verification("mismatch", plan.strategy, plan.readOperation.toolName, "enrollment_not_active");
  }
  return verification("verified", plan.strategy, plan.readOperation.toolName, "fresh_enrollment_readback_matches_active_subject");
}

export function evaluateCanvasOperationReadback(plan, readResult) {
  if (!plan || typeof plan !== "object") return null;
  if (plan.strategy === "canvas-bulk-assignment-dates") return evaluateBulkAssignmentDates(plan, readResult);
  if (plan.strategy === "canvas-enrollment-reactivation") return evaluateEnrollmentReactivation(plan, readResult);
  return null;
}

export function evaluateCanvasOperationProgress(plan, progressResult) {
  if (plan?.strategy !== "canvas-bulk-assignment-dates") return null;
  if (!progressResult || progressResult.ok !== true) {
    return { settled: false, verification: verification("unconfirmed", plan.strategy, plan.progressReadOperation?.toolName, `progress_readback_http_${Number(progressResult?.status || 0)}`) };
  }
  const state = typeof progressResult.data?.workflow_state === "string" ? progressResult.data.workflow_state.toLowerCase() : "";
  if (state === "completed") return { settled: true };
  if (["failed", "failure", "cancelled"].includes(state)) {
    return { settled: false, terminal: true, verification: verification("mismatch", plan.strategy, plan.progressReadOperation?.toolName, `background_progress_${state}`) };
  }
  return { settled: false, verification: verification("unconfirmed", plan.strategy, plan.progressReadOperation?.toolName, "background_progress_unsettled") };
}

export function canvasBulkAssignmentDatesBody(operation, args) {
  const input = bulkAssignmentTargets(args);
  return operation?.toolName === BULK_ASSIGNMENT_DATES.toolName && operation?.key === BULK_ASSIGNMENT_DATES.key && input
    ? args.assignment_dates
    : null;
}

export function isCanvasOperationReadback(operation) {
  return hasNamedCanvasReadback(operation);
}
