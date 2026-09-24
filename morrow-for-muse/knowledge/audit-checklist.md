# Audit checklist: prove the operation actually landed

A green status code is a claim about intent, not a receipt. Canvas has
proven it will return HTTP 200 with the wrong object (D-001, D-009),
200 with a broken "No Title" discussion (D-010), and 200 on a page PUT
that upserted a brand-new page instead of updating (D-011). The
executor now defends against all three (post-write readback, required
field prevalidation, page PUT pre-check), but the audit discipline
below is what makes a write trustworthy end to end.

## Before dispatch: the gate checklist

- The tool name is a real catalog row in
  `proof-battery/OPERATION_CATALOG.md`, and the method plus path match
  the row exactly. Proven names do not pair with arbitrary arguments.
- The row status is `live-proven`, and it is not on evidence-hold in
  `dispatch/admission_policy.json` (the policy is the dispatch
  authority; the catalog is the provenance record).
- For writes in plan mode: a frozen plan file digest-bound to the
  exact action, an educator-signed approval digest-bound to the exact
  action (unexpired, category-scoped, unused), and no
  `~/.morrow/write_halt` present. In edit mode a write needs no
  approval (run `catalog` directly); the executor still asks before a
  deletion while the educator's `confirm_destructive_writes` setting
  is on.
- The principal is verified: a readback through the executor confirms
  the educator before anything else runs.

## After a write: the readback checklist

1. **Read the object back.** Re-run the member GET (e.g.
   `/api/v1/courses/{course_id}/assignments/{id}`) and compare the
   intent fields you sent (name, title, position) against the persisted
   values. The executor already does this for six surfaces and raises
   `WriteFieldMismatch` on mismatch; your job is to read the receipt
   and confirm the fields match anyway. A 200 with wrong fields is a
   failure, not a success.
2. **Deleted? Prove it.** Run the follow-up member GET and expect 404
   (the D-005 rule: 404-after-delete counts as success ONLY with that
   follow-up GET confirming absence). Exception: classic quizzes, where
   provider soft-delete means the member GET may still serve the
   deleted quiz (D-002); for those, removal from the course quiz index
   is the delete receipt.
3. **Uncertainty is a verdict.** If the journal row says
   `uncertain: true` (transport failure or 429/5xx on a write), the
   effect state is unknown. Never re-fire the write to "check"; never
   call it done. Report it as uncertain with the op id and let the
   educator decide.
4. **Prevalidation refusals are clean.** A `WritePrevalidationFailed`
   refusal made zero provider calls and journaled a claim record plus
   a journaled release under the caller's op id; the op id is reusable.
   Fix the request and dispatch fresh.

## Write-path coverage table: every admitted write and its required verification

Ported format from production doctrine: each admitted write path
maps to the verification that proves it. A write path without a row
here is not admitted. "Covered" means the verification is both
documented and performed; "pending" means the path admits no
dispatch until a live battery proves it.

