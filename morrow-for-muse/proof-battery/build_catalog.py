#!/usr/bin/env python3
"""Build OPERATION_CATALOG.md: the authoritative, evidence-honest operation
catalog for the Morrow for Muse proof battery.

Reads the desktop operation catalogs (Canvas REST, Moodle browser) as the
reference surface, filters to course-level operations, and assigns each an
honest evidence status based on actual live receipts in the deploy workspace
and the pre-deploy proof tree. Writes OPERATION_CATALOG.md.

Run: python3 build_catalog.py
Stdlib only.

WARNING (2026-09-22): OPERATION_CATALOG.md carries hand-applied amendments
the evidence map below does not model (2026-09-21 Chromium battery results
across many C- rows, the parity-law amendment retiring tenant-restricted,
and the 2026-09-22 Lane 6 Item Bank executor-pipeline proofs). Regenerating
from this script will CLOBBER those amendments. The Item Bank section of
the map is kept current (mechanism item-banks-sdk, 2026-09-21/22 evidence);
the C-/Moodle sections of the map are stale relative to the md. Do not
regenerate until the map is reconciled with the md, or reconcile by hand.
"""
import json
import os
import re
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY = os.path.dirname(HERE)
CANVAS_CATALOG = "/home/hatch/workspace/morrow-fix/artifacts/canvas-api/canvas-api-catalog.json"
MOODLE_CATALOG = "/home/hatch/workspace/morrow-fix/connector/extension/generated/moodle-browser-catalog.json"
OUT = os.path.join(HERE, "OPERATION_CATALOG.md")
DATE = "2026-09-20"

# --------------------------------------------------------------------------
# Evidence map: Canvas toolName -> (status, evidence)
# --------------------------------------------------------------------------
# Statuses: live-proven | pending | tenant-restricted | unsupported |
#           excluded | source-only
# learner-data is an orthogonal flag, recorded in the privacy section.
E = {}

E["canvas_get_single_course_courses"] = (
    "live-proven",
    "transport/batchA.json op-course: GET /api/v1/courses/89585 (2026-09-20); "
    "logs/keepalive-canvas.log status=200 principal 28206")
E["canvas_create_assignment"] = (
    "live-proven",
    "transport/batchA.json op-create: assignment 4045368 HTTP 201 (2026-09-20 18:30 UTC); "
    "proofs/quiz-lane-unblock.md: external_tool variant 4045366 HTTP 201")
E["canvas_edit_assignment"] = (
    "live-proven",
    "transport/batchB.json op-rename: assignment 4045368 renamed HTTP 200 (2026-09-20)")
E["canvas_delete_assignment"] = (
    "live-proven",
    "transport/batchB.json op-delete: assignment 4045368 workflow_state deleted; "
    "proofs/quiz-lane-unblock.md: assignment 4045366 deleted, GET returned 404")
E["canvas_get_single_assignment"] = (
    "live-proven",
    "4045368 readback after create; GET after delete returned 404 "
    "(weasel-b1-runtime-browser.md section 8; transport/batchB.json op-verify-gone)")
# Item Bank operations (2026-09-21/22, mechanism item-banks-sdk:
# transport/item_bank_sdk.py: dynamic LTI tool resolution, course-scoped
# banks.build launch, CDP capture of the Authorization request headers
# from tenant-bound quiz-api traffic, per-tenant quiz-api origin
# derivation, item fetches in the tab root frame's isolated world).
# Executor-pipeline proof = through dispatch/executor.py on live course
# 89585 with disposable objects and full cleanup (Lane 6 live battery,
# 2026-09-22; evidence ~/workspace/audits/earthshake-2026-09-22/).
_IB_EXEC = ("2026-09-22 Lane 6 live battery: executor-pipeline live proof "
            "through dispatch/executor.py + transport/item_bank_sdk.py "
            "(course 89585, disposable objects, full cleanup).")
E["canvas_item_bank_create_bank"] = (
    "live-proven",
    "2026-09-21 Chromium write battery: POST 201 banks 4053/4054/4055/4056. "
    "%s POST 201 bank 4075; bank GET readback passed." % _IB_EXEC)
E["canvas_item_bank_get_bank"] = (
    "live-proven",
    "DEPLOY.md Fix A: bank 4017 read op 92246094-969d-4f65-80d1-69c180563285; "
    "readbacks of 4037/4040/4041 with title match. "
    "%s GET 200 bank 2934, title '06.02 CHEST 213' matched." % _IB_EXEC)
E["canvas_item_bank_list_banks"] = (
    "live-proven",
    "item_bank_battery_results.json baseline_list: 11 banks; "
    "deploy smoke list before/after (bank 4041 absent after archive). "
    "%s GET 200, 50 banks listed." % _IB_EXEC)
E["canvas_item_bank_attach_item"] = (
    "live-proven",
    "%s POST 201 entry 82773 (item 11269644 attached to disposable bank "
    "4075); entry removed 204; entries list verified clean; bank archived "
    "204, absent from bank list. The 2026-09-21 'No anchor' failure was the "
    "old canvas-origin path; the SDK lane is the only Item Banks lane."
    % _IB_EXEC)
E["canvas_item_bank_list_entries"] = (
    "live-proven",
    "item_bank_battery_results.json src_entries_scan bank 4017 (entry 82658); "
    "entries_readback bank 4037 entry_count 1. "
    "%s GET 200, 12 entries on anchor bank 2934." % _IB_EXEC)
