# Desktop Morrow to Morrow for Muse: Feature Migration Matrix

**Audit date:** 2026-09-20. **Auditor:** Hermes (subagent, read-only; no files changed anywhere).
**Scope:** `~/workspace/morrow-fix` (desktop Morrow, VM copy, read-only) vs
`~/workspace/morrow-for-muse-deploy` (Morrow for Muse, no-MCP connector product).
**Method:** code reading only; nothing executed against live services. "Proven" below means a
live receipt exists in the deploy workspace or in `~/workspace/morrow-for-muse/proofs`; code
presence alone is never marked proven.

## Wave-3 reconciliation addendum (2026-09-21)

This matrix was written 2026-09-20. The rows below are left intact as
the 2026-09-20 record; this addendum states what changed. The
435/711 counts, the "no admission engine" rows, and the legacy
journal path below are stale.

- Catalog counts: the for-muse catalog is now 457 rows (437 Canvas
  C-1 through C-437 plus 20 Item Bank IB-1 through IB-20), not
  435/711. Combined statuses: 210 live-proven, 211 pending,
  13 failed, 11 unsupported, 8 excluded, 5 evidence-hold. Combined
  read/write: 220 reads, 236 writes; live-proven reads 114 (109
  Canvas plus 5 Item Bank); live-proven writes 93. Learner-data
  flagged: 146.
- Admission engine: the "Catalog dispatch path" row (section 3,
  "no admission, no catalog pin") is obsolete. `dispatch/executor.py`
  runs `_catalog_provenance_gate` before any session is loaded or
  admission runs: unknown names, method/path mismatch,
  non-live-proven without an educator-signed `--allow-unproven`
  override, never-dispatch, unsupported, evidence-hold, and
  learner-data are refused before dispatch. The admission gate is
  real and fail-closed.
- Journal path: the live journal is
  `~/.morrow/trees/<tree-id>/journal/ops.jsonl` (or
  `$MORROW_TREE_STATE_DIR/journal/ops.jsonl` when overridden), not
  `~/.morrow/journal/ops.jsonl`. The legacy path is historical
  idempotency input only.
- "Learner privacy is not implemented" is obsolete:
  `privacy/learner_vault.py` (tokenization, HMAC-SHA256 `lrn_`
  tokens, educator-only lookup, per-tenant purge/wipe),
  `check_learner_data` refusing learner ops when the vault is not
  ready, and the `LearnerDataGated` refusal on the raw HTTPS lane are
  implemented and selftested (15/15 vault, 64/64 source privacy,
  30/30 deidentification, 2026-09-21).
- New Quiz delete orphan 506477: resolved by evidence 2026-09-21
  (delete is a live-proven path; see SCOPE.md). Module-item delete
  (C-271) is pending, not live-proven.
- Item Bank unshare (IB-20): live-proven 2026-09-21 (share 38934
  removed, list verified clean).
- `canvas_create_new_quiz` (C-286): provider-path live-proven, but
  the admission policy holds it on evidence-hold and dispatch
  refuses it on every tenant. It is not an admitted capability.
- The runtime pack (`pack/pack.json`) is now version 0.3.0 with an
  empty entry list (the 2 unverifiable external pins were removed,
  2026-09-21), not a 2-entry stub.

## Catalog counts (the baseline for every row below)

| Measure | Desktop | Muse deploy |
|---|---|---|
| Canvas REST catalog operations | 1137 in `artifacts/canvas-api/canvas-api-catalog.json` (1118 official REST + 18 Item Bank + 1 course-file-content) | 435 Canvas rows in `proof-battery/OPERATION_CATALOG.md` (223 writes, 212 reads) |
| Desktop admission of the 566 writes | 245 admitted (229 by course path, 16 by semantic course target); 321 held | No admission engine exists; every cataloged op is dispatched if called |
| Held-by-reason (desktop) | 117 account_authority_required, 100 course_scope_required, 48 cross_course_object_requires_resolution, 36 learner_scope_requires_separate_authority, 9 provider_contract_incomplete, 6 self_scope_not_supported, 4 multi_step_upload_requires_reviewed_transfer, 1 duplicate_assignment_exact_readback_unavailable | N/A (no hold classes) |
| Item Bank operations | 18, identical tool names | 18 rows, identical tool names, full tool-name parity |
| Moodle browser catalog operations | 250 in `connector/extension/generated/moodle-browser-catalog.json` | 250 rows, exact tool-name parity, zero diffs both directions |
| New Quiz launch sequence | desktop: 14 `/api/quiz/v1` ops in catalog + service-worker response evaluators | 14 `/api/quiz/v1` rows + 8-row NQS live sequence table |
| Muse catalog row statuses (711 rows) | n/a | 679 pending, 19 live-proven, 8 excluded, 2 tenant-restricted, 3 unsupported; 172 rows flagged `[LEARNER-DATA]` |