| Write path (catalog rows) | What it writes | Required verification | Status |
|---|---|---|---|
| Course update/settings (C-128, C-129) and course reads incl. tabs | course title, settings, tab order | Member GET readback of the changed fields; rename restored after test writes | covered |
| Assignment create/read/update/delete/duplicate (C-38, C-44, C-43, C-40, C-42) | assignment record | POST/PUT: member GET readback, name match (executor post-write readback, D-009); DELETE: follow-up GET 404 (D-005) | covered |
| Overrides create/update/delete, batch create/update, bulk date update (C-39, C-41, C-34, C-36, C-37) | per-assignment overrides | Per-assignment overrides GET; changing `due_at` does NOT move existing overrides (separate read) | covered |
| Assignment groups create/read/update/delete (C-29, C-32/C-33, C-31, C-30) | assignment groups | Member GET readback of name/position | covered |
| Modules create/update/delete (C-268, C-282, C-270) + module items create/update (C-269, C-283) | modules and their items | Member GET readback; item position and type confirmed | covered |
| Module item delete (C-271) | module item | NOT a covered path: catalog pending, no delete-absence recipe; never dispatch against a real item | pending |
| Pages create/delete/duplicate/revert/update (C-323, C-324, C-325, C-328, C-334) | wiki page content | Member GET by page URL (PUT goes to `/pages/{url}`, not `/pages/{id}`); front-page management excluded (C-333 failed: PUT 200 but the provider kept the original front page) | covered |
| Classic quizzes CRUD (C-374..C-378), question groups CRUD + reorder (C-347, C-348, C-352, C-351), quiz questions CRUD (C-353, C-354, C-357) | classic quizzes | Create: member GET; delete: removal from the course quiz index (D-002; member GET may still serve a deleted quiz) | covered |
| New Quiz object update/delete (Chromium lane; C-299, C-289) | NQ object + parent assignment link | NQ GET, items GET with expected count, points mirror (parent `points_possible` == item sum), parent assignment dates/overrides read | covered |
| New Quiz object create (`canvas_create_new_quiz`, C-286) | NQ object | NQ GET readback of the title; proven through the full governed pipeline 2026-09-22 (disposable quizzes 4049059 and 4049060, deleted with terminal GET 404) | covered |
| Item Bank bank-level ops: create (IB-5), get (IB-9), list (IB-12), list entries (IB-13), get entry (IB-10), list shares (IB-15), rename (IB-16), share (IB-17) | banks, entries, shares | Per-op snapshot rules in `item-banks-sdk.md` (before/after readback; bank_entries cannot confirm a phase-one item create) | covered; live-proven through the executor pipeline (2026-09-22) |
| Bank archive (IB-1) | whole bank deleted | Admission ceremony: fresh bank read (title/entries/shares) presented to the educator, explicit approval on the fan-out caveat (no account-wide reverse lookup exists), disposable-only in batteries | covered; never a casual operation |
| Deletes generally | any deletable object | Follow-up member GET confirming absence (D-005; 404-after-delete counts as success ONLY with that GET) | covered |
| Undo | reversal of a prior write | Not in this release: no undo entry is pinned, so the undo command refuses. A reversal is a new write the educator approves, verified like any other write | not available |
| Course conclude/delete (C-108) | whole course access | evidence-hold: no dispatch on any tenant until a disposable live battery proves the full path; even then, the full admission ceremony | pending |
| New Quiz item rows (C-287 create, C-293 read, C-295 list, C-298 update, C-290 delete) | quiz items | Entry readback; interaction-id preservation check on every PATCH; absence check after delete; proven through the governed pipeline 2026-09-22 (items 11057310, 11057311); ghost-stub and shape doctrine in `new-quizzes-contract.md` | covered |
| Item Bank item create/update (IB-6, IB-18) and direct item read (IB-11) | bank items | Create and update read back through the bank entry (live-proven through the Chromium SDK lane 2026-09-21, item 11244176); the direct item GET (IB-11) answers 404 on live items and is not a v1 claim | covered (IB-6, IB-18); pending (IB-11) |
| Item delete (IB-19) | bank item | PENDING: implemented route, no proven flow; never dispatch against a real item; the live battery attempts it against a disposable item first | pending |
| quiz_entries / bank-draw routes (IB-2/IB-3/IB-8/IB-14) | quiz draws from banks | evidence-hold: 401 under banks.build scope; do not retry without a proven different authorization scope | evidence-hold |
| Discussion topic writes (C-139/C-141/C-167/C-238) | discussion topics | C-139/C-141/C-167 proven only through the retired form lane; C-238 (date_details PUT 204) proven through the 2026-09-21 Chromium write battery; SCOPE.md withholds from v1; flat shape NOT yet implemented: the executor unwraps one nesting level only for readback comparison and prevalidation (`_unwrap_canvas_body` in dispatch/executor.py) and sends the body unchanged, so a wrapped `{"discussion_topic": {...}}` body still hits the D-009 failure class. The flat `{"title": ..., "message": ...}` shape is documented as the production-verified contract in `api-patterns-and-errors.md`; correct the day discussion writes are ever proven on this lane. The admission policy holds all four, so dispatch refuses them | evidence-hold |

### The recipe discipline (symptoms / use / avoid / verify)

Every write request carries four parts, whether or not they are
written down:

- **Symptoms**: what the educator actually asked for, in their words.
- **Use**: the one catalog row that does it, with the exact method
  and path. Proven names do not pair with arbitrary arguments.
- **Avoid**: what not to claim (a preview is not a write; a shell is
  not a quiz with items; a phase-one item create is not a banked
  item; UI impressions are not readback).
- **Verify**: the row in the coverage table above, performed from
  fresh provider reads after the write.

If the journal row says `uncertain: true`, the verify column is
unanswerable: report the op as uncertain with the op id and let the
educator decide. Never re-fire the write to "check".

