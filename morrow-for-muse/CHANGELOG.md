# Changelog

## 0.4.0 (2026-09-22)

Release: `morrow-muse-connector-0.4.0.zip` from the `muse/v0.4.0`
GitHub release. This release fixes every Critical and High defect
found in the adversarial audits after 0.3.0.

In plain words:

- Every write path goes through the mode gate (discovery, pack
  override, and undo included), and only live-proven operations run.
  Undo is its own approved write, bound to the journaled operation.
- An approval binds the exact method, path, query, and body, and the
  vault token of each student label it names. Any non-empty educator
  reply approves. The typed `plan-write` and `approve-write` commands
  run the ceremony.
- The phrase parser is gone. The agent calls typed `mode`, `settings`,
  `query`, and `students` commands. Edit mode is one untimed grant,
  and turning it off means Plan everywhere. Conversation overrides
  last.
- Work with students by name: `morrow students find` asks the
  educator when a match is unsure, the model sees only labels, a write
  by label reaches the right student, and a name reveal is
  educator-only, for one course, short-lived, and never journaled in
  the clear.
- More learner data is labeled: ids inside URLs, SIS ids, bare user
  records, content editors, date details, smart search, and outcome
  alignments.
- Write verification has three honest outcomes: verified, failed (a
  proven wrong value), and uncertain (the readback could not confirm).
- The sign-in pin fails closed, and the Chromium lane refuses a Canvas
  account other than the pinned one. `disconnect` really disconnects.
  Keepalive supervision works without cron, and `stop` ends the whole
  loop.
- `install.sh` installs from a carved tree of this repository. The
  test suite never touches the real `~/.morrow`. The tree's packages
  are regular packages, so installed packages cannot shadow them.

The detailed notes below cover the work since 0.3.0.

### Privacy round 4: working by name, de-identified everywhere else (2026-09-22)

- Working by name (design chosen by the integrator): `morrow students
  find --course C "<name>"` (`learners/find.py`) resolves the name the
  educator typed to a course label; ambiguous or close-spelling
  matches list every candidate as a label with section, enrollment
  state, and last activity date, and are never auto-picked. A resolved
  name is echoed as "<typed name> (Student A3)" in that conversation
  only (`privacy/name_echo.py`, encrypted, ends with the conversation).
  Writes carry labels; the executor resolves them to real ids at the
  LMS boundary after the mode gate, only for the course the write
  targets, and relabels every journal record, result, and error.
- Live-proven people-bearing catalog rows now dispatch on the Chromium
  lane with the encrypted vault (receipts de-identified); they stay
  refused on the raw lane and without `cryptography`.
- The `educator_pii_reveal` consent file is retired (an agent could
  write it). The only reveal is a sealed educator record for one
  course, at most 30 minutes, journaled (`mint_pii_reveal`,
  `--pii-reveal`).
- Any URL path segment or query value equal to a rostered learner id
  is labeled (`/grades/<id>`, `/submissions/<id>`, `?student_id=`).
  `student_ids` arrays read back as labels. New labels follow a keyed
  order, not first-read (alphabetical) order.
- Page revisions with a teacher editor and assignment reads with an
  embedded submission project instead of failing closed.
- Write-verification failures carry only the projected detail to the
  agent, and failure journal records carry the projected receipt.
- Student-resolution errors no longer echo the educator's query; a
  fuzzy match is never auto-picked.
- Docs: SKILL.md teaches the by-name flow; FERPA_POLICY.md,
  privacy/README.md, knowledge/privacy-ferpa.md, SCOPE.md, and
  content/consent.md state plainly that names the educator types
  reach the Muse model and Morrow keeps every other identifier from
  the LMS out.

### Installer, carve, and packaging (Worker 4, 2026-09-21)

