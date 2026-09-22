# Site-parity gap analysis: meetmorrow.app claims vs Morrow for Muse

Date: 2026-09-21 (independent re-verification pass). Read-only analysis of `~/workspace/morrow-for-muse-deploy/`.
Unit evidence only; no live batteries were run for this analysis.

## Wave-3 reconciliation addendum (2026-09-21, later same day)

Several current-state facts in the table and gaps below changed
after this analysis was written. The original rows are left intact
as the earlier-pass record; this addendum is the current state.

- Runtime pack: `pack/pack.json` is now version 0.3.0 with an empty
  entry list, not a 2-entry stub. The 14 unverifiable external pins
  were removed rather than shipped on trust. Top-5 gap #5 and claim 1
  are resolved in the sense the pack no longer pins unverifiable
  entries; the rebuild-from-catalog recommendation stands.
- Operation catalog: `proof-battery/OPERATION_CATALOG.md` holds 457
  rows (437 Canvas C-1..C-437 plus 20 Item Bank IB-1..IB-20), not
  ~1,132. Combined statuses: 210 live-proven, 211 pending, 12
  failed, 11 unsupported, 8 other, 5 evidence-hold. Live-proven:
  115 reads (110 Canvas plus 5 Item Bank), 95 writes. Learner-data
  flagged: 146. Live-proven reads are reads the governed admission
  pipeline can actually dispatch; pending rows are not capabilities.
- New Quiz create: `canvas_create_new_quiz` (C-286) is
  provider-path live-proven but the admission policy holds it on
  evidence-hold; dispatch refuses it on every tenant. It is not an
  admitted capability. Claim 2's "live PATCH/draw/bank batteries
  still pending" is resolved for update/delete/attach flows (see
  `proof-battery/evidence/nq-item-bank-wave2/`); create stays held.
- Module-item delete (C-271): pending, not live-proven. Item-bank
  item delete (IB-19): pending. Item-bank unshare (IB-20):
  live-proven 2026-09-21 (share 38934 removed, list verified clean).
- Journal path: the live journal is
  `~/.morrow/trees/<tree-id>/journal/ops.jsonl` (or
  `$MORROW_TREE_STATE_DIR/journal/ops.jsonl` when overridden), not
  `~/.morrow/journal/ops.jsonl`. The legacy path is historical
  idempotency input only. Claim 5's path reference is updated.
- Blackboard: there is no Blackboard implementation anywhere in
  the product tree (no session, auth, transport, or operations; the
  provider enum is canvas/moodle only). Blackboard references that
  remain are explicit not-implemented disclosures, not code. Claim 12's
  grounding is updated. The GAP stands; under the parity law it needs
  live proof before any launch claim.
- Refusal journaling: catalog-gate refusals journal under a fresh
  refusal event id, never the caller's op id. Post-claim
  pre-provider failures journal a claim record plus a journaled
  release under the caller's op id; the op id stays reusable.

## Addendum: form-relay lane retired (2026-09-21, same day)

After this analysis was written, the form relay lane was retired:
meetmorrow.app/morrow/form-relay/ was taken down and
transport/form_relay.py, transport/form-relay/, and
transport/form_relay_selftest.py were deleted. Two findings above are
affected:
- A1 (PATCH rejected by batch.py): the "transport/form_relay.py accepts
  PATCH" half is gone with the file. The batch.py PATCH rejection stands
  on its own, but it no longer blocks anything: batch.py fails closed on
  every form write now, and live writes run through the helper Chromium
  page context (dispatch/executor.py chromium backend).
- Claims 12 / Blackboard (lines 58, 95, 277): the provider-string negative
  test in transport/form_relay_selftest.py:117 was deleted with the file.
  There is no Blackboard implementation anywhere in the product tree
  (remaining Blackboard references are explicit not-implemented
  disclosures). The GAP stands (no Blackboard session, auth, or operations).

## Addendum: independent verification deltas (2026-09-21, second reviewer)

A second read-only pass verified the pack stub (pack/pack.json entry_count: 2,
confirmed) and the split_batches dead-end (only caller is
transport/selftest.py:154-155, confirmed). Three additional gaps this analysis
did not name:

