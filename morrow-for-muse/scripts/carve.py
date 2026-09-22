#!/usr/bin/env python3
"""Carve the Morrow for Muse distribution from this source tree.

    python3 scripts/carve.py [--out DIR] [--zip]

Builds the installable tree install.sh expects (default
<repo>/dist/morrow-muse-connector) from the files git tracks under
morrow-for-muse/, then:

  1. drops the dev-only surface (see DEV_ONLY): live-test drivers,
     proof evidence with real tenant hosts, the Moodle/lanes research
     code, dev test harnesses that are not install suites;
  2. normalizes tenant hosts in Markdown ONLY (docs carry provenance
     notes; code is never rewritten: a code file that names a real
     tenant fails the gate and the carve);
  3. checks every shipped Python file compiles and that no shipped
     module imports a dropped top-level package;
  4. writes pack/carve-manifest.json (sha256 of every shipped file,
     which install.sh step 2 verifies) and checks pack/version.txt
     matches VERSION;
  5. runs scripts/verify-no-secrets.sh on the carved tree with no
     exclusions;
  6. with --zip, writes morrow-muse-connector-<version>.zip next to the
     tree (the archive INSTALL.md names).

Publication is atomic: the tree is staged beside --out and renamed
into place only after every check passes. Nothing is ever written
inside the source tree. Stdlib only.
"""

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(SRC)
DIST_NAME = "morrow-muse-connector"

# Prefixes (directories end with "/") and exact paths never shipped.
DEV_ONLY = (
    "moodle/", "lanes/", "qr-proof/", "platform-asks/", "learners/evidence/",
    "requirements-dev.txt",
    "scripts/install-robustness-selftest.sh", "scripts/carve.py",
    "scripts/test_carve.py", "scripts/install-e2e.sh",
    # rig-only session capture; production never runs it (SKILL.md)
    "session/capture.py",
    # live-test drivers: they need a real tenant and name it
    "dispatch/live_proof_modes.py", "dispatch/live_proof_new_quiz.py",
    "dispatch/live_proof_write_hardening.py", "failures/live_verify.py",
    "learners/live_verify_reads.py", "learners/live_verify_resolution.py",
    # dev harnesses that are not install suites (install.sh step 9)
    "transport/selftest.py", "transport/browser_backend_selftest.py",
    "transport/item_bank_sdk_selftest.py",
    "provision/provision_selftest.py", "provision/launch_driver_selftest.py",
)
# proof-battery/ is dev evidence except the catalog the executor reads
# and the one driver integration_selftest checks for hygiene.
PROOF_BATTERY_SHIPPED = ("proof-battery/OPERATION_CATALOG.md",
                         "proof-battery/item_bank_sdk_battery.py")
RESIDUE = re.compile(r"(^|/)(__pycache__|\.selftest-work|\.pytest_cache|"
                     r"\.test-state)(/|$)|\.py[co]$")

_TENANT = re.compile(r"(?<![%}A-Za-z0-9.-])([A-Za-z0-9-]+)"
                     r"((?:\.quiz-api(?:-[a-z0-9]+)*)?)\.instructure\.com",
                     re.IGNORECASE)


def _allowed_hosts():
    allowed, section = set(), None
    with open(os.path.join(SRC, "pack", "deny-list.txt"),
              encoding="utf-8") as fh:
        for line in fh:
            clean = line.split("#", 1)[0].strip()
            if clean.startswith("["):
                section = clean
            elif clean and section == "[tenant_allow]":
                allowed.add(clean.lower())
    return allowed


def shipped_files():
    out = subprocess.run(["git", "-C", SRC, "ls-files", "-z", "--", "."],
                         capture_output=True, check=True).stdout
    files = []
    for raw in out.split(b"\0"):
        if not raw:
            continue
        rel = raw.decode("utf-8")
        if not os.path.isfile(os.path.join(SRC, rel)):
            continue  # deleted in the working tree
        if RESIDUE.search(rel):
            continue
        if any(rel == p or (p.endswith("/") and rel.startswith(p))
               for p in DEV_ONLY):
            continue
        if rel.startswith("proof-battery/") \
                and rel not in PROOF_BATTERY_SHIPPED:
            continue
        files.append(rel)
    return sorted(files)


