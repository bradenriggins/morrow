#!/usr/bin/env python3
"""RETIRED 2026-09-21. This script rendered Wave 1 (assignments)
browser-task briefs for the Canvas REST battery through the form lane
(relay page + harvested CSRF, no JS).

The first-party static relay page was taken down 2026-09-21 and the form
lane was removed from transport/batch.py, so this script can no longer
run: transport/batch.render_brief raises FormTransportUnavailable on
every form write. The rendered briefs remain as historical artifacts of
the 2026-09-20/21 battery:
  brief-wave1a-assignments.md
  brief-wave1b-assignments.md
"""
import sys


def main():
    raise RuntimeError(
        "render_wave1.py is retired 2026-09-21: the form lane it rendered "
        "through (first-party static relay page) was taken down and "
        "transport/batch.py no longer renders form writes. The rendered "
        "briefs remain as historical artifacts.")


if __name__ == "__main__":
    main()