A1. **The browser-task batch renderer rejects PATCH.** transport/batch.py:218
(_validate_op) and :250 (_validate_fetch_op) accept only GET/POST/PUT/DELETE.
transport/form_relay.py and transport/browser_backend.py (lines 550, 632) both
accept PATCH, and the newly implemented New Quiz lane requires PATCH for every
update. Net effect: New Quiz PATCH writes cannot be rendered into a browser-task
brief today, so the no-PAT New Quiz write lane is blocked end to end at the
renderer, independent of the executor-side P0-2 work. Fix is mechanical: add
PATCH to both validators in batch.py.

A2. **dispatch/admission_policy.json "tenant_restricted" is stale against live
proof.** It lists canvas_create_new_quiz, canvas_item_bank_attach_bank_entry_to_quiz,
canvas_item_bank_attach_bank_to_quiz, canvas_item_bank_delete_quiz_bank_entry,
and canvas_item_bank_list_quiz_draws with an empty allowed_tenants map, which
refuses them by default. The 2026-09-20 live batteries proved New Quiz
creation and item-bank attach/share flows on course 89585. The gate will refuse
proven writes until the policy is reconciled with the proof evidence.

A3. **Privacy: bare name-only records pass through unprojected.**
privacy/learner_vault.py:264 _learner_id_of only tokenizes dicts carrying
user_id or IDENTITY_FIELDS; a dict with only a name and no id is not a learner
record by this rule and its name reaches the agent visible layer. The "stops if
it cannot protect everyone" promise therefore holds for vault outage
(VaultUnavailable, check_learner_data) but not for unidentifiable records.
Recommend: refuse or flag learner-shaped records the vault cannot identify.

No em dashes used in this document per Braden's rule.

Note on freshness: sibling agents were editing `dispatch/executor.py`, `transport/browser_backend.py`, and `provision/provision.py` during this read (P0 implementation in flight). Line numbers below are as observed ~01:28 UTC 2026-09-21 and may shift by a few lines.

Status key: WORKS = implemented and unit-proven in this tree. PARTIAL = real pieces exist but the claim is not fully met. GAP = missing.

## Claim-by-claim status table