Status vocabulary: `ported-and-proven` (live receipt), `ported-but-unproven` (code exists,
no live receipt), `missing` (no counterpart), `intentionally-inapplicable` (deliberately not
ported for stated architectural reasons).

---

## 1. Operation catalogs and dispatch coverage

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Canvas REST operation catalog (machine-readable) | `packages/canvas-api-catalog/src/index.ts` + `artifacts/canvas-api/canvas-api-catalog.json` (1137 ops) | `proof-battery/OPERATION_CATALOG.md` (prose table, 711 rows); NO catalog JSON ships in the deploy tree | ported-but-unproven | high | Ship a machine-readable catalog JSON in the deploy tree generated from the same source, or executor `catalog` dispatch stays an unpinned free-form CLI |
| Admission engine (which writes may be sent) | `packages/canvas-api-catalog/src/operation-admission.ts` (`canvasOperationAdmission`, 8 hold reasons) | NONE | missing | critical | Build the Muse admission gate before any broad write rollout; without it the catalog's 223 write rows are all dispatchable including learner-scope and cross-course routes the desktop deliberately holds |
| Semantic course-target resolution (prove the course owns the object before writing) | `packages/canvas-api-catalog/src/semantic-target.ts` | NONE | missing | critical | Port or replace the connected-tab ownership read for sections, groups, files, calendar events, outcomes, appointment groups; the Muse catalog carries these families (calendar_events 3, sections 3, group_categories 6, groups 2, files 14) with no ownership proof |
| Readback planner (per-write postcondition + recovery reads) | `packages/canvas-api-catalog/src/readback-plan.ts` (`planBrowserReadback`, `planCanvasRecoveryDescriptor`; report: 163 structurally_exact, 59 unavailable, 23 blocked) | `dispatch/executor.py` verify block (frozen_readback with expect assertions, per manifest) | ported-but-unproven | critical | The verify block covers only the 2 pack manifests; a catalog-wide readback planner (or a proven verify block per write op) is missing; unresolved-write recovery reads exist only as desktop code |
| New Quiz response-bound readbacks | `operation-admission.ts` `NEW_QUIZ_RESPONSE_BOUND_READBACKS` (3 ops) + service-worker evaluators | NONE (NQS sequence proves specific flows, not the evaluator bindings) | missing | high | Port the three response evaluators (course/quiz accommodations, New Quiz report create) before those ops leave pending |
| Account/LTI/developer-key routes | cataloged + held (`account_authority_required`, 117 ops) | NONE (not in Muse catalog at all) | intentionally-inapplicable | low | None; correctly excluded, since Muse runs with educator authority only. Do not add them without an account-authority consent model |
| Catalog dispatch path | `packages/mcp-server/src/operation-tools.ts` (gated by admission + approval) | `dispatch/executor.py` `dispatch_catalog_op` (CLI: name/method/path, no admission, no catalog pin) | ported-but-unproven | high | Wire dispatch to a pinned catalog and the admission gate; today any name/method/path string can be dispatched |
| Moodle catalog | `connector/extension/generated/moodle-browser-catalog.json` (250) | `proof-battery/OPERATION_CATALOG.md` (250, exact tool-name parity) | ported-but-unproven | high | Rows are content parity only; executor coverage is 2 live-proven ops (M-9, M-165). See section 9 |

## 2. Learner privacy

**Plain statement: Muse learner tokenization is NOT integrated.** The desktop vault,
roster, free-text redaction, and output projection have no Muse counterpart. The catalog
correctly flags 172 rows `[LEARNER-DATA]` as "not live-tested until learner tokenization
lands", but that flag is a prose annotation, not an enforced gate; nothing in code stops a
learner-scope op from being dispatched today.

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Learner vault (encrypted at-rest identity store) | `packages/gateway-core/src/privacy.ts` (`LearnerVault`, AES key file, 64MB/100k-entry caps) | NONE | missing | critical | Build the vault before any learner-data op runs; today there is no place to keep the identity map |
| Learner roster + free-text redaction (alias matcher, grapheme segmentation, percent-escape handling) | `privacy.ts` (`LearnerRoster`, `redactLearnerEgress`, `redactKnownLearnerTextPrepared`) | NONE | missing | critical | Port the redaction pipeline; key-pattern masking does not catch names/IDs inside free text |
| Output projection / deny-all descriptor | `privacy.ts` (`projectOutput`, `DENY_ALL_OUTPUT`, `ArtifactGenerationRegistry`) | NONE | missing | high | Port projection before returning learner-bearing results to the agent |
| Token resolution (tokens back to identities for authorized views) | `privacy.ts` (`resolveLearnerTokens`, `snapshotLearnerToken`) | NONE | missing | high | Needed for any educator-visible view of tokenized data |
| Key-pattern redaction of receipts | n/a (desktop does this plus the above) | `dispatch/executor.py` `redact_payload` (regex on key names, `[redacted]`) | ported-but-unproven | medium | Keep, but do not present it as learner privacy; it masks `Authorization`-shaped keys only |
| Moodle learner privacy in the browser | `connector/extension/src/moodle-privacy.js` | NONE | missing | high | Same gap on the Moodle lane; learner reads (submissions, grades, participants) have no redaction |
| Protected request roster (per-request identity list validation) | `connector/extension/src/protected-request.js` | NONE | missing | medium | Port if per-request identity scoping is required |

