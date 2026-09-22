# Wave 3 GET results (2026-09-21, live via browser task, course 89585)

Session: id 28206 "Braden Riggins", alive. Nothing created, modified, or deleted.

| op_id | catalog | status | note |
|---|---|---|---|
| g3-1 | C-196 | 200 | folders list, 10 rows; {F}=1564355 |
| g3-2 | C-197 | 200 | files list, 10 rows; {FI}=12030079 (217W1-1.PNG) |
| g3-3 | C-194 | 200 | quota 4194304000, used 47851 |
| g3-4 | C-198 | 200 | content_licenses, 8 license rows |
| g3-5 | C-195 | 200 | folders/media -> "Uploaded Media", 50 files |
| g3-6 | C-258 | 200 | [] media_attachments |
| g3-7 | C-259 | 200 | [] media_objects |
| g3-8 | C-193 | 200 | folder 1564355 "Diagrams" |
| g3-9 | C-192 | 200 | file 12030079 full metadata |
| g3-10 | C-199 | 404 | PROBE: /files/{id}/text on a PNG returns HTML Page Not Found. Expected for binary; not an endpoint defect. |
| g3-11 | C-201 | 200 | folders/by_path?path=/ -> root "course files" |
| g3-12 | C-202 | 404 | PROBE: by_path/{full_name} path-segment construction 404s. The by_path endpoint likely wants ?path= instead of a path segment; brief-construction suspect, not endpoint defect. |

Proven GET ops this wave: C-196, C-197, C-194, C-198, C-195, C-258, C-259, C-193, C-192 (9).
Probe data: C-199 (404 on binary, expected), C-201 (200, works), C-202 (404, brief URL construction suspect).
