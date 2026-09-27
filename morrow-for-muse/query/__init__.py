"""Failed-students query chain, driven by typed arguments.

The agent reads what the educator asked ("show me the students that
failed last week's quiz") and calls the chain with typed arguments:
course, quiz window, and at most one threshold. No code here parses
the educator's words.

Workstream 3 of the 2026-09-22 polish campaign.

Modules:
  quiz_resolve  "last week's quiz" -> exactly one quiz (exact week and
                effective-date semantics; never silently picks)
  thresholds    what "failed" means (points/percent, grading standards,
                pass_fail, excused, missing)
  live_read     authenticated reads through the helper's browser
                context (Canvas auth never leaves the browser)
  present       de-identified educator result via the privacy boundary
  chain         typed arguments and orchestration; failures route through
                failures/translator.py
"""