## 3. Batch engine behavior

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Batch render + result parse | `packages/batch-engine/src/index.ts` | `transport/batch.py` (`render_brief`, `parse_results`, `split_batches`, max 15 ops) | ported-but-unproven | high | The mechanism is live-proven (assignment lifecycle 4045368 via batchA/batchB), but the catalog states it is "not yet integrated behind dispatch/executor.py"; integration is the gap |
| Durable batch store (SQLite, encrypted args, crash recovery) | `packages/batch-engine/src/index.ts` (`DurableBatchStore`), `recovery.ts` (`recoverBatchState`) | NONE | missing | high | No durable batch state; an interrupted batch leaves no resumable record |
| Batch modes (read_only / stage_writes), concurrency (8 read / 4 write), rate policy, course-set resolution | `packages/batch-engine/src/index.ts` | NONE | missing | medium | Port before multi-course or high-volume use; current Muse batches are single-course, sequential, agent-paced |
| Source settlement + result binding artifacts | `packages/batch-engine/src/settlement.ts`, `canvas-result-binding.ts` | NONE | missing | medium | No result-binding artifacts; Canvas-saved-byte proof exists only ad hoc in wave1 evidence |
| Batch selftest | desktop test suites | `transport/selftest.py` (render/parse/state checks, no browser needed) | ported-but-unproven | low | Fine as-is; add live round-trip selftest behind the browser task when integration lands |

## 4. Operation journal and duplicate-op handling

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Effect journal with state machine | `packages/operation-journal/src/effect-broker.ts` (`ProviderEffectBroker`: awaiting_approval to verified, SQLite, approval TTL, authority snapshots, `correctionOf`, `attention` flags) | `dispatch/executor.py` `journal_append` to `~/.morrow/journal/ops.jsonl` (append-only JSONL) | ported-but-unproven | high | JSONL journal has no state machine, no approval records, no authority snapshots; decide whether the SQLite broker is needed for production use |
| Duplicate-op refusal | broker-level reservation (`DispatchReservationOptions`) | `dispatch/executor.py` used-op-id set derived from the journal (`DuplicateOpId`) | ported-but-unproven | medium | The executor docstring itself admits this is a best-effort client-side guard with no server-side protection against race, crash, or tamper; acceptable only if a single operator runs it |
| Deploy-tree journal dir | n/a | `journal/` in the deploy tree is EMPTY by design (executor writes to `~/.morrow/journal/`) | intentionally-inapplicable | low | Documented in DEPLOY.md; no action, but operators must know the real journal is outside the deploy tree |

## 5. Frozen plans, readbacks, undo, retry, uncertain-write reconciliation

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Frozen plans | `packages/batch-engine/src/index.ts` (`FrozenBatchManifest`), `effect-broker.ts` (`FrozenReadbackPlan` with expectedDigest) | `dispatch/executor.py` `FrozenPlan` (op_id, entry_name, params, before_state_digest, frozen_readback) + `expected_digest` concurrency check | ported-but-unproven | high | Semantics ported in code; no live receipt in the deploy tree shows a frozen plan refusing a moved state |
| Frozen readback after writes | `readback-plan.ts` + generated `canvas-readback-plan.js` | executor verify block (`expect` assertions against response paths) | ported-but-unproven | high | Only 2 pack manifests carry verify blocks; no catalog-wide coverage |
| Undo | `effect-broker.ts` `correctionOf`, desktop undo semantics | executor: "an entry's undo block runs as a new, separately journaled operation" | ported-but-unproven | medium | Code claim only; no undo receipt in the deploy tree |
| Retry discipline | desktop retry policy in executors | executor: exponential backoff with full jitter, 4 attempts, 30s timeout, retryable 408/429/500/502/503/504, fail-fast on other 4xx, writes never retried blindly after uncertain | ported-but-unproven | medium | Code claim only; acceptable shape, needs a live receipt |
| Uncertain-write reconciliation | `readback-plan.ts` `planCanvasRecoveryDescriptor` (retained recovery reads; never resend) + broker `applied_or_unknown` state | executor `UncertainWrite` exception: "the op is journaled as uncertain for reconciliation" | missing (second half) | high | The journaling half exists; the reconciliation worker that later checks the retained reads does not. An uncertain op today is recorded and then sits |
| Recovery descriptors for POSTs (collection retained to detect double-create) | `readback-plan.ts` (parent collection retained for POSTs) | NONE | missing | medium | Without it, a retried POST after an ambiguous response cannot be checked for a duplicate |