def normalize_markdown(text, allowed):
    def sub(m):
        host = (m.group(1) + m.group(2) + ".instructure.com").lower()
        if host in allowed:
            return m.group(0)
        return "example" + m.group(2).lower() + ".instructure.com"
    return _TENANT.sub(sub, text)


def _dropped_top_levels(files):
    shipped_tops = {f.split("/", 1)[0] for f in files}
    all_tops = {f.split("/", 1)[0] for f in subprocess.run(
        ["git", "-C", SRC, "ls-files", "--", "."], capture_output=True,
        text=True, check=True).stdout.split()}
    return {t for t in all_tops - shipped_tops if "." not in t}


def check_python(stage, files):
    dropped = _dropped_top_levels(files)
    problems = []
    for rel in files:
        if not rel.endswith(".py"):
            continue
        path = os.path.join(stage, rel)
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        try:
            compile(source, rel, "exec")
        except SyntaxError as exc:
            problems.append("does not compile: %s (%s)" % (rel, exc))
            continue
        tree = ast.parse(source, rel)
        for node in tree.body:
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module \
                    and node.level == 0:
                names = [node.module]
            for name in names:
                if name.split(".", 1)[0] in dropped:
                    problems.append("%s imports dropped package %r"
                                    % (rel, name))
    return problems


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def carve(out_dir, make_zip=False, run_gate=True):
    version = open(os.path.join(SRC, "VERSION")).read().strip()
    pack_version = open(os.path.join(SRC, "pack", "version.txt")).read().strip()
    if version != pack_version:
        raise SystemExit("CARVE FAIL: VERSION %r != pack/version.txt %r"
                         % (version, pack_version))
    files = shipped_files()
    allowed = _allowed_hosts()
    parent = os.path.dirname(os.path.abspath(out_dir))
    os.makedirs(parent, exist_ok=True)
    if os.path.commonpath([os.path.abspath(out_dir), SRC]) == SRC:
        raise SystemExit("CARVE FAIL: --out must be outside the source tree")
    stage = tempfile.mkdtemp(prefix=".carve-stage-", dir=parent)
    try:
        normalized = []
        for rel in files:
            src, dst = os.path.join(SRC, rel), os.path.join(stage, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if rel.endswith(".md"):
                with open(src, encoding="utf-8") as fh:
                    text = fh.read()
                new = normalize_markdown(text, allowed)
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(new)
                shutil.copymode(src, dst)
                if new != text:
                    normalized.append(rel)
            else:
                shutil.copy2(src, dst)
        problems = check_python(stage, files)
        if problems:
            raise SystemExit("CARVE FAIL:\n  " + "\n  ".join(problems))
        manifest = {"carve_version": version,
                    "files": {rel: sha256(os.path.join(stage, rel))
                              for rel in files}}
        with open(os.path.join(stage, "pack", "carve-manifest.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=1, sort_keys=True)
            fh.write("\n")
        gate = subprocess.run(
            ["bash", os.path.join(stage, "scripts", "verify-no-secrets.sh"),
             stage], capture_output=True, text=True,
            env=dict(os.environ, VERIFY_EXCLUDE="")) if run_gate else None
        if gate is not None and gate.returncode != 0:
            raise SystemExit("CARVE FAIL: secrets gate\n%s%s"
                             % (gate.stdout, gate.stderr))
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)
        os.replace(stage, out_dir)
        stage = None
    finally:
        if stage and os.path.exists(stage):
            shutil.rmtree(stage, ignore_errors=True)
    print("carved %d files into %s (version %s)" % (len(files), out_dir,
                                                    version))
    for rel in normalized:
        print("  normalized tenant hosts in %s" % rel)
    if make_zip:
        zpath = os.path.join(parent, "%s-%s.zip" % (DIST_NAME, version))
        tmp = zpath + ".partial"
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in sorted(files + ["pack/carve-manifest.json"]):
                path = os.path.join(out_dir, rel)
                info = zipfile.ZipInfo.from_file(
                    path, os.path.join(DIST_NAME, rel))
                with open(path, "rb") as fh:
                    zf.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
        os.replace(tmp, zpath)
        print("wrote %s" % zpath)
    return out_dir


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=os.path.join(REPO, "dist", DIST_NAME))
    ap.add_argument("--zip", action="store_true")
    args = ap.parse_args(argv)
    carve(os.path.abspath(args.out), make_zip=args.zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
