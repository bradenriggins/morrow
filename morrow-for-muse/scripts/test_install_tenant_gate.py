#!/usr/bin/env python3
"""install.sh applies the tenant rules before any network probe, and a
helper that will not come up fails the install.

Failure modes this suite pins down (written before the fix; muse UX
audit 3, finding muse-ux3/installer-probes-before-tenant-rules):
  1. install.sh step 10 checked only placeholders, then ran curl
     against CANVAS_BASE. A pasted https://user:pw@host sent embedded
     credentials to the network in the probe, an http:// address was
     fetched over plain HTTP, a private IP literal was probed, and an
     unconfirmed custom domain was probed and then refused by the
     helper with only "WARNING: the helper did not come up" and
     "Install complete" (exit 0). INSTALL.md step 3 promises the rules
     are enforced by the installer and the helper before any probe.
  2. A keepalive failure at step 10 left the install "complete": the
     agent had no plain reason to relay.

The validator under test is the shared one, config/tree_config.py
normalize_tenant_base, which helper/server.py also uses; the install
step is asserted in place (the full installer runs the 23 selftest
suites, far too heavy for this suite). A fake curl stub proves the
probe never runs for a refused address.
"""

import json
import os
import re
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, TREE)

from config.tree_config import normalize_tenant_base  # noqa: E402


def test_the_helper_rule_refuses_the_audit_cases():
    cases = {
        "http://lincolnhs.instructure.com": "https",
        "https://teacher:pw@lincolnhs.instructure.com": "credentials",
        "https://10.0.0.5": "non-routable",
        "https://canvas.lincolnhs.edu": "Canvas tenant",
    }
    for url, needle in cases.items():
        with pytest.raises(ValueError) as exc:
            normalize_tenant_base(url)
        assert needle in str(exc.value), (url, str(exc.value))


def test_server_uses_the_shared_validator():
    with open(os.path.join(TREE, "helper", "server.py"),
              encoding="utf-8") as fh:
        srv = fh.read()
    assert "from config.tree_config import normalize_tenant_base" in srv
    # No local copy of the rule body drifted back in.
    assert "_PLACEHOLDER_HOSTS" not in srv


def _install_step10_probe():
    """The step-10 tenant block as install.sh ships it: everything from
    the 'does not end in .instructure.com' custom-domain note is not
    needed; this extracts the validation + curl probe sequence."""
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("_TENANT_CHECK=")
    probe = text.index('curl -s -m 15 -L --max-redirs 3 "${CANVAS_BASE}"')
    end = text.index("\n", probe)
    return text[start:end], text.index("keepalive.sh\" >/dev/null 2>&1")


def test_the_validation_runs_before_the_probe():
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    check = text.index("_TENANT_CHECK=")
    probe = text.index('curl -s -m 15 -L --max-redirs 3 "${CANVAS_BASE}"')
    launch = text.index('"${TREE}/helper/keepalive.sh" >/dev/null 2>&1')
    assert check < probe < launch


def test_the_shared_validator_names_the_tree_root():
    # install.sh's check imports config.tree_config from the tree with
    # cwd outside it, like every other python step.
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    block = text[text.index("_TENANT_CHECK="):text.index("P1-26")]
    assert "cd / &&" in block
    assert "config.tree_config" in block
    assert "normalize_tenant_base" in block


def test_a_keepalive_failure_fails_the_install():
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    at = text.index("    *)", text.index("KEEP_RC"))
    tail = text[at:at + 2000]
    tail = tail[:tail.index("\n  esac\n")] if "\n  esac\n" in tail else tail
    assert 'fail "helper"' in tail
    assert "WARNING: the helper did not come up" not in tail


def test_the_probe_logs_no_credentials_for_a_refused_url(tmp_path):
    """With a logging curl stub, a refused CANVAS_BASE never reaches
    curl at all (the old probe sent embedded credentials and plain
    http:// URLs to the network)."""
    block, _launch = _install_step10_probe()
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    (fakebin / "curl").write_text(
        '#!/bin/bash\nprintf "PROBE SENT: %s\\n" "$*" >> %s\n'
        % ("$*", str(tmp_path / "probe.log")))
    (fakebin / "curl").chmod(0o755)
    log = tmp_path / "probe.log"
    stub = ('fail(){ echo "INSTALL FAIL [$1]: $2"; exit 1; }; '
            'note(){ echo "$1"; }; ENV_FILE=helper/env; '
            'TREE=%s\n' % TREE) + block
    for bad in ("http://lincolnhs.instructure.com",
                "https://teacher:pw@lincolnhs.instructure.com",
                "https://10.0.0.5",
                "https://canvas.lincolnhs.edu"):
        if log.exists():
            log.unlink()
        proc = subprocess.run(
            ["bash", "-c", stub + "\nCANVAS_BASE=%s\n%s"
             % (bad, block)],
            capture_output=True, text=True, env=dict(
                os.environ, PATH=str(fakebin) + os.pathsep
                + os.environ["PATH"],
                HOME=str(tmp_path / "home")), timeout=60)
        assert proc.returncode == 1, (bad, proc.stdout + proc.stderr)
        assert "not a Canvas address the helper accepts" in \
            proc.stdout + proc.stderr, bad
        if log.exists():
            raise AssertionError(
                "the network probe ran for a refused address %r: %s"
                % (bad, log.read_text()))