## 6. Canvas REST catalog admission and readback plans (provision/, lanes/)

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| New Quiz LTI provisioning chain | `connector/extension/src/item-bank-credential.js` (10-min credential, memory-only, exact tab/frame/origin/nonce checks) | `provision/provision.py` (5-step chain: CDP in-tab wrapped-token mint, banks-page `window.ENV.NEW_QUIZZES` parse, native launch on quiz-lti host, `banks.build` token, quiz-api calls with raw token + `AuthType: Signature` header) | ported-and-proven | critical | Proven live 2026-09-20 (DRESS-REHEARSAL.md, quiz_battery_results.json). Note the failure modes are documented: fail-closed on native-AMS tenants, no plain-ServicesJwt fallback |
| Credential TTL + caching | 10-minute max age, cleared after op | 60-minute TTL on the provisioned pair, `cached_pair_fresh` | ported-but-unproven | medium | Different policy than desktop; confirm 60 minutes is acceptable to the tenant |
| Lane detection (PAT vs session) | n/a (desktop has one signed-in-Chrome path) | `lanes/detect.py` (`decide`: New Access Token button vs disabled hints vs inconclusive) | ported-but-unproven | medium | No live receipt in the deploy tree; logic is sound but unverified against a real settings page |
| Manifest metadata hygiene | n/a | `provision/manifests/*.json` reference `~/workspace/morrow-for-muse/provision/provision.py` while `executor.py` resolves to the deploy sibling | ported-but-unproven | low | Fix the stale `implementation`/`via` strings in the two manifests so the pack is self-describing |

## 7. New Quiz payload contracts and native-launch flow

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Native launch flow | `item-bank-credential.js` + `item-bank-frames.js` | `provision/provision.py` steps 1-5; NQS-1..NQS-5, NQS-8 live-proven (assignment 4045366, quiz 506477, quiz-api assignment 507872) | ported-and-proven | critical | Proven; keep the fail-closed contract |
| Quiz item payload validation (per interaction type) | `connector/extension/src/quiz-item-payload.js` (1046 lines: Multiple Choice, Matching, Categorization, Formula, Ordering, Hot Spot, etc.; UUID/scoring/feedback checks; accessibility rules: no undescribed `<img>`, https-only media) | NONE (wave1 evidence chunks are ad-hoc per-run JS) | missing | high | Port the payload contract before any New Quiz item create/update leaves pending; wave1 chunk17 shows a malformed PATCH 400ing server-side, which is the server catching what the client should have refused |
| New Quiz write contract (JSON body detection, settings merge groups, settings digest) | `connector/extension/src/new-quiz-write-contract.js` | NONE | missing | high | The settings-block rule (send the complete block, never partial) has no Muse equivalent |
| Classic quiz question contract | `packages/canvas-api-catalog/src/classic-quiz-question-contract.ts` | NONE | missing | medium | No classic-quiz repair path in Muse |
| Quiz delete / archive | desktop: delete held to reviewed paths; N/A | NQS-6 unsupported (DELETE 401s on quiz.build token; quiz 506477 orphaned), NQS-7 unsupported (no archive action in the served bundle) | missing | high | Orphan acceptability is Braden's pending call; without delete or archive, quiz creation leaves undeletable objects |
| `/api/quiz/v1` Canvas ops (C-286..C-299) | cataloged, response-bound readbacks | cataloged, all pending; C-286 tenant-restricted (direct create 401s; proven path is assignment-create + native launch) | ported-but-unproven | high | Prove or restrict each of the 14; C-286's restriction must be enforced in code, not just noted |

## 8. Item Bank lifecycle, sharing, item, and quiz-link operations

