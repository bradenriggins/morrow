#!/usr/bin/env python3
"""Render GET-only browser-task briefs for waves 2-15 of the Canvas REST battery.

Each brief is self-contained: session check, GET navigations in dependency
order, ID capture rules, honest-report format. No writes, no relay page,
no CSRF. Anchors (already-proven GETs used only to capture IDs) are marked
and are never proof claims.

Output: proof-battery/waves/canvas-rest/gets-only/wave-N-gets.md (N=2..15)
"""
import os

BASE = "https://chcp.instructure.com"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
COURSE = "89585"

HEADER = """# WAVE {n} GETS: {title} (course 89585)

GET-only live-proof battery through the browser task. Every step is a plain
GET navigation inside this browser's authenticated Canvas session. There are
NO writes in this brief: no relay page, no forms, no CSRF token, nothing is
created, modified, or deleted, so no cleanup is needed.

ID CAPTURE (do this as you go; later steps use these placeholders):
{capture_rules}

HARD RULES:
- Do not sign in. Do not enter any credentials. Do not fill any login form.
- Visit no site other than https://chcp.instructure.com.
- NEVER report cookie values, the CSRF token value, or any credential material.
- Work only with the API URLs below. Never click through the Canvas web UI;
  this is API work, not UI automation.
- Execute the operations in the exact order listed.
- Steps marked ANCHOR use an already-proven endpoint only to capture an ID
  for later steps. They are not proof claims; run them exactly as written.

STEP 1, SESSION CHECK (always first):
Navigate to https://chcp.instructure.com/api/v1/users/self and read the JSON body.
Session is alive only if the JSON shows id 28206 and name "Braden Riggins".
If you see a login page, a login redirect, or an error instead: STOP the whole
brief immediately and report session_dead. Attempt nothing further.

STEPS 2..N, THE OPERATIONS (in order):
Pace yourself: about one op every few seconds. On HTTP 429, wait the
Retry-After seconds and retry that op once. If an op returns 4xx/5xx, record
the status and body verbatim and continue with the next op; a 4xx on a step
marked PROBE is a valid result, not a failure.
"""

STEP_TMPL = """STEP {n}:
  op_id: {op_id}
  catalog: {catalog}{anchor_note}
  method: GET
  url: {url}
  action: navigate (GET), report the body{body_note}{capture_note}{cond_note}{probe_note}
"""

FOOTER = """REPORT FORMAT (follow exactly):
First, one line per op in order:
  op_id | http_status | first_500_chars_of_body
(For skipped conditional steps: op_id | skipped | reason.)
Then a final section starting with the literal line RESULTS_JSON
followed by a JSON array, one object per op, in order:
  [{"op_id": "...", "status": 200, "body": "<JSON-escaped, max 2000 chars>"}, ...]
If the session check failed, the whole report is the single line: session_dead
"""

def step(n, op_id, catalog, url, anchor=False, capture=None, cond=None,
         probe=False, html=False):
    anchor_note = " (ANCHOR: already live-proven; ID capture only, not a proof claim)" if anchor else ""
    body_note = ""
    if html:
        body_note = " (note: this endpoint returns an HTML form page, not JSON; report the first 500 chars of the HTML)"
    capture_note = f'\n  capture: {capture}' if capture else ""
    cond_note = f'\n  only if: {cond}; otherwise report "skipped" with the reason and continue' if cond else ""
    probe_note = "\n  PROBE: record the status and body honestly; a 4xx here is a valid result" if probe else ""
    return STEP_TMPL.format(n=n, op_id=op_id, catalog=catalog, url=url,
                            anchor_note=anchor_note, body_note=body_note,
                            capture_note=capture_note, cond_note=cond_note,
                            probe_note=probe_note)

def render(n, title, capture_rules, steps):
    body = HEADER.format(n=n, title=title, capture_rules=capture_rules)
    for i, s in enumerate(steps, start=2):
        body += step(i, **s)
    body += FOOTER
    path = os.path.join(OUT, f"wave-{n}-gets.md")
    with open(path, "w") as f:
        f.write(body)
    return path, len(steps)

C = f"{BASE}/api/v1/courses/{COURSE}"
results = []

