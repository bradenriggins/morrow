# Morrow for Muse: Deployment Record

**Date:** 2026-09-20
**Deployed by:** Hermes (subagent)
**Directive:** Braden Riggins

## What was deployed

Morrow for Muse, the no-PAT Canvas/Moodle automation product, deployed as a
clean product-only tree. This is separate from Claude's desktop MCP version.

**Components:**
- Session capture (`session/capture.py`) and CDP support (`session/cdp.py`)
- LTI provisioning chain (`provision/provision.py`)
- Product manifest pack (`pack/pack.json`, version 0.3.0, entries intentionally empty)
- Dispatch executor and journal (`dispatch/executor.py`)
- Reauthentication state machine (`reauth/state_machine.py`)
- Lane detection (`lanes/detect.py`)
- Consent, setup, and revocation content (`content/`)
- Moodle session, login, probe, and reauth (`moodle/`)

**Excluded:** connector-verification, proof batteries, lab harnesses, audit
scratch, desktop MCP files, test-only helpers, Mac worktree material.

## Deployment location

`/home/hatch/workspace/morrow-for-muse-deploy/`

**Layout:**
- `bin/` - keepalive scripts, scheduler, smoke test
- `config/` - (reserved for educator config)
- `content/` - consent.md, setup-guide.md, revoke.md
- `dispatch/` - executor.py
- `journal/` - (legacy executor journal path; the live journal is
  per-tree under `~/.morrow/trees/<tree-id>/journal/`)
- `lanes/` - detect.py
- `logs/` - keepalive logs, scheduler log, smoke plans
- `moodle/` - session.py, login.py, probe.py, reauth.py
- `pack/` - pack.json (product manifest pack)
- `provision/` - provision.py, manifests/
- `reauth/` - state_machine.py
- `session/` - capture.py, cdp.py

**Session state:** `~/.morrow/session.json` (Canvas, principal 28206)
**Journal:** `~/.morrow/trees/<tree-id>/journal/ops.jsonl` (or
`$MORROW_TREE_STATE_DIR/journal/ops.jsonl` when overridden)
**Logs:** `~/workspace/morrow-for-muse-deploy/logs/`

## How to run it

### Session capture (first time)
```bash
cd ~/workspace/morrow-for-muse-deploy
python3 session/capture.py
# Educator signs in through the login helper page. capture.py attaches
# through the helper's token-authenticated /cdp/* proxy (W4-P0-3: no
# TCP CDP listener exists). No credentials are shared with the agent side.
```

### Provisioning (no-PAT LTI chain)
```bash
python3 provision/provision.py --course-id 89585
```

### Execute a manifest
```bash
python3 dispatch/executor.py execute \
  --entry provision/manifests/morrow_check_new_quiz.json \
  --params '{"course_id":"89585","quiz_id":"<new-quiz-assignment-id>","source_binding_id":"<binding>"}'
```

The static item bank fan-out manifest
(`provision/manifests/morrow_read_item_bank_fan_out.json`) was removed
2026-09-21 (W3-P2-21): item bank reads now run through the live Item
Banks SDK lane (transport/item_bank_sdk.py), not through a frozen
manifest. The remaining runnable entry is `morrow_check_new_quiz`.
```
### Reauth drill
```bash
python3 reauth/state_machine.py selftest
```

### Keepalive scheduler
```bash
bin/scheduler.py start    # start the daemon
bin/scheduler.py status   # check status
bin/scheduler.py stop     # stop
bin/scheduler.py run-once # test both keepalives now
```
**After a VM restart:** re-run `bin/scheduler.py start`. The scheduler is a
userspace daemon (no cron on this VM); only `/home/hatch` survives restarts.
The shipped product no longer needs this record's scheduler for the
helper: without cron, `install.sh` starts `helper/supervisor.py`'s
background loop, which runs `helper/keepalive.sh` every 5 minutes, and
`bin/morrow start` restarts it after a reboot.

## Fixes applied

### Fix A: Product manifest pack (0.2.4)
**Problem:** The execute CLI could not run the corrected LTI manifests.
**Root causes found and fixed:**
1. `pack.json` pinned stale 0.1.0 manifests using the retired
   `mint_service_jwt` step. Created product-only pack
   (`pack/pack.json`) pinning the corrected manifests.
2. Manifests used prose discovery picks ("First tool whose..."). Added
   structured discovery-pick support to the executor
   (`response_path`, `first_where_contains`, `project`, `replace`).
3. **OTP wall:** The discovery block did a raw-HTTPS Canvas API call with
   session cookies, which 302s to `/login/otp` on this tenant. Removed the
   discovery block; the PROVISION step now binds `quiz_api_host` (derived
   from the tenant via the proven pattern) and the build token.
4. **Broken capture map:** Manifests had prose descriptions instead of
   provision-result keys, so the token bound to `None`. Fixed to
   `{"banks_build_token": "build_token", "quiz_api_host": "quiz_api_host"}`
   and made the binding strict (raises on unknown keys).
5. **Step order:** PROVISION now runs before quiz-api steps (they need the
   token). Added `Authorization` headers to `resolve_bank`.
6. **Removed broken steps:** `resolve_bank` (bare `/api/banks` not authorized
   for course-scoped tokens) and `scan_quiz_uses` (bare `/api/quizzes` 401s).
   The entry now does PROVISION, read_bank, list_bank_entries.
7. **Double-scheme bug:** Fixed `quiz_api_host` to return the bare hostname
   (manifests build their own `https://` URLs).
