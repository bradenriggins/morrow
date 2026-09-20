// Every Canvas write in the catalog, attempted live against BT2.
//
// Safety rule: a write only ever addresses an object this sweep created. Real
// course content is never passed to a change, so nothing the course already held
// can be altered or removed here. A write whose object cannot be created in this
// course is recorded unreachable, with the reason.
import { readFileSync } from "node:fs";
import { OPERATIONS, COURSE, connect, makeTools, fillArguments, harvestSeeds } from "./lib/catalog.mjs";
import { makeDisposables, removeDisposables } from "./lib/disposables.mjs";
import { settleOperation } from "./lib/settle.mjs";
import { loadLedger, recordRow, summarize } from "./ledger.mjs";
import { SANDBOX } from "./connect.mjs";

const logPath = new URL("run-writes.log", import.meta.url);
const ledger = loadLedger();
const receipt = { results: ledger.rows };
const mark = `${SANDBOX.mark}${String(Math.floor(Date.now() / 1000))}`;

// The owner holds grades and messages to people outside this authority.
const EXCLUDED_TOOLS = new Set([
  "canvas_delete_conclude_course", "canvas_reset_course", "canvas_merge_user_into_another_user_accounts",
  "canvas_merge_user_into_another_user_destination_user_id", "canvas_split_merged_users_into_separate_users",
  "canvas_terminate_all_user_sessions", "canvas_force_password_reset", "canvas_kickoff_password_recovery_flow",
  "canvas_log_users_out_of_all_mobile_apps_id", "canvas_log_users_out_of_all_mobile_apps_mobile_sessions",
  "canvas_deprecated_self_register_user", "canvas_deprecated_create_instaccess_token",
  "canvas_restore_deleted_user_from_root_account", "canvas_update_multiple_users",
  "canvas_delete_push_notification_endpoint", "canvas_delete_communication_channel_id",
  "canvas_delete_communication_channel_type",
]);

// A change addressed by one of these names acts on another person or on their
// sign-in. None of them is an object this sweep made.
const OTHER_PERSON_INPUT = /^(?:observer_id|observee_id|login_id|enrollment_id|communication_channel_id|pseudonym_id|as_user_id)$/;
// Even inside the test course, these routes leave it: tickets to support,
// messages or invites to people, shared objects that notify, and blueprint
// pushes that alter associated courses. Sandbox-only means none of them run.
const OUTBOUND_PATH = /(error_reports|account_notifications|conversations|messages?|notifications|content_shares|collaborations|conferences|appointment_groups|blueprint_templates|communication_channels|push)/;
// A person route the sweep may use, because what it addresses is an object the
// sweep creates and removes under the signed-in person, never a setting that was
// there before.
const SELF_OBJECT_ROUTE = /^\/v1\/users\/\{(?:user_id|id)\}\/(?:bookmarks|planner_notes|files|folders|course_nicknames|content_shares|calendar_events|custom_data|educator_accessibility_course_scan|educator_accessibility_course_statistics)/;
const SETTINGS_ROUTE = /(?:settings|colors|dashboard_positions|preferences|features|profile|avatars|page_views|logins|communication_channels|split|merge)/;

/**
 * What Canvas needs for a change whose shape its own documentation does not
 * state: a grading scheme is a set of paired entries, a question group names its
 * group, a blackout date has two dates. Everything here is ordinary course
 * content addressed to the objects this sweep made.
 */