| # | Site claim | Status | Grounding |
|---|-----------|--------|-----------|
| 1 | Plan courses and create approved lessons, activities, discussions, assignments, modules | PARTIAL | The executor dispatches these catalog operations (`dispatch/executor.py`, `execute`/`catalog`/`complete`/`undo` CLI at executor.py:1953-2120). Live proof exists for a small set on course 89585 (assignment/page/discussion/New Quiz lifecycle creates, verified then deleted). The operation catalog (`proof-battery/OPERATION_CATALOG.md`, 456 rows: 436 Canvas plus 20 Item Bank) covers the surface, but the shippable runtime pack (`pack/pack.json`, v0.3.0) currently pins zero entries, so catalog coverage is not shippable coverage yet. |
| 2 | Build, review, improve New Quizzes and Item Banks down to each question and setting | PARTIAL | New Quiz lane implemented 2026-09-21 in `dispatch/executor.py`: PATCH-never-PUT guard (`guard_new_quiz_request`, hooked in `build_request` and both browser planners), complete settings merge (`plan_new_quiz_settings`), interaction-ID preservation check, builder-token draw PATCH, quiz-API-route delete, hard 506477 refusal. Independently re-verified: `dispatch/executor_selftest.py` passes, tail shows the New Quiz checks green. Item Bank side: launch/capture rewrite of `provision/provision.py` was in flight during this read. All unit-proven only; live PATCH/draw/bank batteries still pending. |
| 3 | Audit and remediate accessibility at scale | GAP | No accessibility scanner exists anywhere in the product tree. Grep for accessibility/a11y/wcag across all .py files returns zero product hits; the only mentions are in docs (`proof-battery/OPERATION_CATALOG.md` one comment, `audit/` docs, weasel notes). No finding model, no per-course scan, no aggregation, no a11y remediation flow. Remediation primitives exist per-op (individual writes + approval + readback), but nothing a11y-specific. |
| 4 | Compare and update dozens of courses, then verify each approved change against what the LMS saved | GAP | `transport/batch.py` provides one primitive: render one browser-task brief of up to 15 ordered ops (`MAX_OPS_PER_BATCH = 15`, `split_batches` at batch.py:617). Verified by grep: `split_batches` has no product caller, only `transport/selftest.py:154-155`. There is no course-list input, no fan-out runner, no multi-batch orchestrator, no per-course error isolation, no progress reporting, no result aggregation. Manifest-level multi-course params exist (`morrow_read_item_bank_fan_out` accepts `course_ids` up to 500 and `quiz_use_course_ids` up to 500), but nothing in the executor loops over them. `bin/scheduler.py` is a keepalive daemon (Canvas daily, Moodle every 6h), not a job scheduler. Per-change readback verification exists per-op (see claim 7) but there is no job-level rollup. |
| 5 | Review courses each week (missing work, course problems, tracked changes) | GAP | No weekly review job, no missing-work detector, no course-problem scanner. The journal (`dispatch/executor.py:175`, `~/.morrow/trees/<tree-id>/journal/ops.jsonl`) records per-op history, but nothing turns it into a per-course tracked-changes view or a weekly digest. No cron or scheduled job in the tree drives course reviews. |
| 6 | Compare sections (assignments, discussions, dates, outcomes across chosen sections) | GAP | No comparison machinery exists. Reads are per-object; nothing reads N sections and diffs assignments, discussions, dates, or outcomes. `morrow_check_new_quiz` compares up to 3 quizzes within one course only. |
| 7 | Check every approved change (readback verification of each change) | WORKS per-op; GAP at job scale | Per-op verification machinery is implemented and unit-proven: writes require a frozen plan (`_check_write_gates`, executor.py:1553-1588, `MissingFrozenPlan`), `run_verify` executes frozen readback assertions (executor.py:1495), the browser lane has dispatch/complete/verify phases with `reverify_approval` (dispatch/admission.py:890), and honest outcome classification (verified/unconfirmed/failed/applied_or_unknown) is in flight in `transport/browser_backend.py`. Missing: aggregating many per-op verdicts into a per-course or per-job report. |
| 8 | Privacy: student identity protection (identifiers replaced with labels; stops if it cannot protect everyone) | PARTIAL | Tokenization is implemented and unit-proven (`privacy/learner_vault.py`): deterministic HMAC-SHA256 tokens per (tenant, learner id), `PII_FIELDS` never agent-visible, educator-only `vault.lookup`, per-tenant purge and full wipe. The "stops if it cannot protect everyone" half holds: `check_learner_data` refuses learner-bearing ops when the vault is not ready (dispatch/admission.py:329-346), and the browser completion path raises `VaultUnavailable` instead of projecting (transport/browser_backend.py:115-129), wired at both browser completion points. Two gaps vs the site copy: tokens are opaque (`lrn_<20 hex chars>`), not human-friendly labels like "Student A1"; and the raw HTTPS lane refuses learner ops outright (`LearnerDataGated`, executor.py:1616) rather than projecting them. |
| 9 | Plan mode: every course starts in Plan, review before save; Edit access granted per course and change type; after each change the assistant checks the course and reports | PARTIAL | The per-action machinery is implemented and unit-proven: v2 approval ceremony in `dispatch/admission.py` (HMAC-sealed records, single-use digests under fcntl lock, digest binding over entry+params+tenant+category, `reverify_approval` at complete; `dispatch/approval-ceremony.md` documents it as implemented with the educator-facing UX still open, development-worktree doc, not shipped in the dist). Every write requires a frozen reviewed plan (review-before-save at op level). Gaps: no per-course Plan state (no course registry, no default-mode flag), no standing per-course/per-change-type Edit grants (approvals are per-action, single-use, tenant+category scoped, 24h TTL), and the approval UX wiring is explicitly open (approval-ceremony.md checklist item 6). Category scoping (`entry_category`, admission.py:464, e.g. `canvas.assignment`) is the closest existing analog to "change type". |
| 10 | Works with ChatGPT, Claude, Gemini | Out of tree (platform layer) | The deploy tree is the connector backend and is model-agnostic: nothing in it binds to a specific assistant model. Model attachment is the Muse platform connector layer, which is not in this repo. Not evaluable here; no tree change required for this claim beyond keeping the backend model-neutral. |
| 11 | Canvas, Moodle | PARTIAL | Canvas: session lane + PAT lane detection (`lanes/detect.py`), live reads and lifecycle writes proven for a small op set on course 89585. Moodle: lane modules exist (`moodle/session.py`, `moodle/login.py`, `moodle/probe.py`, `moodle/reauth.py`) and the browser form lane accepts provider `moodle` (`transport/batch.py` `render_brief` validates canvas/moodle only). Moodle live proof so far is the public sandbox only. |
| 12 | Blackboard (admin-set-up connection) | GAP | No Blackboard implementation exists anywhere in the product tree (remaining Blackboard references are explicit not-implemented disclosures). No Blackboard session, auth, or operations exist. In scope under the parity law; it needs live proof before any launch claim. |
| 13 | Map curriculum, prepare accreditation evidence | GAP | No curriculum-mapping or evidence-packaging code anywhere in the tree. |

