#!/usr/bin/env python3
"""The carve pipeline and repository hygiene it depends on.

Failure modes pinned down (written before the fix):
  1. install.sh step 2 requires pack/carve-manifest.json, but nothing in
     the repo produced it, so the repo could not be installed at all.
  2. The manifest must cover every shipped file with its real sha256,
     or install.sh's integrity walk fails (or passes a tampered file).
  3. The carved tree must pass the secrets gate with no exclusions:
     no tenant hosts in code, no scratch, no session material.
  4. Dev-only surface (live drivers, proof evidence, Moodle research)
     must not ship.
  5. Test scratch (vault keys, a Cookies file) was committed under
     privacy/.selftest-work/. No scratch may be tracked, and git must
     ignore it so it cannot be committed again.
  6. The release shipped the pytest-only test modules but not
     conftest.py, which keeps them out of the live home. Run from the
     installed tree (modes/README.md said to), they wrote the live
     journal's generation high-water, and the live journal then refused
     every read as a STALE restore (final sweep 2026-09-23). Only the
     install suites ship; each keeps itself out of the live home.
  7. The release zip held no license. The repository's MIT LICENSE sits
     outside morrow-for-muse/, and the carve ships only files under it,
     so an institution reviewing the zip had no license grant, though
     the website says the license text travels with the source (final
     sweep 2026-09-23).
  8. The release zip (--zip, docs/versioning.md step 5) copied the
     working tree without checking it matched a commit, and recorded
     none, so an uncommitted edit (a debug line in SKILL.md) shipped in
     a zip that no longer matched its tag, and install.sh's integrity
     check, which compares the zip with its own manifest, could not
     tell. The zip must refuse any tracked change under morrow-for-muse/
     or to LICENSE: an edit, a staged change, a deleted or added file, a
     mode change, and an edit git was told to ignore (assume-unchanged).
     Untracked files never ship, so they do not block it. Every carve
     records the commit it read and whether the tree differed from it
     (final sweep 2026-09-23).

The full install proof (install.sh run from the carved tree into a
scratch HOME/MORROW_HOME, then disconnect and uninstall) runs in a
Linux container: scripts/install-e2e.sh. Scratch lives under
.selftest-work/ (never /tmp).
"""

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carve  # noqa: E402


def _git(*args):
    return subprocess.run(["git", "-C", TREE] + list(args),
                          capture_output=True, text=True)


def test_no_scratch_is_tracked():
    tracked = _git("ls-files").stdout.split("\n")
    bad = [p for p in tracked
           if ".selftest-work/" in p or "__pycache__/" in p
           or p.endswith((".pyc", ".pyo")) or ".test-state/" in p]
    assert not bad, "tracked scratch: %s" % bad[:10]


@pytest.mark.parametrize("path", [
    "privacy/.selftest-work/wire-purge-vault.json.key",
    "dispatch/.selftest-work/journal/ops.jsonl",
    "modes/.test-state/pid-1/modes/grants/x.json",
])
def test_scratch_is_ignored(path):
    assert _git("check-ignore", "-q", path).returncode == 0, path


