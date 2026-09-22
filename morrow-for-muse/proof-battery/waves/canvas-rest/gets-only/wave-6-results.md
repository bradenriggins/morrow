# Wave 6 GET results (2026-09-21, live via browser task, course 89585)

Session: id 28206 "Braden Riggins", alive. Nothing created, modified, or deleted.

| op_id | catalog | status | note |
|---|---|---|---|
| g6-1 | C-309 | 200 | root_outcome_group {RG}=126490 |
| g6-2 | C-304 | 200 | outcome_groups list (root only) |
| g6-3 | C-305 | 200 | outcome_group_links: outcome 157543 "Meridian Capability Check Outcome" (pre-existing) |
| g6-4 | C-310 | 200 | outcome_group 126490 show |
| g6-5 | C-308 | 200 | [] subgroups |
| g6-6 | C-307 | 200 | group outcomes: 157543 |
| g6-7 | C-322 | 4xx | outcome_alignments: "student_id or assignment_id is required". Brief defect: endpoint needs a query param. Re-run candidate with ?assignment_id=. |
| g6-8 | C-341 | 4xx | outcome_proficiency: "ActiveRecord::RecordNotFound". Course has no proficiency ratings configured; endpoint reachable, no data. |

Proven GET ops this wave: C-309, C-304, C-305, C-310, C-308, C-307 (6).
Probe data: C-322 (needs param), C-341 (no proficiency data on course).
Note: "Meridian Capability Check Outcome" 157543 pre-dates tonight; left untouched.