## Top 5 gaps blocking the two callouts

Callout A: full program-wide accessibility audits and remediation.
Callout B: working across dozens of courses at once.

1. **No accessibility scanner at all.** Nothing reads a course's pages, assignments, quiz items, or files and reports findings (missing alt text, tables without headers, unlabelled quiz images, caption status). This is the single largest blocker for callout A; aggregation, remediation, and evidence all depend on it.
2. **No multi-course job abstraction.** No course-list input, no fan-out over `batch.py` briefs, no multi-batch runner, no per-course error isolation, no progress tracking, no completion rollup. `split_batches` exists but has no product caller. This is the single largest blocker for callout B.
3. **No finding aggregation or per-course rollup.** Even once scans and batches exist, nothing maps approved changes to their readback verdicts per course or rolls findings up into a program-level report. `transport/state.py` stores lane metadata only; `parse_results` returns per-op dicts with no rollup.
4. **No per-course Plan state or standing Edit grants.** Program-wide work needs durable per-course grants scoped by course and change type; otherwise a 40-course remediation means a fresh per-action approval ceremony for every op. `dispatch/admission.py` has per-action single-use approvals only (24h TTL).
5. **The shippable runtime pack is empty.** `pack/pack.json` v0.3.0 pins zero entries (the 2 unverifiable external pins were removed 2026-09-21 rather than shipped on trust). Until the pack is rebuilt from the operation catalog with honest evidence statuses, neither a11y scan entries nor multi-course entries are shippable, and catalog-driven coverage claims cannot be verified from the pack.

## Recommended implementation order

0. **Rebuild the runtime pack from the operation catalog** with per-entry evidence status. Unblocks everything shippable; without it, new entries have no delivery vehicle.
1. **Build the a11y scanner as read-only catalog entries**: one entry per finding class (page images without alt, tables without headers, quiz item images without labels, media caption status), each with a frozen readback, reusing the existing verify machinery. Unblocks callout A at the read layer.
2. **Build the multi-course job runner**: course-list input, fan-out over `batch.py` briefs (sequential first), per-course error isolation so one course failure never kills the batch, an enforced per-tenant rate limiter in code (not brief text), per-course progress journaling, aggregated per-course verdicts. Unblocks callout B.
3. **Add per-course verification rollups**: aggregate `parse_results` per course, map each approved change to its readback verdict, emit a job-level report. Closes the "verify each approved change" half of claim 4.
4. **Add the remediation-write flow for a11y findings**: each finding becomes a frozen plan plus approval ceremony plus write plus readback, reusing `dispatch/admission.py` and the executor verify path. Add standing per-course Edit grants to admission (scoped by course and change type, with expiry and revocation) so program-wide remediation is not N ceremonies per op.
5. **Add the educator-facing surfaces**: approval UX (approval-ceremony.md checklist item 6), post-change course reports, the weekly review job (claim 5: missing work, course problems, tracked-changes digest from the journal), section comparison reads (claim 6), curriculum/accreditation evidence export (claim 13), the Blackboard lane with live proof (claim 12), and human-friendly learner labels ("Student A1") as a display layer over vault tokens (claim 8).

## Independent re-verification addendum (2026-09-21, second pass)