@pytest.fixture(scope="module")
def carved():
    root = os.path.join(HERE, ".selftest-work", "carve-%d" % os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    out = os.path.join(os.path.dirname(TREE), "dist", "carve-test-%d"
                       % os.getpid(), carve.DIST_NAME)
    try:
        # The secrets gate takes minutes over the whole tree; the gate
        # test below runs it once, and scripts/install-e2e.sh always does.
        # A zip needs a committed tree; the zip tests below build one.
        carve.carve(out, run_gate=False)
        yield out
    finally:
        shutil.rmtree(os.path.dirname(out), ignore_errors=True)
        shutil.rmtree(root, ignore_errors=True)


def test_manifest_covers_every_shipped_file(carved):
    with open(os.path.join(carved, "pack", "carve-manifest.json")) as fh:
        man = json.load(fh)
    on_disk = set()
    for root, _dirs, files in os.walk(carved):
        for name in files:
            on_disk.add(os.path.relpath(os.path.join(root, name), carved))
    assert on_disk - set(man["files"]) == {"pack/carve-manifest.json"}
    for rel, want in man["files"].items():
        with open(os.path.join(carved, rel), "rb") as fh:
            assert hashlib.sha256(fh.read()).hexdigest() == want, rel
    with open(os.path.join(TREE, "VERSION")) as fh:
        assert man["carve_version"] == fh.read().strip()


def test_the_license_ships_in_the_tree_and_the_zip(carved):
    with open(os.path.join(os.path.dirname(TREE), "LICENSE"), "rb") as fh:
        license_text = fh.read()
    assert license_text.startswith(b"MIT License")
    with open(os.path.join(carved, "LICENSE"), "rb") as fh:
        assert fh.read() == license_text
    with open(os.path.join(carved, "pack", "carve-manifest.json")) as fh:
        assert "LICENSE" in json.load(fh)["files"]
    with open(os.path.join(TREE, "VERSION")) as fh:
        version = fh.read().strip()
    zpath = carve.write_zip(carved)
    assert zpath == os.path.join(os.path.dirname(carved), "%s-%s.zip"
                                 % (carve.DIST_NAME, version))
    with zipfile.ZipFile(zpath) as zf:
        assert zf.read(carve.DIST_NAME + "/LICENSE") == license_text


def test_manifest_names_the_commit_it_was_carved_from(carved):
    with open(os.path.join(carved, "pack", "carve-manifest.json")) as fh:
        man = json.load(fh)
    assert man["source_commit"] == _git("rev-parse", "HEAD").stdout.strip()
    assert isinstance(man["source_dirty"], bool)


def _mini_git(repo, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null",
         "-c", "commit.gpgsign=false", "-c", "user.name=carve test",
         "-c", "user.email=carve-test@example.invalid"] + list(args),
        capture_output=True, text=True, check=True, env=env)


@pytest.fixture
def mini(tmp_path, monkeypatch):
    """A committed repository with this carve.py and the least tree it
    needs: (repo, its carve module)."""
    for name in [k for k in os.environ if k.startswith("GIT_")]:
        monkeypatch.delenv(name)
    repo = tmp_path / "repo"
    files = {
        "LICENSE": "MIT License\n\nmini\n",
        "other/README.md": "outside morrow-for-muse\n",
        "morrow-for-muse/VERSION": "9.9.9\n",
        "morrow-for-muse/pack/version.txt": "9.9.9\n",
        "morrow-for-muse/pack/deny-list.txt": "[tenant_allow]\n",
        "morrow-for-muse/scripts/install-suites.sh": 'SUITES=""\n',
        "morrow-for-muse/SKILL.md": "# Skill\n",
        "morrow-for-muse/tool.py": "X = 1\n",
    }
    for rel, text in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    script = repo / "morrow-for-muse" / "scripts" / "carve.py"
    shutil.copy2(os.path.join(HERE, "carve.py"), str(script))
    _mini_git(repo, "init", "-q")
    _mini_git(repo, "add", "-A")
    _mini_git(repo, "commit", "-q", "-m", "mini")
    spec = importlib.util.spec_from_file_location("carve_mini", str(script))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return repo, module


def _append(path, text="uncommitted local edit\n"):
    with open(str(path), "a", encoding="utf-8") as fh:
        fh.write(text)


def _modify(repo):
    _append(repo / "morrow-for-muse" / "SKILL.md")
    return "morrow-for-muse/SKILL.md"


def _stage(repo):
    _modify(repo)
    _mini_git(repo, "add", "-A")
    return "morrow-for-muse/SKILL.md"


def _delete(repo):
    os.remove(str(repo / "morrow-for-muse" / "tool.py"))
    return "morrow-for-muse/tool.py"


def _add(repo):
    (repo / "morrow-for-muse" / "new.py").write_text("Y = 2\n")
    _mini_git(repo, "add", "morrow-for-muse/new.py")
    return "morrow-for-muse/new.py"


def _license(repo):
    _append(repo / "LICENSE")
    return "LICENSE"


