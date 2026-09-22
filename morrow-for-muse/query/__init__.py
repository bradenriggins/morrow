"""Natural-language query chain: "show me the students that failed X".

Workstream 3 of the 2026-09-22 polish campaign.

Modules:
  intent        NL parsing of the failed-students phrasing family
  quiz_resolve  "last week's quiz" -> exactly one quiz (exact week and
                effective-date semantics; never silently picks)
  thresholds    what "failed" means (points/percent, grading standards,
                pass_fail, excused, missing)
  live_read     authenticated reads through the helper's browser
                context (Canvas auth never leaves the browser)
  present       de-identified educator result via the privacy boundary
  chain         orchestration; failures route through
                failures/translator.py
"""
