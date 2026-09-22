# GET-only reads track: waves 2-15

Date: 2026-09-21. Rendered by `render_get_waves.py` (data-driven; re-run to regenerate).

## Why this track exists

Wave 1A ran live tonight through the browser task: the 4 placeholder-free
GET ops returned 200, but EVERY relay-page write op was skipped because the
browser task has no cookie-reading capability and no JavaScript execution, so
the `_csrf_token` cannot be harvested. Finding: the relay-page write lane is
DEAD for browser-task execution. GET navigations work fine.

So the battery splits: this directory is the reads track (every pending GET
whose URL is constructible without a prior write). All writes across waves
1-15 are parked pending Braden's Mac-rig-vs-defer decision. See the
"2026-09-21 write-lane blocker" section appended to `../WAVE-PLAN.md`.

## The 14 briefs

| Brief | Resources | Pending GETs covered | Steps (incl. anchors) |
|-------|-----------|---------------------|----------------------|
| wave-2-gets.md | pages + modules | C-272, C-273, C-274, C-281, C-326, C-327, C-329, C-331, C-332 (9) | 10 |
| wave-3-gets.md | files + media_objects | C-192, C-193, C-194, C-195, C-196, C-197, C-198, C-199, C-201, C-202, C-258, C-259 (12) | 12 |
| wave-4-gets.md | classic quizzes | C-349, C-350, C-355, C-356, C-377, C-378 (6) | 6 |
| wave-5-gets.md | rubrics | C-390, C-391, C-393 (3) | 3 |
| wave-6-gets.md | outcomes | C-304, C-305, C-307, C-308, C-309, C-310, C-322, C-341 (8) | 8 |
| wave-7-gets.md | grading | C-32, C-33, C-212, C-213, C-217, C-218, C-229 (7) | 7 |
| wave-8-gets.md | sections + groups | C-222, C-223, C-225, C-226, C-227, C-399 (6) | 7 |
| wave-9-gets.md | calendar + blackout | C-54, C-55, C-56, C-75 (4) | 4 |
| wave-10-gets.md | tabs + tools + LTI + collab | C-77, C-78, C-79, C-180, C-181, C-182, C-183, C-251, C-255, C-256, C-433 (11) | 11 |
| wave-11-gets.md | migrations + exports | C-81, C-82, C-84, C-85, C-86, C-87, C-88, C-89, C-90 (9) | 9 |
| wave-12-gets.md | courses | C-105, C-106, C-107, C-109, C-111, C-112, C-113, C-115, C-116, C-117, C-118, C-119, C-120, C-121, C-126, C-127 (16) | 17 |
| wave-13-gets.md | ai_experiences | C-12, C-14, C-15, C-16 (4) | 4 |
| wave-14-gets.md | misc + date_details | C-27, C-59, C-66, C-68, C-70, C-73, C-94, C-187, C-188, C-231, C-233, C-234, C-235, C-236, C-343, C-344, C-346, C-402, C-403 (19) | 24 |
| wave-15-gets.md | new-quiz REST reads | C-291, C-292, C-293, C-294, C-295 (5) | 5 |

Total: **119 pending GET ops** covered in 127 steps (8 steps are already-proven
anchors used only for ID capture: modules list, course show, assignments list,
files list, pages list, quizzes list, sections list; marked ANCHOR in the
briefs and never proof claims).

Already proven tonight (Wave 1A, not re-run here): w1a-list (assignments),
w1a-sections, w1a-for-user, all 200.

## GET ops deliberately excluded (with reasons)

- C-204 (translate_file_reference): needs a migration_id; only exists after a write.
- C-392 (rubric upload status): needs an upload id; only exists after a write.
- C-313, C-314 (outcome import status/created groups): need an import id; only exists after a write.
- C-98 (show course pace): needs a pace id; no list endpoint exists without a write.
- C-176 (show epub export): needs an export id; only exists after a write.
- C-102, C-103 (report status): need a valid report_type; no list endpoint to discover one.
- C-110 (course copy status): needs a copy id; only exists after a write.
- C-13, C-17 (student AI conversations): learner-data-adjacent; deferred per wave plan.
- C-186 (feature flag): needs a valid feature flag name; not guessable.
- C-61, C-62, C-63, C-64, C-65, C-67, C-71 (blueprint templates/migrations): need template/subscription ids; none exist without writes.
- C-232 (discussion date_details): needs a discussion_topic_id; the list endpoint is learner-data gated.
- C-400 (list sections): same endpoint already proven tonight as w1a-sections (200); not re-run.

## Execution rule

One browser task per brief, sequential (shared browser profile). Each brief is
self-contained and order-independent: run 2-15 in any order. Session check
first in every brief; on `session_dead` the brief stops and nothing is
attempted. Results feed the catalog via `build_catalog.py` (same E-map
feedback loop as the write waves; respect the audit-amendment caution in
WAVE-PLAN.md).

Steps marked PROBE (C-180, C-201, C-202, C-222, C-223, C-226, C-119, C-402,
C-403, C-199): the endpoint may legitimately need parameters or may not apply
to this course; record the status and body honestly. A 4xx on a probe is data,
not a failure.