def _mode(repo):
    os.chmod(str(repo / "morrow-for-muse" / "SKILL.md"), 0o755)
    return "morrow-for-muse/SKILL.md"


def _hidden(repo):
    _mini_git(repo, "update-index", "--assume-unchanged",
              "morrow-for-muse/SKILL.md")
    return _modify(repo)


@pytest.mark.parametrize("change", [_modify, _stage, _delete, _add,
                                    _license, _mode, _hidden],
                         ids=lambda f: f.__name__.strip("_"))
def test_the_release_zip_refuses_uncommitted_changes(mini, change):
    repo, mini_carve = mini
    changed = change(repo)
    out = repo / "dist" / mini_carve.DIST_NAME
    with pytest.raises(SystemExit) as refused:
        mini_carve.carve(str(out), make_zip=True, run_gate=False)
    assert changed in str(refused.value), str(refused.value)
    assert not (repo / "dist").exists()


def test_a_clean_checkout_zips_and_records_its_commit(mini):
    repo, mini_carve = mini
    # Neither ships: an untracked file, and a change outside
    # morrow-for-muse/.
    (repo / "morrow-for-muse" / "scratch.txt").write_text("untracked\n")
    _append(repo / "other" / "README.md")
    head = _mini_git(repo, "rev-parse", "HEAD").stdout.strip()
    out = repo / "dist" / mini_carve.DIST_NAME
    mini_carve.carve(str(out), make_zip=True, run_gate=False)
    with open(str(out / "pack" / "carve-manifest.json")) as fh:
        man = json.load(fh)
    assert man["source_commit"] == head
    assert man["source_dirty"] is False
    assert "scratch.txt" not in man["files"]
    zpath = repo / "dist" / ("%s-9.9.9.zip" % mini_carve.DIST_NAME)
    with zipfile.ZipFile(str(zpath)) as zf:
        root = mini_carve.DIST_NAME + "/"
        assert json.loads(zf.read(root + "pack/carve-manifest.json")) == man
        assert zf.read(root + "SKILL.md") == b"# Skill\n"
        assert zf.read(root + "LICENSE") == b"MIT License\n\nmini\n"


def test_a_tree_carve_of_uncommitted_changes_says_so(mini):
    # CI and the tests carve the working tree; only the zip is a release.
    repo, mini_carve = mini
    _modify(repo)
    head = _mini_git(repo, "rev-parse", "HEAD").stdout.strip()
    out = repo / "dist" / mini_carve.DIST_NAME
    mini_carve.carve(str(out), run_gate=False)
    with open(str(out / "pack" / "carve-manifest.json")) as fh:
        man = json.load(fh)
    assert man["source_commit"] == head
    assert man["source_dirty"] is True
    assert os.listdir(str(repo / "dist")) == [mini_carve.DIST_NAME]


@pytest.mark.skipif(not os.environ.get("MORROW_CARVE_GATE"),
                    reason="slow (minutes); set MORROW_CARVE_GATE=1, or run "
                           "scripts/install-e2e.sh, which always gates")
def test_carved_tree_passes_secrets_gate_without_exclusions(carved):
    proc = subprocess.run(
        ["bash", os.path.join(carved, "scripts", "verify-no-secrets.sh"),
         carved], capture_output=True, text=True,
        env=dict(os.environ, VERIFY_EXCLUDE=""))
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_dev_only_surface_does_not_ship(carved):
    for rel in ("moodle", "lanes", "qr-proof", "learners/evidence",
                "proof-battery/evidence", "dispatch/live_proof_modes.py",
                "session/capture.py", "requirements-dev.txt",
                # CI's hash-locked pytest; the install suites need none
                "requirements-test.txt",
                "scripts/carve.py", "bin/keepalive-moodle.sh",
                "bin/keepalive-canvas.sh", "bin/scheduler.py", "DEPLOY.md",
                # pytest-only: the suite's HOME isolation and its check
                "conftest.py", "test_suite_isolation.py",
                # pytest-only: the conftest warning check, and the doc
                # count check (it reads DEPLOY.md, which does not ship)
                "test_optional_dependency_warning.py",
                "test_doc_catalog_counts.py", "test_educator_pages.py",
                # the retired form relay (SCOPE.md: no form-relay code
                # ships) and internal audit notes with stale status
                "transport/form_host_server.py",
                "transport/form_host_server_selftest.py",
                "transport/form-host", "audit", "INTEGRATION_NOTES.md"):
        assert not os.path.exists(os.path.join(carved, rel)), rel
    for rel in ("install.sh", "proof-battery/OPERATION_CATALOG.md",
                "scripts/uninstall.sh", "dispatch/executor.py",
                "SKILL.md", "INSTALL.md"):
        assert os.path.exists(os.path.join(carved, rel)), rel


