#!/usr/bin/env python3
"""Install text and install suites say only what is true.

Failure modes this suite pins down (written before the fix; round-4
audit 2026-09-22):
  L4. install.sh and INSTALL.md said Python 3.10 "reached" security
      end-of-life in October 2026; on 2026-09-22 that is in the future.
  L6. transport/egress_selftest.py hard-coded a path under
      ~/workspace/audits/..., an external dependency no install has.
  F2. knowledge/troubleshooting-playbook.md said install.sh "checks
      python3 >= 3.10", but install.sh refuses 3.10, so an agent
      reading it would call a 3.10 VM fine (final sweep 2026-09-23).
"""

import os
import re
import subprocess

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        return fh.read()


def test_python_310_eol_is_stated_as_future():
    for rel in ("install.sh", "INSTALL.md"):
        text = _read(rel)
        assert "reached security end-of-life in October 2026" not in text
        assert not re.search(r"reached\s+security\s+end-of-life", text), rel
        assert re.search(r"reaches\s+security\s+end-of-life\s+in\s+"
                         r"October\s+2026", text), rel


def test_every_doc_names_the_python_floor_install_enforces():
    floor = re.search(r"sys\.version_info >= \(3, (\d+)\)",
                      _read("install.sh")).group(1)
    docs = subprocess.run(["git", "-C", TREE, "ls-files", "*.md"],
                          capture_output=True, text=True,
                          check=True).stdout.split()
    claims = []
    for rel in docs:
        if rel == "CHANGELOG.md":
            continue  # history: past floors stay as they were
        for m in re.finditer(r"python3\s*\(?\s*>=\s*3\.(\d+)"
                             r"|Python 3\.(\d+) or newer", _read(rel),
                             re.IGNORECASE):
            claims.append((rel, m.group(1) or m.group(2)))
    assert claims, "no doc states the python3 floor"
    assert [c for c in claims if c[1] != floor] == [], claims


def test_selftests_depend_on_no_external_paths():
    for rel in ("transport/egress_selftest.py", "helper/helper_selftest.py"):
        text = _read(rel)
        assert "~/workspace" not in text, rel
        assert "/audits/" not in text, rel
