// Decisions the proof harness used to fold into a PASS. They are pure so a test can
// call them with a recorded answer and never open a live course.

const WAITING = /waiting for approval|existing request/i;

const WRITE_VERDICTS = {
  verified: "PASS",
  excluded: "BLOCKED",
  unreachable: "BLOCKED",
  not_planned: "BLOCKED",
  sent_unchecked: "BLOCKED",
  applied_or_unknown: "BLOCKED",
  approval_withheld: "BLOCKED",
  awaiting_approval: "BLOCKED",
  approved: "BLOCKED",
  unsettled: "BLOCKED",
  closed_by_person: "BLOCKED",
  cancelled: "BLOCKED",
  refused: "BLOCKED",
  threw: "FAIL",
  mismatch: "FAIL",
  failed: "FAIL",
};

const DISPATCHED = new Set([
  "verified",
  "awaiting_approval",
  "applied_or_unknown",
  "awaiting_verification",
  "approved",
  "planned",
  "sent_unchecked",
]);

const STALE_SNAPSHOT = new Set([
  "item_bank_snapshot_changed",
  "quiz_bank_snapshot_changed",
]);

const PROTECTED_ID_KEYS = ["page_id", "url_or_id", "module_id", "context_module_id", "feature", "outcome_group_id"];

const ID_FIELDS = ["id", "url", "page_id", "url_or_id"];
const TITLE_FIELDS = ["title", "name", "question_name"];

function detailOf(entry) {
  return `${entry?.text ?? ""} ${entry?.detail ?? ""} ${entry?.reason ?? ""}`;
}

function blockedReason(detail) {
  if (WAITING.test(detail)) {
    return "Morrow held this change behind one already waiting on the same target; this run did not settle it.";
  }
  if (/input is invalid|Check this input/i.test(detail)) {
    return `This harness could not build the argument shape the route requires: ${/Check this input: ([^.]+)\./.exec(detail)?.[1] ?? "see detail"}.`;
  }
  return "";
}

/**
 * What a capability change may be called. Waiting for approval is never a pass, even when an
 * internal status string is verified. A pass needs a readback that shows the change, or an
 * explicit verified readback field.
 */
export function classifyWriteEvidence(entry = {}) {
  const state = String(entry.state ?? entry.outcome ?? "unknown");
  const detail = detailOf(entry);
  const verification = entry.verification ?? entry.readback?.verification;
  const showsChange = entry.readbackShowsChange === true || entry.readback?.showsChange === true;
  if (WAITING.test(detail)) {
    return {
      verdict: "BLOCKED",
      state,
      reason: "Morrow held this change behind one already waiting on the same target; this run did not settle it.",
    };
  }
  if (state === "verified") {
    if (verification === "verified" || showsChange) return { verdict: "PASS", state };
    if (verification !== undefined && verification !== "verified") {
      return {
        verdict: "FAIL",
        state,
        reason: `Morrow settled this change as ${state} while its own readback said ${verification}.`,
      };
    }
    return {
      verdict: "BLOCKED",
      state,
      reason: "Morrow reported this change as verified before a readback showed the saved result.",
    };
  }
  const queued = blockedReason(detail);
  if (queued) return { verdict: "BLOCKED", state, reason: queued };
  const verdict = WRITE_VERDICTS[state] ?? "FAIL";
  return { verdict, state };
}

/** A stored PASS is proven only when the write was actually read back and was not still waiting. */
export function evidenceProvesWrite(evidence) {
  if (!evidence || evidence.verdict !== "PASS") return false;
  if (evidence.kind && evidence.kind !== "write") return false;
  if (WAITING.test(detailOf(evidence))) return false;
  const verification = evidence.verification ?? evidence.readback?.verification;
  if (verification === "verified") return true;
  return evidence.readbackShowsChange === true || evidence.readback?.showsChange === true;
}

/** Manifest classification for one ledger row. A waiting or unread write is not PROVEN. */
export function classificationFromPass(evidence) {
  if (WAITING.test(detailOf(evidence))) {
    return {
      classification: "QUEUE-COLLISION",
      proof: "BLOCKED",
      reason: "Morrow held this change behind one already waiting on the same target; this run did not settle it.",
    };
  }
  if (evidence?.kind === "write" && !evidenceProvesWrite(evidence)) {
    return {
      classification: "NO-READBACK",
      proof: "BLOCKED",
      reason: "Canvas has no read that shows the saved result of this change.",
    };
  }
  return { classification: "PROVEN", proof: "PROVEN" };
}