def test_no_pytest_only_module_ships(carved):
    import re
    suites = set(carve.install_suites())
    shipped = []
    for root, _dirs, files in os.walk(carved):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), carved)
            if re.fullmatch(r"test_.*\.py|.*_test\.py|conftest\.py", name) \
                    and rel not in suites:
                shipped.append(rel)
    assert shipped == [], shipped


def test_no_shipped_doc_says_to_run_pytest(carved):
    said = []
    for root, _dirs, files in os.walk(carved):
        for name in files:
            if not name.endswith(".md") or name == "CHANGELOG.md":
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8") as fh:
                if "pytest" in fh.read():
                    said.append(os.path.relpath(path, carved))
    assert said == [], said


def test_every_install_suite_ships(carved):
    for suite in carve.install_suites():
        assert os.path.isfile(os.path.join(carved, suite)), suite
    assert os.path.isfile(os.path.join(carved, "scripts",
                                       "install-suites.sh"))


def test_carve_refuses_output_inside_source():
    with pytest.raises(SystemExit):
        carve.carve(os.path.join(TREE, "dist-inside"))
    assert not os.path.exists(os.path.join(TREE, "dist-inside"))


def test_shipped_docs_name_no_missing_file_as_shipped(carved):
    # A shipped doc may mention dev-only code (moodle/, session/capture.py)
    # only while saying it is not shipped; otherwise the educator (or the
    # agent) is sent to a file the release does not contain.
    import re
    path_re = re.compile(r"(?<![\w/.-])((?:[a-z_]+/)+[a-z_.-]+\.(?:py|sh))\b")
    stale = []
    for rel in ("failures/catalog.json", "SCOPE.md", "SKILL.md",
                "INSTALL.md", "FIRST_RUN.md", "modes/README.md",
                "privacy/FERPA_POLICY.md"):
        with open(os.path.join(carved, rel), encoding="utf-8") as fh:
            text = fh.read()
        for match in path_re.finditer(text):
            name = match.group(1)
            if name.startswith(("~/", "/")) or "<" in name:
                continue
            if os.path.exists(os.path.join(carved, name)):
                continue
            window = text[max(0, match.start() - 200):match.end() + 200]
            if "not shipped" in window or "not in the release" in window:
                continue
            stale.append("%s: %s" % (rel, name))
    assert not stale, stale


# A doc says a path is not in the release with one of these (known-6).
_LEFT_OUT_RE = re.compile(r"source repository|not shipped|not in the "
                          r"release|does not (?:ship|carry)|not carried")
_PATH_TOKEN_RE = re.compile(r"(?<![\w./~<$-])((?:[\w.-]+/)+[\w.-]*"
                            r"|[\w-]+\.(?:py|sh|md|json|txt|html))")


def _left_out():
    """(files, dirs) git tracks here that the release leaves out."""
    shipped = set(carve.shipped_files())
    tracked = {p for p in _git("ls-files", "-z").stdout.split("\0") if p}
    files = tracked - shipped
    dirs = set()
    for rel in files:
        parts = rel.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i])
            if not any(s.startswith(d + "/") for s in shipped):
                dirs.add(d)
    return files, dirs


def _catalog_citations(text):
    """The catalog's "Evidence citations" section: row notes cite
    provenance records it names there."""
    section = text.split("## Evidence citations", 1)[-1].split("\n## ", 1)[0]
    section = " ".join(section.split())
    return section if _LEFT_OUT_RE.search(section) else ""