E["canvas_item_bank_archive_bank"] = (
    "live-proven",
    "DEPLOY.md 4-8: bank 4041 op 884eb821-d3b6-4ca9-b04f-80de9d851d99, "
    "bank 4040 op 4438579d-9b73-4745-8664-47e52dcae508; pre-deploy bank 4037; "
    "all archived=true and absent from the live list. "
    "2026-09-21 Chromium write battery: DELETE 204 archive; readback "
    "archived_flag. %s DELETE 204 archive bank 4075; absent from bank list."
    % _IB_EXEC)

# Explicitly unproven / restricted / unsupported
E["canvas_list_assignments_assignments"] = (
    "pending",
    "LEDGER.md marked this PROVEN on 'lifecycle readbacks'; audit found no "
    "explicit list-assignments receipt, only single-assignment GETs. Corrected to pending.")
E["canvas_send_message_to_unsubmitted_or_submitted_users_for_quiz"] = (
    "excluded",
    "Braden exclusion: sends messages to people (messages quiz takers)")
E["canvas_create_new_quiz"] = (
    "tenant-restricted",
    "Direct quiz creation 401s under the quiz.build token on this tenant class; "
    "the proven creation path is assignment-create plus native launch (see New Quiz sequence).")
E["canvas_delete_conclude_course"] = (
    "tenant-restricted",
    "Destructive on the live course; no disposable test object possible. "
    "Not safely provable on a real course.")
E["canvas_item_bank_share_bank"] = (
    "live-proven",
    "Wave 1: bank 4042 share 38922 (course 89585) HTTP 201; "
    "Wave 2: bank 4044 share 38924 HTTP 201. "
    "2026-09-21 Chromium write battery: POST 201 share 38934. "
    "%s POST 201 share 39204 (course 89585); share list showed it."
    % _IB_EXEC)
E["canvas_item_bank_list_shares"] = (
    "live-proven",
    "Wave 1/2: GET /api/banks/{bank}/shared_banks HTTP 200 on banks 4042/4044; "
    "archived-bank share inspection 401s (scope has no policy for archived shares). "
    "%s GET 200 shared_banks on anchor bank 2934." % _IB_EXEC)
E["canvas_item_bank_unshare_bank"] = (
    "live-proven",
    "Unshare is PATCH /api/banks/{bank_id}/shared_banks/{shared_bank_id} with "
    "{shared_bank:{permission:\"removed_access\"}}: 2026-09-21 Chromium write "
    "battery (share 38934, PATCH 200, list verified clean). DELETE on the "
    "share route 404s; that DELETE reading is retired as the unshare "
    "statement. %s PATCH 200 unshare share 39204; share list verified clean."
    % _IB_EXEC)

# Item Bank Wave 1 + Wave 2 receipts (2026-09-20, quiz-api host, banks.build
# token), superseded by the SDK lane 2026-09-21 and the executor pipeline
# 2026-09-22 (Lane 6 live battery).
E["canvas_item_bank_create_item"] = (
    "live-proven",
    "2026-09-21: LIVE-PROVEN through the Chromium SDK lane: item_create 201, "
    "item 11244176 in disposable bank 4062; full lifecycle with cleanup "
    "(attached via bank_entries 201 entry 82714, entry removed 204, bank "
    "archived 204). %s POST 201 item 11269644 in disposable bank 4075; "
    "generic readback deliberately skipped (IB-11 provider anomaly)."
    % _IB_EXEC)
E["canvas_item_bank_update_item"] = (
    "live-proven",
    "2026-09-21: LIVE-PROVEN through the Chromium SDK lane: PATCH 200 on "
    "attached item 11244176 (disposable bank 4062), entry GET readback 200 "
    "with the renamed item_body confirmed (rename_match). PATCH must run "
    "after the item is attached via bank_entries (unattached items 404). "
    "%s PATCH 200 item 11269644; entry GET readback 200 with the updated "
    "item_body confirmed." % _IB_EXEC)
E["canvas_item_bank_get_entry"] = (
    "live-proven",
    "Entry GET is the working item read path (direct item GET is "
    "provider-anomalous, see canvas_item_bank_get_item). 2026-09-21: entry "
    "82714 read 200 with exact nested item. "
    "%s GET 200 entry 82773 with the updated item_body." % _IB_EXEC)
E["canvas_item_bank_get_item"] = (
    "unsupported",
    "Provider-anomalous: direct item GET /api/banks/{bank}/items/{item} -> "
    "404 for existing items (2026-09-21: 11244173 unattached, 11244175 and "
    "11244176 attached; earlier 11242724/11242015). Entry GET is the working "
    "readback route. No working item DELETE route either (IB-19).")
E["canvas_item_bank_delete_item"] = (
    "pending",
    "Item DELETE was never proven on any lane; the SDK lane answered 404 on "
    "the attached live item 11244176 (2026-09-21). The provider's actual "
    "item-removal route is DELETE /api/banks/{bank_id}/bank_entries/{entry_id} "
    "(IB-7). The route as defined stays unproven and is not claimed.")
E["canvas_item_bank_delete_entry"] = (
    "live-proven",
    "2026-09-21: the 22:01 UTC disposable lifecycle removed bank entry 82714 "
    "with DELETE 204; pre-archive entries-list readback 200 count=0 with the "
    "entry absent. %s DELETE 204 entry 82773; entries list verified clean."
    % _IB_EXEC)
E["canvas_item_bank_rename_bank"] = (
    "live-proven",
    "Wave 1: bank 4042 PATCH rename HTTP 200. 2026-09-21 Chromium write "
    "battery: PATCH 200 rename 4053; readback title_match. "
    "%s PATCH 200 rename bank 4075; readback title matched." % _IB_EXEC)