export function operationIsProven(manifestRow, evidence) {
  if (!evidence) return false;
  if (evidence.kind === "write" || WAITING.test(detailOf(evidence))) return evidenceProvesWrite(evidence);
  return manifestRow?.classification === "PROVEN" && evidence.verdict === "PASS";
}

/**
 * A plan whose status string is verified is not a finished write until the readback says so.
 * Waiting text on that answer is not a completed change.
 */
export function outcomeFromChangePlan(plan, text) {
  if (plan?.status !== "verified") return null;
  const verification = plan?.verification?.status;
  if (WAITING.test(String(text ?? ""))) {
    return { outcome: "awaiting_approval", state: "awaiting_approval", verification };
  }
  if (verification === "verified") return { outcome: "verified", state: "verified", verification };
  if (verification) return { outcome: "mismatch", state: "mismatch", verification };
  return { outcome: "sent_unchecked", state: "sent_unchecked" };
}

/** A list read. A failure or a non-array body is not an empty collection. */
export function listRead(result) {
  if (!result || result.ok === false) return { ok: false, reason: "read_failed" };
  const data = Object.hasOwn(result, "data") ? result.data : result;
  if (!Array.isArray(data)) return { ok: false, reason: "not_an_array" };
  return { ok: true, rows: data };
}

/** The row whose own id or title is the proof object's, never the first search hit. */
export function rowByIdentity(rows, identity = {}) {
  if (!Array.isArray(rows)) return null;
  const id = identity.id == null || identity.id === "" ? "" : String(identity.id);
  const title = identity.title == null || identity.title === "" ? "" : String(identity.title);
  if (!id && !title) return null;
  return rows.find((row) => {
    if (id && ID_FIELDS.some((field) => String(row?.[field] ?? "") === id)) return true;
    if (title && TITLE_FIELDS.some((field) => String(row?.[field] ?? "") === title)) return true;
    return false;
  }) ?? null;
}

/** Gone only when a successful array read has no row with this id or title. */
export function absenceOf(result, identity) {
  const listed = listRead(result);
  if (!listed.ok) return { gone: false, failed: true, reason: listed.reason, row: null };
  if (!identity || (identity.id == null && identity.title == null) || (identity.id === "" && identity.title === "")) {
    return { gone: false, failed: true, reason: "no_identity", row: null };
  }
  const row = rowByIdentity(listed.rows, identity);
  return { gone: row == null, failed: false, reason: null, row };
}

const CHECKED_PRIVACY_PATHS = ["canvas_list_assignments_assignments", "canvas_list_assignment_submissions_courses"];

function learnerToken(row) {
  return typeof row?.learnerToken === "string" && row.learnerToken !== "";
}

/** PASS only when every learner row has a token and no raw identity remains. A failed read is not tokenized. */
export function judgePrivacyScenario({ submissions, findings = [] } = {}) {
  if (findings.length) {
    return { verdict: "FAIL", reason: findings.join("; "), privacy: { tokenized: false, checkedPaths: CHECKED_PRIVACY_PATHS } };
  }
  if (!submissions || submissions.ok !== true) {
    return {
      verdict: "BLOCKED",
      reason: `Canvas did not answer the submission read: ${submissions?.code ?? "unknown"}.`,
      privacy: { tokenized: false },
    };
  }
  if (!Array.isArray(submissions.data)) {
    return {
      verdict: "FAIL",
      reason: "The submission read did not return a list, so tokenization is not proven.",
      privacy: { tokenized: false },
    };
  }
  const rows = submissions.data;
  if (rows.length === 0) {
    return {
      verdict: "BLOCKED",
      reason: "No learner has attempted an assignment in the sandbox course, so there is no score to personalize from.",
      privacy: { tokenized: false, checkedPaths: CHECKED_PRIVACY_PATHS },
    };
  }
  const named = rows.filter(learnerToken);
  if (named.length !== rows.length) {
    return {
      verdict: "FAIL",
      reason: `${rows.length - named.length} of ${rows.length} learner rows have no learner token.`,
      readback: {
        source: "canvas",
        submissions: rows.length,
        tokenizedIdentities: named.length,
        rawIdentityFieldsFound: findings.length,
      },
      privacy: { tokenized: false, checkedPaths: CHECKED_PRIVACY_PATHS },
    };
  }
  return {
    verdict: "PASS",
    readback: {
      source: "canvas",
      submissions: rows.length,
      tokenizedIdentities: named.length,
      rawIdentityFieldsFound: 0,
      evidence: "every learner in this chain is named by a Morrow learner token",
    },
    privacy: { tokenized: true, checkedPaths: CHECKED_PRIVACY_PATHS },
  };
}