def test_shipped_docs_say_so_when_they_name_what_the_release_leaves_out():
    # known-6: transport/README.md and other shipped docs named files the
    # carve drops (session/capture.py, lanes/detect.py, proof-battery
    # evidence) as if they were there. A shipped doc may name one only
    # while saying it is not in the release. CHANGELOG.md is history.
    files, dirs = _left_out()
    unmarked = []
    for doc in carve.shipped_files():
        if not doc.endswith(".md") or doc == "CHANGELOG.md":
            continue
        with open(os.path.join(TREE, doc), encoding="utf-8") as fh:
            text = fh.read()
        citations = _catalog_citations(text) \
            if doc == "proof-battery/OPERATION_CATALOG.md" else ""
        for match in _PATH_TOKEN_RE.finditer(text):
            token = match.group(1).rstrip("/.,:;")
            names = {token, os.path.normpath(
                os.path.join(os.path.dirname(doc), token))}
            named = sorted(n for n in names if n in files or n in dirs)
            if not named:
                continue
            window = text[max(0, match.start() - 300):match.end() + 300]
            if _LEFT_OUT_RE.search(" ".join(window.split())):
                continue
            line_start = text.rfind("\n", 0, match.start()) + 1
            if citations and text.startswith("|", line_start) \
                    and token in citations:
                continue
            unmarked.append("%s: %s" % (doc, named[0]))
    assert unmarked == [], sorted(set(unmarked))


def test_no_shipped_file_invokes_a_dev_only_script(carved):
    # Nothing in the release may call a script the carve leaves out.
    missing = []
    for root, _dirs, files in os.walk(carved):
        for name in files:
            if not name.endswith((".py", ".sh")):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            for script in ("keepalive-moodle.sh", "keepalive-canvas.sh",
                           "bin/scheduler.py"):
                if script in text:
                    missing.append("%s -> %s"
                                   % (os.path.relpath(path, carved), script))
    assert not missing, missing


def test_chromium_selftest_allowlist_scan_needs_no_rig_only_code(
        carved, tmp_path):
    # local_chromium_selftest.py once shipped, and its allowlist scan
    # opened session/capture.py, which the carve leaves out, so it failed
    # in every released tree. It now runs in the source repository's CI
    # (scripts/dev-suites.sh), not from the release; its scan must still
    # pass in a tree without the rig-only capture module.
    suite = os.path.join("transport", "local_chromium_selftest.py")
    assert not os.path.exists(os.path.join(carved, suite))
    assert not os.path.exists(os.path.join(carved, "session", "capture.py"))
    tree = tmp_path / "release"
    shutil.copytree(carved, str(tree), symlinks=True)
    shutil.copy2(os.path.join(TREE, suite), str(tree / suite))
    probe = ("import local_chromium_selftest as t\n"
             "t._t_proxy_generic_call_methods_allowlisted()\n"
             "raise SystemExit(1 if t.FAIL else 0)\n")
    result = subprocess.run([sys.executable, "-c", probe],
                            cwd=str(tree / "transport"),
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def test_env_template_promises_only_what_keepalive_honors():
    # keepalive.sh always pins the helper profile to <tree>/helper/profile,
    # so the tree env template must not offer LOGIN_HELPER_PROFILE_DIR as
    # a setting (it would be silently overridden).
    with open(os.path.join(TREE, "install.sh"), encoding="utf-8") as fh:
        text = fh.read()
    template = text.split('cat > "${TREE_ENV_FILE}" <<\'EOF\'', 1)[1]
    template = template.split("\nEOF\n", 1)[0]
    assert "LOGIN_HELPER_PROFILE_DIR=" not in template
    assert "helper/profile" in template
    with open(os.path.join(TREE, "helper", "keepalive.sh"),
              encoding="utf-8") as fh:
        keepalive = fh.read()
    assert 'export LOGIN_HELPER_PROFILE_DIR="${HELPER_DIR}/profile"' \
        in keepalive