- `install.sh` rewritten (10 steps): integrity verification against
  `pack/carve-manifest.json`, version detection via `pack/version.txt`
  (0.3.0), timestamped tree backup outside the tree (excluding
  `helper/profile/`) on upgrade, stale-file removal with loud logging,
  failure rollback from backup, keepalive cron migration (exactly one
  entry for this tree, stale entries from other trees removed), secrets
  gate BEFORE helper launch, all 23 selftest suites, version/manifest
  record under effective `MORROW_HOME`. Reruns revalidate and reconcile
  state. `PYTHONDONTWRITEBYTECODE=1` and import probes from `/` prevent
  `__pycache__/` from tripping the secrets gate (W2-P0-14).
- `scripts/uninstall.sh` added: exact-PID signaling only (no pkill),
  cron removal verified mandatory (surviving entries resurrect the
  helper within 5 minutes), effective `MORROW_HOME` and
  `LOGIN_HELPER_PROFILE_DIR` honored, enumerated paths and freed ports
  verified.
- `pack/deny-list.txt` and `scripts/verify-no-secrets.sh` rewritten
  with NFKC normalization, invisible-character stripping, Greek/Cyrillic
  homoglyph folding, any-depth case-insensitive matching, Chromium-store
  variants, `.env*`/`*secret*`, JSON `canvas_session`/`remember_user_token`,
  and case-insensitive tenant extraction. Independent pinned policy at
  `~/workspace/carve-deny-list.txt`; carve refuses on mismatch.
- `pack/pack.json` entries emptied (14 unverifiable external pins
  removed); `pack/version.txt` added (0.3.0).
- `requirements-optional.txt` added (`cryptography==50.0.1`);
  `privacy/core.py` degrades gracefully without it (file-backed vault
  refuses with install instructions; in-memory vaults and redaction
  work normally).
- `carve-morrow-dist.py` rewritten: persistent staging, atomic
  publication, whole-line anchor enforcement, in-memory compile,
  all 8 suites run from staged dist with sandboxed HOME/MORROW_HOME,
  banner normalization, independent policy check, manifest generation.
- Documentation: `INSTALL.md` (10-step order, uninstall.sh, cron
  mandatory, 5-min reboot downtime, upgrade backup/migration/rollback,
  optional cryptography, empty pack entries), `SKILL.md`, `helper/README.md`,
  `helper/keepalive.sh` header (reboot downtime, mandatory cron removal).

### Journal integrity and claim authorization (W4-P0-1, W4-P0-2, W4-P2-6, 2026-09-21)
- Every journal record now carries a per-record HMAC (`rec_hmac`,
  HMAC-SHA256 over the canonical record body) keyed by a per-tree
  secret minted at `ops.secret` (0600, created atomically). The sidecar
  index is version 2 and HMAC-sealed (`index_hmac`); a forged or
  seal-stripped index is never trusted.
- All read paths verify the seal: edited, forged, or appended records
  raise `JournalIntegrityError` instead of being trusted. Deleted
  records are detected (journal shrinkage against the sealed index)
  and fail closed. A missing index alongside an existing journal, or a
  secret with no journal, also fails closed.
- Claim tokens are never written to the journal: pending-claim records
  store only `claim_token_hash` (SHA256). `recheck_claim`/`release_op_id`
  hash the presented raw token; a scraped hash cannot release a claim
  (refused as `DuplicateOpId`).
- Pre-HMAC journals fail closed on first open and point at the explicit
  upgrade step `python3 dispatch/executor.py journal-seal`, which adopts
  the current bytes as the trust anchor, seals records, hashes plaintext
  tokens, and rebuilds the index (it refuses to bless a record whose
  seal does not verify). `journal-repair` quarantines a torn tail and
  re-seals through the same adopt step. Both are CLI subcommands.
- The flock is documented as advisory only (a crash/race boundary, not
  a security boundary); the tamper boundary is the HMAC seal.
- New suite `dispatch/journal_integrity_selftest.py` (26 checks), wired
  into `install.sh` (now 9 suites).

