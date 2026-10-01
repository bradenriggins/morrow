"""Guards on the governed Moodle dispatcher (shipped path)."""
import hashlib
import json

import pytest

from moodle.dispatch import MoodleDispatcher


def _assets(tmp_path):
    catalog = {"operations": [
        {"key": "op.write.v1", "toolName": "moodle_write_thing",
         "readOnly": False, "provider": "moodle"},
        {"key": "op.read.v1", "toolName": "moodle_read_thing",
         "readOnly": True, "provider": "moodle"},
    ]}
    catalog_raw = json.dumps(catalog).encode()
    routes = {"schema": "morrow.moodle-browser-routes.v1",
              "sources": {"moodle-browser-catalog.json": hashlib.sha256(catalog_raw).hexdigest(),
                          "moodle-adapter.js": "0" * 64},
              "operations": {
                  "op.write.v1": {"file": "moodle-adapter.js", "function": "run",
                                  "functionSha256": "1" * 64, "readOnly": False,
                                  "toolName": "moodle_write_thing",
                                  "inputKind": "operation",
                                  "attachmentMode": "none",
                                  "functionByteRange": [0, 8]},
                  "op.read.v1": {"file": "moodle-adapter.js", "function": "run",
                                 "functionSha256": "1" * 64, "readOnly": True,
                                 "toolName": "moodle_read_thing",
                                 "inputKind": "operation",
                                 "attachmentMode": "none",
                                 "functionByteRange": [0, 8]},
              }}
    routes_raw = json.dumps(routes).encode()
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "moodle-browser-routes.json").write_bytes(routes_raw)
    (assets / "moodle-browser-catalog.json").write_bytes(catalog_raw)
    return assets, hashlib.sha256(routes_raw).hexdigest()


class _Transport:
    base = "https://moodle.example.edu"
    principal_id = "educator-1"


def _dispatcher(tmp_path):
    assets, pin = _assets(tmp_path)
    return MoodleDispatcher(_Transport(), assets, registry_sha256=pin)


def test_write_without_course_id_refuses_cleanly(tmp_path):
    dispatcher = _dispatcher(tmp_path)
    with pytest.raises(ValueError, match="need a course ID"):
        dispatcher.descriptor("op.write.v1", {"expected_digest": "a" * 64})


def test_write_with_course_id_passes(tmp_path):
    dispatcher = _dispatcher(tmp_path)
    entry = dispatcher.descriptor(
        "op.write.v1", {"course_id": 2, "expected_digest": "a" * 64})
    assert entry["effects"] == "write"


def test_account_level_read_without_course_id_passes(tmp_path):
    dispatcher = _dispatcher(tmp_path)
    entry = dispatcher.descriptor("op.read.v1", {})
    assert entry["effects"] == "read"
