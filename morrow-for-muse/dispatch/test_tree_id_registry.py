"""Tree-id registry guards: changed, deleted, and duplicated ids."""
import os

import dispatch.executor as executor

UID = "f" * 32


def _tree_root():
    return os.path.realpath(
        os.path.dirname(os.path.dirname(
            os.path.abspath(executor.__file__))))


def test_shared_id_warns_but_runs(monkeypatch, capsys):
    monkeypatch.setattr(executor, "read_tree_uuid", lambda root: UID)
    registry = {_tree_root(): UID, "/other/copy": UID}
    monkeypatch.setattr(executor, "_read_tree_id_registry",
                        lambda: dict(registry))
    monkeypatch.setattr(executor, "_write_tree_id_registry",
                        lambda reg: registry.update(reg))
    assert executor._tree_id() == UID
    err = capsys.readouterr().err
    assert "also recorded for /other/copy" in err, err
    assert "Run only one of these roots" in err, err


def test_single_root_stays_silent(monkeypatch, capsys):
    monkeypatch.setattr(executor, "read_tree_uuid", lambda root: UID)
    registry = {_tree_root(): UID}
    monkeypatch.setattr(executor, "_read_tree_id_registry",
                        lambda: dict(registry))
    monkeypatch.setattr(executor, "_write_tree_id_registry",
                        lambda reg: registry.update(reg))
    assert executor._tree_id() == UID
    assert capsys.readouterr().err == ""