### Form-relay lane removed (2026-09-21) The first-party static relay page
  on meetmorrow.app/morrow/form-relay/ was taken down and its source
  deleted (transport/form_relay.py, transport/form-relay/,
  transport/form_relay_selftest.py). Dead code: the live write path runs
  in the helper Chromium's page context (dispatch/executor.py chromium
  backend), so nothing called the relay anymore. transport/batch.py now
  fails closed on every form write (FormTransportUnavailable,
  unconditionally); the relay routing, relay_url parameter, and
  _render_relay_brief are gone from batch.py and
  transport/browser_backend.py. Proof-battery wave-1 renderer and briefs
  marked retired; defect-log relay items annotated historical. All 22
  source selftests pass (20
  `*_selftest.py` files, `transport/selftest.py`, and
  `helper/keepalive_selftest.sh`; count re-verified 2026-09-21, all
  exit 0). Measured suite counts
  (2026-09-21): keepalive 53 checks on the shipped copy (88 combined
  across both variants); privacy/source_privacy 69/69;
  privacy/deidentif 30/30; privacy/learner_vault 15/15;
  transport/item_bank_sdk 59; transport/local_chromium 31;
  dispatch/executor_write_hardening 124 checks PASS.

### Item Bank lane hardening (2026-09-21)
  `transport/item_bank_sdk.py`: quiz-lti frame detection now requires a
  structural quiz-lti hostname label (optionally tenant-bound), HTTPS,
  and exact frame-origin binding of the captured banks.build token
  response; Item Banks tool resolution refuses duplicate matches and
  validates tool url/domain against the tenant domain family; launch
  JS builds the course URL with a JSON-encoded course id; bank/item ids
  are boundary-validated (non-empty, single path segment). Dead
  `_SDK_ITEM_IDS_RE`/`sdk_item_ids` removed. `transport/local_chromium.py`
  `capture_network_response` gained an optional `expected_origin` pin
  (W3-P2-17). `transport/chromium_session.py`: SDK lane status 0 and
  3xx never return as success (reads retry/fail fast, writes go
  UncertainWrite; W3-P2-19). `dispatch/executor.py` readback derivation
  now covers Item Bank bank/item create and member reads with nested
  `{"bank":{"id"}}` / `{"item":{"id"}}` payloads (W3-P2-22). Catalog
  gains IB-20 `canvas_item_bank_unshare_bank` (PATCH, live-proven;
  count 19 to 20). `proof-battery/item_bank_sdk_battery.py` (development
  worktree script, not shipped in the dist) records a
  terminal item GET after DELETE, correlated with the pre-delete GET
  (W3-P0-14). W3-P2-25 (`canvas_item_bank_get_item` unsupported entry)
  awaits the dedicated live battery result: still open.

### Item Bank smoke script and fan-out manifest removed (2026-09-21)
  `bin/smoke_bank_lifecycle.py` and
  `provision/manifests/morrow_read_item_bank_fan_out.json` deleted
  (W3-P2-21). The smoke script was the pre-SDK live lifecycle proof;
  the fan-out manifest had a proven live executor lane, but its
  frozen-plan form is superseded by the live Item Banks SDK lane
  (`transport/item_bank_sdk.py`), which derives quiz-lti frame origins,
  binds the banks.build token to the validated frame origin, and
  validates bank/item ids at the boundary. Current Item Bank lifecycle
  proof is `proof-battery/item_bank_sdk_battery.py` (development
  worktree script, not shipped in the dist; now with a
  terminal item GET readback after DELETE, W3-P0-14). References
  reconciled: `dispatch/integration_selftest.py` (hygiene list),
  `DEPLOY.md` (runnable example now `morrow_check_new_quiz`),
  `audit/desktop-parity-audit.md`,
  `audit/DESKTOP_TO_MUSE_MATRIX.md`, `INTEGRATION_NOTES.md`.

Documentation corrections from the 2026-09-21 adversarial gap audit
(a set of documentation findings from that audit's docs lane; the
finding numbers are not defined anywhere in this tree, so they are
recorded here in plain language only). No code changed.

