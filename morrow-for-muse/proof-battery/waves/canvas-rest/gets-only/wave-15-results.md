# Wave 15 GET results (2026-09-21, live via browser task, course 89585)

Session: id 28206 "Braden Riggins", alive. Nothing created, modified, or deleted.

| op_id | catalog | status | note |
|---|---|---|---|
| g15-1 | C-294 | 200 | /api/quiz/v1 quizzes list: 10 new quizzes; {NQ}=4044840 (list has no assignment_id field; used id) |
| g15-2 | C-292 | 200 | new quiz 4044840 show |
| g15-3 | C-295 | 200 | quiz 4044840 items: 11 essay items; {NI}=11026666 |
| g15-4 | C-293 | 200 | item 11026666 show |
| g15-5 | C-291 | 200 | media_upload_url returns presigned S3 PUT URL |

Proven GET ops this wave: C-294, C-292, C-295, C-293, C-291 (5). No skips.
Finding: /api/quiz/v1 New Quiz REST endpoints respond on the same chcp.instructure.com origin via the authenticated session cookie. No quiz-api host hop needed for these reads.