# ---------------- Wave 2: pages + modules ----------------
results.append(render(2, "pages + modules",
    "- After the modules anchor: record the first module's \"id\" as {M}.\n"
    "- After the module-items step: record the first item's \"id\" as {I}.\n"
    "- After list pages: record the first page's \"url\" as {P}.\n"
    "- After list revisions: record the first revision's \"revision_id\" as {R}.",
 [
  dict(op_id="g2-anchor-modules", catalog="C-275", url=f"{C}/modules", anchor=True,
       capture='first element\'s "id" as {M}; if the list is empty, report it and skip the module-item steps'),
  dict(op_id="g2-1", catalog="C-272", url=f"{C}/module_item_sequence"),
  dict(op_id="g2-2", catalog="C-273", url=f"{C}/modules/{{M}}/items", cond="{M} captured",
       capture='first element\'s "id" as {I}'),
  dict(op_id="g2-3", catalog="C-281", url=f"{C}/modules/{{M}}/items/{{I}}", cond="{M} and {I} captured"),
  dict(op_id="g2-4", catalog="C-274", url=f"{C}/modules/{{M}}/assignment_overrides", cond="{M} captured"),
  dict(op_id="g2-5", catalog="C-326", url=f"{C}/pages",
       capture='first element\'s "url" as {P}; if the list is empty, report it and skip the page-revision steps'),
  dict(op_id="g2-6", catalog="C-329", url=f"{C}/front_page"),
  dict(op_id="g2-7", catalog="C-327", url=f"{C}/pages/{{P}}/revisions", cond="{P} captured",
       capture='first element\'s "revision_id" as {R}'),
  dict(op_id="g2-8", catalog="C-331", url=f"{C}/pages/{{P}}/revisions/latest", cond="{P} captured"),
  dict(op_id="g2-9", catalog="C-332", url=f"{C}/pages/{{P}}/revisions/{{R}}", cond="{P} and {R} captured"),
 ]))

# ---------------- Wave 3: files + media ----------------
results.append(render(3, "files + media_objects",
    "- After list folders: record the first folder's \"id\" as {F}.\n"
    "- After list files: record the first file's \"id\" as {FI}.\n"
    "- After list folders: record the first folder's \"full_name\" as {FP} (e.g. \"course files\").",
 [
  dict(op_id="g3-1", catalog="C-196", url=f"{C}/folders",
       capture='first element\'s "id" as {F} and "full_name" as {FP}'),
  dict(op_id="g3-2", catalog="C-197", url=f"{C}/files",
       capture='first element\'s "id" as {FI}'),
  dict(op_id="g3-3", catalog="C-194", url=f"{C}/files/quota"),
  dict(op_id="g3-4", catalog="C-198", url=f"{C}/content_licenses"),
  dict(op_id="g3-5", catalog="C-195", url=f"{C}/folders/media"),
  dict(op_id="g3-6", catalog="C-258", url=f"{C}/media_attachments"),
  dict(op_id="g3-7", catalog="C-259", url=f"{C}/media_objects"),
  dict(op_id="g3-8", catalog="C-193", url=f"{C}/folders/{{F}}", cond="{F} captured"),
  dict(op_id="g3-9", catalog="C-192", url=f"{C}/files/{{FI}}", cond="{FI} captured"),
  dict(op_id="g3-10", catalog="C-199", url=f"{C}/files/{{FI}}/text", cond="{FI} captured",
       probe=True),
  dict(op_id="g3-11", catalog="C-201", url=f"{C}/folders/by_path?path=/", probe=True),
  dict(op_id="g3-12", catalog="C-202",
       url=f"{C}/folders/by_path/{{FP}}  -- build this URL as {C}/folders/by_path/ followed by {{FP}} with spaces encoded as %20 (e.g. full_name \"course files\" becomes \"course%20files\")",
       cond="{FP} captured", probe=True),
 ]))
# fix g3-12 url: full_name starts with no slash; path is /by_path/*full_path
# handled below via post-process note in capture: prepend / and encode spaces as %20
# (brief text tells the task how to build it)

# ---------------- Wave 4: classic quizzes ----------------
results.append(render(4, "classic quizzes + questions + question groups",
    "- After list quizzes: record the first quiz's \"id\" as {Q}.\n"
    "- After list questions: record the first question's \"id\" as {QQ} (may be none).\n"
    "- After list groups: record the first group's \"id\" as {G} (may be none).",
 [
  dict(op_id="g4-1", catalog="C-378", url=f"{C}/quizzes",
       capture='first element\'s "id" as {Q}; if the list is empty, report it and skip the remaining steps'),
  dict(op_id="g4-2", catalog="C-377", url=f"{C}/quizzes/{{Q}}", cond="{Q} captured"),
  dict(op_id="g4-3", catalog="C-356", url=f"{C}/quizzes/{{Q}}/questions", cond="{Q} captured",
       capture='first element\'s "id" as {QQ} if any exist'),
  dict(op_id="g4-4", catalog="C-355", url=f"{C}/quizzes/{{Q}}/questions/{{QQ}}", cond="{Q} and {QQ} captured"),
  dict(op_id="g4-5", catalog="C-350", url=f"{C}/quizzes/{{Q}}/groups", cond="{Q} captured",
       capture='first element\'s "id" as {G} if any exist'),
  dict(op_id="g4-6", catalog="C-349", url=f"{C}/quizzes/{{Q}}/groups/{{G}}", cond="{Q} and {G} captured"),
 ]))