## Lifecycle rule for test objects

Every disposable test object follows create, readback-verify,
delete, verify-gone. Nothing proven counts as proven until the
cleanup GET confirms absence (or index removal, for classic quizzes).
The 2026-09-21 batteries ran this full lifecycle on course 89585:
assignment 4045385, module 958491, module item 10058160, quizzes
4045401/4045406/4045410/4045411, classic quiz 338345 with question
6797992 and group 47372, banks 4053/4054/4055/4056.

**Never clean a sandbox course for cosmetics.** The sandbox is a
scratch pad, not a showroom. Leftover proof objects are not a defect
to fix and not a question to ask about. Deleting or tidying them
spends the educator's attention on test-environment hygiene.
Adversarial proof that capabilities work is the measure of done in
test environments, not tidiness.

**Disposable test objects live on the sandbox course only.**
Designate one sandbox course on the educator's own tenant: course
89585 (the historical sandbox from the 2026-09-21 batteries) is evidence history,
not your course. Never create test objects on
the educator's live courses: a "quick test write" on a real course
is a real write, and real-course writes need explicit per-action
approval through the full ceremony. The 2026-09-21 batteries ran the
full lifecycle on 89585 only.

## Hard lines (never, no exception)

- Never dispatch a plan-mode write without the educator-approved
  ceremony (frozen plan, educator-signed approval, no write halt); in
  edit mode the write runs without asking, except a deletion while
  `confirm_destructive_writes` is on.
- Never mint or sign an approval yourself, and never try to learn
  the real name behind a label the educator did not name.
- Never send anything externally on the educator's behalf without
  their explicit word: no announcements (permanently excluded as a standing
  product exclusion), no conversation messages (the `/conversations` rows are
  in the admission policy's never-dispatch list), no quiz
  submission-user messages. Drafting is not sending; sending needs
  the word.
- Never point the connector at a tenant the educator did not name.
  `CANVAS_BASE` is educator config, always.
- Never work around a gate refusal by renaming the tool, reshaping
  the request, or switching backends. A refusal names its reason;
  fix the reason or escalate to the educator.
- Never commit, tag, publish, or deploy anything from this tree
  without the educator's explicit word.

## Journal verification

A dispatch journals more than one record. The live journal is
`~/.morrow/trees/<tree-id>/journal/ops.jsonl` (0700 dir, 0600 file;
or `$MORROW_TREE_STATE_DIR/journal/ops.jsonl` when overridden). The
legacy `~/.morrow/journal/ops.jsonl` is read for historical
idempotency only. To audit an op:

```
tail -n 50 ~/.morrow/trees/<tree-id>/journal/ops.jsonl | python3 -c "
import json,sys
for line in sys.stdin:
    r=json.loads(line)
    if r.get('op_id')=='<op_id>': print(json.dumps(r,indent=1))"
```

Reads journal a `wal="claimed"` record before provider work, then a
completion record. Writes journal an fsynced `wal="pending"` claim
before provider work, then a `wal="complete"` record on success.

Check: `entry_name` and `method` match what you meant to run;
`verification` is not `fail`; `uncertain` is false; for writes, the
`approval` audit block is present (op digest, by, channel,
authorization citation). Consumed op ids are never reused; a replayed
op id is refused as a duplicate.

Refusal journaling depends on when the refusal happens. Catalog-gate
refusals (unknown name, method/path mismatch, non-live-proven
without override, never-dispatch, unsupported, evidence-hold,
learner-data) are journaled under their own fresh refusal event ids,
never under the caller's op id, so a refused op id is never burned.
Post-claim pre-provider failures (prevalidation refusal, session
death, provably-never-sent writes) journal a claim record plus a
journaled release under the CALLER's op id, and the op id stays
reusable. Ambiguous write failure journals the claim plus an audit
record with a fresh event id.

## What the audit never shows

- The journal carries shapes, statuses, lengths, digests, and IDs
  only. Displayed learner names never enter the journal, the receipt,
  or any agent-visible surface. If you see a learner name in a journal
  row, that is a privacy defect: stop and report it.
- Session death after claim journals a claim record plus a journaled
  release under the caller's op id: the op id stays reusable, and
  absence of a completion record is not evidence of failure. Pre-claim
  death journals nothing at all.
- The receipts are byte-capped (262144 bytes, tail-truncated) and
  redaction-patterned at the executor level. Do not paste full
  provider bodies into chat when a receipt suffices.
