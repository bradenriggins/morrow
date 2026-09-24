# Accessibility catalog (ported from desktop Morrow)

This directory ports the desktop Morrow accessibility audit system
(`packages/mcp-server/src/course-audit.ts`, `page-correction.ts`,
`item-bank-repair.ts`) into Morrow for Muse catalog entries. It is the
missing a11y scanner: read-only signal detection plus ten guarded
image-alt repair planners.

## Canvas accessibility parity checker (Morrow for Muse)

`canvas_parity_rules.py` is a faithful port of Instructure's
`tinymce-a11y-checker` (MIT licensed,
https://github.com/instructure/canvas-lms, pinned to commit
`1c9f0bb8013ed69c4f2efe11fd483025469b7e6c`), the 13-rule inline checker
built into Canvas's rich content editor. `augmented_rules.py` runs after
it and adds 13 Morrow-extended rules that go beyond what Canvas's own
checker covers. Both are stdlib-only and offline: they read
already-supplied HTML strings and make no network or browser calls.

The 13 Canvas-parity rule ids (verbatim, in checker order):

`img-alt`, `img-alt-filename`, `img-alt-length`, `table-caption`,
`table-header`, `table-header-scope`, `small-text-contrast`,
`large-text-contrast`, `adjacent-links`, `headings-sequence`,
`paragraphs-for-headings`, `list-structure`, `headings-start-at-h2`.