# ---------------- Wave 5: rubrics ----------------
results.append(render(5, "rubrics",
    "- After list rubrics: record the first rubric's \"id\" as {R} (may be none).",
 [
  dict(op_id="g5-1", catalog="C-393", url=f"{C}/rubrics",
       capture='first element\'s "id" as {R} if any exist'),
  dict(op_id="g5-2", catalog="C-391", url=f"{C}/rubrics/{{R}}", cond="{R} captured"),
  dict(op_id="g5-3", catalog="C-390", url=f"{C}/rubrics/{{R}}/used_locations", cond="{R} captured"),
 ]))

# ---------------- Wave 6: outcomes ----------------
results.append(render(6, "outcomes + outcome_groups + proficiency",
    "- After the root group step: record its \"id\" as {RG}.",
 [
  dict(op_id="g6-1", catalog="C-309", url=f"{C}/root_outcome_group",
       capture='the "id" field as {RG}'),
  dict(op_id="g6-2", catalog="C-304", url=f"{C}/outcome_groups"),
  dict(op_id="g6-3", catalog="C-305", url=f"{C}/outcome_group_links"),
  dict(op_id="g6-4", catalog="C-310", url=f"{C}/outcome_groups/{{RG}}", cond="{RG} captured"),
  dict(op_id="g6-5", catalog="C-308", url=f"{C}/outcome_groups/{{RG}}/subgroups", cond="{RG} captured"),
  dict(op_id="g6-6", catalog="C-307", url=f"{C}/outcome_groups/{{RG}}/outcomes", cond="{RG} captured"),
  dict(op_id="g6-7", catalog="C-322", url=f"{C}/outcome_alignments"),
  dict(op_id="g6-8", catalog="C-341", url=f"{C}/outcome_proficiency"),
 ]))

# ---------------- Wave 7: grading ----------------
results.append(render(7, "grading_standards + grading_periods + late_policy + assignment_groups",
    "- After list assignment groups: record the first group's \"id\" as {AG}.\n"
    "- After list grading periods: record the first period's \"id\" as {GP} (may be none).\n"
    "- After list grading standards: record the first standard's \"id\" as {GS} (may be none).",
 [
  dict(op_id="g7-1", catalog="C-33", url=f"{C}/assignment_groups",
       capture='first element\'s "id" as {AG}'),
  dict(op_id="g7-2", catalog="C-32", url=f"{C}/assignment_groups/{{AG}}", cond="{AG} captured"),
  dict(op_id="g7-3", catalog="C-213", url=f"{C}/grading_periods",
       capture='first element\'s "id" as {GP} if any exist'),
  dict(op_id="g7-4", catalog="C-212", url=f"{C}/grading_periods/{{GP}}", cond="{GP} captured"),
  dict(op_id="g7-5", catalog="C-218", url=f"{C}/grading_standards",
       capture='first element\'s "id" as {GS} if any exist'),
  dict(op_id="g7-6", catalog="C-217", url=f"{C}/grading_standards/{{GS}}", cond="{GS} captured"),
  dict(op_id="g7-7", catalog="C-229", url=f"{C}/late_policy"),
 ]))

# ---------------- Wave 8: sections + groups ----------------
results.append(render(8, "sections + groups + group_categories",
    "- After the sections anchor: record the first section's \"id\" as {S}.\n"
    "- After list group categories: record the first category's \"id\" as {GC} (not strictly needed below; captured for the record).",
 [
  dict(op_id="g8-anchor-sections", catalog="C-400 equiv (proven tonight as w1a-sections; ID capture only, not a proof claim)",
       url=f"{C}/sections", anchor=True,
       capture='first element\'s "id" as {S}'),
  dict(op_id="g8-1", catalog="C-399", url=f"{C}/sections/{{S}}", cond="{S} captured"),
  dict(op_id="g8-2", catalog="C-225", url=f"{C}/group_categories",
       capture='first element\'s "id" as {GC} if any exist'),
  dict(op_id="g8-3", catalog="C-227", url=f"{C}/groups"),
  dict(op_id="g8-4", catalog="C-222", url=f"{C}/group_categories/export_tags", probe=True),
  dict(op_id="g8-5", catalog="C-223", url=f"{C}/group_categories/differentiation_tag_candidate_count", probe=True),
  dict(op_id="g8-6", catalog="C-226", url=f"{C}/bulk_user_tags", probe=True),
 ]))

