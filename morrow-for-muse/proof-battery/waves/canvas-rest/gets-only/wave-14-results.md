# Wave 14 GET results (2026-09-21, live via browser task, course 89585)

Session: id 28206 "Braden Riggins", alive. Nothing created, modified, or deleted.

| op_id | catalog | status | note |
|---|---|---|---|
| g14-1 | C-27 | 200 | external_feeds, 3 rows (2 MORROW-SWEEP test feeds, 1 Canvas blog) |
| g14-2 | C-59 | 500 | block_editor_templates: internal_server_error on this tenant |
| g14-3 | C-68 | 200 | blueprint_subscriptions: [] |
| g14-4 | C-66 | skipped | no {BS} |
| g14-5 | C-70 | skipped | no {BS}/{BM} |
| g14-6 | C-73 | 200 | brand_variables full set |
| g14-7 | C-94 | 200 | csp_settings |
| g14-8 | C-187 | 200 | features/enabled (20 rows; includes smart_search, new_quizzes_by_default) |
| g14-9 | C-188 | 200 | features (6 rows) |
| g14-10 | C-231 | 200 | assignment 3636237 date_details |
| g14-11 | C-233 | 200 w/ error body | "This API does not support files." (learning_object_dates rejects files) |
| g14-12 | C-234 | 200 | module 864907 date_details |
| g14-13 | C-235 | 200 | page date_details |
| g14-14 | C-236 | 200 | quiz 338165 date_details |
| g14-15 | C-343 | 200 | quizzes/assignment_overrides (10 quizzes) |
| g14-16 | C-344 | 200 | new_quizzes/assignment_overrides (10 new-quiz assignments) |
| g14-17 | C-346 | 200 | quiz 338165 ip_filters: [] |
| g14-18 | C-402 | 4xx probe | SIS integration not configured on this tenant |
| g14-19 | C-403 | 200 | smartsearch?q=test: 10 WikiPage results |

Proven GET ops this wave: C-27, C-68, C-73, C-94, C-187, C-188, C-231, C-234, C-235, C-236, C-343, C-344, C-346, C-403 (14).
Unproven: C-59 (500 tenant error), C-66, C-70 (no blueprint subs), C-233 (API rejects files type), C-402 (SIS not enabled).
Note: smart_search feature is enabled on the tenant.