All 18 desktop Item Bank ops exist in Muse with identical tool names (full parity of the
catalog surface). Live-proven: IB-1 (archive_bank), IB-4 (attach_item), IB-5 (create_bank),
IB-9 (get_bank), IB-12 (list_banks), IB-13 (list_entries). The rest are pending or
unsupported.

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Bank lifecycle (create/rename/archive) | catalog + `item-bank-executor.js` | `provision/manifests` + quiz-api-token lane; IB-1/IB-5 proven | ported-but-unproven | high | Rename (IB-16) still pending |
| Item create/update | catalog + `item-bank-executor.js` | IB-6, IB-18 pending (wave1 chunk6b/6c/17 ran ad-hoc, not through dispatch) | ported-but-unproven | high | Route through dispatch with frozen plans and readbacks before claiming |
| Entry attach/delete, quiz-entry attach/delete | catalog | IB-2, IB-3, IB-7, IB-8 pending | ported-but-unproven | medium | Prove through dispatch |
| Share bank | catalog (`canvas_item_bank_share_bank`) | IB-17 marked **unsupported**: "claimed live, never attempted" (delta-2 blocker) | missing | high | Attempt honestly or keep unsupported; the earlier "claimed live" must not be repeated |
| **Delete item** (`DELETE /api/banks/{id}/items/{item_id}`) | NOT in desktop catalog | NOT in Muse catalog | missing (both) | medium | Define the op explicitly; wave1 chunk17 shows a `delete_item` 200 whose semantics are unclear (see below) |
| **Unshare** (remove a share) | NOT in desktop catalog (LIMITATIONS.md: "changing or removing an existing share are all absent") | NOT in Muse catalog | missing (both) | medium | Explicit product gap inherited from desktop; shares are currently irrevocable through Morrow |
| Readback correctness for bank reads | `item-bank-executor.js` rereads inside the Item Banks frame | Wave1 evidence shows anomalous server behavior | ported-but-unproven | critical | See anomalies below; readbacks must be designed around them |

**Wave1 evidence anomalies** (`proof-battery/evidence/nq-item-bank-wave1/`), all live-observed
2026-09-20 and directly relevant to readback design:

1. `GET /api/banks/4042/items/{item_id}` returns **404** while `PATCH` on the same path
   returns **200** with the rename applied (chunk9-result.json: `get_item` 404, `update_item`
   200 "Weasel Proof Item RENAMED"). Item identity and entry identity are different ID
   spaces (item 11242725 vs bank_entry 82699); a GET-after-write readback addressed by the
   wrong ID proves nothing.
2. Archive and delete are **soft**: after `DELETE` (204), `GET` on the deleted entry still
   returns **200** (`read_deleted_entry` 200, `deleted_entry_get` 200); after archive,
   `GET /api/banks/4042` returns 200 with `archived: true`, and the bank is absent from the
   list. A readback that treats "GET still 200" as "not deleted" will misreport; absence
   must be proved via the list endpoint.
3. There is no defined delete_item or unshare op, so cleanup of items and shares has no
   governed path at all.