# ---------------- Wave 9: calendar + blackout + pace ----------------
results.append(render(9, "calendar_events + blackout_dates",
    "- After list blackout dates: record the first entry's \"id\" as {B} (may be none).",
 [
  dict(op_id="g9-1", catalog="C-55", url=f"{C}/blackout_dates",
       capture='first element\'s "id" as {B} if any exist'),
  dict(op_id="g9-2", catalog="C-54", url=f"{C}/blackout_dates/{{B}}", cond="{B} captured"),
  dict(op_id="g9-3", catalog="C-56", url=f"{C}/blackout_dates/new", html=True),
  dict(op_id="g9-4", catalog="C-75", url=f"{C}/calendar_events/timetable"),
 ]))

# ---------------- Wave 10: tabs + tools + lti + collaborations ----------------
results.append(render(10, "tabs + external_tools + LTI + collaborations + conferences",
    "- After list external tools: record the first tool's \"id\" as {T} (may be none).\n"
    "- After list LTI resource links: record the first link's \"id\" as {L} (may be none).",
 [
  dict(op_id="g10-1", catalog="C-433", url=f"{C}/tabs"),
  dict(op_id="g10-2", catalog="C-183", url=f"{C}/external_tools",
       capture='first element\'s "id" as {T} if any exist'),
  dict(op_id="g10-3", catalog="C-181", url=f"{C}/external_tools/{{T}}", cond="{T} captured"),
  dict(op_id="g10-4", catalog="C-182", url=f"{C}/external_tools/visible_course_nav_tools"),
  dict(op_id="g10-5", catalog="C-180", url=f"{C}/external_tools/sessionless_launch", probe=True),
  dict(op_id="g10-6", catalog="C-251", url=f"{C}/lti_apps/launch_definitions"),
  dict(op_id="g10-7", catalog="C-255", url=f"{C}/lti_resource_links",
       capture='first element\'s "id" as {L} if any exist'),
  dict(op_id="g10-8", catalog="C-256", url=f"{C}/lti_resource_links/{{L}}", cond="{L} captured"),
  dict(op_id="g10-9", catalog="C-77", url=f"{C}/collaborations"),
  dict(op_id="g10-10", catalog="C-78", url=f"{C}/potential_collaborators"),
  dict(op_id="g10-11", catalog="C-79", url=f"{C}/conferences"),
 ]))

# ---------------- Wave 11: migrations + exports + reports ----------------
results.append(render(11, "content_migrations + content_exports",
    "- After list migrations: record the first migration's \"id\" as {CM} (may be none).\n"
    "- After list migration issues: record the first issue's \"id\" as {MI} (may be none).\n"
    "- After list content exports: record the first export's \"id\" as {CE} (may be none).",
 [
  dict(op_id="g11-1", catalog="C-87", url=f"{C}/content_migrations",
       capture='first element\'s "id" as {CM} if any exist'),
  dict(op_id="g11-2", catalog="C-85", url=f"{C}/content_migrations/{{CM}}", cond="{CM} captured"),
  dict(op_id="g11-3", catalog="C-84", url=f"{C}/content_migrations/{{CM}}/asset_id_mapping", cond="{CM} captured"),
  dict(op_id="g11-4", catalog="C-88", url=f"{C}/content_migrations/{{CM}}/selective_data", cond="{CM} captured"),
  dict(op_id="g11-5", catalog="C-89", url=f"{C}/content_migrations/{{CM}}/migration_issues", cond="{CM} captured",
       capture='first element\'s "id" as {MI} if any exist'),
  dict(op_id="g11-6", catalog="C-86", url=f"{C}/content_migrations/{{CM}}/migration_issues/{{MI}}",
       cond="{CM} and {MI} captured"),
  dict(op_id="g11-7", catalog="C-90", url=f"{C}/content_migrations/migrators"),
  dict(op_id="g11-8", catalog="C-81", url=f"{C}/content_exports",
       capture='first element\'s "id" as {CE} if any exist'),
  dict(op_id="g11-9", catalog="C-82", url=f"{C}/content_exports/{{CE}}", cond="{CE} captured"),
 ]))

