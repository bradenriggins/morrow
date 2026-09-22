# Reconciliation: Canvas GET waves 3-15 (plus waves 1A, 2, and the fix wave)

Date: 2026-09-21. Reconciled by Hermes (read-only analysis, no live API calls).

## Verdict

**PUBLISH the count: 103 unique successful GET operations.** The provisional
claim is accurate, not inflated. Every one of the 103 traces to a recorded
HTTP 200 with a described response body. Dedup is clean (zero cross-wave
duplicates). No wave file overclaims: each results file's "Proven" line
matches its own op table, and the skips/failures/probes are honestly
recorded rather than silently dropped.

Publish with the evidence-basis caveats in section 4. The count is
verifiable against the recorded evidence; the rawest layer (saved response
bodies) was never written to disk, so anyone auditing below the results
tables will find summaries, not fixtures.

## Per-wave verified counts

| Wave | Proven ops | Catalog IDs |
|------|-----------|-------------|
| 1A (assignments, browser task) | 3 | C-48, C-400, C-49 |
| 2 (pages + modules) | 8 | C-273, C-281, C-274, C-326, C-329, C-327, C-331, C-332 |
| 3 (files + media_objects) | 9 | C-196, C-197, C-194, C-198, C-195, C-258, C-259, C-193, C-192 |
| 4 (classic quizzes) | 4 | C-378, C-377, C-356, C-350 |
| 5 (rubrics) | 3 | C-393, C-391, C-390 |
| 6 (outcomes) | 6 | C-309, C-304, C-305, C-310, C-308, C-307 |
| 7 (grading) | 6 | C-33, C-32, C-213, C-218, C-217, C-229 |
| 8 (sections + groups) | 4 | C-399, C-225, C-227, C-226 |
| 9 (calendar + blackout) | 4 | C-55, C-54, C-56, C-75 |
| 10 (tabs + tools + LTI + collab) | 10 | C-433, C-183, C-181, C-182, C-251, C-255, C-256, C-77, C-78, C-79 |
| 11 (migrations + exports) | 9 | C-87, C-85, C-84, C-88, C-89, C-86, C-90, C-81, C-82 |
| 12 (courses) | 13 | C-105, C-106, C-107, C-111, C-112, C-113, C-120, C-115, C-117, C-118, C-119, C-121, C-126 |
| 13 (ai_experiences) | 0 | none (404s, feature not exposed on this tenant) |
| 14 (misc + date_details) | 14 | C-27, C-68, C-73, C-94, C-187, C-188, C-231, C-234, C-235, C-236, C-343, C-344, C-346, C-403 |
| 15 (new-quiz REST reads) | 5 | C-294, C-292, C-295, C-293, C-291 |
| fix (corrected-parameter reruns) | 5 | C-272, C-202, C-322, C-127, C-180 |
| **Total** | **103** | **100 unique across waves 2-15 + fix, plus 3 from wave 1A** |

Arithmetic check: 3+8+9+4+3+6+6+4+4+10+9+13+0+14+5+5 = 103.
Cross-wave duplicate scan across all 100 wave-2-15/fix IDs: zero duplicates.
Wave 1A IDs (C-48, C-400, C-49) appear in no other wave. Anchors (C-275,
sections, course show) were never counted as proof claims.

## Not proven (honestly recorded, not counted)

- Wave 2: C-272 first run (400, missing asset_type param); proven later by fix f-1.
- Wave 3: C-199 (404 on binary text read, expected), C-202 (404, bad path construction); proven later by fix f-2.
- Wave 4: C-355, C-349 (skipped, no questions/groups on the quiz).
- Wave 6: C-322 (needed assignment_id param); proven later by fix f-3. C-341 (no proficiency ratings on course).
- Wave 7: C-212 (no grading periods on course).
- Wave 8: C-222, C-223 (unauthorized at course scope, likely need account context).
- Wave 10: C-180 (needed tool id param); proven later by fix f-5.
- Wave 12: C-109, C-116 (400, course not module-based), C-127 (needed search_term); proven later by fix f-4.
- Wave 13: C-12, C-14, C-15, C-16 (ai_experiences 404s; feature not exposed at course scope on this tenant).
- Wave 14: C-59 (500 tenant internal error), C-66, C-70 (no blueprint subscriptions), C-233 (API rejects files type), C-402 (SIS not enabled).
- Wave 3 probe C-201: returned 200 with a real body (folders/by_path?path=/),
  but the wave author classified it as probe data, not a proof claim. Kept
  out of the total per that classification. If ever reclassified, the total
  becomes 104.