A fresh read-only pass re-read the cited files directly (no sibling-agent
output trusted). Every status and line reference in the table above was
confirmed accurate as of ~01:45 UTC 2026-09-21:

- `dispatch/admission.py:329` `check_learner_data`, `:890`
  `reverify_approval` both present.
- `transport/browser_backend.py:114` `_project_learner_result` fail-closed
  projection, `:730` canvas-only `_lane_for` both confirmed.
- `dispatch/executor.py:1495` `run_verify`, `:1553` `_check_write_gates`
  (frozen-plan gate) confirmed.
- `transport/batch.py:83` `MAX_OPS_PER_BATCH = 15`, `:617`
  `split_batches` confirmed; no product caller found by grep.
- `transport/form_relay_selftest.py:117` is the only Blackboard mention in
  product code (a provider-string negative test).
- `bin/scheduler.py` exists (keepalive-driven, not a course-job scheduler).
- The New Quiz lane landed during the first read: `guard_new_quiz_request`,
  `plan_new_quiz_settings`, builder-token draw PATCH, quiz-API delete route,
  and the hard 506477 refusal are in `dispatch/executor.py`; the extended
  `dispatch/executor_selftest.py` passes (tail shows the New Quiz checks
  green). Unit-proven only; live PATCH/draw/bank batteries still pending.

### One material finding the first pass did not call out

**Policy tension on the site's headline feature: RESOLVED 2026-09-21.**
Per parity law (no tenant allowlists anywhere), `tenant_restricted` was
retired from `dispatch/admission_policy.json` and `dispatch/admission.py`
(replaced by tenant-independent `evidence_holds`). CORRECTION 2026-09-21:
the earlier claim that `canvas_create_new_quiz` was live-proven on 2026-09-21
(New Quiz 4045374 created, read, deleted, verified absent on course 89585) was
false; no such battery ran (4045374 exists only as a selftest fixture). The
verified New Quiz write proof remains the 2026-09-20 Mac-rig battery (quiz
4045369), which does not prove the integrated product path. `canvas_create_new_quiz`
is therefore refused on every tenant by evidence hold until a disposable live
battery proves the integrated path, then it opens on all tenants automatically. The
four item-bank ops
(`canvas_item_bank_attach_bank_entry_to_quiz`,
`canvas_item_bank_attach_bank_to_quiz`,
`canvas_item_bank_delete_quiz_bank_entry`,
`canvas_item_bank_list_quiz_draws`) are refused on every tenant by
evidence hold until a disposable live battery proves the rewritten
credential path, then they open on all tenants automatically. No policy
blocker remains on claim 2.

### Catalog-table staleness

`proof-battery/OPERATION_CATALOG.md` carries ~830 data rows with ~248 still
marked pending and only 2 marked live-proven in the table format; the
authoritative proof record is `proof-battery/LEDGER.md` (e.g. C-W1
assignment lifecycle PROVEN, NQ-R1/NQ-R2 PROVEN), which the catalog table
does not reflect. Any per-entry evidence-status rebuild of `pack/pack.json`
(implementation step 0) must read the LEDGER, not the catalog table.

## Honesty notes

- Sibling agents were implementing P0-1/P0-2/P0-4/P0-7 items in `provision/provision.py`, `dispatch/executor.py`, and `transport/browser_backend.py` during this read; statuses marked "in flight" may have landed by the time this is read.
- `proof-battery/LEDGER.md` live-evidence claims (2026-09-20 batteries) were not re-verified here; PENDING/NOT PROVEN rows there remain unproven.
- The desktop Morrow analysis reports (`~/workspace/morrow-desktop-analysis/`) document how desktop does governed tools and session handling; this analysis covers only what exists in the Muse deploy tree.
- Claim 10 (ChatGPT/Claude/Gemini) is a platform-layer concern; the tree backend is model-agnostic and needs no change for it.

## Independent reconciliation pass (2026-09-21, second analyst)

A second analyst independently re-read the deploy tree and confirms the
status table, the top 5 gaps, and the recommended order above. Key claims
were re-verified from source:

- `split_batches` has no product caller: only `transport/batch.py:617`
  (definition) and `transport/selftest.py:154-155` (test). Confirmed no
  fan-out runner exists.