# quiz_entries routes: provider-unserved under the banks.build scope.
# Parity law: evidence-hold (refused on EVERY tenant), never tenant-restricted.
for _tool in [
    "canvas_item_bank_attach_bank_entry_to_quiz",
    "canvas_item_bank_attach_bank_to_quiz",
    "canvas_item_bank_list_quiz_draws",
    "canvas_item_bank_delete_quiz_bank_entry",
]:
    E[_tool] = (
        "evidence-hold",
        "All quiz_entries routes -> 401 under the banks.build scope (the "
        "scope has no policy for quiz_entries). Requires a different "
        "authorization scope. Refused on every tenant until a disposable "
        "live battery proves the complete path; when proven it is admitted "
        "on all tenants. Quiz 506477 untouched.")

# Writes that affect the subaccount or account-level state (Braden exclusion)
for _tool in [
    "canvas_begin_migration_to_push_to_associated_courses",
    "canvas_update_associated_courses",
    "canvas_set_or_remove_restrictions_on_blueprint_course_object",
]:
    E[_tool] = ("excluded",
                "Braden exclusion: blueprint migrations push to associated courses, "
                "affecting the subaccount beyond the test course")
E["canvas_disable_assignments_currently_enabled_for_grade_export_to_sis"] = (
    "excluded", "Braden exclusion: affects SIS grade export (subaccount/institution state)")
E["canvas_set_feature_flag_courses"] = (
    "excluded", "Braden exclusion: feature flags affect subaccount-level feature state")
E["canvas_remove_feature_flag_courses"] = (
    "excluded", "Braden exclusion: feature flags affect subaccount-level feature state")
E["canvas_enable_disable_or_clear_explicit_csp_setting_courses"] = (
    "excluded", "Braden exclusion: CSP settings affect account security posture")

# Discussion topics: announcement variants notify enrolled users
E["canvas_create_new_discussion_topic_courses"] = (
    "live-proven",
    "Plain topic lifecycle proven 2026-09-20: discussion 1241942 created "
    "HTTP 201, read 200 with exact title/body (author 28206); announcement "
    "variants remain EXCLUDED (posting an announcement notifies enrolled "
    "users, which Braden excluded). Fixture: "
    "evidence/canvas-wave-c1/discussion-lifecycle-result.json")
E["canvas_update_topic_courses"] = (
    "live-proven",
    "Discussion 1241942 renamed HTTP 200, readback 200 with exact title "
    "(2026-09-20, canvas-batch form lane)")
E["canvas_delete_topic_courses"] = (
    "live-proven",
    "Discussion 1241942 deleted HTTP 200, final GET 404, nothing remains "
    "(2026-09-20, canvas-batch form lane)")

# Canvas module lifecycle (2026-09-20, course 89585, canvas-batch form lane)
E["canvas_create_module"] = (
    "live-proven",
    "Module 958488 created HTTP 201 ('Weasel Proof Module (delete me)', "
    "position 206, unpublished). Fixture: "
    "evidence/canvas-wave-c1/module-lifecycle-result.json")
E["canvas_show_module"] = (
    "live-proven",
    "Module 958488 readback HTTP 200 with exact name, before and after rename")
E["canvas_update_module"] = (
    "live-proven",
    "Module 958488 renamed to 'Weasel Proof Module RENAMED' HTTP 200, "
    "readback confirmed the exact new name")
E["canvas_delete_module"] = (
    "live-proven",
    "Module 958488 deleted HTTP 200; direct GET 404 and absent from the "
    "100-module course list; no residue")
E["canvas_list_modules"] = (
    "live-proven",
    "GET /api/v1/courses/89585/modules?per_page=100 returned 100 modules; "
    "used as the verify-gone check (no 'Weasel' names, id 958488 absent)")

# Canvas page lifecycle (2026-09-20, course 89585, canvas-batch form lane)
E["canvas_create_page_courses"] = (
    "live-proven",
    "Page 3467772 created HTTP 201 (slug weasel-proof-page-delete-me). Live "
    "contract: Canvas Pages uses wiki_page[title] and wiki_page[body]. Fixture: "
    "evidence/canvas-wave-c1/page-lifecycle-result.json")
E["canvas_show_page_courses"] = (
    "live-proven",
    "Page 3467772 readback HTTP 200 under both the original and the "
    "regenerated slug")
E["canvas_update_create_page_courses"] = (
    "live-proven",
    "Page 3467772 renamed HTTP 200; Canvas regenerated the slug to "
    "weasel-proof-page-renamed")
E["canvas_delete_page_courses"] = (
    "live-proven",
    "Page 3467772 deleted HTTP 200; both slugs GET 404; 'weasel' search empty; "
    "no page residue")

# --------------------------------------------------------------------------
# Learner-data families (Canvas). Any op in these families returns learner PII.
# These are NOT live-tested until the tokenization boundary lands.
# --------------------------------------------------------------------------
LEARNER_FAMILIES = {
    "submissions", "quiz_submissions", "quiz_submission_events",
    "quiz_submission_files", "enrollments", "analytics", "names_and_role",
    "outcome_results", "gradebook_history", "grade_change_log",
    "moderated_grading", "peer_reviews", "submission_comments", "line_items",
    "result", "score", "assignment_extensions", "quiz_extensions",
    "course_quiz_extensions", "quiz_reports", "quiz_statistics",
    "what_if_grades", "progress", "liveassessments", "quiz_submission_user_list",
    "custom_gradebook_columns", "ai_conversations", "discussion_topics",
    "course_audit_log",
}