## Discrepancies and evidence caveats

1. **Catalog lags the evidence.** Of the 100 wave-2-15/fix proven ops, only
   the 5 fix-wave ops were fed into the catalog's E-map (they carry
   "PROVEN live 2026-09-21 (fix wave f-N)" status). The other 95 still show
   "pending" in catalog-parsed.json. Recommended: run the build_catalog.py
   feedback loop for waves 2-15 so the catalog matches the evidence before
   anyone reads the catalog as the source of truth.
2. **No raw response-body fixtures on disk.** WAVE-PLAN rule 7 required
   sanitized fixtures at proof-battery/evidence/canvas-rest-waveN/; that
   directory tree does not exist. Every wave's evidence is the summarized
   results table (status + body description). Sufficient for the count,
   insufficient for a body-level re-audit.
3. **Wave 1A has no on-disk results file.** Its 3 proven GETs are recorded
   in the 2026-09-21 memory log (high-confidence verification entry),
   GET-WAVES-README.md, and the WAVE-PLAN blocker section. The bodies were
   described (10 assignments; section 85641 "Braden's Test 2"; same 10 for
   user) but no raw fixture exists.
4. **"4 placeholder-free GET ops" vs 3 named.** The WAVE-PLAN blocker
   section says 4, then names 3 (list assignments, sections list, user
   assignments). The 4th is presumably the session-check GET
   (/api/v1/users/self), which is not a proof claim. Minor doc
   inconsistency; the memory log and README both record 3.
5. **Thin but legitimate 200s.** Several proven 200s returned empty arrays
   or objects (C-258, C-259, C-308, C-213, C-227, C-68, C-346, C-75, C-107,
   C-77, C-79, C-274). These are real 200 responses with real bodies and
   count, but they prove reachability more than data richness.
6. **Tenant/platform limits, not falsifications.** Wave-13 404s
   (ai_experiences not exposed at course scope), wave-14 C-59 500, and the
   wave-8/wave-12 4xx constraint responses say the endpoint cannot be
   exercised on this tenant/course, not that the op is unsupported.
7. **Catalog claims re-verified.** 714 total entries: confirmed. 361 RO:W:
   confirmed. POST 110, PUT 72, DELETE 46, PATCH 6: confirmed. "Missing
   method 127" refers to empty-method entries with RO=W (127 of 261 total
   empty-method entries): confirmed. GET method total: 219, of which 60 are
   learner-data gated.

## Context beyond the waves

The 103 above covers the GET wave battery only. The catalog separately
carries 10 earlier live-proven GET ops (C-44, C-114, C-275, C-280, C-330,
IB-9, IB-10, IB-12, IB-13, IB-15) from prior transport/proof work, none of
which overlap the 103. All-time verified successful GET count on this
tenant: 113. Do not present 113 as the wave-battery number; the two
scopes are different.

## Files reviewed

- gets-only/GET-WAVES-README.md
- waves/canvas-rest/WAVE-PLAN.md
- waves/canvas-rest/catalog-parsed.json (714 entries)
- gets-only/wave-N-results.md for N = 2..15, wave-fix-results.md
- gets-only/wave-2-gets.md, wave-14-gets.md, wave-fix-gets.md (brief/result mapping spot checks)
- waves/canvas-rest/wave-1/brief-wave1a-assignments.md
- memory/2026-09-21.md (wave 1A verification entry)