8. **Case-sensitive prose guard:** Fixed to reject prose picks case-insensitively.

**Live proof:** `execute` ran `morrow_read_item_bank_fan_out` end-to-end.
Op `92246094-969d-4f65-80d1-69c180563285`, receipt `[{"bank_id": "4017"}]`.

### Fix B: PROVISION failure journaling
**Problem:** LTI provisioning failures raised raw exceptions without a
journal receipt.
**Fix:** Added `ProvisioningFailed` exception. The executor catches it,
journals a safe `incomplete` receipt (`reason: provisioning_failed`, no
credential material), and re-raises. Verified with a mocked failure: the
journal contains only the safe reason string.

### Fix C: Retired `provision_all`
**Problem:** `proofs/battery_common.py::provision_all` was a 100+ line
duplicate of the LTI chain, still referenced by obsolete batteries.
**Fix:** Replaced with a thin adapter delegating to
`provision.provision_build_token_memory` (the exact product function).
The adapter provides `token`, `quiz_api_host`, `quiz_lti_host`, `x_domain`,
`referer`, `course_uuid` (from cached params), and `receipts`. Accessing the
obsolete full launch material (`access_token`, `launch_token`) raises a clear
`ProvisionFailed` pointing to the canonical proofs.
**Canonical proofs:** `proofs/quiz-lane/battery2.py` (New Quiz),
`proofs/dress-rehearsal/stage4_driver.py` (Item Banks). These are
external evidence history from the operator's 2026-09-20 proof
campaign; they do not exist in this tree (see the evidence-citation
conventions in `proof-battery/OPERATION_CATALOG.md`). Neither uses
`provision_all`.

## Installed keepalive schedules

**Scheduler:** `bin/scheduler.py` (userspace daemon, pid file in `logs/`)
**Status:** Running (verified 2026-09-20)

| Keepalive | Schedule | Status |
|-----------|----------|--------|
| Canvas | Daily (every 24h) | **Live.** Last run: 200, principal 28206. Log: `logs/keepalive-canvas.log` |
| Moodle | Every 6 hours | **Installed but dormant.** No Moodle session bundle exists yet. The script logs `IDLE` and exits 0 until Braden bootstraps a session with `moodle/login.py`. Log: `logs/keepalive-moodle.log` |

**Note:** The VM has no cron daemon. The scheduler is a Python daemon under
`/home/hatch` (survives restarts). After a VM reboot, run
`bin/scheduler.py start`. (The product helper's keepalive is separate:
on this VM it runs from `helper/supervisor.py`'s background loop; after
a reboot, `bin/morrow start` restarts it.)

## Post-deploy smoke-test receipts

All tests ran through the **deployed** product entry points.

### 1. Lane detection
- **PAT lane:** Blocked by institution policy (CHCP does not permit PAT minting).
- **Session lane (raw HTTPS):** Blocked by OTP wall (302 to `/login/otp`).
- **Session lane (in-tab CDP):** **Works.** The product uses this lane.
- The lane detector (`lanes/detect.py`) correctly fails on raw HTTPS,
  confirming the OTP wall. The product does not rely on raw cookie replay.

### 2. Session capture
- Existing session verified: `~/.morrow/session.json`
- Principal: 28206 (Braden Riggins)
- Canvas base: `https://chcp.instructure.com`
- Keepalive probe: 200, principal_id=28206.
- **Note:** A truly fresh capture requires Braden to sign in through
  the login helper page. The existing session is valid and was verified live.

### 3. Provisioning
- `provision/provision.py --course-id 89585`
- Result: `ok=True`
- Steps: step1 ok, step2 reused_cached_pair, step3 ok, step4 ok, step5 ok.
- Quiz API host: `https://chcp.quiz-api-iad-prod.instructure.com`
- Course UUID: `OxO4Y5yErxxwmlKpXV7qWx9wnFyMoQG17sLQndNi`