- `transport/state.py` holds lane metadata only (base, principal id/name,
  lane, timestamps) and refuses to persist credential-shaped keys.
- `pack/pack.json` v0.2.4 pins exactly 2 entries
  (`morrow_read_item_bank_fan_out`, `morrow_check_new_quiz`), both
  referencing `../provision/manifests/`; `credential_slots` lists
  `canvas_pat` and `moodle_sesskey`. The tree's own
  `desktop-defect-audit.md:171` already flags this as a stub.
- No "Student A1"-style labeler exists anywhere in product code (zero hits
  for "Student A" across all `.py` files); learner labels are `lrn_<hex>`
  tokens (`privacy/learner_vault.py:60`).
- The `morrow_read_item_bank_fan_out` manifest accepts `course_ids` up to 500
  and `quiz_use_course_ids` up to 500, but these are scoping parameters for a
  single bank read, not a fan-out loop; nothing iterates them.
- `bin/scheduler.py` is keepalive-only (Canvas daily, Moodle every 6h).
- The live proof driver (`proof-battery/live-product-proof/driver.py`) is
  single-op: one dispatch/complete per step, no multi-course input.

Additional nuances found in this pass:

1. Privacy fail-closed is narrower than the site copy. When the vault is
   unavailable, reads refuse (`VaultUnavailable`,
   `transport/browser_backend.py:115-129`; `LearnerDataGated`,
   `dispatch/admission.py:329-346`) and the raw HTTPS lane refuses
   learner-bearing ops outright (`dispatch/executor.py:1617`) rather than
   projecting them. But projection itself is heuristic
   (`_learner_id_of`, `privacy/learner_vault.py:235`): payload shapes not
   recognized as learner-shaped pass through unprojected with no refusal.
   So "stops if it cannot protect everyone" holds when the vault is down,
   not for unrecognized payload shapes.
2. Policy gating on the New Quiz claim: RESOLVED 2026-09-21. The old
   `tenant_restricted` mechanism (empty `allowed_tenants` map) was retired
   per parity law. `canvas_create_new_quiz` is admitted on all tenants; the
   item-bank ops sit in tenant-independent `evidence_holds` until a live
   battery proves the rewritten credential path, then they open everywhere
   automatically.
3. The Item Bank fan-out manifest now documents the frame-bound
   launch/capture design (captured, never minted), consistent with the P0-1
   rewrite in flight; its `fail_closed_on` list and the 10-minute
   single-operation credential rule are the strictest credential handling in
   the tree.
4. Moodle lane modules exist (`moodle/session.py`, `login.py`, `probe.py`,
   `reauth.py`) with `batch.py` `render_brief` accepting provider `moodle`;
   live proof is the public sandbox only, so the Moodle half of any
   program-wide claim still needs production proof.

No contradictions with the main analysis were found. The top 5 gaps and the
recommended implementation order (pack rebuild first, then a11y scanner,
multi-course runner, verification rollups, remediation flow with batch
ceremony, educator surfaces) stand.

## Independent re-verification addendum (2026-09-21, second read)

A second read of the same tree, done in parallel, confirmed the analysis
above and adds the following verified details and nuances. No product
files were changed by either read.

1. Catalog status counts: `proof-battery/OPERATION_CATALOG.md` uses the
   vocabulary live-proven / pending / tenant-restricted / unsupported /
   excluded / source-only. The desktop-parity matrix
   (audit/DESKTOP_TO_MUSE_MATRIX.md, section 1) records 711 rows: 679
   pending, 19 live-proven, 8 excluded, 2 tenant-restricted,
   3 unsupported, 172 flagged [LEARNER-DATA]. Row-level counts should be
   taken from that matrix, not from string counts of the catalog prose.
   Either way, roughly nine in ten cataloged operations are unproven,
   which is the single largest fact against the parity law.
2. `split_batches` confirmed to have no product caller: the only
   references are its definition (transport/batch.py:617) and the
   selftest (transport/selftest.py:154-155). The multi-course blocker
   stands.
3. The 2-entry pack confirmed: pack/pack.json pins exactly
   `morrow_read_item_bank_fan_out` and `morrow_check_new_quiz`
   (entry_count 2). The rebuild-the-pack recommendation stands.