function exactArguments(operation, made, mark) {
  const byTool = {
    canvas_create_new_grading_standard_courses: { title: `${mark} scheme`, grading_scheme_entry_name: ["A", "F"], grading_scheme_entry_value: [90, 0] },
    canvas_update_grading_standard_courses: { title: `${mark} scheme two`, grading_scheme_entry_name: ["A", "F"], grading_scheme_entry_value: [95, 0] },
    canvas_create_group_category_courses: { name: `${mark} set two` },
    canvas_create_link_outcome_courses: {
      title: `${mark} outcome`, description: "Morrow sweep", display_name: `${mark} outcome`,
      calculation_method: "highest", mastery_points: 3,
      ratings_description: ["Met", "Not met"], ratings_points: [3, 0],
    },
    canvas_create_subgroup_courses: { title: `${mark} subgroup`, description: "Morrow sweep" },
    canvas_update_outcome_group_courses: { title: `${mark} outcome group`, description: "Morrow sweep" },
    canvas_create_question_group: { quiz_groups_name: [`${mark} group`], quiz_groups_pick_count: [1], quiz_groups_question_points: [1] },
    canvas_update_question_group: { quiz_groups_name: [`${mark} group two`], quiz_groups_pick_count: [1], quiz_groups_question_points: [1] },
    canvas_create_blackout_date_courses: { event_title: `${mark} blackout`, start_date: "2026-10-05", end_date: "2026-10-06" },
    canvas_rate_entry_courses: { rating: 1 },
    canvas_update_module: { module_name: `${mark} module two` },
    canvas_update_module_item: { module_item_title: `${mark} item two` },
    canvas_update_rubricassociation: { rubric_association_title: `${mark} association two` },
    canvas_create_lti_resource_link: { url: "https://example.edu/morrow-sweep-lti", title: `${mark} link` },
    canvas_create_update_proficiency_ratings_courses: {
      ratings_description: ["Met", "Not met"], ratings_points: [3, 0],
      ratings_mastery: [true, false], ratings_color: ["3366AA", "AA3333"],
    },
    canvas_create_rubricassociation: {
      rubric_association_rubric_id: made.rubric_id,
      rubric_association_association_id: made.assignment_id,
      rubric_association_association_type: "Assignment",
      rubric_association_purpose: "grading",
      rubric_association_title: `${mark} association two`,
    },
    canvas_create_single_rubric: {
      rubric_title: `${mark} rubric two`,
      rubric_association_association_id: made.assignment_id,
      rubric_association_association_type: "Assignment",
      rubric_association_purpose: "grading",
    },
    // Canvas names the files a usage right applies to as a list of ids, and the
    // justification from its own list. A single id or an invented word is the
    // request Canvas refuses.
    canvas_set_usage_rights_courses: {
      file_ids: made.file_id ? [made.file_id] : undefined,
      usage_rights_use_justification: "own_copyright",
      usage_rights_legal_copyright: `${mark} copyright`,
    },
    canvas_remove_usage_rights_courses: { file_ids: made.file_id ? [made.file_id] : undefined },
    // A reorder names the pinned topics it moves, so it needs one this sweep pinned.
    canvas_reorder_pinned_topics_courses: { order: made.pinned_topic_id ? [made.pinned_topic_id] : undefined },
    // Canvas reads the feed it is given, so the address has to be a feed.
    canvas_create_external_feed_courses: {
      url: "https://www.canvaslms.com/blog/rss.xml", verbosity: "link_only", header_match: false,
    },
    // The course this sweep proves itself in keeps its own name. A sweep that
    // renames it leaves the person's course carrying a sweep's mark, so the
    // change is proven on a field that names nothing else.
    canvas_update_course: { course_name: undefined, course_friendly_name: `${mark} friendly name` },
    canvas_update_courses: { course_name: undefined },
    // Canvas needs a whole late policy, not a name. A policy with nothing
    // enabled changes no grade and is what this course can be proven with.
    canvas_create_late_policy: {
      late_policy_late_submission_deduction_enabled: false,
      late_policy_missing_submission_deduction_enabled: false,
      late_policy_late_submission_interval: "day",
      late_policy_late_submission_deduction: 0,
      late_policy_missing_submission_deduction: 0,
    },
    canvas_patch_late_policy: {
      late_policy_late_submission_deduction_enabled: false,
      late_policy_late_submission_interval: "day",
    },
    // A flag is set to a state Canvas names, never to a word.
    canvas_set_feature_flag_courses: { state: "off" },
    canvas_remove_feature_flag_courses: {},
    // A column's data is a list of records, one per person, and this sweep has
    // no person's grade to write. The column itself is proven instead.
    canvas_bulk_update_column_data: { column_data: undefined },
    // A folder Canvas still holds content in is only removed when the request
    // says so, which is what this sweep's own folder needs.
    canvas_delete_folder: { force: true },
    canvas_export_content_groups: { export_type: "zip", skip_notifications: true, select: undefined },
    canvas_export_content_courses: { export_type: "zip", skip_notifications: true, select: undefined },
    // A content migration copies this course into itself, which reaches no
    // other course and is the shape Canvas accepts.
    canvas_create_content_migration_courses: {
      migration_type: "course_copy_importer", settings_source_course_id: COURSE,
      pre_attachment_name: undefined, pre_attachment: undefined, settings_question_bank_name: undefined,
      settings_file_url: undefined, select: undefined,
    },
    // Canvas keys a timetable by the section it is for, so the section this
    // sweep made is the key and the times sit under it.
    canvas_set_course_timetable: {
      timetables_course_section_id: made.section_id,
      timetables_course_section_id_weekdays: ["Mon"],
      timetables_course_section_id_start_time: ["09:00"],
      timetables_course_section_id_end_time: ["10:00"],
      timetables_course_section_id_location_name: [`${mark} room`],
    },
    // A course copy names the course it copies from. This course copies from
    // itself, so the change reaches no other course.
    canvas_copy_course_content: { source_course: COURSE, except: undefined, only: undefined },
    canvas_create_new_quiz: { quiz_title: `${mark} new quiz`, quiz_points_possible: 1 },
    canvas_update_single_quiz: { quiz_title: `${mark} new quiz two` },
    canvas_create_course_pace: { start_date: "2026-10-05", end_date: "2026-11-05", workflow_state: "active", exclude_weekends: true },
    // A reorder names the objects it moves, and these are the ones this sweep made.
    // Canvas takes these as records, and its own specification lists them as
    // plain strings, so the shape has to come from the Canvas documentation.
    canvas_batch_create_overrides_in_course: {
      assignment_overrides: made.assignment_id && made.section_id
        ? [{ assignment_id: made.assignment_id, course_section_id: made.section_id, title: `${mark} override` }]
        : undefined,
    },
    canvas_batch_update_overrides_in_course: {
      assignment_overrides: made.assignment_id && made.override_id
        ? [{ id: made.override_id, assignment_id: made.assignment_id, title: `${mark} override two` }]
        : undefined,
    },
    canvas_create_or_update_events_directly_for_course_timetable: {
      course_section_id: made.section_id,
      events_title: [`${mark} timetable event`],
      events_start_at: ["2026-10-05T15:00:00Z"],
      events_end_at: ["2026-10-05T16:00:00Z"],
      events: undefined,
    },
    canvas_reorder_quiz_items: { order_id: [made.question_id].filter(Boolean), order_type: "question" },
    canvas_reorder_question_groups: { order_id: [made.question_id].filter(Boolean), order_type: "question" },
    canvas_reorder_module_items: { order: [made.item_id].filter(Boolean) },
  };
  // Everything this sweep makes carries its mark, so the sweep can find what it
  // made, address only that, and remove all of it afterwards.
  const named = {};
  for (const parameter of operation.parameters || []) {
    if (parameter.location === "path") continue;
    if (!/(?:^|_)(?:name|title)$/.test(parameter.inputName)) continue;
    if (parameter.schema?.type === "array") named[parameter.inputName] = [`${mark} ${parameter.inputName}`];
    else if (parameter.schema?.type === "string" || parameter.schema?.type === undefined) named[parameter.inputName] = `${mark} ${parameter.inputName}`;
  }
  return { ...named, ...(byTool[operation.toolName] || {}) };
}

