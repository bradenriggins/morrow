# Student privacy boundary

Faithful Python port of the desktop Morrow source privacy boundary
(historical provenance: the desktop Morrow monorepo, not shipped in this package):

- `origin-morrow/packages/gateway-core/src/source-mcp-privacy.ts`
- `origin-morrow/packages/gateway-core/src/privacy.ts` (1,585 lines)

read-only sources; nothing was modified there.

## Files

- `core.py`: exact learner scopes, canonical JSON, AES-256-GCM
  learner vault, persistent encrypted mappings, exact-scope roster,
  alias machinery (full-name, given-name, reversed forms),
  Unicode/HTML-entity/percent-escape-aware matching, structural
  egress redaction, write-direction label resolution, secure
  private-file helpers, batch redaction.
- `boundary.py`: `SourceMcpPrivacyBoundary` plus roster/schema
  helpers. Source and Canvas roster harvesters, Moodle history
  rules, input-schema extension, exact binding validation,
  pre-handler roster registration, post-handler binding-currentness
  check, course/binding matching, optional course-request gate,
  private and multi-course tool refusal, stable failure envelopes,
  metadata-only internal capability.
- `source_privacy_selftest.py`: the test suite (see below).
- `executor_wire.py`: the executor's projection point (every learner
  read, no reveal), working-by-name helpers (`issue_labels`,
  `apply_name_echo`, `resolve_learner_labels`, `relabel_learner_ids`),
  and the shipped purge commands.
- `name_echo.py`: the encrypted per-conversation record of students
  the educator named (the name echo).
- `FERPA_POLICY.md`: the plain-language policy, working by name, what
  Morrow can and cannot protect, the adapted deployment gate ladder,
  honest limitations.

Legacy lanes (`learner_vault.py`, `pseudonym.py`) are kept for
compatibility but are not the wired boundary.

## Egress only

This package is pseudonymization on EGRESS: learner identities from
the LMS become stable course-local `Student A<n>` labels before
anything is agent-visible or journaled. The production Meridian JS
privacy boundary (`privacy_boundary.js` on the team kit) also has an
INGRESS half (PII detection on what a person types). Morrow for Muse
has no ingress half: it cannot intercept the educator's messages to
Muse, so names the educator types reach the Muse model. Morrow keeps
every other student identifier from the LMS out. The selftest's Part
3 ports the reusable ingress-detection patterns (course-title
preservation, education-record facts, email in gradebook context,
label spoof-gating, routine-course-copy byte-identity) as adversarial
pins on this egress half.

## STRONG-context gating (design reflection)

The ingress layer's production history (audits 2026-05-11 through
2026-05-28) proved that aggressive keyword gating breaks routine
course-content operations: chapter copy like "Word Parts in
Action", course-mechanic copy like "lock students out", and quiz
answer choices like "B. Disinfect the completed cast" all fired
false positives. The answer there was a three-tier pattern system
(broad detection, STRONG same-paragraph signals, OPERATION-gated
mode switching).

The egress half answers the same lesson structurally: redaction is
roster-driven, never keyword-driven. The harvester admits only
records carrying an unambiguous identity field (email, login_id,
sis_user_id, sortable_name, short_name, or a user-ish key), so a
Canvas module `{id, name, position, items_count}` or a course
`{id, name, course_code}` can never be relabeled no matter what
words its title contains. Routine course copy passes through
byte-identical; the selftest pins both directions.

## Wiring

`dispatch/executor.py` projects every learner receipt in
`dispatch_entry`'s success path (and every verification detail and
failure-journal receipt) through
`executor_wire.project_learner_result`. People-bearing operations
dispatch only on the Chromium lane with the encrypted vault; the raw
HTTPS lane, and any lane without `cryptography`, refuses them
(`LearnerDataGated`). `transport/browser_backend.py::_project_learner_result`
delegates to the same function for the proof-battery lane. Working by
name: `learners/find.py` (`bin/morrow students find`) issues labels and
records the name echo; `dispatch_entry` resolves labels in a write to
real ids after the mode gate and relabels everything afterwards. See
FERPA_POLICY.md for the honest scope.

## Semantic divergences (port decisions)

1. The owner-file transaction protocol is replaced by `flock(2)`
   plus atomic replacement; 0600 files, symlink refusal, owner
   validation, and byte limits are retained.
2. `Intl.Segmenter` grapheme handling is approximated with Unicode
   normalization and combining-mark grouping; full emoji ZWJ
   segmentation is not reproduced.
3. JavaScript Unicode property regexes and localized casing map to
   Python Unicode regex behavior and `str.lower()`.
4. Async TypeScript callbacks become synchronous Python callables.
5. `OutputPrivacyDescriptor`, `projectOutput`,
   `outputDescriptorDigest`, and `ArtifactGenerationRegistry` were
   not ported; the boundary does not use them.
6. A file object's `display_name` field is dropped (faithful to the
   desktop boundary's identity value fields); the Meridian ingress
   layer preserves file display names instead.
7. Python URL-safe base64 emits unpadded values, matching Node
   `base64url` behavior.
8. W2-P2-4: when a learner alias or identity reference occurs
   inside a URL or `mailto:` token, the replacement is
   percent-encoded (`Student%20A1`) instead of inserting a
   raw-space pseudonym, so the link stays a single intact token
   and the name cannot reappear split across URL boundaries.
9. W2-P1-1: secret-shaped text is redacted surgically, not by
   whole-read refusal. Soft instructional shapes (short `csrf`
   / `token=` examples, hidden/display-none HTML tags, short
   teaching `data:...;base64,...` examples) are scrubbed in place
   with `[redacted sensitive span]`; hard credential-shaped values
   (bearer tokens, substantial cookie/token values, substantial
   base64 data URLs) still refuse the whole read with
   `privacy_sensitive_text_refused`.
10. W2-P0-12/W2-P0-13: matching folds a focused set of Latin /
    Cyrillic / Greek confusables and strips Unicode `Cf` format
    (zero-width) characters before alias matching, so lookalike
    and zero-width-evasive spellings still de-identify. Bare
    surnames (`Thornton`) and given-name-plus-initial forms are
    matched too; a partial-name match (`Alice Thornton` for
    learner `Alice B. Thornton`) never emits the raw surname, it
    emits the learner's label with the middle initial folded in
    (`Student A1 Thornton` is rewritten so no raw name text leaks).

## Tests

`python3 privacy/source_privacy_selftest.py` (from the deploy root):

- Part 1: 23 cases translated from the TypeScript suite
  (`source-mcp-privacy.test.ts`).
- Part 2: 10 hostile leak cases (deep nesting, unicode, emails,
  grade CSV, pagination, SIS ids, LTI params, opaque blobs,
  dispatch bypass, secret-shaped text).
- Part 3: 11 ported ingress-detection cases (8 pins + 3
  documented gaps: initial-last names, `canvas id <id>` context,
  bare DOB).
- Part 4: 14 wave-2 adversarial regressions (homoglyph spellings,
  zero-width full and reversed names, bare surname, partial-name
  surname leakage, URL percent-encoding, mailto tokens, surgical
  soft-secret redaction, hard-credential refusal).
- Part 5 onward: wave-3 and later adversarial regressions.

78/78 PASS as of 2026-09-22. Fixtures are synthetic; vault scratch
lives under `privacy/.selftest-work/`.