const QUIZ_TIME_LIMIT_SECONDS = 600;
export { QUIZ_TIME_LIMIT_SECONDS };

export function judgeQuizAuthoring({ quizId, questionAdded, questionReadBack, timeLimitSet, timeLimitReadBack } = {}) {
  if (questionAdded === true && questionReadBack === true && timeLimitSet === true && timeLimitReadBack === true && quizId) {
    return {
      verdict: "PASS",
      readback: { source: "canvas", quiz: String(quizId), questionReadBack: true, timeLimitReadBack: true },
    };
  }
  const titleOnly = Boolean(quizId) && questionReadBack !== true && timeLimitReadBack !== true;
  return {
    verdict: "FAIL",
    reason: titleOnly
      ? "A quiz with that title is not the authoring check. The question was not read back and the time limit was not read back."
      : "The quiz authoring check needs the added question and the time limit, both read back.",
  };
}

/** An operation list, including an empty one, is not an undo. The prior state has to come back. */
export function judgeUndoScenario(evidence = {}) {
  if (evidence.before == null && evidence.after == null) {
    const listed = Array.isArray(evidence.operations) ? evidence.operations.length : 0;
    return {
      verdict: "FAIL",
      reason: "An operation list is not an undo. The prior state was not restored.",
      readback: { source: "morrow-journal", operationsListed: listed },
    };
  }
  return judgeUndoRestoration(evidence);
}

export function judgeUndoRestoration({ before, after, identity } = {}) {
  const prior = listRead(before);
  if (!prior.ok) {
    return { verdict: "FAIL", reason: "The read before undo failed, so the prior state is unknown." };
  }
  const saved = rowByIdentity(prior.rows, identity);
  if (!saved) {
    return { verdict: "FAIL", reason: "The proof object was not found by its own id or title, so undo had no target." };
  }
  const restored = absenceOf(after, identity);
  if (restored.failed) {
    return { verdict: "FAIL", reason: "The read after undo failed, so absence is not proven." };
  }
  if (!restored.gone) {
    return { verdict: "FAIL", reason: "Undo did not restore the prior state. The proof object is still there." };
  }
  return {
    verdict: "PASS",
    readback: { source: "canvas", restored: true, matchedBy: identity?.id ? "id" : "title" },
  };
}

/** Two visible courses are not a comparison. A pass needs a difference or a verified absence. */
export function judgeCourseComparison({ coursesVisible, left, right, leftId, rightId } = {}) {
  if (left == null && right == null) {
    return {
      verdict: "FAIL",
      reason: "Two courses being visible is not a comparison.",
      readback: { source: "canvas", coursesVisible: coursesVisible ?? null },
    };
  }
  const leftList = listRead(left);
  const rightList = listRead(right);
  if (!leftList.ok || !rightList.ok) {
    return {
      verdict: "FAIL",
      reason: "A course read failed, so a difference or a verified absence is not proven.",
      readback: { source: "canvas", coursesVisible: coursesVisible ?? null, readFailed: true },
    };
  }
  const nameOf = (row) => String(row?.title ?? row?.name ?? "");
  const leftNames = new Set(leftList.rows.map(nameOf).filter(Boolean));
  const rightNames = new Set(rightList.rows.map(nameOf).filter(Boolean));
  const onlyLeft = [...leftNames].filter((name) => !rightNames.has(name));
  const onlyRight = [...rightNames].filter((name) => !leftNames.has(name));
  if (onlyLeft.length || onlyRight.length) {
    return {
      verdict: "PASS",
      readback: {
        source: "canvas",
        difference: true,
        verifiedAbsence: false,
        leftId: leftId ?? null,
        rightId: rightId ?? null,
        onlyLeft: onlyLeft.slice(0, 5),
        onlyRight: onlyRight.slice(0, 5),
      },
    };
  }
  return {
    verdict: "PASS",
    readback: {
      source: "canvas",
      difference: false,
      verifiedAbsence: true,
      leftId: leftId ?? null,
      rightId: rightId ?? null,
      compared: leftList.rows.length,
    },
  };
}