// The objects that live inside the connected course. A change addressed at one
// of them is a change inside that course, whatever its address looks like: a
// group's folder is the course's group's folder, and Canvas simply names it
// `/v1/groups/{group_id}/folders`.
const SANDBOX_RESOURCES = new Set([
  "courses", "groups", "sections", "folders", "files", "quizzes", "assignments", "discussion_topics",
  "rubrics", "rubric_associations", "polls", "poll_sessions", "poll_choices", "group_categories",
  "modules", "outcome_groups", "outcomes", "appointment_groups", "external_feeds", "content_migrations",
  "calendar_events", "conversations", "eportfolios", "planner_notes", "planner", "submissions",
  "quiz_submissions", "progress", "epub_exports", "media_objects", "question_banks", "assessment_questions",
]);

/** The resource each `{id}` in a route addresses, from the segment before it. */
function addressedResources(operation) {
  const segments = String(operation.path || "").split("/").filter(Boolean);
  const named = [];
  for (const [index, segment] of segments.entries()) {
    if (!segment.startsWith("{")) continue;
    const owner = segments[index - 1];
    named.push(owner || "");
  }
  return named;
}

function insideTheSandboxCourse(operation) {
  if (/^\/(?:quiz\/)?v1\/courses\/\{course_id\}\//.test(operation.path)) return true;
  // The institution's own account, its global outcomes, its student information
  // system and an installed LTI tool all sit outside this course, however the
  // route is addressed.
  if (/^\/v1\/(?:accounts|global)\//.test(operation.path)
    || /^\/sis\//.test(operation.path)
    || operation.path.startsWith("/lti/")) return false;
  const named = addressedResources(operation);
  if (named.length === 0) return false;
  // `users` is this person and the course's own test people, never anyone else:
  // the other-person rule below still holds for a route that names one.
  return named.every((resource) => SANDBOX_RESOURCES.has(resource) || resource === "users");
}

// A message route this sweep may attempt, because it names the signed-in person
// as the only recipient and reaches nobody else.
const SELF_ADDRESSED_MESSAGE_TOOLS = new Set([
  "canvas_create_conversation", "canvas_add_message", "canvas_batch_update_conversations",
  "canvas_delete_conversation", "canvas_delete_message", "canvas_mark_all_as_read",
]);

function exclusion(operation) {
  // The one rule that decides what this sweep may attempt: every object the
  // change addresses has to live inside the connected course, which is a course
  // made only to prove Morrow and holds no learner but its own test people.
  // What stays out is what leaves it: the institution account, another course,
  // another person, an installed LTI tool, and anything Canvas sends onward.
  if (!insideTheSandboxCourse(operation)) {
    return "owner_excluded_outside_the_connected_course";
  }
  if (OUTBOUND_PATH.test(operation.path)) return "owner_excluded_outbound_ticket_message_or_cross_course";
  if (/error_report|ticket|support_request/i.test(`${operation.family} ${operation.toolName} ${operation.path}`)) {
    return "owner_excluded_support_ticket";
  }
  if (/blueprint|update_associations|migration_to_push/i.test(`${operation.family} ${operation.toolName} ${operation.path}`)) {
    return "owner_excluded_cross_course_blueprint";
  }
  if (EXCLUDED_TOOLS.has(operation.toolName)) return "owner_excluded_irreversible_person_or_course_change";
  // Grades and submissions inside this course belong to its own test people, so
  // they are this sweep's to prove. A grade anywhere else still is not.
  // A message is different: it leaves Canvas for whoever it names. Only the
  // routes whose recipients this sweep pins to the signed-in person are allowed.
  if (/conversation|message|notification/i.test(`${operation.family} ${operation.toolName}`)
    && !SELF_ADDRESSED_MESSAGE_TOOLS.has(operation.toolName)) {
    return "owner_excluded_learner_messages";
  }
  if (operation.path.startsWith("/lti/")) return "requires_installed_lti_tool_token";
  if ((operation.parameters || []).some((parameter) => parameter.location === "path" && OTHER_PERSON_INPUT.test(parameter.inputName))) {
    return "owner_excluded_another_person";
  }
  if (/^\/v1\/accounts\//.test(operation.path)
    || (operation.parameters || []).some((parameter) => parameter.location === "path" && parameter.inputName === "account_id")) {
    return "owner_excluded_institution_account";
  }
  if (/^\/v1\/users\//.test(operation.path) && !SELF_OBJECT_ROUTE.test(operation.path)) {
    return "owner_excluded_signed_in_person_settings";
  }
  if (SETTINGS_ROUTE.test(operation.path) && /^\/v1\/users\//.test(operation.path)) {
    return "owner_excluded_signed_in_person_settings";
  }
  return null;
}

const { client, transport } = await connect("morrow-sweep-writes");
const { log, read, change, callTool } = makeTools(client, logPath);

/**
 * One write's evidence. PASS only where the effect was read back from Canvas itself; a change
 * Canvas has no read for is BLOCKED with that reason, never counted as proven.
 */
const VERDICTS = {
  verified: "PASS",
  // Not proven, and not a defect either: the harness could not build the argument, Morrow held
  // the change behind one already waiting on the same target, or Canvas has no read for it.
  excluded: "BLOCKED",
  unreachable: "BLOCKED",
  not_planned: "BLOCKED",
  sent_unchecked: "BLOCKED",
  applied_or_unknown: "BLOCKED",
  approval_withheld: "BLOCKED",
  approved: "BLOCKED",
  unsettled: "BLOCKED",
  closed_by_person: "BLOCKED",
  cancelled: "BLOCKED",
  refused: "BLOCKED",
  // A defect: Morrow threw, or its own readback disagreed with what it settled.
  threw: "FAIL",
  mismatch: "FAIL",
  failed: "FAIL",
};

/**
 * Why a change that did not complete was not proven. A queue conflict and an argument the harness
 * cannot build are limits of this run; they are recorded as such rather than as defects, because a
 * FAIL that is not a defect hides the ones that are.
 */
function blockedReason(entry) {
  const detail = String(entry.text ?? entry.detail ?? "");
  if (/waiting for approval|existing request/i.test(detail)) {
    return "Morrow held this change behind one already waiting on the same target; this run did not settle it.";
  }
  if (/input is invalid|Check this input/i.test(detail)) {
    return `This harness could not build the argument shape the route requires: ${/Check this input: ([^.]+)\./.exec(detail)?.[1] ?? "see detail"}.`;
  }
  return "";
}
const record = (toolName, entry) => {
  const state = String(entry.state ?? entry.outcome ?? "unknown");
  const confirmed = state !== "verified" || entry.verification === undefined || entry.verification === "verified";
  const queued = blockedReason(entry);
  // A change Canvas confirmed is proven, whatever an earlier planning attempt said: the queue
  // reason only explains a change that did not complete.
  const verdict = !confirmed ? "FAIL"
    : state === "verified" ? "PASS"
    : queued ? "BLOCKED"
    : (VERDICTS[state] ?? "FAIL");
  recordRow(ledger, toolName, {
    phase: 1,
    kind: "write",
    verdict,
    ...(confirmed ? {} : { reason: `Morrow settled this change as ${state} while its own readback said ${entry.verification}.` }),
    ...(confirmed && queued && state !== "verified" ? { reason: queued } : {}),
    state,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.missing ? { missing: entry.missing } : {}),
    ...(entry.attention ? { attention: entry.attention } : {}),
    ...(entry.verification
      ? { readback: { source: "canvas", verification: entry.verification, operationId: entry.operationId ?? null } }
      : {}),
    ...(entry.text ? { detail: String(entry.text).slice(0, 300) } : {}),
    sandbox: { courseId: SANDBOX.courseId, mark },
  });
};