4. Privacy nuance for claim 8: projection happens on the receipt at
   complete time (transport/browser_backend.py _project_learner_result,
   line 89), but the raw browser-task report text is parsed by the
   agent before projection, and the raw provider payload stays in the
   pending envelope; privacy/learner_vault.py states raw browser
   reports "must not be persisted as evidence; that is the caller's
   responsibility." The fail-closed half (refuse rather than leak)
   holds; the "before reaching the assistant" half is not airtight
   for the report-text path.
5. Free-text redaction is absent: the vault redacts recognized
   user/enrollment/submission shapes by key (PII_FIELDS) but has no
   name-in-free-text redaction, which desktop had
   (DESKTOP_TO_MUSE_MATRIX.md section 2). A name appearing in
   discussion text or a page body is not tokenized.
6. Approval friction for program-wide work: dispatch/admission.py
   binds one approval to one (entry, params, tenant, category) digest
   (op_digest_of), single-use, max 24h TTL. Updating one item across
   40 courses, or remediating hundreds of a11y findings, needs one
   ceremony per action today. This is why the standing per-course
   Edit grants recommendation matters for both callouts, not just
   convenience.
7. Moodle coverage: 250 rows at tool-name parity in the catalog, but
   only 2 live-proven (M-9 list courses, M-165 forum discussion
   create). All 12 Moodle lesson ops (M-106..M-109, M-197..M-202) are
   pending, which directly weakens the site's "create lessons" claim.
8. Session/authentication posture (claim 11 analog) is the strongest
   part of the tree: cookie-capture retired (transport/README.md),
   slot_secret raises on cookie-jar slots, principal pinned before
   writes (browser_backend.py:756), login redirects fail closed
   (reauth/state_machine.py), stale lane generations refused
   (browser_backend.py:807-825), write halt plus quarantine on expiry
   with principal-pinned verified resume. This part of the site claim
   is genuinely WORKS.
9. Blackboard: no code in the deploy tree beyond one provider string
   in a selftest. The site advertises it; the parity law puts it in
   scope; it needs live proof before launch.

## Supplement: second independent pass (2026-09-21, ~01:35 UTC)

A second agent re-read the tree independently and appends the following.
It confirms the table above where re-verified, and adds findings the
first pass did not cover. No em dashes used per Braden's rule.

### Independent confirmations

- Accessibility: re-grep across `dispatch/`, `transport/`, `privacy/`,
  `lanes/`, `session/`, `reauth/`, `moodle/` returns zero product hits
  for accessibility/a11y/wcag. Claim 3 GAP confirmed.
- Multi-course: executor dispatches one op per invocation
  (`dispatch/executor.py` main, line 1953); `split_batches` in
  `transport/batch.py` line 617 has no product caller. No course-set
  input, no fan-out, no per-course isolation, no progress rollup.
  Claim 4 GAP (multi-course half) confirmed.
- Blackboard: zero product code (only a provider string in
  `transport/form_relay_selftest.py:117`). Claim 12 GAP confirmed.
- Pack: `pack/pack.json` pins exactly 2 entries
  (`morrow_read_item_bank_fan_out`, `morrow_check_new_quiz`).
  Top-5 gap #5 confirmed.
- New Quiz lane: `guard_new_quiz_request` (executor.py:1069),
  `plan_new_quiz_settings` (executor.py:1152),
  `build_quiz_draw_update` (executor.py:1301), 506477 hard refusal
  (executor.py:1029,1102,1207,1322) all present; 50 new checks in
  `dispatch/executor_selftest.py`, suite passes. Claim 2 PARTIAL
  confirmed.
- Item Bank provisioner: `provision/provision.py` rewritten to the
  launch/capture design (`ItemBankCredential` line 166, binding checks,
  single-use `CredentialConsumed`, `CredentialClosed` semantics,
  `quiz_api_base` tenant host). P0-1 landed.