## 9. Moodle 250-operation browser catalog and executors

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| 250-op catalog | `connector/extension/generated/moodle-browser-catalog.json` | `proof-battery/OPERATION_CATALOG.md` M-1..M-250 (exact tool-name parity, zero diffs) | ported-but-unproven | high | Catalog rows only; executor coverage is the gap |
| AJAX + form-path executors | `connector/extension/src/moodle-*.js` (~30 executors + readers: forum, gradebook, lesson, workshop, qbank, SCORM, enrolment, etc.) | `moodle/session.py` (AJAX envelope + form fallback), `login.py`, `probe.py`, `reauth.py` | ported-but-unproven | high | Only M-9 and M-165 live-proven (forum discussion create/delete via form path); AJAX variants are **unsupported** on stock Moodle 5.2 (proven by behavioral probing, not assumed) |
| Capability probing (`allowed_from_ajax`) | desktop fixture knowledge | `moodle/probe.py` (live behavioral probe per function) | ported-but-unproven | medium | Good design; keep the probe as the source of truth per tenant |
| Moodle reauth state machine | n/a (browser session persists in the user's Chrome) | `moodle/reauth.py` (detect/halt/notify/re-sign-in/resume + drill) | ported-but-unproven | medium | Drill exists; no live dead-session recovery receipt |
| Moodle learner-data ops | cataloged, desktop `moodle-privacy.js` redaction | catalog rows exist (Moodle learner-data section); NO redaction | missing | high | Same tokenization gap as Canvas; see section 2 |
| Doc drift | n/a | `moodle/README.md` describes `proof_run.py` and a `journal/` dir that do not exist in the deploy tree (they live under `~/workspace/morrow-for-muse/moodle/`) | n/a | low | Fix the README paths or vendor the files |

## 10. Browser/session capture and reauthentication

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Authenticated execution context | Chrome extension in the user's own browser (`fetch` with `credentials: "include"`) | Two competing models (see conflict below) | n/a | critical | Resolve the conflict before production |
| Model A: browser-task transport (no credential exposure) | n/a | `transport/batch.py` + `transport/state.py` (metadata only, refuses credential-shaped keys); live-proven 2026-09-20 | ported-and-proven | critical | This is the architecturally endorsed lane per `transport/README.md` |
| Model B: cookie capture + HTTPS replay | n/a | `session/capture.py` + `session/cdp.py` (helper /cdp/* proxy, W4-P0-3: no TCP CDP; session-cookie heuristic, live CSRF from `document.cookie` in an isolated world, principal verification) + `dispatch/executor.py` `canvas_session` slot | ported-but-unproven | critical | **Conflict:** `transport/README.md` declares this model RETIRED (OTP-walled on CHCP tenants; violates no-exposure), while `capture.py` still calls itself the "source of truth" and the executor still implements cookie replay. One of them must go |
| Canvas reauth state machine | n/a (user's browser session persists) | `reauth/state_machine.py` (expiry classification, write_halt ownership, quarantine, notify, re-sign-in, principal-pinned resume; selftest present) | ported-but-unproven | high | Selftest receipt exists (`proofs/reauth_selftest_receipt.txt`); no live dead-session recovery receipt |
| QR mobile-login proof | n/a | `qr-proof/` (attempt 1 blocked at `mobile_verify`: `authorized: false`) | ported-but-unproven | low | Negative result is correctly recorded; the QR path is not a working lane |

## 11. Bridge responsibilities that must be replaced in Muse

The desktop bridge (`packages/bridge-protocol`, `packages/bridge-loopback`,
`connector/extension/src/bridge-transport.js`, `packages/legacy-bridge-mcp`) is a localhost
HTTP server with HMAC challenge auth, versioned schemas, bindings, and catalog-digest-bound
edit permissions. Muse has no bridge by design. What the bridge did that Muse must do
differently:

| Bridge responsibility | Desktop source | Muse replacement | Status | Criticality |
|---|---|---|---|---|
| Transport between assistant runtime and the browser | `bridge-transport.js`, `bridge-protocol/src/index.ts` (BRIDGE_PROTOCOL_VERSION 1, 2MB message cap) | Browser tasks (`transport/batch.py`) for Canvas REST; CDP for provisioning | ported-but-unproven | high |
| Edit permissions bound to catalog digest (selection limit 500, conversational edit 30 min, max 24 h, per-category grants) | `connector/extension/src/edit-policy.js` (`createEditPermission`, `validEditPermission`, `guardedItemBankUpdate`) | NONE (frozen plans + `write_halt` + prose consent) | missing | high |
| Edit access request/grant flow | `packages/mcp-server/src/edit-access.ts` | NONE | missing | medium |
| Credential isolation (Item Bank token memory-only, tab closed after op) | `item-bank-credential.js` | `provision.py` transients (never persisted; build token 60-min TTL) | ported-but-unproven | medium |
| Private attachments over the bridge | `bridge-protocol` (1MB cap, base64) | NONE | missing | low |

## 12. MCP responsibilities intentionally absent from Muse

Muse is a no-MCP product by architecture (Morrow Direct manifest standard, zero MCP). The
following desktop `packages/mcp-server` responsibilities are deliberately not ported:

- MCP stdio transport and server lifecycle (`server.ts`, `strict-stdio.ts`, `full-server.ts`)
- Native tool manifest and upstream MCP clients (`native-tool-manifest.ts`, `packages/upstream-mcp`, `sandbox-upstream.ts`)
- Third-party MCP upstreams (`morrow.upstreams.*.example.json` connection profiles)
- Source attestation and publication policy (`source-attestation.ts`, `publication*.ts`, `exact-trust-file.ts`)
- Loopback approval server and review platform (`approval-server.ts`, `approval-entry.ts`, `approval-preview.ts`, `approval-context.ts`)
- Private chat channel (`private-chat.ts`), local-owner sidecars (`local-owner*.ts`), Meridian adapters (`meridian-*.ts`)
- Program ledger (`program-ledger.ts`), server instructions (`server-instructions.ts`)
- Blackboard Learn REST package (`packages/blackboard-learn-api`, 17 operation files): no live tenant was ever tested (desktop LIMITATIONS.md); out of scope for a Canvas/Moodle product

The one MCP-side responsibility that is NOT safely droppable is **approval as code**:
desktop approvals are recorded grants with TTL in the effect broker. Muse replaces this with
frozen plans, the reauth-owned `write_halt`, and prose consent (see section 13). That is a
weaker, non-equivalent control and is tracked as a gap in section 13.

## 13. Setup, consent, revocation, credential isolation, private-state handling

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Setup guide | `installer/` (Electron, per-OS builds, smoke-tested) | `content/setup-guide.md` | ported-but-unproven | medium | Prose only; no installer, no smoke test, no versioned release artifact |
| Consent | `connector/extension/src/course-data-consent.js` (per-course consent key, enforced in code) | `content/consent.md` (plain-language, includes Meta training-data default disclosure) | ported-but-unproven | high | **No Python file in the deploy tree references consent.** The consent text is not wired to any gate; writes do not check it. Wire consent to the dispatch path or stop presenting it as a control |
| Revocation | n/a (browser session ends with the browser) | `content/revoke.md` (token path: delete integration; session path: log out) | ported-but-unproven | medium | Correct instructions; verify the "Morrow for Muse" integration row name matches what the PAT lane actually creates |
| Credential isolation | extension memory-only; `item-bank-credential.js` never writes tokens to storage | `~/.morrow/session.json` (0600), `browser_lane.json` (0600), secret rejection in `transport/state.py`, executor never logs secrets | ported-but-unproven | high | Resolve the Model A/B conflict (section 10): Model B holds raw cookie values on disk, which `transport/README.md` says the product must never do |
| Private-state hardening | `packages/gateway-core/src/private-state-file.ts` (transaction-locked files, PID-verified owners), `private-sqlite-state.ts`, `private-file-access.ts` (macOS/Windows ACL hardening), `process-lifetime.ts` | 0600 JSON files with atomic `.new`+rename writes and a mode check on load | ported-but-unproven | medium | No transaction locks, no ACL hardening, no PID ownership; fine for single-operator use, insufficient for shared machines |
| Secrets in state | vault key files, exact byte limits | `_reject_secrets` refuses credential-shaped keys in lane state | ported-but-unproven | low | Good; extend the same rejection to every state file write path |

## 14. Anything else desktop-only, not ported or explicitly rejected

| Feature | Desktop source path | Muse counterpart (path or NONE) | Status | Criticality | Required remediation |
|---|---|---|---|---|---|
| Reviewed course-file transfer (freeze file, 3-step upload, saved-byte comparison) | `connector/extension/src/canvas-file-transfer.js`; admission holds the raw preflight route until this transfer exists | NONE (`transport/batch.py` fields are strings; no binary path) | missing | high | Any file-upload claim is currently false; build the reviewed transfer or keep uploads excluded |
| Course file/folder semantic operations (rename/move/remove with ownership proof) | LIMITATIONS.md contract + `canvas-file-content.js`, `canvas-file-signals.js` | NONE | missing | medium | The Muse catalog carries a files family (14 ops) with no ownership proof and no transfer path |
| Aggregate summary reads (submission/gradebook/activity summaries, file signals) | `connector/extension/generated/canvas-browser-catalog.json` (5 ops), `canvas-course-summary-read.js` | NONE | missing | low | Explicitly out of the Muse catalog; fine if the exclusion is deliberate |
| Conversations (messaging) | cataloged, writes held (`canvas-conversations.js` executor) | NONE (no conversations section in the Muse catalog) | intentionally-inapplicable | low | Correctly excluded; desktop holds these writes too |
| Course audit / inventory | `packages/mcp-server/src/course-audit.ts`, `course-inventory.ts` | NONE | missing | low | Nice-to-have; not load-bearing |
| Lesson review, page correction, quiz check tools | `lesson-review.ts`, `page-correction.ts`, `quiz-check.ts` | NONE | missing | low | Product features, not safety controls; schedule as features |
| Item bank fan-out (which quizzes use a bank) | `item-bank-fan-out.js` (+ LIMITATIONS.md: always incomplete, no authoritative reverse lookup) | REMOVED 2026-09-21 (W3-P2-21): `provision/manifests/morrow_read_item_bank_fan_out.json` deleted; item bank reads moved to the live Item Banks SDK lane (`transport/item_bank_sdk.py`) | superseded-by-sdk-lane | medium | Keep the "observed uses only, always incomplete" caveat from desktop LIMITATIONS.md in the Muse readback notes |
| Bank draw / quiz-entry executors | `quiz-bank-draw-executor.js` | NONE (IB-2, IB-3 pending) | missing | medium | See section 8 |
| Edit-policy migration of legacy permissions | `edit-policy.js` `migrateLegacyEditPermission` | NONE | intentionally-inapplicable | low | No legacy permissions exist in Muse |
| Batch window scheduler | `batch-window-scheduler.ts`, `batch-recovery.ts` | `bin/scheduler.py` + keepalive scripts (session keepalive, not batch windows) | ported-but-unproven | low | Different purpose; do not confuse the two |

---

## Prioritized remediation list

1. **Resolve the session-model conflict (critical).** `transport/README.md` retires cookie
   capture; `session/capture.py` and `dispatch/executor.py` still implement it. Pick one:
   either delete Model B from the deploy tree or rescind the retirement. Until then the
   product ships two contradictory credential postures.
2. **Build the admission gate (critical).** Port `operation-admission.ts` (or a Muse-native
   equivalent) so the 223 cataloged writes are not all dispatchable. Minimum viable: hold
   learner-scope routes, account routes, cross-course object routes, and the file-upload
   preflight, exactly the desktop hold classes.
3. **Land learner tokenization before any learner-data op runs (critical).** The 172
   `[LEARNER-DATA]` rows are flagged but not gated. Port the vault + roster + free-text
   redaction + output projection from `packages/gateway-core/src/privacy.ts`; key-pattern
   masking is not a substitute.
4. **Add the semantic course-target ownership proof (critical).** Sections, groups, files,
   calendar events, and outcomes in the Muse catalog need the connected-tab ownership read
   the desktop requires, or those families must be restricted to plain course-path routes.
5. **Build the uncertain-write reconciliation worker (high).** `UncertainWrite` is journaled
   and then abandoned; port `planCanvasRecoveryDescriptor` and a worker that checks the
   retained reads without resending.
6. **Port the New Quiz payload contract (high).** `quiz-item-payload.js` and
   `new-quiz-write-contract.js` before item create/update leaves pending; the complete-settings-block
   rule has no Muse equivalent.
7. **Decide the quiz-delete/orphan question (high).** NQS-6/NQS-7 are unsupported and quiz
   506477 is orphaned; Braden's call is pending. Do not create more quizzes until the
   delete path or the orphan policy is settled.
8. **Fix Item Bank readback semantics (high).** Design readbacks around the proven
   anomalies: GET-after-PATCH 404 vs PATCH 200 (ID-space confusion), soft-delete GET-still-200
   (prove absence via list), and define delete_item and unshare explicitly instead of
   leaving them absent.
9. **Wire consent to code (high).** `content/consent.md` is currently unenforced prose; no
   dispatch path checks it.
10. **Integrate the browser-task transport behind the executor (high).** The mechanism is
    live-proven but the catalog notes it is "not yet integrated behind dispatch/executor.py";
    today the executor only speaks PAT/cookie HTTPS.
11. **Attempt or formally drop bank sharing (high).** IB-17 was "claimed live, never
    attempted"; unshare does not exist in either product.
12. **Extend Moodle executor coverage (high).** 250 catalog rows, 2 proven ops; every
    additional family needs its executor plus its behavioral probe result.
13. **Port the reviewed file transfer (high).** No binary upload path exists; the desktop
    deliberately holds the upload preflight until it does.
14. **Replace bridge edit permissions with a Muse-native equivalent (medium).**
    Catalog-digest-bound, time-boxed, category-scoped grants have no counterpart; frozen
    plans plus `write_halt` are weaker.
15. **Hygiene (low):** fix stale `~/workspace/morrow-for-muse/...` paths in pack manifests;
    fix `moodle/README.md` references to `proof_run.py`/`journal/`; ship a machine-readable
    catalog JSON; record the "observed uses only" fan-out caveat.

## What cannot be claimed as seamless or complete

- **Catalog parity is content-only.** The Muse catalog lists 711 operations, but 679 are
  pending, 19 are live-proven, and the machine-readable catalog plus the admission engine
  that make the desktop catalog safe do not exist in Muse.
- **Learner privacy is not implemented.** Stating that learner data is protected would be
  false: tokenization, the vault, free-text redaction, and output projection are all absent,
  and the `[LEARNER-DATA]` flags are unenforced annotations.
- **The no-PAT lane is proven for a narrow path, not the product.** Proven: browser-task
  transport for Canvas REST (assignment lifecycle), the 5-step LTI provisioning chain, the
  New Quiz launch sequence, Item Bank bank/entry lifecycle, and 2 Moodle forum ops. Not
  proven: executor-integrated dispatch, 679 pending catalog ops, Moodle executor breadth,
  reauth recovery, consent enforcement, or any learner-data flow.
- **Delete is not a complete story.** New Quiz delete 401s (orphan 506477), Item Bank
  archive/delete are soft with anomalous readback behavior, and delete_item and unshare
  are undefined in both products.
- **The credential posture is internally contradictory** until the Model A/B conflict in
  section 10 is resolved; the product cannot claim a single no-exposure story today.