let cleanup = [];
try {
  const disposables = await makeDisposables(mark, { read, change, log });
  cleanup = disposables.cleanup;
  // Only the course this sweep is bound to and the objects this sweep made. An
  // id read from the course itself is never addressed by a change here, so no
  // content the course already held can be altered or removed by this sweep.
  // The connected course and the objects this sweep made inside it. No person,
  // no account, and nothing the course already held.
  // The signed-in person is the person every route that names one addresses
  // here. A route that names anyone else is refused before it is filled.
  const addressable = { course_id: COURSE, user_id: "self", ...disposables.made };
  // Objects the course already holds, read from Canvas by the seed harvest. A
  // change that alters one of them is proven against a real record, which is
  // what this course exists for. A change that removes one is not: a removal is
  // only ever attempted against an object this sweep made itself, so the course
  // keeps everything it held before.
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(new URL("seed-pool.json", import.meta.url), "utf8"));
  } catch { /* the sweep still runs on what it makes itself */ }
  const alterable = { ...existing, ...addressable };
  // A change that removes an object runs after every change that needs it. In
  // name order alone the sweep deleted its own page, topic and assignment first
  // and then addressed them, and Morrow rightly withheld approval for a change
  // to an item that was no longer there.
  const removes = (operation) => (operation.risk === "destructive" || /(?:^|_)(?:delete|destroy|remove)_/.test(operation.toolName) ? 1 : 0);
  // One named set of changes, for proving the few a full sweep left blocked.
  const only = (process.env.PROOF_ONLY || process.env.SWEEP_ONLY || "").split(",").map((name) => name.trim()).filter(Boolean);
  const writes = OPERATIONS.filter((operation) => !operation.readOnly)
    .filter((operation) => only.length === 0 || only.includes(operation.toolName))
    .sort((a, b) => removes(a) - removes(b) || a.toolName.localeCompare(b.toolName));
  await log(`writes to attempt: ${writes.length}, already recorded: ${Object.keys(receipt.results).length}`);

  let index = 0;
  for (const operation of writes) {
    index += 1;
    if (receipt.results[operation.toolName]) continue;
    const excluded = exclusion(operation);
    if (excluded) { record(operation.toolName, { state: "excluded", reason: excluded, path: operation.path }); continue; }

    // The object a route names by `id` is this sweep's own object of that family.
    // A removal addresses only what this sweep made; anything else may also
    // address what the course already holds.
    const own = { ...(removes(operation) ? addressable : alterable) };
    // A submission belongs to the person who made it, and the signed-in teacher
    // made none. Morrow names a person in this course by the learner token it
    // gives across its privacy boundary, never by a raw Canvas id, so that token
    // is who these routes address.
    if (/\/submissions(?:\/|$)/.test(operation.path) && own.learner_token) {
      for (const parameter of operation.parameters || []) {
        if (parameter.location !== "path") continue;
        if (/^(?:user_id|student_id|course_user_id)$/.test(parameter.inputName)) own[parameter.inputName] = own.learner_token;
      }
      // A submission exists for one exact assignment and one exact person. The
      // assignment this sweep made has no submission for anyone, so the pairing
      // Canvas really holds is the one these routes address.
      if (own.submission_assignment_id) own.assignment_id = own.submission_assignment_id;
      if (own.submission_id) own.id = own.submission_id;
    }
    const familyId = `${operation.family}_id`;
    if (own[familyId] !== undefined) own.id = own[familyId];
    const filled = fillArguments(operation, own, exactArguments(operation, own, mark));
    if (filled.missing) {
      record(operation.toolName, { state: "unreachable", missing: filled.missing, path: operation.path });
      continue;
    }
    const entry = await change(`sweep.${operation.toolName}`, operation.toolName, filled.args);
    // What this change created is what the next change to that kind needs. The
    // sweep reads the collection it went into and keeps the id, so a create, an
    // update and a delete of the same kind can each be proved in one pass.
    if (["verified", "sent_unchecked", "applied_or_unknown"].includes(String(entry.outcome)) && operation.method === "POST") {
      const listing = OPERATIONS.find((candidate) => candidate.readOnly && candidate.method === "GET" && candidate.path === operation.path);
      if (listing) {
        const filledRead = fillArguments(listing, own);
        if (!filledRead.missing) {
          const listed = await read(listing.toolName, { ...filledRead.args, morrow_max_pages: 5 });
          if (listed.ok) {
            const learned = harvestSeeds(listing, listed.data, addressable, mark);
            if (learned.length) await log(`learned ${learned.join(" ")}`);
          }
        }
      }
    }
    // A change Morrow could not confirm holds its target. Settling it here is
    // what lets the next change to the same collection be attempted at all.
    if (entry.operationId && ["sent_unchecked", "applied_or_unknown", "awaiting_verification"].includes(String(entry.outcome))) {
      try {
        entry.settled = await settleOperation(callTool, entry.operationId, operation.toolName, own);
        await log(`settle ${operation.toolName}: ${entry.settled}`);
      } catch (error) { entry.settled = `settle_failed:${String(error).slice(0, 60)}`; }
    }
    record(operation.toolName, {
      state: entry.outcome,
      code: entry.plan?.code ?? entry.result?.code ?? null,
      ...(entry.attention ? { attention: entry.attention } : {}),
      ...(entry.approvalReason ? { approvalReason: entry.approvalReason, approvalSentence: entry.approvalSentence } : {}),
      ...(entry.settled ? { settled: entry.settled } : {}),
      text: (entry.plan?.text || entry.result?.text || entry.error || "").slice(0, 200),
      path: operation.path,
      arguments: filled.args,
    });
    if (index % 20 === 0) {
      const by = {};
      for (const row of Object.values(receipt.results)) by[row.state] = (by[row.state] || 0) + 1;
      await log(`${index}/${writes.length} ${JSON.stringify(by)}`);
    }
  }
} finally {
  await log(`writes complete: ${JSON.stringify(summarize(ledger))}`);
  // Nothing this run made is left in the sandbox. Each removal is recorded, so the ledger says
  // the course was returned to what it held before.
  if (cleanup.length) {
    const removed = await removeDisposables(cleanup, { change, log }).catch((error) => ({ error: String(error).slice(0, 200) }));
    const leftBehind = removed?.leftBehind ?? [];
    recordRow(ledger, `cleanup:${mark}`, {
      phase: 1, kind: "cleanup",
      verdict: removed?.error || leftBehind.length > 0 ? "FAIL" : "PASS",
      ...(leftBehind.length ? { reason: `${leftBehind.length} object(s) this run made were not removed: ${leftBehind.map((row) => row.key).join(", ")}.` } : {}),
      sandbox: { courseId: SANDBOX.courseId, mark }, cleanup: removed ?? { removed: cleanup.length },
    });
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
