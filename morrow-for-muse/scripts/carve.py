#!/usr/bin/env python3
"""Carve the Morrow for Muse distribution from this source tree.

    python3 scripts/carve.py [--out DIR] [--zip]

Builds the installable tree install.sh expects (default
<repo>/dist/morrow-muse-connector) from the files git tracks under
morrow-for-muse/, then:

  1. drops the dev-only surface (see DEV_ONLY): live-test drivers,
     proof evidence with real tenant hosts, the Moodle/lanes research
     code, dev test harnesses that are not install suites, and every
     test_*.py that is not an install suite (scripts/install-suites.sh);
  2. normalizes tenant hosts in Markdown ONLY (docs carry provenance
     notes; code is never rewritten: a code file that names a real
     tenant fails the gate and the carve);
  3. checks every shipped Python file compiles and that no shipped
     module imports a dropped top-level package;
  4. writes pack/carve-manifest.json (sha256 of every shipped file,
     which install.sh step 2 verifies, and the commit the carve read)
     and checks pack/version.txt matches VERSION;
  5. runs scripts/verify-no-secrets.sh on the carved tree with no
     exclusions;
  6. with --zip, writes morrow-muse-connector-<version>.zip next to the
     tree (the archive INSTALL.md names).

The zip is what a release publishes, so --zip refuses to start while
any tracked file under morrow-for-muse/ or a REPO_FILES file differs
from the commit checked out: the zip then always holds that commit's
bytes. A tree carve (no --zip, as CI and the tests run it) reads the
working tree and records in its manifest whether it differed.

The repository's LICENSE (see REPO_FILES) ships at the tree root too:
the software's license lives outside morrow-for-muse/.

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
    "requirements-dev.txt", "requirements-test.txt",
    "scripts/install-robustness-selftest.sh", "scripts/carve.py",
    "scripts/install-e2e.sh",
    # rig-only session capture; production never runs it (SKILL.md)
    "session/capture.py",
    # the 2026-09-20 VM deployment record and its userspace scheduler
    # (no cron on that VM); the product's keepalive is helper/keepalive.sh,
    # supervised by cron or, without cron, by helper/supervisor.py's
    # background loop; Moodle is out for v1 (SCOPE.md)
    "DEPLOY.md", "bin/scheduler.py", "bin/scheduler_selftest.py",
    "bin/keepalive-canvas.sh", "bin/keepalive-moodle.sh",
    # live-test drivers: they need a real tenant and name it
    "dispatch/live_proof_modes.py", "dispatch/live_proof_new_quiz.py",
    "dispatch/live_proof_write_hardening.py", "failures/live_verify.py",
    "learners/live_verify_reads.py", "learners/live_verify_resolution.py",
    # internal audit and integration notes (status as of past waves)
    "audit/", "INTEGRATION_NOTES.md",
    # dev harnesses that are not install suites (install.sh step 9): CI
    # runs them from the source repository through scripts/dev-suites.sh,
    # and nothing would run them in the release
    "scripts/dev-suites.sh",
    "transport/selftest.py", "transport/browser_backend_selftest.py",
    "transport/item_bank_sdk_selftest.py",
    "provision/provision_selftest.py", "provision/launch_driver_selftest.py",
    "catalog/a11y/a11y_parity_selftest.py", "catalog/a11y/a11y_selftest.py",
    "dispatch/approval_display_selftest.py",
    "dispatch/catalog_gate_selftest.py", "dispatch/state_backup_selftest.py",
    "dispatch/wave3_hardening_selftest.py",
    "dispatch/wave5_concurrency_selftest.py",
    "dispatch/wave5_injection_selftest.py",
    "dispatch/wave6_crypto_selftest.py",
    "helper/educator_surface_selftest.py",
    "reauth/wave5_resource_selftest.py", "session/cdp_selftest.py",
    "transport/chromium_memory_selftest.py",
    "transport/local_chromium_selftest.py",
    "transport/wave5_injection_selftest.py",
    # the pytest suite's scratch-HOME isolation
    "conftest.py",
)
# Files git tracks at the repository root that ship at the tree root.
REPO_FILES = ("LICENSE",)
# pytest-only test modules: they rely on conftest.py to stay out of the
# live home, so run from an installed tree they would write the
# educator's live journal. Only the install suites, which isolate
# themselves, ship.
TEST_MODULE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test)\.py$")
# proof-battery/ is dev evidence except the catalog the executor reads
# and the one driver integration_selftest checks for hygiene.
PROOF_BATTERY_SHIPPED = ("proof-battery/OPERATION_CATALOG.md",
                         "proof-battery/item_bank_sdk_battery.py")
RESIDUE = re.compile(r"(^|/)(__pycache__|\.selftest-work|\.pytest_cache|"
                     r"\.test-state)(/|$)|\.py[co]$")

_TENANT = re.compile(r"(?<![%}A-Za-z0-9.-])([A-Za-z0-9-]+)"
                     r"((?:\.quiz-api(?:-[a-z0-9]+)*)?)\.instructure\.com",
                     re.IGNORECASE)


def install_suites(tree=SRC):
    """The install selftest suites, in order, as scripts/install-suites.sh
    lists them (install.sh step 9 and CI run that script)."""
    with open(os.path.join(tree, "scripts", "install-suites.sh"),
              encoding="utf-8") as fh:
        text = fh.read()
    return text.split('SUITES="', 1)[1].split('"', 1)[0].split()


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
    suites = set(install_suites())
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
        if TEST_MODULE.search(rel) and rel not in suites:
            continue
        if rel.startswith("proof-battery/") \
                and rel not in PROOF_BATTERY_SHIPPED:
            continue
        files.append(rel)
    return sorted(files)


def repo_files():
    """{rel: source path} for REPO_FILES. Refuses a missing or untracked
    file, and a file of the same name under morrow-for-muse/."""
    out = {}
    for rel in REPO_FILES:
        src = os.path.join(REPO, rel)
        tracked = subprocess.run(
            ["git", "-C", REPO, "ls-files", "--error-unmatch", "--", rel],
            capture_output=True).returncode == 0
        if not tracked or not os.path.isfile(src):
            raise SystemExit("CARVE FAIL: the repository's %s is missing "
                             "or not tracked by git" % rel)
        if os.path.exists(os.path.join(SRC, rel)):
            raise SystemExit("CARVE FAIL: morrow-for-muse/%s would shadow "
                             "the repository's %s" % (rel, rel))
        out[rel] = src
    return out


def _git_out(*args, **kwargs):
    return subprocess.run(["git", "-C", REPO] + list(args),
                          capture_output=True, check=True, **kwargs).stdout


def source_state(sources):
    """(commit, changed): the commit checked out, and the repository
    paths under morrow-for-muse/ or in REPO_FILES that differ from it.
    git diff names edits, staged changes, deleted and added files, and
    mode changes; comparing each source's bytes with the commit's also
    catches a file git was told to stop checking (assume-unchanged,
    skip-worktree)."""
    try:
        commit = _git_out("rev-parse", "--verify",
                          "HEAD^{commit}").decode().strip()
    except subprocess.CalledProcessError:
        raise SystemExit("CARVE FAIL: the repository has no commit to "
                         "carve from")
    scope = ["--", os.path.relpath(SRC, REPO)] + list(REPO_FILES)
    changed = {path.decode("utf-8") for path in _git_out(
        "diff", "--name-only", "--no-renames", "-z", "HEAD",
        *scope).split(b"\0") if path}
    committed = {}
    for entry in _git_out("ls-tree", "-r", "-z", "HEAD",
                          *scope).split(b"\0"):
        if entry:
            meta, path = entry.split(b"\t", 1)
            committed[path.decode("utf-8")] = meta.split()[2].decode()
    paths = sorted(os.path.relpath(src, REPO) for src in sources.values())
    ids = _git_out("hash-object", "--no-filters", "--stdin-paths",
                   input="".join(p + "\n" for p in paths).encode("utf-8")
                   ).decode().split()
    changed.update(path for path, blob in zip(paths, ids)
                   if committed.get(path) != blob)
    return commit, sorted(changed)


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
    sources = {rel: os.path.join(SRC, rel) for rel in shipped_files()}
    sources.update(repo_files())
    files = sorted(sources)
    commit, changed = source_state(sources)
    if make_zip and changed:
        raise SystemExit(
            "CARVE FAIL: a release zip must hold commit %s exactly, but "
            "%d file(s) differ from it:\n  %s\nCommit or discard these "
            "changes, then carve again." % (
                commit[:12], len(changed), "\n  ".join(changed[:20])
                + ("\n  ... and %d more" % (len(changed) - 20)
                   if len(changed) > 20 else "")))
    allowed = _allowed_hosts()
    parent = os.path.dirname(os.path.abspath(out_dir))
    os.makedirs(parent, exist_ok=True)
    if os.path.commonpath([os.path.abspath(out_dir), SRC]) == SRC:
        raise SystemExit("CARVE FAIL: --out must be outside the source tree")
    stage = tempfile.mkdtemp(prefix=".carve-stage-", dir=parent)
    try:
        normalized = []
        for rel in files:
            src, dst = sources[rel], os.path.join(stage, rel)
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
                              for rel in files},
                    "source_commit": commit,
                    "source_dirty": bool(changed)}
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
    print("carved %d files into %s (version %s, commit %s%s)"
          % (len(files), out_dir, version, commit[:12],
             ", with uncommitted changes" if changed else ""))
    for rel in normalized:
        print("  normalized tenant hosts in %s" % rel)
    if make_zip:
        print("wrote %s" % write_zip(out_dir))
    return out_dir


def write_zip(out_dir):
    """Zip the carved tree at out_dir, every file its manifest lists and
    the manifest, as <DIST_NAME>-<version>.zip beside it. Returns the
    zip's path."""
    with open(os.path.join(out_dir, "pack", "carve-manifest.json"),
              encoding="utf-8") as fh:
        manifest = json.load(fh)
    zpath = os.path.join(os.path.dirname(os.path.abspath(out_dir)),
                         "%s-%s.zip" % (DIST_NAME, manifest["carve_version"]))
    tmp = zpath + ".partial"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(list(manifest["files"])
                          + ["pack/carve-manifest.json"]):
            path = os.path.join(out_dir, rel)
            info = zipfile.ZipInfo.from_file(
                path, os.path.join(DIST_NAME, rel))
            with open(path, "rb") as fh:
                zf.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
    os.replace(tmp, zpath)
    return zpath


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=os.path.join(REPO, "dist", DIST_NAME))
    ap.add_argument("--zip", action="store_true")
    args = ap.parse_args(argv)
    carve(os.path.abspath(args.out), make_zip=args.zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
