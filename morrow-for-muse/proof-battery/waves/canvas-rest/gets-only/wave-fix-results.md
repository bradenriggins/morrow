# Fix wave results: corrected-parameter reruns (f-1..f-5)

Completed 2026-09-21 02:15:43 UTC on course 89585. Session verified as user 28206 (Braden Riggins). All five ops returned HTTP 200. GET-only, no writes performed, no cleanup needed.

Brief: `wave-fix-gets.md`

| Op | Catalog ID | Correction applied | Result |
|----|-----------|-------------------|--------|
| f-1 | C-272 | `asset_type=ModuleItem&asset_id=9274395` on module item sequence | 200, empty items/modules (valid empty sequence) |
| f-2 | C-202 | `?path=course%20files` on folder by_path | 200, resolved to folder 1564337 "course files" (12 subfolders, 0 files) |
| f-3 | C-322 | `assignment_id=3636219` on outcome alignments | 200, empty array (no alignments on that assignment) |
| f-4 | C-127 | `search_term=Student` on content share users | 200, 3 matching test users returned |
| f-5 | C-180 | external-tool ID 292087 on sessionless launch | 200, returned "Clover Learning" tool with signed launch URL |

Notes:

- All five prior failures were brief defects (missing/wrong parameters), not capability gaps. Each is now proven.
- f-5's signed launch URL verifier value is not retained here (credential-adjacent, single-use).
- f-4 matched three pre-existing test accounts; no contact details retained beyond what the API returned for the read itself.
- No test objects were created; nothing to clean up.