# ---------------- Wave 12: courses ----------------
results.append(render(12, "courses",
    "- After the course anchor: record the \"account_id\" field as {ACCT}.\n"
    "- After list users: record the first user's \"id\" as {U}.",
 [
  dict(op_id="g12-1", catalog="C-105", url=f"{C}/activity_stream"),
  dict(op_id="g12-2", catalog="C-106", url=f"{C}/activity_stream/summary"),
  dict(op_id="g12-3", catalog="C-107", url=f"{C}/todo"),
  dict(op_id="g12-4", catalog="C-109", url=f"{C}/bulk_user_progress"),
  dict(op_id="g12-5", catalog="C-111", url=f"{C}/settings"),
  dict(op_id="g12-6", catalog="C-112", url=f"{C}/effective_due_dates"),
  dict(op_id="g12-anchor-course", catalog="course show (already live-proven; ID capture only, not a proof claim)",
       url=f"{C}", anchor=True, capture='the "account_id" field as {ACCT}'),
  dict(op_id="g12-7", catalog="C-113", url=f"{BASE}/api/v1/accounts/{{ACCT}}/courses/{COURSE}", cond="{ACCT} captured"),
  dict(op_id="g12-8", catalog="C-120", url=f"{C}/users",
       capture='first element\'s "id" as {U}'),
  dict(op_id="g12-9", catalog="C-115", url=f"{C}/users/{{U}}", cond="{U} captured"),
  dict(op_id="g12-10", catalog="C-116", url=f"{C}/users/{{U}}/progress", cond="{U} captured"),
  dict(op_id="g12-11", catalog="C-117", url=f"{C}/recent_students"),
  dict(op_id="g12-12", catalog="C-118", url=f"{C}/students"),
  dict(op_id="g12-13", catalog="C-119", url=f"{C}/search_users", probe=True),
  dict(op_id="g12-14", catalog="C-121", url=f"{C}/permissions"),
  dict(op_id="g12-15", catalog="C-126", url=f"{C}/student_view_student"),
  dict(op_id="g12-16", catalog="C-127", url=f"{C}/content_share_users"),
 ]))

# ---------------- Wave 13: ai_experiences ----------------
results.append(render(13, "ai_experiences",
    "- After list AI experiences: record the first experience's \"id\" as {AE} (may be none).\n"
    "Student-conversation reads (C-13, C-17) are intentionally out of this brief: learner-data-adjacent, deferred.",
 [
  dict(op_id="g13-1", catalog="C-12", url=f"{C}/ai_experiences",
       capture='first element\'s "id" as {AE} if any exist'),
  dict(op_id="g13-2", catalog="C-14", url=f"{C}/ai_experiences/{{AE}}", cond="{AE} captured"),
  dict(op_id="g13-3", catalog="C-15", url=f"{C}/ai_experiences/{{AE}}/edit", cond="{AE} captured", html=True),
  dict(op_id="g13-4", catalog="C-16", url=f"{C}/ai_experiences/new", html=True),
 ]))