# PII-bearing fields per family (exact field names the API returns)
PII_FIELDS = {
    "submissions": "user_id, user[id, name, short_name, sortable_name, avatar_url], "
                   "grader_id, submitted_at, body/attachments (learner-authored)",
    "quiz_submissions": "user_id, user[name, sortable_name], started_at, finished_at, "
                        "attempt, score, answers (learner-authored)",
    "quiz_submission_events": "user_id, created_at, event_type, event_data",
    "quiz_submission_files": "user_id, attachment filenames/urls",
    "enrollments": "user_id, user[id, name, short_name, sortable_name, avatar_url, "
                   "enrollments], sis_user_id, login_id, email",
    "analytics": "student_id, page_views, participations, tardiness breakdowns",
    "names_and_role": "LTI NRPS membership: user_id, name, email, roles, status",
    "outcome_results": "user_id, user[name], score, submitted_or_assessed_at",
    "gradebook_history": "grader_id, user_id, grade_before/after, graded_at",
    "grade_change_log": "user_id, grader_id, grade_before/after",
    "moderated_grading": "provisional grades with user_id, grader_id, score, comments",
    "peer_reviews": "assessor_id, assessee user_id, user[name]",
    "submission_comments": "author_id, author_name, comment (learner-authored), created_at",
    "line_items": "LTI AGS line items; results carry userId, resultScore, comment",
    "result": "LTI AGS results: userId, resultScore, resultMaximum, comment",
    "score": "LTI AGS score publish: userId, scoreGiven, comment",
    "assignment_extensions": "user_id, extra_time/attempts granted to a learner",
    "quiz_extensions": "user_id, extra_time/attempts granted to a learner",
    "course_quiz_extensions": "user_id, extra_time/attempts granted to a learner",
    "quiz_reports": "quiz attempt reports: user_id, name, score, answers",
    "quiz_statistics": "aggregate statistics derived from learner attempts "
                       "(per-question response distributions)",
    "what_if_grades": "user_id, hypothetical grade values",
    "progress": "user_id, completed_at, progress per learner",
    "liveassessments": "assessor/assessee user_ids, scores",
    "quiz_submission_user_list": "user_id, user[name], attempt status per learner",
    "custom_gradebook_columns": "column structure is course-level; cell values are "
                                "per-learner (user_id, content)",
    "ai_conversations": "student-authored conversation content, user_id",
    "discussion_topics": "author[id, display_name, avatar_image_url], "
                         "last_reply_by; entries carry learner-authored text",
    "course_audit_log": "user_id of the actor for each audited event",
}

# --------------------------------------------------------------------------
# Moodle evidence map: toolName -> (status, evidence)
# --------------------------------------------------------------------------
M = {}
M["moodle_create_forum_discussion"] = (
    "live-proven",
    "moodle-lane-proof.md section 4: discussion 2, post 2 created via form path, "
    "HTTP 200, frozen plan op 45cc4b25 (sandbox.moodledemo.net, Moodle 5.2)")
M["moodle_list_my_courses"] = (
    "live-proven",
    "moodle-lane-proof.md section 4: course 2 'My first course', 2 enrolled "
    "(moodle.courses.read, AJAX)")
# Lane-level rows not present in the 250-op catalog
M_LANE = [
    ("moodle.principal.read (core_user_get_users_by_field, AJAX)",
     "live-proven",
     "moodle-lane-proof.md section 2: teacher id 3, username teacher, "
     "fullname Terri Teacher; sesskey 10 chars, stable"),
    ("moodle.forum.discover (form path)",
     "live-proven",
     "moodle-lane-proof.md section 4: News forum cmid 1 on course 2"),
    ("moodle.discussion.verify (form readback)",
     "live-proven",
     "moodle-lane-proof.md section 4: discussion_id 2 verified via frozen readback"),
    ("moodle.discussion.delete (form first-post delete)",
     "live-proven",
     "moodle-lane-proof.md section 4: post 2 deleted via form confirmation flow, "
     "HTTP 200; leftover discussion 1/post 1 from failed run also cleaned"),
    ("moodle.discussion.verify_gone (form read)",
     "live-proven",
     "moodle-lane-proof.md section 4: subject absent from forum page; zero "
     "MORROW-LANE-PROOF- occurrences after run"),
    ("mod_forum_add_discussion (AJAX variant)",
     "unsupported",
     "Capability probe: servicenotavailable on Moodle 5.2 (not allowed_from_ajax). "
     "Form path is the mechanism."),
    ("mod_forum_get_forum_discussions (AJAX variant)",
     "unsupported",
     "Capability probe: servicenotavailable on Moodle 5.2. Form path is the mechanism."),
    ("mod_forum_get_forums_by_courses (AJAX variant)",
     "unsupported",
     "Capability probe: servicenotavailable on Moodle 5.2. Form path is the mechanism."),
    ("core_course_get_contents (AJAX variant)",
     "unsupported",
     "Capability probe: servicenotavailable on Moodle 5.2. Form path is the mechanism."),
    ("mod_forum_delete_discussion (AJAX)",
     "unsupported",
     "Not registered in Moodle 5.2 forum db/services.php at all "
     "(invalidrecordunknown, byte-identical to a nonexistent function). "
     "Undo for discussion create is the form-path first-post delete."),
]

# Moodle learner-data tool name fragments
MOODLE_LEARNER_FRAGMENTS = (
    "grade", "submission", "participant", "enrol", "roster", "user",
    "attempt", "feedback_response", "survey",
)

# Moodle exclusions (Braden's three)
MOODLE_EXCLUDED = {
    "moodle_send_message": "Braden exclusion: sends messages to people",
}


