# modes/ : Plan/Edit mode state machine (Workstream A)

Per-user Plan/Edit mode for Morrow for Muse. Answers one question: may
this write proceed without a per-write educator approval? Everything
else about the two modes is identical: reads are unrestricted with no
approval in both modes, and every other admission gate
(never-dispatch, unsupported, evidence-holds, learner-data) runs
unchanged in both modes.

## The model (Braden's correction)

Edit mode is NOT scoped. There are no course lists and no category
lists on a grant. Edit mode means exactly one thing: the educator gives
their Muse agent permission to edit Canvas on their behalf without
approving every single change. The ONLY difference between plan and
edit mode is whether writes surface approval to the user.

The agent finds the correct course itself via search and reasons with
the user to confirm it is working in the right course (e.g. "Biology
101 section A"). Ambiguous course resolution must be confirmed
conversationally, never guessed silently: a write whose course
resolution is below 0.9 confidence without explicit user confirmation
is refused as ambiguous, in every mode path that carries a resolution.

## Grant model

Grant = `{grant_id, educator_identity (bound), granted_at, expires_at,
revoked flag, scope_type, source_utterance}`.

`scope_type`:
- `"timed"`: an explicit timed session request (e.g., "give me a 60-minute
  edit session"). Expires after `duration_min` (explicit, else the
  `edit_grant_duration_min` setting, else 30 minutes; capped at 24 hours).
  Bare "use edit mode" is now a standing grant, not a timed session.
- `"conversation"`: "use edit mode for this conversation". No time
  expiry (`expires_at` is null); lives until revoked. The session
  owner revokes on session end (e.g. `switch_mode(user, "plan")`).
- `"standing"`: not a grant record. The educator set `default_mode`
  to `"edit"` in settings themselves. Persistent until changed.

The grant STILL requires an educator-issued confirmation:
`{"by": "educator", "authorization": "<verbatim educator utterance,
at least 20 chars>", "channel": "educator-chat" | "driver"}`.
The agent must NEVER promote itself to edit mode:
- `request_edit_grant` without a valid confirmation raises
  `ModeSelfGrantRefused`.
- `switch_mode(user, "edit")` raises `ModeSelfGrantRefused`. The
  educator flips `default_mode` in settings themselves for standing
  edit mode.

Educator principal binding: this tree represents the educator
principal as `by == "educator"` plus the verbatim authorization
citation (the approval-record pattern in `dispatch/admission.py`).
Grants bind the same, and every journal event below carries the
educator identity. Honest trust statement (same as `sign_approval`):
this runs in the agent's process, so it cannot cryptographically prove
the citation came from the educator; the citation is journaled
verbatim for audit and the grant file carries a tamper seal, so
post-grant modification fails closed.

## Effective mode resolution

`current_mode(user_id, conversation_id=None)` is the single
authoritative resolver (`settings.effective_mode` delegates to it;
there is no second resolver). Most-recent-wins among the educator's
explicit actions:

1. A settings conversation override for this conversation.
2. A live timed grant.
3. A live conversation grant applying to this conversation.
4. Else the educator's standing `default_mode == "edit"` -> `"edit"`
   (standing).
5. Else `"plan"`.

On equal timestamps the explicit per-conversation override wins (the
safe direction when it says "plan"). `current_mode` raises
`ModeSettingsTamper` (fail closed) when the grant file's tamper seal
does not verify or a stored setting value is invalid.

Conversation overrides are in-memory, per (user, conversation), and
are cleared by `settings.end_conversation(user_id, conversation_id)`,
which also revokes grants bound to that conversation. Timed grants
created through settings (`start_edit_session`) are real persisted
mode grants, optionally bound to a conversation id.

## Write authority

`check_write_authority(user_id, course_id=None, resolution=None)` ->
`(decision, reason_code)`:

| decision | reason_code | meaning |
|---|---|---|
| `allow` | `ok` | edit mode (live grant or standing), course unambiguous |
| `refuse` | `grant_expired` | the latest grant lapsed |
| `refuse` | `grant_revoked` | the latest grant was revoked |
| `refuse` | `ambiguous_course` | resolution confidence < 0.9 without user confirmation |
| `defer` | `plan_mode_approval_required` | plan mode: run the frozen-plan + educator-signed v2 approval path |

`resolution` is an optional dict the dispatcher supplies when it has
one: `{course_id, confidence (0..1), user_confirmed (bool), query,
candidates_public}`. Without a resolution the gate cannot judge
ambiguity and admits in edit mode; the conversational confirmation
duty stays with the agent.

`authorize_write(...)` honors the same most-recent-action result as
`current_mode(...)`: a later conversation override of plan defeats an
earlier live timed grant, and a later educator-issued grant defeats an
older override only in the conversation it applies to. Both go
through `_newest_authority(...)`; there is no grant-alone path. An
educator-confirmed edit override with no live grant admits with
override-sourced auth context (`scope_type="conversation_override"`).
A newer plan override also supersedes a stale grant's expiry or
revocation: the educator explicitly chose the plan path, so the stale
refusal does not apply (without an override, expiry and revocation
still refuse).

`authorize_write(...)` is the same decision plus the auth context
(grant id, revision, scope type, educator identity) that the admission
hook needs for its audit block and usage journaling.

## Admission hook

`dispatch/admission.py::check_mode_authority(entry, params, approval,
mode_ctx)` sits in the `admit()` gate chain behind the optional
`mode_ctx` parameter. The full harness contract:

```python
mode_ctx = {"user_id": "<id>",
            "conversation_id": "<id>",            # optional; scopes grants
            "course_resolution": {"course_id": ...,
                                  "confidence": 0.0-1.0,
                                  "user_confirmed": bool,
                                  "query": ...,
                                  "candidates_public": ...},  # optional
            "destructive_confirmed": "<verbatim educator yes>"}  # optional
admit(entry, params, tenant_base=..., mode_ctx=mode_ctx)
```

The Muse harness supplies `user_id` (env `MORROW_USER_ID`) and
`conversation_id` (env `MORROW_CONVERSATION_ID`) for every dispatch;
`dispatch_entry`, `dispatch_catalog_op`, and `dispatch_undo` all accept
and forward `mode_ctx`. Missing `user_id` fails closed to the legacy
plan-mode approval path.

- Reads: `(None, None)`, unchanged.
- Plan mode: delegates to the existing `check_write_approval`. When it
  finds no approval, the educator gets the mode-aware
  `PlanModeWriteWithoutApproval` (translated to
  `plan_mode_write_without_approval`), with the legacy
  `WriteApprovalMissing` kept as the cause.
- Edit mode, in scope: admits WITHOUT a per-write approval record and
  returns `(mode_audit_block, None)`; the dispatcher's
  `persist_signed_record` / `consume_approval` calls are no-ops for
  `None`, exactly like reads. The executor also skips the frozen-plan
  requirement for edit-mode writes (the frozen plan is the plan-mode
  ceremony's artifact); every other write gate (halt, quarantine,
  op-id claim, concurrency) still applies.
- Edit mode, expired/revoked grant, or ambiguous course: raises
  `ModeGrantExpired`, `ModeGrantRevoked`, or
  `AmbiguousCourseWriteRefused`.
- Destructive writes (HTTP DELETE, or entries explicitly marked
  destructive) in edit mode: when the educator's
  `confirm_destructive_writes` setting is on (off by default), the write is
  refused as `DestructiveConfirmationRequired` unless `mode_ctx`
  carries `destructive_confirmed` with the educator's verbatim yes.
  When the setting is off, destructive writes proceed under edit
  authority.

When `mode_ctx` is None, `admit()` behaves exactly as before. There
are no tenant restrictions anywhere in the mode path: no operation is
gated or restricted by tenant.

## Persistence

Per-user grant state: `<morrow_home>/modes/grants/<user_id>.json`
(0600, atomic write, HMAC-sealed with the same machine keyring as
approval records, so post-grant edits fail closed). `morrow_home()`
honors `MORROW_HOME`; state survives restarts and reinstalls and never
lives inside the deploy tree. `user_id` is restricted to
`[A-Za-z0-9_.:@-]{1,160}` so it is filesystem-safe.

## Journal events (tree journal, educator identity bound)

- `mode.grant_issued`: grant_id, revision, scope_type, educator
  identity, granted_at, expires_at, source utterance.
- `mode.grant_revoked`: grant_id, revision, scope_type, educator
  identity, reason (explicit revoke, `switch_mode:plan`, or
  `superseded by grant <id>`).
- `mode.grant_expired`: journaled once, on first observation of the
  lapse.
- `mode.write_admitted`: one per edit-mode write admitted under a
  grant (or standing): entry, course_id, op_id, grant id/revision,
  educator identity, resolution confidence when supplied.
- `mode.write_refused`: one per mode refusal with the reason code.
- `mode.switched_to_plan`: switch events with the revoked count.

## Settings contract (`settings/store.py`)

- `get_setting(user_id, key)` -> stored value, or `None` when unset.
  Raises only on backend failure.
- `set_setting(user_id, key, value)` persists the value (consequential
  keys require `educator_confirmed=True`, else `SettingsTamperRefused`).
  Raises on failure.
- Keys: `"default_mode"` (`"plan"` | `"edit"`; standing default),
  `"edit_grant_duration_min"` (int minutes; timed-grant default),
  `"verbosity"`, `"confirm_destructive_writes"` (bool; destructive
  writes in edit mode need explicit confirmation),
  `"write_approval_style"`, `"failure_verbosity"`, `"proactivity"`,
  `"read_confirmations"`.
- `settings.effective_mode(user_id, conversation_id)` delegates to
  `modes.state.current_mode`: one resolver, no second authority.
- `start_edit_session(...)` with educator confirmation creates a real
  persisted mode grant (optionally conversation-bound), not a separate
  session record. `end_conversation(...)` clears the in-memory
  override and revokes conversation-bound grants.
- `switch_mode(user, "plan")` revokes live grants for the session but
  does NOT rewrite the educator's persisted `default_mode`: changing
  the saved default is a separate educator-confirmed settings
  ceremony.

## Failure modes (Workstream C maps these by name)

`modes/errors.py`: `ModeSelfGrantRefused`, `ModeGrantExpired`,
`ModeGrantRevoked`, `AmbiguousCourseWriteRefused`, `ModeSettingsTamper`,
`DestructiveConfirmationRequired`, `PlanModeWriteWithoutApproval`
(all under the `ModeError` base). Scalar constructor/attribute
evidence (`grant_id`, `course_id`, `query`, `candidates_public`,
`setting_name`, `mode`) is merged by the translator. `ModeOutOfScope`
and `ModeCategoryDenied` were dropped: no scopes exist in this model.
Plan mode keeps the existing `WriteApprovalMissing` /
`ApprovalMismatch` path underneath; the mode gate wraps the missing
case in `PlanModeWriteWithoutApproval` so the educator sees the
mode-aware message.

## What was deliberately not built

- The agent can never promote itself to edit mode (`ModeSelfGrantRefused`
  at every layer); only the educator's explicit confirmation grants it.
- No live writes, no browser work, no commits, no deployments in this
  unit-test lane: `modes/test_modes_integration.py` covers the
  integrated adversarial cases synthetically.

## Tests

`modes/test_modes.py` (pytest, stdlib only in the package) plus
`modes/test_modes_integration.py` (modes + settings + admission gate,
real packages, no fakes). Run from the deploy tree root:

    python3 -m pytest modes/test_modes.py modes/test_modes_integration.py -q

Test state roots live under `modes/.test-state/` and
`modes/.selftest-work/` (never `/tmp`) and are removed after the run.