What "same as Canvas" means: the same trigger conditions (an image with
no alt attribute fires `img-alt`, exactly as Canvas's checker would),
the same thresholds (alt text over 120 characters; minimum contrast
4.5:1 for small text and 3.0:1 for large text, where large means 18pt or
larger, or bold 14pt or larger), and the same message and why strings
Canvas shows educators. Rule ids and wording are verbatim so results
compare 1:1 with the checker output educators see in the RCE.

The one documented divergence: the course-level Ruby checker
(`app/models/accessibility/`) flags alt text over 200 characters, while
the RCE inline checker (what educators actually see) uses 120. This
module ports the RCE 120-char rule; the 200-char variant is documented
in the module, not implemented as a second rule.

Where Morrow goes further: the 13 `morrow-` rules (every finding labeled
Morrow-extended, source `morrow-extended`) cover surfaces Canvas's
checker does not: New Quiz item and Item Bank images, quiz instructions
checks, media caption tracks and autoplay, iframe titles, aria-hidden on
focusable elements, link text problems (empty, bare URL, generic),
decorative images carrying alt text, and unclosed table markup. They
never re-implement a Canvas-parity rule.

Contrast approximation caveat: Canvas computes contrast from live
computed styles inside the editor. This port sees only saved HTML, so it
resolves color, background color, font size, and font weight from inline
`style` attributes only (nearest ancestor declaration wins, defaulting to
black text on white). Every contrast finding is marked
`approximate: True` with a note that Canvas uses live computed styles; a
contrast finding resting on defaults is a prompt to look, never a
verdict.

Honesty standard (non-negotiable): every finding is a signal for human
review, never a violation, and a clean result is never a pass. No
finding set establishes WCAG conformance. Canvas's own checker carries
the same limitation: it is a teaching aid, not a conformance tool.

Evidence: the two checker modules are live-verified against real course
content on 2026-09-22 (course 89585, BIOL 101: General Biology); see
`~/workspace/audits/a11y-parity-2026-09-22/REPORT.md`. Parity selftests
75/75 and the existing 74/74 regression both pass (run from the source
repository: `python3 catalog/a11y/a11y_parity_selftest.py` and
`python3 catalog/a11y/a11y_selftest.py`; CI runs both through
`scripts/dev-suites.sh`, and neither is part of the release).

## Files

| File | Purpose |
|---|---|
| `a11y_signals.py` | Stdlib-only port of desktop `htmlSignals`: the 18 saved-source signal detectors. Pure local computation, no network, no browser. |
| `a11y_repair.py` | `validate_repair_plan(kind, params, evidence)`: enforces every desktop planner guard against fresh audit evidence; raises `RepairPlanRefused` with a stable code. |
| `morrow_audit_course_item.json` | Read-only audit catalog entry. 28 target kinds (12 Canvas, 16 Moodle). Effects: read. Executor wiring: wired via `catalog/a11y/runner.py` audit mode (`run_audit`); `dispatch/executor.py` deliberately carries no a11y branches per the F-17 carve. Evidence status: live-unverified. |
| `runner.py` | A11y mode runner: audit mode (`run_audit`) and planner mode (`run_planner`). Uses the executor's public `dispatch_catalog_op` for reads only; never writes. Unknown/unwired kinds funnel through `failures/funnel.py`. |
| `runner_selftest.py` | 29 offline checks for the runner (audit, planner, refusals, funnel, PARITY LAW). Run: `python3 catalog/a11y/runner_selftest.py` |
| `morrow_plan_*_image_alt_repair.json` (10) | Guarded repair planner manifests, one per desktop planner: page, assignment, discussion, classic quiz description, classic quiz question, new quiz item, new quiz choice, new quiz answer feedback, new quiz feedback, item bank question. Effects: plan (no write during planning). |
| `build_repair_manifests.py` | Generator for the 10 repair manifests (shared guard contract in one place). |
| `a11y_selftest.py` | 74 offline checks, in the source repository only (CI runs it through `scripts/dev-suites.sh`). Run: `python3 a11y_selftest.py` |

## What was ported

- All 18 signal names and their detection rules, including the shared
  image-index counting (images inside `<template>`, `<svg>`, `<math>` take
  no index), the decorative-with-alt rule (role presentation/none or
  aria-hidden=true), heading jump/empty rules, table/caption/scope rules,
  media caption-track and autoplay rules, link text rules (empty, bare URL,
  generic), iframe title rule, aria-hidden-on-focusable, fixed pixel widths,
  and font tags.
- Truncation semantics: each list caps at 100 entries; a truncated list is
  reported `evidence_incomplete` with per-signal counts.
- Media metadata (capped at 100, sha256 of src/title/alt/kind, digests only)
  with the manual-review reason.
- All ten repair planners with their exact guard contracts: digest match,
  image index/src match, single-image ambiguity refusal, alt_text/decorative
  consistency, classic quiz question type allowlist (5 types), quiz_group_id
  refusal, resend-every-field contract, item bank snapshot digests and the
  decorative ban, Stimulus refusal, and the protected New Quiz 506477 rule.
- The honesty standard verbatim: signals are human-review signals, never
  violations; no signal set establishes WCAG conformance.

## Deliberately left as documented gaps (not silently dropped)

1. **render_evidence unavailable.** Desktop computes a
   `morrow.canvas-render-check.v1` record in the Morrow Bridge sandbox (an
   isolated page with CSP `default-src 'none'`). This VM has no
   Bridge/Electron loopback, so `render_evidence.status` is `unavailable`.
   Focus order, accessible names, contrast, and learner-view checks stay
   manual until a VM-native sandbox is built.
2. **Rubric remediation blocked.** Audit reads criteria/rating text, but the
   rubric update route takes the whole criteria set as one untyped indexed
   hash the catalog does not encode. No planner is named for rubric
   findings.
3. **Stimulus entries blocked.** `blocked_current_contract`: no harvested
   source proved a stimulus mutation contract, so Stimulus and unsupported
   entry types name no planner.
4. **File reads need a separate user opt-in and are bounded at 1 MiB.**
   Text/HTML/XHTML return text; PDF/Word/PowerPoint/Excel return structural
   `file_signals` only (counts and presence states), never document words.
   `content_evidence.status` stays `not_observed`; a signal set is never a
   pass.
5. **Moodle file bytes are never read.** Resource/Folder reads return file
   metadata only.
6. **Blackboard is not implemented.** There is no Blackboard auth lane,
   no Blackboard transport, and the provider enum is canvas/moodle only.
   No Blackboard audit operation exists, so Blackboard results are not
   available in any status.
7. **Parser parity note.** Desktop uses htmlparser2; this port uses stdlib
   `html.parser`. For ordinary Canvas-saved HTML the signal indexes match;
   for pathological markup (mid-document implied closes) results may differ,
   and remain valid human-review signals either way.

## Evidence status

The two checker modules (`canvas_parity_rules.py`, `augmented_rules.py`)
are live-verified (2026-09-22, course 89585; report at
`~/workspace/audits/a11y-parity-2026-09-22/REPORT.md`). Every other entry
in this directory is marked `evidence_status: live-unverified`. The
detector and planner guards are unit-proven (74 checks, zero network).
No live tenant battery has run through Morrow for Muse for the repair
planners. The runner (`catalog/a11y/runner.py`, 2026-09-22) wires audit
mode and planner mode without touching `dispatch/executor.py`: 4 Canvas
target kinds with live-proven reads are wired (page, assignment, new quiz,
new quiz item); unwired kinds (rubric, files, discussions, classic quizzes,
syllabus, Moodle) are refused with a named reason instead of guessed.

## Verification

```
python3 catalog/a11y/a11y_selftest.py   # 74 checks, all offline (source repository only)
python3 catalog/a11y/runner_selftest.py  # 23 checks, all offline
python3 catalog/a11y/build_repair_manifests.py  # regenerate manifests
```
