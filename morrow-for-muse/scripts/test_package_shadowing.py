"""The tree's own packages win over same-named packages installed on the machine.

A directory with no __init__.py is a namespace package, and Python prefers a
regular package with the same name anywhere on sys.path. A site-packages
`dispatch` or `config` would then replace the tree's code without an error.

Script mode (`python3 dispatch/executor.py ...`, the way SKILL.md and bin/morrow
run the tree) puts the script's own directory first on sys.path, not the tree
root. An entry point that imports a tree package before it puts the tree root
first loads the installed package instead: on Homebrew Python,
pyobjc-framework-libdispatch installs `dispatch`, and the executor then failed
with "cannot import name 'executor' from 'dispatch'".
"""

import ast
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carve  # noqa: E402

TREE_PACKAGES = ("catalog", "config", "dispatch", "failures", "helper",
                 "learners", "modes", "privacy", "query", "reauth", "session",
                 "settings", "transport")


def _write_shadows(root):
    """A regular package for every tree package name, like one pip installed."""
    for name in TREE_PACKAGES:
        pkg = root / name
        pkg.mkdir()
        (pkg / "__init__.py").write_text("SHADOW = True\n")


def test_every_tree_package_is_a_regular_package():
    missing = [name for name in TREE_PACKAGES
               if not os.path.isfile(os.path.join(TREE, name, "__init__.py"))]
    assert missing == []


def test_tree_packages_win_over_installed_packages_of_the_same_name(tmp_path):
    _write_shadows(tmp_path)
    probe = (
        "import importlib, os, sys\n"
        "sys.path.append(%r)\n"
        "for name in %r:\n"
        "    mod = importlib.import_module(name)\n"
        "    where = os.path.dirname(os.path.abspath(mod.__file__ or list(mod.__path__)[0]))\n"
        "    assert not getattr(mod, 'SHADOW', False), name\n"
        "    assert where.startswith(%r), (name, where)\n"
        "print('ok')\n" % (str(tmp_path), TREE_PACKAGES, TREE))
    result = subprocess.run([sys.executable, "-c", probe], cwd=TREE,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def _imported_tree_packages(rel):
    """Tree package names the file imports anywhere (module level or lazily
    inside a function)."""
    with open(os.path.join(TREE, rel), encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), rel)
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".", 1)[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module \
                and node.level == 0:
            names.add(node.module.split(".", 1)[0])
    return sorted(names & set(TREE_PACKAGES))


def _script_entry_points():
    """Every shipped file the tree runs as `python3 <path>` that imports a
    tree package."""
    out = []
    for rel in carve.shipped_files():
        path = os.path.join(TREE, rel)
        if rel != "bin/morrow" and not rel.endswith(".py"):
            continue
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        if rel != "bin/morrow" and "__main__" not in source:
            continue
        names = _imported_tree_packages(rel)
        if names:
            out.append((rel, names))
    return out


# Runs an entry point's module-level code the way `python3 <entry>` does
# (the script's directory first on sys.path), then imports every tree
# package the entry point imports anywhere, as its commands later would.
_ENTRY_PROBE = r"""
import importlib, json, os, runpy, sys
entry, tree, names = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
sys.argv = [entry]
sys.path[0] = os.path.dirname(os.path.realpath(entry))
runpy.run_path(entry, run_name="__shadow_probe__")
wrong = {}
for name in names:
    mod = importlib.import_module(name)
    where = os.path.realpath(mod.__file__ or list(mod.__path__)[0])
    if getattr(mod, "SHADOW", False) or not where.startswith(tree + os.sep):
        wrong[name] = where
print(json.dumps(wrong))
"""


def _entry_env(tmp_path, shadows):
    env = dict(os.environ, PYTHONPATH=str(shadows),
               PYTHONDONTWRITEBYTECODE="1",
               # helper/server.py refuses, at import, to boot on the
               # production ports or the tree's live profile.
               LOGIN_HELPER_PROFILE_DIR=str(tmp_path / "profile"),
               LOGIN_HELPER_PORT="18901", LOGIN_HELPER_CDP_PORT="19923")
    for name in ("CANVAS_BASE", "HELPER_AUTH_TOKEN", "HELPER_AUTH_TOKEN_FILE"):
        env.pop(name, None)
    return env


def test_every_script_entry_point_loads_the_tree_packages(tmp_path):
    shadows = tmp_path / "installed"
    shadows.mkdir()
    _write_shadows(shadows)
    entries = _script_entry_points()
    assert "dispatch/executor.py" in [rel for rel, _ in entries]
    env = _entry_env(tmp_path, shadows)
    failures = {}
    for rel, names in entries:
        result = subprocess.run(
            [sys.executable, "-c", _ENTRY_PROBE, os.path.join(TREE, rel),
             os.path.realpath(TREE), json.dumps(names)],
            cwd=str(tmp_path), env=env, capture_output=True, text=True,
            timeout=60)
        if result.returncode != 0:
            failures[rel] = result.stderr.strip().splitlines()[-1:]
            continue
        wrong = json.loads(result.stdout.strip().splitlines()[-1])
        if wrong:
            failures[rel] = wrong
    assert failures == {}


def test_approve_write_runs_in_script_mode_beside_an_installed_dispatch(
        tmp_path):
    """The reported failure: approve-write reaches a lazy `from dispatch
    import executor`, which the installed `dispatch` answered."""
    shadows = tmp_path / "installed"
    shadows.mkdir()
    _write_shadows(shadows)
    result = subprocess.run(
        [sys.executable, os.path.join(TREE, "dispatch", "executor.py"),
         "approve-write", "--op-id", "op-12345678", "--authorization", "Yes"],
        cwd=str(tmp_path), env=_entry_env(tmp_path, shadows),
        capture_output=True, text=True, timeout=60)
    text = result.stdout + result.stderr
    out = json.loads([line for line in text.splitlines()
                      if line.startswith("{")][-1])
    assert "cannot import" not in text
    assert out["error"] != "ImportError", out
