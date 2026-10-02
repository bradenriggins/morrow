#!/usr/bin/env python3
"""The Canvas lane validates its base URL at construction time.

Failure mode pinned down (written before the fix): ChromiumSession.load()
accepted any base string with no https/userinfo gate (unlike Moodle's
normalize_moodle_base), so an http base failed only late at CDP navigate,
after _tenant_tab_locked swallowed the navigation error, and was
misreported as session death. normalize_canvas_base now refuses
plaintext (unless CANVAS_BASE_ALLOW_HTTP=1) and userinfo up front, in
both ChromiumSession and LocalChromiumTransport constructors.
"""

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_TREE = os.path.dirname(HERE)
sys.path.insert(0, _TREE)

import local_chromium as lc  # noqa: E402
from transport import chromium_session as cs  # noqa: E402


def test_https_base_is_accepted_and_rstriped():
    assert lc.normalize_canvas_base("https://t.instructure.com/") == \
        "https://t.instructure.com"


def test_http_base_is_refused():
    with pytest.raises(ValueError, match="plaintext"):
        lc.normalize_canvas_base("http://t.instructure.com/")


def test_http_base_is_allowed_with_explicit_override(monkeypatch):
    monkeypatch.setenv("CANVAS_BASE_ALLOW_HTTP", "1")
    assert lc.normalize_canvas_base("http://127.0.0.1:9/") == \
        "http://127.0.0.1:9"


def test_userinfo_base_is_refused():
    with pytest.raises(ValueError, match="https origin"):
        lc.normalize_canvas_base("https://user:pass@t.instructure.com/")


def test_malformed_bases_are_refused():
    for bad in ("", "   ", "not a url", "ftp://t.instructure.com/",
                "https://", "https://t.instructure.com/x?y=1",
                "https://t.instructure.com/x#y", "https://t:0/"):
        with pytest.raises(ValueError):
            lc.normalize_canvas_base(bad)


def test_session_construction_gates_the_base():
    with pytest.raises(ValueError, match="plaintext"):
        cs.ChromiumSession("http://t.instructure.com/", transport=object())
    with pytest.raises(ValueError, match="https origin"):
        cs.ChromiumSession("https://u:p@t.instructure.com/",
                           transport=object())
    sess = cs.ChromiumSession("https://t.instructure.com/",
                              transport=object())
    assert sess.base_for("canvas") == "https://t.instructure.com"


def test_transport_construction_gates_the_base():
    launcher = lc.ChromiumLauncher.__new__(lc.ChromiumLauncher)
    launcher.cdp = object()
    with pytest.raises(ValueError, match="plaintext"):
        lc.LocalChromiumTransport("http://t.instructure.com/", launcher)
    assert lc.LocalChromiumTransport(
        "https://t.instructure.com/", launcher).base == \
        "https://t.instructure.com"


def test_load_gates_an_http_base(monkeypatch):
    monkeypatch.delenv("CANVAS_BASE_ALLOW_HTTP", raising=False)
    with pytest.raises(ValueError, match="plaintext"):
        cs.ChromiumSession.load(base_url="http://t.instructure.com/")