# ---------------- Wave 14: misc ----------------
results.append(render(14, "misc reads + learning_object_dates",
    "- After list blueprint subscriptions: record the first subscription's \"id\" as {BS} (may be none).\n"
    "- After list blueprint imports: record the first migration's \"id\" as {BM} (may be none).\n"
    "- Anchors capture: {A} first assignment id, {FI} first file id, {M} first module id,\n"
    "  {P} first page url, {Q} first quiz id. Anchors are not proof claims.",
 [
  dict(op_id="g14-1", catalog="C-27", url=f"{C}/external_feeds"),
  dict(op_id="g14-2", catalog="C-59", url=f"{C}/block_editor_templates"),
  dict(op_id="g14-3", catalog="C-68", url=f"{C}/blueprint_subscriptions",
       capture='first element\'s "id" as {BS} if any exist'),
  dict(op_id="g14-4", catalog="C-66", url=f"{C}/blueprint_subscriptions/{{BS}}/migrations",
       cond="{BS} captured", capture='first element\'s "id" as {BM} if any exist'),
  dict(op_id="g14-5", catalog="C-70", url=f"{C}/blueprint_subscriptions/{{BS}}/migrations/{{BM}}",
       cond="{BS} and {BM} captured"),
  dict(op_id="g14-6", catalog="C-73", url=f"{C}/brand_variables"),
  dict(op_id="g14-7", catalog="C-94", url=f"{C}/csp_settings"),
  dict(op_id="g14-8", catalog="C-187", url=f"{C}/features/enabled"),
  dict(op_id="g14-9", catalog="C-188", url=f"{C}/features"),
  dict(op_id="g14-anchor-assignments", catalog="assignments list (proven tonight as w1a-list; ID capture only, not a proof claim)",
       url=f"{C}/assignments", anchor=True, capture='first element\'s "id" as {A}'),
  dict(op_id="g14-10", catalog="C-231", url=f"{C}/assignments/{{A}}/date_details", cond="{A} captured"),
  dict(op_id="g14-anchor-files", catalog="files list (C-197, also covered in wave 3; ID capture only here)",
       url=f"{C}/files", anchor=True, capture='first element\'s "id" as {FI}'),
  dict(op_id="g14-11", catalog="C-233", url=f"{C}/files/{{FI}}/date_details", cond="{FI} captured"),
  dict(op_id="g14-anchor-modules", catalog="modules list (C-275, live-proven; ID capture only, not a proof claim)",
       url=f"{C}/modules", anchor=True, capture='first element\'s "id" as {M}'),
  dict(op_id="g14-12", catalog="C-234", url=f"{C}/modules/{{M}}/date_details", cond="{M} captured"),
  dict(op_id="g14-anchor-pages", catalog="pages list (C-326, also covered in wave 2; ID capture only here)",
       url=f"{C}/pages", anchor=True, capture='first element\'s "url" as {P}'),
  dict(op_id="g14-13", catalog="C-235", url=f"{C}/pages/{{P}}/date_details", cond="{P} captured"),
  dict(op_id="g14-anchor-quizzes", catalog="quizzes list (C-378, also covered in wave 4; ID capture only here)",
       url=f"{C}/quizzes", anchor=True, capture='first element\'s "id" as {Q}'),
  dict(op_id="g14-14", catalog="C-236", url=f"{C}/quizzes/{{Q}}/date_details", cond="{Q} captured"),
  dict(op_id="g14-15", catalog="C-343", url=f"{C}/quizzes/assignment_overrides"),
  dict(op_id="g14-16", catalog="C-344", url=f"{C}/new_quizzes/assignment_overrides"),
  dict(op_id="g14-17", catalog="C-346", url=f"{C}/quizzes/{{Q}}/ip_filters", cond="{Q} captured"),
  dict(op_id="g14-18", catalog="C-402", url=f"{BASE}/api/sis/courses/{COURSE}/assignments", probe=True),
  dict(op_id="g14-19", catalog="C-403", url=f"{C}/smartsearch?q=test", probe=True),
 ]))

# ---------------- Wave 15: new-quiz REST reads ----------------
NQ = f"{BASE}/api/quiz/v1/courses/{COURSE}"
results.append(render(15, "new-quiz Canvas REST reads",
    "- After list new quizzes: record the first quiz's \"assignment_id\" as {NQ}.\n"
    "- After list quiz items: record the first item's \"id\" as {NI} (may be none).\n"
    "These are the Canvas /api/quiz/v1 paths (session cookie only, no extra headers).\n"
    "New-quiz WRITES are out of scope: their cleanup needs the quiz-api host, which is blocked.",
 [
  dict(op_id="g15-1", catalog="C-294", url=f"{NQ}/quizzes",
       capture='first element\'s "assignment_id" as {NQ}; if the list is empty, report it and skip the remaining steps'),
  dict(op_id="g15-2", catalog="C-292", url=f"{NQ}/quizzes/{{NQ}}", cond="{NQ} captured"),
  dict(op_id="g15-3", catalog="C-295", url=f"{NQ}/quizzes/{{NQ}}/items", cond="{NQ} captured",
       capture='first element\'s "id" as {NI} if any exist'),
  dict(op_id="g15-4", catalog="C-293", url=f"{NQ}/quizzes/{{NQ}}/items/{{NI}}", cond="{NQ} and {NI} captured"),
  dict(op_id="g15-5", catalog="C-291", url=f"{NQ}/quizzes/{{NQ}}/items/media_upload_url", cond="{NQ} captured"),
 ]))

total = 0
for path, count in results:
    total += count
    print(f"wrote {path} ({count} steps)")
print(f"TOTAL steps: {total}")
