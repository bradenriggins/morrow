# Integration notes: Item Bank provisioning and accessibility runner

Date: 2026-09-21. Worktree: `~/workspace/morrow-for-muse-deploy/`.
Status: offline integration complete; live batteries pending approval.

## What was integrated

1. `dispatch/executor.py` `_run_provision_step` now calls the real
   `provision.provision_item_bank_credential_memory` with the managed-browser
   launch driver from `provision/launch_driver.py`. No mint chain, no
   placeholder. Fail-closed via `ProvisioningFailed` when the driver cannot
   complete.
2. `run_multi_step` re-captures per quiz-api step through
   `_ensure_fresh_bank_credential`: a consumed or closed handle is never
   re-presented; a fresh capture runs before the next step.
3. `build_headers` resolves a credential-handle transient to the
   Authorization value for exactly one `headers()` call; a second use raises.
   Handles are closed and zeroed before transients return.
4. The accessibility runner (`_run_a11y_entry`) executes the 11 pinned a11y
   entries offline: exact route resolution, SCAN with the 18 ported desktop
   signals, ROUTE to a repair planner, and VALIDATE plus APPROVE that stops
   in plan mode. DISPATCH is refused inside plan entries. Unwired target
   kinds (rubric, course files, Moodle) are refused instead of guessed.
5. `pack/pack.json` is now version 0.3.0 with an empty entry list
   (counted 2026-09-21: `python3 -c "import json;
   print(len(json.load(open('pack/pack.json'))['entries']))"` -> 0):
   the earlier 14 unverifiable external pins were removed rather than
   shipped on trust. The manifest (`pack/carve-manifest.json`) is the
   integrity source of truth.
6. `bin/smoke_bank_lifecycle.py` was rewritten: one capture per quiz-api
   operation, full origin from `quiz_api_base("chcp")`, disposable bank with
   archive and absent-from-live-list verification, fail-closed when the
   driver cannot complete. (2026-09-21, W3-P2-21: this script was then
   REMOVED; the SDK live battery `proof-battery/item_bank_sdk_battery.py`
   (development worktree script, not shipped in the dist)
   is the current Item Bank lifecycle proof.)

## Defects found and repaired during integration

1. `provision.py` `COURSE_UUID_RE` required RFC-4122 shape, but the real
   Canvas course UUID is a 43-character opaque token (observed live in
   `proof-battery/live-product-proof/report-read.json`). The real provision
   API would have rejected the real course. The regex now accepts either
   form. Evidence-based repair; the provision selftest still passes.
2. Both product manifests captured the handle as `item_bank_credential`
   while every quiz-api step reads `{"transient": "banks_build_token"}`.
   The capture maps now bind `banks_build_token`. Versions bumped to
   0.2.7 (fan_out) and 0.2.5 (check_new_quiz); pack pins refreshed.
3. Double-scheme URLs: `quiz_api_host` is a full origin
   (`https://chcp.quiz-api.instructure.com`), but manifest step URLs,
   the a11y `item_bank_question` route templates, and the a11y bank
   snapshot URL prefixed it with another `https://`. All now use the bare
   `{quiz_api_host}` token.
4. `_is_credential_handle` duck-typed on a `consumed` attribute that does
   not exist on `ItemBankCredential`; it now checks
   `headers`/`close`/`assert_binding_for`.
5. `_run_provision_step` caught only `ProvisionFailed`; `NoLaunchDriver`
   and other `ProvisionBlocked` failures escaped as the wrong type. It now
   catches both.
6. `_ensure_fresh_bank_credential` read `handle.consumed`/`handle.closed`
   attributes; it now reads the public `binding_summary()`.
7. `_a11y_https_get` built relative URLs; Canvas-origin routes now render
   against `{canvas_base}`.

## Credential format (live-observed)

The captured credential goes in `Authorization` as the raw token with no
scheme prefix; the scheme word travels in the separate
`AuthType: Signature` header. `handle.headers()` returns exactly this
pair for one operation, then the handle zeroes itself.

## Offline proof (2026-09-21)

- `dispatch/integration_selftest.py`: 43/43 PASS (re-ran 2026-09-21:
  `PASS: 43`, 43 `ok` checks, exit 0; provision step, fail-closed
  driver, single-use handle, two GETs = two captures, AuthType
  Signature on both calls, no handle escapes transients, a11y audit
  SCAN/ROUTE, a11y refusals, planner VALIDATE/APPROVE, stale-body
  refusal, plan effect class, CLI flags, pack pins, em-dash and /tmp
  hygiene).
- `catalog/a11y/a11y_selftest.py`: 74 PASS.
- `provision/launch_driver_selftest.py`: 40 PASS (offline fakes only).
- `provision/provision_selftest.py`: all PASS.
- `dispatch/executor_selftest.py`: all PASS.
- `dispatch/admission_selftest.py`: all PASS.
- `privacy/learner_vault_selftest.py`: 15/15 PASS.
- `transport/browser_backend_selftest.py`, `form_host_server_selftest.py`:
  PASS. (`form_relay_selftest.py` was removed 2026-09-21 with the retired
  form-relay lane.)
- Static scans: no em dashes, no temp-directory paths, no regional quiz-api
  host assumptions, no live mint-chain references in touched code.

## Not yet proven

- No live browser launch has been attempted; the launch driver is proven
  only against offline fakes.
- The smoke script has not been run live (needs Braden's approval under
  the current checkpoint; writes also need an educator-signed approval).
- Completion pinning (`--expected-generation` / `--pinned-principal`) is
  CLI-plumbed but not yet bound to a dispatch-envelope record.
- Accessibility is not yet wired through the managed-browser backend's
  dispatch path, only the direct executor path.
- Program-wide multi-course auditing, the runtime-pack entry contracts
  for the new pins, and full desktop/site parity remain open work.
