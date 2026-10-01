"""keepalive.sh tree-id resolution: deleted ids stop supervision.

Extracts the real tree-id functions from helper/keepalive.sh (the same
approach as scripts/test_install_helper_port.py) and runs tree_id()
against fixture trees and registries.
"""
import os
import subprocess

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _functions():
    with open(os.path.join(TREE, "helper", "keepalive.sh"),
              encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    start = next(i for i, line in enumerate(lines)
                 if line == "tree_id_bounded() {")
    end = next(i for i, line in enumerate(lines)
               if line == "tree_version() {")
    return "\n".join(lines[start:end])


def _run(tree_root, home):
    script = ("set -u\nTREE_ROOT=%s\nMORROW_HOME=%s\n%s\n"
              "TREE_ID=\"$(tree_id)\"; rc=$?; printf 'rc=%%s id=%%s\\n' "
              "\"$rc\" \"$TREE_ID\""
              % (tree_root, home, _functions()))
    return subprocess.run(["bash", "-c", script], capture_output=True,
                          text=True, timeout=60)


def _fixture(tmp_path, *, tree_id=None, registry=None):
    root = tmp_path / "tree"
    (root / "helper").mkdir(parents=True)
    if tree_id is not None:
        (root / ".morrow-tree-id").write_text(tree_id + "\n")
    home = tmp_path / "home"
    if registry is not None:
        trees = home / "trees"
        trees.mkdir(parents=True)
        (trees / ".tree-id-registry.json").write_text(registry)
    return str(root), str(home)


def test_deleted_id_stops_supervision(tmp_path):
    root, home = _fixture(
        tmp_path, registry='{"%s": "abc123"}' % os.path.realpath(
            os.path.join(str(tmp_path), "tree")))
    proc = _run(root, home)
    out = proc.stdout + proc.stderr
    assert "rc=1 " in out, out
    assert "was deleted" in out, out
    assert "Restore .morrow-tree-id from backup" in out, out


def test_missing_id_without_registry_falls_back_silently(tmp_path):
    root, home = _fixture(tmp_path)
    proc = _run(root, home)
    out = proc.stdout + proc.stderr
    assert "rc=0 " in out, out
    assert "ERROR" not in out, out


def test_malformed_id_warns_and_falls_back(tmp_path):
    root, home = _fixture(tmp_path, tree_id="not-a-uuid")
    proc = _run(root, home)
    out = proc.stdout + proc.stderr
    assert "rc=0 " in out, out
    assert "not a UUID" in out, out


def test_valid_id_wins(tmp_path):
    uuid = "a" * 32
    root, home = _fixture(tmp_path, tree_id=uuid)
    proc = _run(root, home)
    out = proc.stdout + proc.stderr
    assert "rc=0 id=%s" % uuid in out, out