### 4-8. Item Bank lifecycle (create, readback, attach, archive, verify)
- **Create:** Bank 4041, title `MORROWDEPLOY-SMOKE-20260920-161552`.
  Op `5f16277b-5514-4700-add8-05cbd9a2bbcf`.
- **Readback:** Title confirmed.
- **Attach:** Entry 82698 (copied from bank 4017 entry 82658).
  Op `20b0cf55-87c3-46e0-bdf0-3559d09d6101`.
- **Archive:** Op `884eb821-d3b6-4ca9-b04f-80de9d851d99`.
- **Verify:** Bank 4041 absent from the live list (11 banks checked).
  Direct read: `archived=True`.

### 9. Zero proof residue
- Live banks: 11, none with SMOKE/DEPLOY titles.
- Bank 4040: `archived=True` (cleanup from an interrupted smoke run).
- Bank 4041: `archived=True` (the successful smoke test).
- **No educator-visible residue.** Both banks are archived.

### 10. Reauthentication drill
- `reauth/state_machine.py selftest`
- Result: **10/10 passed.** State restored to healthy.

## Exact Canvas IDs created and cleaned up

| ID | Type | Created | Cleaned up | Status |
|----|------|---------|------------|--------|
| 4040 | Item Bank | 2026-09-20 (interrupted smoke) | Archived 2026-09-20, op `4438579d-9b73-4745-8664-47e52dcae508` | `archived=True` |
| 4041 | Item Bank | 2026-09-20, op `5f16277b-5514-4700-add8-05cbd9a2bbcf` | Archived 2026-09-20, op `884eb821-d3b6-4ca9-b04f-80de9d851d99` | `archived=True` |
| 82698 | Bank Entry | 2026-09-20, op `20b0cf55-87c3-46e0-bdf0-3559d09d6101` | Archived with parent bank 4041 | Not educator-visible |

**Note (corrected 2026-09-20):** The orphaned quiz-api quiz 506477 (from the pre-deploy dress
rehearsal) remains server-side because the rehearsal deleted the assignment via Canvas REST first,
which detaches without cleaning the quiz backend object. Re-proven live 2026-09-20 on disposable quiz
4045369: DELETE via the quiz API (`DELETE /api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}`)
returns 200 and removes the quiz object, the assignment, and the list entry together, with no orphan.
The correct lifecycle is quiz-API delete, never assignment-endpoint delete for New Quizzes. Evidence:
`proof-battery/evidence/nq-item-bank-wave1/WAVE-B-SUMMARY.md`.

## Anything still requiring Braden

1. **Moodle session bootstrap:** The Moodle keepalive is installed but
   dormant. To activate it, run `moodle/login.py` to create a persisted
   session bundle at `~/.morrow/moodle-session.json`. Until then, the
   keepalive logs `IDLE` every 6 hours (not an error).

2. **Fresh session capture:** The current Canvas session is valid, but a
   truly fresh capture (if the session ever expires) requires Braden to sign
   in through the login helper page. The reauth state machine will
   guide this if expiry is detected.

3. **VM restart recovery:** After any VM restart, re-run
   `bin/scheduler.py start` to resume the keepalive daemon.

4. **Nine desktop MCP fixes:** Still unapplied (Mac repos are read-only
   without explicit authorization). Not part of this deploy.

5. **Public repo reconciliation:** The public Morrow repo is behind the
   active work. No push or merge is authorized.

## Verification

- Source scanned for token-like material: clean (no JWTs in files).
- All fixes unit-tested.
- Reauth selftest: 10/10.
- Smoke tests: all passed via deployed entry points.
- Scheduler: running and verified.

## Recovery runbooks (W6-P2-9)

**Backup/restore:** `python3 -m dispatch.state_backup create <dir>`
(encrypted storage mandatory) prints the backup folder it made,
`<dir>/morrow-backup-<time>`; pass that folder to `verify` and to
`restore <folder> --yes`. Post-restore: `python3 -m dispatch.executor
journal-reconcile --yes`.

**Journal secret loss:** Reconcile in-flight ops against the provider
first, then `python3 -m dispatch.executor journal-recover-secret --yes
--reason "operator attestation (min 20 chars)"`.

**Missing archives:** Restore from backup, then `python3 -m
dispatch.executor journal-reconcile --yes`.
Never re-claim op_ids while archives are missing.

**Retired seal adoption:** `python3 -m dispatch.executor retired-seal --yes`.