function nestedCodes(value, found = []) {
  if (!value || typeof value !== "object") return found;
  for (const key of ["code", "error", "sourceRefusal"]) {
    if (typeof value[key] === "string" && value[key]) found.push(value[key]);
  }
  if (value.problem && typeof value.problem === "object") nestedCodes(value.problem, found);
  if (value.data && typeof value.data === "object") nestedCodes(value.data, found);
  return found;
}

/** PASS only for the stale-snapshot refusal before dispatch. capability_input_invalid is not that proof. */
export function judgeStaleSnapshot(answer) {
  const held = answer?.structuredContent && typeof answer.structuredContent === "object" ? answer.structuredContent : {};
  const codes = nestedCodes(held);
  if (codes.includes("capability_input_invalid")) {
    return { verdict: "FAIL", readback: { status: held.status ?? null, code: "capability_input_invalid" } };
  }
  const status = held.status == null ? null : String(held.status);
  const effect = held.effectState == null ? null : String(held.effectState);
  if ((status && DISPATCHED.has(status)) || (effect && DISPATCHED.has(effect))) {
    return { verdict: "FAIL", readback: { status, code: codes[0] ?? null } };
  }
  const stale = codes.find((code) => STALE_SNAPSHOT.has(code));
  const sent = held.sent === false || held.data?.sent === false || answer?.sent === false;
  const refused = status === "refused" || status === "failed" || status === "rejected" || held.phase === "rejected" || sent;
  if (!stale || !refused) {
    return { verdict: "FAIL", readback: { status, code: codes[0] ?? null } };
  }
  return { verdict: "PASS", readback: { status, code: stale, refusedBeforeDispatch: true } };
}

/** Ids a write may name: only what this run created, plus the connected course and the signed-in person. */
export function addressPoolForWrite(created = {}) {
  const pool = {};
  for (const [key, value] of Object.entries(created)) {
    if (value === undefined || value === null || value === "") continue;
    pool[key] = value;
  }
  return pool;
}

function ownedValue(created, key) {
  if (created?.[key] !== undefined) return created[key];
  if (key === "url_or_id") return created?.page_id;
  if (key === "page_id") return created?.url_or_id;
  return undefined;
}

function priorValue(preexisting, key) {
  if (preexisting?.[key] !== undefined) return preexisting[key];
  if (key === "url_or_id") return preexisting?.page_id;
  if (key === "page_id") return preexisting?.url_or_id;
  return undefined;
}

/** A pre-existing page, module, feature flag, or outcome group named by the arguments. */
export function preexistingTarget(args, preexisting = {}, created = {}) {
  if (!args || typeof args !== "object") return null;
  for (const key of PROTECTED_ID_KEYS) {
    if (args[key] === undefined || args[key] === null) continue;
    const value = String(args[key]);
    const prior = priorValue(preexisting, key);
    if (prior === undefined || String(prior) !== value) continue;
    const owned = ownedValue(created, key);
    if (owned !== undefined && String(owned) === value) continue;
    return { key, id: value };
  }
  return null;
}

export function deletionAllowed(id, preexistingIds) {
  const blocked = preexistingIds instanceof Set ? preexistingIds : new Set((preexistingIds || []).map((value) => String(value)));
  return !blocked.has(String(id));
}

export function quizSettingsReadBack(quiz, seconds) {
  const settings = quiz?.data?.quiz_settings ?? quiz?.data?.quiz?.quiz_settings ?? quiz?.data ?? {};
  return quiz?.ok === true
    && settings?.has_time_limit === true
    && Number(settings?.session_time_limit_in_seconds) === Number(seconds);
}

export function questionReadBack(items, title) {
  const listed = listRead(items);
  if (!listed.ok) return false;
  return listed.rows.some((row) => {
    const name = row?.entry?.title ?? row?.title ?? row?.question_name ?? row?.item?.entry?.title;
    return String(name ?? "") === String(title);
  });
}