- A2 confirmed: `dispatch/admission_policy.json` `tenant_restricted`
  still refuses `canvas_create_new_quiz`,
  `canvas_item_bank_attach_bank_entry_to_quiz`,
  `canvas_item_bank_attach_bank_to_quiz`,
  `canvas_item_bank_delete_quiz_bank_entry`,
  `canvas_item_bank_list_quiz_draws` with an empty `allowed_tenants`
  map, while the 2026-09-20 batteries proved these flows on course
  89585. Policy is stale against live proof.
- A3 confirmed: `privacy/learner_vault.py` `_learner_id_of` (line 235)
  returns None for a dict carrying only a `name` (no `user_id`, no
  `IDENTITY_FIELDS` member, not under a user key). The `_project`
  deep-walk only tokenizes dicts `_learner_id_of` identifies, so a bare
  name-only record passes through unprojected to the agent-visible
  layer. "Stops if it cannot protect everyone" holds for vault outage
  but not for unidentifiable records.

### Additional findings (not in the first pass)

**F1. Sign-in stays in the browser: WORKS (design).** `transport/batch.py`
briefs forbid reporting cookie values, CSRF values, or credential
material; the CSRF token is harvested in-page by the task and never
written into reports. `transport/browser_backend.py` secret rules refuse
any plan that would carry credential material (`SecretEgressRefused`).
Lane state is metadata only (`transport/state.py`,
`~/.morrow/browser_lane.json`): base URL, provider, principal id/name,
verification timestamps, no secrets.

**F2. Account, user, and global reads: GAP under the parity law.** The
matrix marks account/LTI/developer-key routes "intentionally-inapplicable"
under the old educator-authority-only model. The 2026-09-21 parity law
puts account/user/global reads in scope, so this is now a gap to close
with a proper consent model, not a settled exclusion.

**F3. Claim 10 nuance: connector UX is in-tree work, not purely
platform-layer.** The first pass calls ChatGPT/Claude/Gemini support
"out of tree". But `dispatch/approval-ceremony.md` checklist item 6
("Wire the renderer into the connector's approval UX: present display,
capture verbatim reply") is explicitly marked OPEN with "no connector UX
exists yet in this tree". The backend is model-agnostic, but the
ceremony's educator-facing half, which every write depends on, is
unbuilt in this tree. Until it is wired, no approved write can actually
flow through any of the three assistants.

**F4. Privacy retention note.** The raw provider payload is retained in
the pending envelope (0600 file) so internal machinery (deferred verify,
undo, transient capture) can resolve result references. Agent-visible
surfaces carry only tokens. This matches "before reaching the assistant"
but is a retained-PII path that belongs in the retention inventory.

**F5. Per-op approval will not scale to program-wide remediation.**
Confirmed independently: approvals are per-action, single-use,
digest-bound, 24h TTL (`dispatch/admission.py`). The site's "Edit access
granted per course and change type" implies standing grants. A 40-course
a11y remediation under per-op ceremonies is operationally infeasible;
the standing-grant design (scoped by course and change type, with expiry
and revocation) is a prerequisite for callout A at program scale, not a
later optimization.

### Recommended implementation order (second pass)

The first pass orders pack rebuild first. This pass orders the batch
engine first, because program-wide accessibility IS a scan fanned out
over a course set: without fan-out, error isolation, and rollup, the
a11y scanner has no delivery vehicle at program scale.

1. **Multi-course job runner**: course-list input, fan-out over
   `batch.py` briefs (sequential first), per-course error isolation,
   in-code per-tenant rate limiter, per-course progress journaling,
   aggregated per-course verdicts.
2. **A11y scanner as read-only catalog entries**, one per finding class
   (page images without alt, tables without headers, quiz item images
   without labels, media caption status), each with a frozen readback.
3. **Standing per-course/per-type Edit grants** in admission (F5), then
   the a11y remediation-write flow: finding to frozen plan to approval
   to write to readback.
4. **Rebuild the runtime pack from the operation catalog** with honest
   per-entry evidence statuses, so new entries are shippable.
5. **Reconcile `tenant_restricted`** with the 2026-09-20 live proof (A2);
   fix the bare-name projection hole (A3).
6. **Weekly review, section compare, curriculum/accreditation export**;
   **Blackboard lane + account/user/global reads**, each live-proven
   before any claim; **connector approval UX** (F3); human-friendly
   learner labels as a display layer over vault tokens.