- `SCOPE.md` rewritten to claim only what the batteries prove: New
  Quizzes narrowed to quiz-object create/update/delete through the
  Chromium lane (no publish, no question items, provider path only);
  Item Bank bank-level operations (create, rename, share, unshare,
  archive, list) confirmed IN for v1 after the 2026-09-21 operator
  correction and the 2026-09-21 Chromium write battery (IB-5 create,
  IB-16 rename, IB-17 share+unshare, IB-1 archive; SCOPE.md's earlier
  "dropped" wording was superseded); item-level CRUD stays out/roadmap
  per the catalog; course narrowed to read/update (create never
  tested, delete/conclude on evidence hold); pages except front-page
  management (C-333 failed live); discussion and classic-bank
  lifecycles removed (unproven); the 114 live-proven reads kept as a
  v1 claim with the self-contradicting footnote removed (ships in v1 =
  live-proven rows).
- `SKILL.md`: admission gate now documented as enforcing the
  live-proven catalog with an educator-signed `--allow-unproven`
  override; session-death note fixed (retry needs a freshly signed
  approval plus re-sign-in; multi-step partial-effect gap documented as
  latent); Blackboard stated as roadmap, not a ship criterion.
- `pack/pack.json`: governance section added documenting catalog
  enforcement, the `--allow-unproven` override, and the disambiguated
  op-id rules (consumed op ids are never reused; unjournaled op ids
  stay reusable).

## 0.3.0 (2026-09-21)

First distributable connector: Chromium-only Canvas core.

- Carved from the Morrow for Muse source tree as the standalone
  `morrow-muse-connector`: the live-proven Canvas Chromium lane, the
  governed dispatcher, the admission gate, the login helper, and the
  proof evidence. Nothing else ships.
- Chromium-only lane: the transport (`transport/local_chromium.py`,
  `transport/chromium_session.py`, `transport/egress.py`,
  `transport/proxy_forwarder.py`) and dispatch (`--backend chromium`)
  are pinned in `pack/pack.json`. The Chromium profile resolves inside
  the tree (`helper/profile/`); no fixed developer path remains.
- Egress probe carries no real tenant fallback; the helper refuses to
  start on the placeholder until the educator sets `CANVAS_BASE`.
- `SKILL.md`, `INSTALL.md` (zero tribal knowledge, clean uninstall),
  `SCOPE.md` (exact v1 declaration), and this changelog are new.
- `install.sh` is new: idempotent, stdlib + shell only, locates
  Chromium, probes egress, creates only the safe `~/.morrow` layout,
  installs one deduped keepalive cron entry, re-runs all selftests,
  runs the secrets gate, and never writes secrets.
- `pack/deny-list.txt` and `scripts/verify-no-secrets.sh` are new: the
  packaging secrets gate (private keys, live credential values, SPKI
  pin literals, proxy credentials, account-specific defaults,
  non-example tenant URLs, runtime state artifacts, retired-lane
  dependencies).
- Seven selftest suites ship and pass: Chromium session, egress,
  executor, admission, executor write hardening, v1 integration, and the
  offline login-helper suite. Learner-tokenization and provision-lane
  tests skip loudly; those lanes are out of v1.
- Content pages (`content/`) carry an explicit v1 packaging note:
  their original two-lane mechanics are superseded by the
  Chromium-only v1; `INSTALL.md` is authoritative.
- Proof evidence (`proof-battery/OPERATION_CATALOG.md`,
  `defects/DEFECTS.md`) is carried forward as clearly-marked example
  output, not defaults or credentials.

## 0.2.x (internal)

Pre-packaging development line. The live proof campaign (Item Banks,
New Quizzes, Moodle sandbox, dress-rehearsal battery) and the
adversarial defect log were built on this line. No public distribution.

## 0.1.x (internal)

Two-lane prototype (direct REST plus the since-retired form relay).
Superseded: the form relay is retired and excluded from this package.
