# Wave 12 GET results (2026-09-21, live via browser task, course 89585)

Session: id 28206 "Braden Riggins", alive. Nothing created, modified, or deleted.

| op_id | catalog | status | note |
|---|---|---|---|
| g12-1 | C-105 | 200 | activity_stream, 19 entries |
| g12-2 | C-106 | 200 | activity_stream/summary |
| g12-3 | C-107 | 200 | todo: [] |
| g12-4 | C-109 | 400 | course not module-based; expected constraint |
| g12-5 | C-111 | 200 | settings |
| g12-6 | C-112 | 200 | effective_due_dates (208 assignment keys) |
| g12-anchor-course | course show | 200 | ANCHOR; {ACCT}=1 |
| g12-7 | C-113 | 200 | accounts/1/courses/89585 |
| g12-8 | C-120 | 200 | users: 2 rows; {U}=48901 |
| g12-9 | C-115 | 200 | user 48901 show |
| g12-10 | C-116 | 400 | user not student-enrolled / not module-based; expected constraint |
| g12-11 | C-117 | 200 | recent_students |
| g12-12 | C-118 | 200 | students |
| g12-13 | C-119 | 200 | search_users (no 4xx) |
| g12-14 | C-121 | 200 | permissions |
| g12-15 | C-126 | 200 | student_view_student 109894 |
| g12-16 | C-127 | 400 | content_share_users needs ?search_term; brief defect |

Proven GET ops this wave: C-105, C-106, C-107, C-111, C-112, C-113, C-120, C-115, C-117, C-118, C-119, C-121, C-126 (13).
Unproven: C-109, C-116 (endpoint constraints, course not module-based), C-127 (needs ?search_term=; rerun candidate).
