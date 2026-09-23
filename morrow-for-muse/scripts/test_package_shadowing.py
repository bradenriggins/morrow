"""The tree's own packages win over same-named packages installed on the machine.

A directory with no __init__.py is a namespace package, and Python prefers a
regular package with the same name anywhere on sys.path. A site-packages
`dispatch` or `config` would then replace the tree's code without an error.
"""

import json
import os
import subprocess
import sys

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TREE_PACKAGES = ("dispatch", "config", "transport", "reauth", "catalog",
                 "helper", "session")


def test_every_tree_package_is_a_regular_package():
    missing = [name for name in TREE_PACKAGES
               if not os.path.isfile(os.path.join(TREE, name, "__init__.py"))]
    assert missing == []


def test_tree_packages_win_over_installed_packages_of_the_same_name(tmp_path):
    for name in TREE_PACKAGES:
        pkg = tmp_path / name
        pkg.mkdir()
        (pkg / "__init__.py").write_text("SHADOW = True\n")
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


def test_executor_run_as_a_script_uses_the_trees_packages(tmp_path):
    # `python3 dispatch/executor.py` puts dispatch/ first on sys.path, not the
    # tree root, so a `dispatch` package found on PYTHONPATH (PyObjC ships one
    # on macOS) must not be the one the executor imports.
    for name in TREE_PACKAGES:
        pkg = tmp_path / "shadow" / name
        pkg.mkdir(parents=True)
        (pkg / "__init__.py").write_text("SHADOW = True\n")
    env = dict(os.environ, PYTHONPATH=str(tmp_path / "shadow"))
    result = subprocess.run(
        [sys.executable, os.path.join("dispatch", "executor.py"),
         "--canvas-base", "https://canvas.example.edu",
         "catalog", "--name", "users_self", "--method", "GET",
         "--path", "/api/v1/users/self", "--dry-run"],
        cwd=TREE, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["dry_run"] is True