def is_course_scoped(op):
    return bool(re.search(r"/courses/\{|/sis/courses/\{", op["path"]))


def canvas_mechanism(op):
    if op.get("family") == "new-quizzes-item-banks":
        return "quiz-api-token"
    return "canvas-batch"


def main():
    catalog = json.load(open(CANVAS_CATALOG))
    ops = [o for o in catalog["operations"] if is_course_scoped(o)]
    ops.sort(key=lambda o: (o.get("family", ""), o["toolName"]))

    mcat = json.load(open(MOODLE_CATALOG))
    mops = mcat["operations"]
    mops.sort(key=lambda o: o["key"])

    lines = []
    A = lines.append

    A("# Morrow for Muse: Operation Catalog (authoritative)")
    A("")
    A("Date: %s. Product: Morrow for Muse (no-PAT Canvas/Moodle connector, no MCP)." % DATE)
    A("This file is the authoritative operation catalog for the proof battery. "
      "It supersedes proof-battery/LEDGER.md, which is kept as-is for history.")
    A("")
    A("Path convention: the desktop catalog records paths without the /api prefix; "
      "every Canvas REST path below is shown with the real /api prefix added.")
    A("")
    A("## Proof standard")
    A("Each operation needs: (1) a batch rendered by transport/batch.py or the "
      "equivalent product transport, (2) live dispatch through the educator's "
      "browser-owned authenticated session, (3) readback verification, "
      "(4) full cleanup of disposable test objects, (5) a sanitized evidence "
      "fixture. Statuses: live-proven, pending, tenant-restricted, unsupported, "
      "excluded, source-only. Learner-data is an orthogonal flag: flagged ops are "
      "NOT live-tested until the learner tokenization boundary lands.")
    A("")
    A("## Transport mechanisms")
    A("- canvas-batch: transport/batch.py browser-task transport. Mechanism proven "
      "live 2026-09-20 (assignment lifecycle 4045368, course read, users/self). "
      "Per-operation proof still required. Not yet integrated behind dispatch/executor.py.")
    A("- quiz-api-token: provision/provision.py LTI chain plus dispatch/executor.py. "
      "Proven for the banks.build scope (bank lifecycle 4040/4041/4037). "
      "Retired for /api/banks/... paths 2026-09-21: the only Item Banks lane "
      "is item-banks-sdk below; quiz-api-token remains only as provenance on "
      "the evidence-held quiz_entries rows.")
    A("- item-banks-sdk: transport/item_bank_sdk.py Chromium SDK lane "
      "(2026-09-21/22). Dynamic Item Banks LTI tool resolution, course-scoped "
      "banks.build launch, CDP capture of the Authorization request headers "
      "from tenant-bound quiz-api traffic (token memory-only, never logged "
      "or persisted), per-tenant quiz-api origin derivation, item fetches "
      "evaluated in the tab root frame's isolated world. Executor-pipeline "
      "live proof 2026-09-22 (Lane 6 live battery, course 89585, disposable "
      "objects, full cleanup).")
    A("- moodle-ajax: moodle/session.py AJAX envelope (lib/ajax/service.php). "
      "Proven for allowed_from_ajax functions.")
    A("- moodle-form: moodle/session.py form-path fallback. Proven for forum "
      "discussion create/delete.")
    A("- executor-plain: dispatch/executor.py plain HTTPS. Works with PAT; "
      "session-cookie replay is OTP-walled on the CHCP tenant class, so no-PAT "
      "proof goes through canvas-batch.")
    A("")
    A("## Audit corrections vs LEDGER.md")
    A("1. C-R2 (list assignments) was marked PROVEN on 'lifecycle readbacks'. "
      "Audit found no explicit list-assignments receipt, only single-assignment GETs. "
      "Corrected to pending.")
    A("2. NQ-R1/NQ-R2 (list/get New Quiz) were marked PROVEN on 'provisioning battery'. "
      "The battery2 proof used quiz-api host paths (/api/quizzes/{id}), not the "
      "/api/quiz/v1 Canvas paths. The /api/quiz/v1 ops are corrected to pending; "
      "the quiz-api host read/edit are recorded in the New Quiz sequence table.")
    A("3. NQ-W1 was marked PROVEN. SUPERSEDED 2026-09-20 by the full New Quiz "
      "lifecycle (quiz 4045369): quiz-API DELETE returns HTTP 200 and cleans "
      "both quiz and assignment, no orphan. The old 401/orphan-506477 reading "
      "was wrong; that orphan came from deleting assignment 4045366 through "
      "the Canvas assignment endpoint first. Correct lifecycle: always delete "
      "a New Quiz through the quiz API. Orphan 506477 itself remains Braden's call.")
    A("4. IB-W2 was marked PENDING with 'entry 82698 archived with bank'. "
      "SUPERSEDED 2026-09-20: item create (11242724/11242727/11242728/11242729, "
      "HTTP 201) and item update (PATCH 200) are proven; entry attach "
      "(82698, 82695, 82699, 82700, 82701, 82702) and entry delete (204, "
      "idempotent) are proven; entry GET is the working item read path. "
      "Direct item GET is provider-anomalous (404 on existing items) and no "
      "item DELETE route exists (all 404).")
    A("5. IB-W3 (share/unshare) was marked NOT PROVEN (delta-2 blocker). "
      "SUPERSEDED 2026-09-20: sharing is proven (shares 38922/38924, HTTP 201; "
      "list 200). Unshare is unsupported: no working unshare route exists "
      "(DELETE 404s); shares are API-permanent on archived banks.")
    A("6. M-R1/M-R2/M-R3 were marked PROVEN. Refined: the successful run created "
      "discussion 2 / post 2 (not discussion 1 / post 1, which was the failed first "
      "run, cleaned up in the second run). The AJAX variants of the forum functions "
      "are unsupported on stock Moodle 5.2, not pending.")
    A("7. C-R11/C-R12 were correctly pending with the tokenization gate. Kept.")
    A("")

    # ---- Canvas tables by family ----
    A("## Canvas course-level operations")
    A("")
    fams = OrderedDict()
    for o in ops:
        fams.setdefault(o.get("family", "unfamilied"), []).append(o)

    counts = Counter()
    n = 0
    for fam, members in fams.items():
        A("### %s (%d)" % (fam, len(members)))
        A("")
        A("| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |")
        A("|---|------|--------|------|----|-----------|--------|------------------|")
        for o in members:
            n += 1
            tool = o["toolName"]
            method = o["method"]
            path = "/api" + o["path"] if o["path"].startswith("/") else o["path"]
            ro = "R" if o.get("readOnly") else "W"
            mech = canvas_mechanism(o)
            status, note = E.get(tool, ("pending", ""))
            if tool in E and E[tool][0] == "excluded":
                counts["excluded"] += 1
            elif status == "live-proven":
                counts["live-proven"] += 1
            elif status == "pending":
                counts["pending"] += 1
            elif status == "tenant-restricted":
                counts["tenant-restricted"] += 1
            elif status == "unsupported":
                counts["unsupported"] += 1
            else:
                counts["source-only"] += 1
            learner = " [LEARNER-DATA]" if fam in LEARNER_FAMILIES else ""
            if fam in LEARNER_FAMILIES:
                counts["learner-flagged"] += 1
            if note:
                cell = note
            elif fam in LEARNER_FAMILIES:
                cell = "GATED: not live-tested until learner tokenization lands"
            else:
                cell = ""
            A("| C-%d | %s | %s | %s | %s | %s | %s | %s |"
              % (n, tool, method, path, ro, mech, status + learner, cell))
        A("")

    # ---- Item Bank quiz-api operations (not course-scoped in the catalog) ----
    ibank = [o for o in catalog["operations"]
             if o.get("family") == "new-quizzes-item-banks"]
    ibank.sort(key=lambda o: o["toolName"])
    A("## Item Bank quiz-api operations (%d)" % len(ibank))
    A("")
    A("These run on the quiz-api host with the LTI-provisioned banks.build token "
      "(mechanism item-banks-sdk: transport/item_bank_sdk.py), not on Canvas "
      "course paths. The executor's Chromium lane egresses every /api/banks/... "
      "path through the SDK: dynamic Item Banks LTI tool resolution, "
      "course-scoped launch, CDP capture of the Authorization request headers "
      "from tenant-bound quiz-api traffic (token held in memory only, never "
      "logged or persisted), per-tenant quiz-api origin derivation, and item "
      "fetches evaluated in the tab root frame's isolated world. "
      "The archive action "
      "is the provider's whole-bank delete; there is no whole-quiz delete or "
      "archive (see the New Quiz sequence table). Bank sharing is proven "
      "(Wave 1/2, 2026-09-20); unshare is PATCH "
      "/api/banks/{bank_id}/shared_banks/{shared_bank_id} with "
      "{shared_bank:{permission:\"removed_access\"}} (proven 2026-09-21, share "
      "38934; re-proven 2026-09-22, share 39204; list verified clean both "
      "times); DELETE on the share route 404s. Direct item GET is "
      "provider-anomalous (404s on existing items); entry GET is the working "
      "item read path. quiz_entries routes need a different authorization "
      "scope (401 under banks.build); they are evidence-hold, refused on "
      "every tenant per the parity law, never tenant-restricted.")
    A("")
    A("| # | Tool | Method | Path | RO | Mechanism | Status | Evidence / notes |")
    A("|---|------|--------|------|----|-----------|--------|------------------|")
    for i, o in enumerate(ibank, start=1):
        tool = o["toolName"]
        status, note = E.get(tool, ("pending", ""))
        counts[status] += 1
        # LANE6 (2026-09-22): the SDK lane is the only Item Banks lane;
        # the four quiz_entries rows stay on the retired quiz-api-token
        # mechanism name as provenance (they are evidence-hold, refused
        # on every tenant).
        mech = ("quiz-api-token" if "quiz_entries" in o["path"]
                or "quiz_entry" in tool else "item-banks-sdk")
        A("| IB-%d | %s | %s | %s | %s | %s | %s | %s |"
          % (i, tool, o["method"], o["path"], "R" if o.get("readOnly") else "W",
             mech, status, note))
    A("")

    # ---- New Quiz creation sequence ----
    A("## New Quiz creation sequence (quiz-lti native-launch lane)")
    A("")
    A("The proven no-PAT New Quiz creation path (proofs/quiz-lane-unblock.md, "
      "2026-09-20, course 89585). This is the lane library sequence; productizing "
      "it as Muse ops is still pending.")
    A("")
    A("| # | Step | Status | Evidence |")
    A("|---|------|--------|----------|")
    nq = [
        ("NQS-1", "Create Canvas assignment (external_tool, New Quizzes tool 54065)",
         "live-proven", "assignment 4045366, HTTP 201 (proofs/quiz-lane-unblock.md)"),
        ("NQS-2", "Native launch (POST quiz-lti /api/native/launch)",
         "live-proven", "quiz-api assignment 507872 auto-provisioned, HTTP 200"),
        ("NQS-3", "Assignment session (GET quiz-lti /api/assignments/{id}?scope=quiz.build)",
         "live-proven", "quiz-api quiz 506477 auto-created, HTTP 200"),
        ("NQS-4", "Quiz read (GET quiz-api /api/quizzes/506477)",
         "live-proven", "HTTP 200, title matched"),
        ("NQS-5", "Quiz edit (PATCH quiz-api /api/quizzes/506477)",
         "live-proven", "title plus shuffle_questions confirmed via GET"),
        ("NQS-6", "Quiz delete (DELETE quiz-api /api/quizzes/{id})",
         "live-proven", "quiz 4045369 deleted via the quiz API, HTTP 200; quiz "
         "GET 404, assignment GET 404, assignment absent from the course list, "
         "no orphan. CORRECTION 2026-09-20: the old 401/orphan-506477 reading "
         "was wrong; that orphan came from deleting assignment 4045366 through "
         "the Canvas assignment endpoint first. Correct lifecycle: always "
         "delete a New Quiz through the quiz API, never through the assignment "
         "endpoint. Orphan 506477 remains Braden's call."),
        ("NQS-7", "Quiz archive (PATCH status=archived)",
         "unsupported", "No whole-quiz archive action in the served tool bundle; "
         "battery2 fallback failed"),
        ("NQS-8", "Canvas assignment delete plus verify-gone",
         "live-proven", "assignment 4045366 deleted via API, GET returned 404"),
        ("NQS-9", "Quiz settings read plus full-block PATCH",
         "live-proven", "quiz 4045369: settings read returned 13 keys; "
         "full-block PATCH changed only shuffle_questions (HTTP 200); readback "
         "preserved the other 12"),
        ("NQS-10", "Quiz item create/read/list/delete",
         "live-proven", "items 11028911/11028912 created (HTTP 200), read 200, "
         "listed, deleted; final item count 0"),
        ("NQS-11", "Quiz item rename via item.entry",
         "live-proven", "item 11028912 renamed through {item: {entry: {...}}} "
         "with readback match. Payload contract: partial {item: {title}} "
         "update -> HTTP 400; entry-nested shape is required."),
    ]
    for row in nq:
        A("| %s | %s | %s | %s |" % row)
        if row[2] == "live-proven":
            counts["live-proven"] += 1
        else:
            counts["unsupported"] += 1
    A("")
    A("Note: battery2.py also covered the accessibility-relevant check "
      "(title non-empty, instructions key present, status present, quiz_type present). "
      "Pre-existing proof objects 4045358, 4045364, 4045365 and quiz 506400 were "
      "left untouched by the lane.")
    A("")

    # ---- Moodle tables ----
    A("## Moodle course-level operations")
    A("")
    A("Reference: the desktop Moodle browser catalog (250 operations). "
      "Live proof: proofs/moodle-lane-proof.md (2026-09-20, sandbox.moodledemo.net, "
      "Moodle 5.2, teacher demo account). The sandbox resets hourly; production "
      "SSO variants and session lifetimes are unproven (proof section 6).")
    A("")

    def mseg(o):
        p = o["key"].split(".")
        return p[2] if len(p) > 2 else o["key"]

    mfams = OrderedDict()
    for o in mops:
        mfams.setdefault(mseg(o), []).append(o)

    mn = 0
    for seg, members in mfams.items():
        A("### moodle.%s (%d)" % (seg, len(members)))
        A("")
        A("| # | Tool | Key | RO | Mechanism | Status | Evidence / notes |")
        A("|---|------|-----|----|-----------|--------|------------------|")
        for o in members:
            mn += 1
            tool = o["toolName"]
            key = o["key"]
            ro = "R" if o.get("readOnly") else "W"
            mech = "moodle-ajax" if ".ajax." in key else "moodle-form"
            if tool in M:
                status, note = M[tool]
            elif tool in MOODLE_EXCLUDED:
                status, note = "excluded", MOODLE_EXCLUDED[tool]
            else:
                status, note = "pending", ""
            learner = any(f in tool for f in MOODLE_LEARNER_FRAGMENTS)
            if status == "live-proven":
                counts["live-proven"] += 1
            elif status == "excluded":
                counts["excluded"] += 1
            else:
                counts["pending"] += 1
            if learner:
                counts["m-learner-flagged"] += 1
                if not note:
                    note = "GATED: not live-tested until learner tokenization lands"
                status = status + " [LEARNER-DATA]"
            A("| M-%d | %s | %s | %s | %s | %s | %s |"
              % (mn, tool, key, ro, mech, status, note))
        A("")

    A("### Moodle lane-level rows (proven outside the 250-op catalog)")
    A("")
    A("| Tool | Status | Evidence |")
    A("|------|--------|----------|")
    for tool, status, note in M_LANE:
        A("| %s | %s | %s |" % (tool, status, note))
        if status == "live-proven":
            counts["live-proven"] += 1
        else:
            counts["unsupported"] += 1
    A("")

    # ---- Privacy gate ----
    A("## Privacy gate: learner-data operations")
    A("")
    A("Rule: no learner-data operation is live-tested until the learner "
      "tokenization boundary lands in Morrow for Muse. The desktop privacy engine "
      "(LearnerVault, scoped learner tokens, output projection) exists in "
      "morrow-fix/packages/gateway-core/src/privacy.ts; the Muse deploy only has "
      "generic key-pattern redaction in dispatch/executor.py. Until the boundary "
      "is integrated and proven, every flagged op below stays gated.")
    A("")
    A("### Canvas learner-data families and their PII-bearing fields")
    A("")
    A("| Family | PII fields exposed |")
    A("|--------|--------------------|")
    for fam in sorted(LEARNER_FAMILIES):
        A("| %s | %s |" % (fam, PII_FIELDS.get(fam, "learner identity fields")))
    A("")
    A("Count of flagged Canvas course-level ops: %d." % counts["learner-flagged"])
    A("")
    A("### Moodle learner-data operations")
    A("")
    A("Any Moodle op whose tool name contains: %s." % ", ".join(MOODLE_LEARNER_FRAGMENTS))
    A("Count of flagged Moodle ops: %d." % counts["m-learner-flagged"])
    A("These include grade reports, assignment submissions, forum authors, "
      "participant rosters, and enrolment reads. The live forum proof used only "
      "the educator's own demo account; no other learner identity was read.")
    A("")

    # ---- Excluded ----
    A("## Excluded operations (Braden's three exclusions)")
    A("")
    A("| Operation | Exclusion | Reason |")
    A("|-----------|-----------|--------|")
    A("| canvas_send_message_to_unsubmitted_or_submitted_users_for_quiz | "
      "sends messages to people | Messages quiz takers |")
    A("| Canvas help ticket creation (account-level, not course-scoped) | "
      "submits support tickets | Braden exclusion; no ticket is ever filed by the battery |")
    A("| Discussion announcement variants (canvas_create_new_discussion_topic_courses "
      "with announcement flag) | sends messages to people | Posting an announcement "
      "notifies enrolled users |")
    A("| canvas_begin_migration_to_push_to_associated_courses | affects subaccount | "
      "Blueprint migrations push to associated courses |")
    A("| canvas_update_associated_courses | affects subaccount | "
      "Changes blueprint course associations |")
    A("| canvas_set_or_remove_restrictions_on_blueprint_course_object | affects subaccount | "
      "Changes blueprint restrictions across courses |")
    A("| canvas_disable_assignments_currently_enabled_for_grade_export_to_sis | "
      "affects subaccount | Changes SIS grade export state |")
    A("| canvas_set_feature_flag_courses / canvas_remove_feature_flag_courses | "
      "affects subaccount | Feature flags affect account-level feature state |")
    A("| canvas_enable_disable_or_clear_explicit_csp_setting_courses | "
      "affects subaccount | CSP settings affect account security posture |")
    A("")

    # ---- Counts ----
    A("## Counts by status")
    A("")
    A("| Status | Canvas | Moodle lane | Total |")
    A("|--------|--------|-------------|-------|")
    # Canvas counts were accumulated in the family loop; Moodle lane rows added too.
    # Recompute cleanly for the table:
    A("")
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    # Compute final counts independently for the report
    canvas_counts = Counter()
    for o in ops:
        tool = o["toolName"]
        status = E.get(tool, ("pending", ""))[0]
        canvas_counts[status] += 1
    ibank_all = [o for o in catalog["operations"]
                 if o.get("family") == "new-quizzes-item-banks"]
    for o in ibank_all:
        canvas_counts[E.get(o["toolName"], ("pending", ""))[0]] += 1
    moodle_counts = Counter()
    for o in mops:
        tool = o["toolName"]
        if tool in M:
            moodle_counts[M[tool][0]] += 1
        elif tool in MOODLE_EXCLUDED:
            moodle_counts["excluded"] += 1
        else:
            moodle_counts["pending"] += 1
    lane_counts = Counter(s for _, s, _ in M_LANE)
    nq_counts = Counter(r[2] for r in nq)

    def row(status):
        c = canvas_counts.get(status, 0)
        m = moodle_counts.get(status, 0) + lane_counts.get(status, 0)
        extra = nq_counts.get(status, 0) if status in ("live-proven", "unsupported") else 0
        return "| %s | %d | %d | %d |" % (status, c, m, c + m + extra)

    summary = []
    summary.append("| Status | Canvas | Moodle lane | Total |")
    summary.append("|--------|--------|-------------|-------|")
    for st in ["live-proven", "pending", "tenant-restricted", "unsupported",
               "excluded", "source-only"]:
        summary.append(row(st))
    summary.append("| New Quiz sequence rows (above) | - | - | %d live-proven, %d unsupported |"
                   % (nq_counts["live-proven"], nq_counts["unsupported"]))
    summary.append("")
    summary.append("Canvas course-scoped ops in reference catalog: %d, plus %d "
                   "Item Bank quiz-api ops." % (len(ops), len(ibank_all)))
    summary.append("Moodle ops in reference catalog: %d, plus %d lane-level rows."
                   % (len(mops), len(M_LANE)))
    summary.append("Learner-data flagged: %d Canvas, %d Moodle."
                   % (counts["learner-flagged"], counts["m-learner-flagged"]))

    # Replace the placeholder counts section
    text = open(OUT, encoding="utf-8").read()
    text = text.replace(
        "## Counts by status\n\n| Status | Canvas | Moodle lane | Total |\n"
        "|--------|--------|-------------|-------|",
        "## Counts by status\n\n" + "\n".join(summary))
    open(OUT, "w", encoding="utf-8").write(text)

    print("Wrote", OUT)
    print("Canvas ops:", len(ops), dict(canvas_counts))
    print("Moodle ops:", len(mops), dict(moodle_counts), "lane:", dict(lane_counts))
    print("NQ sequence:", dict(nq_counts))
    print("Learner-flagged: canvas=%d moodle=%d"
          % (counts["learner-flagged"], counts["m-learner-flagged"]))


if __name__ == "__main__":
    main()
