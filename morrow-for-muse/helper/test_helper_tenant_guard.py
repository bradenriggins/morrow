#!/usr/bin/env python3
"""The helper page cannot move the session browser off the tenant.

Failure modes this suite pins down (written before the fix; muse UX
audit 3, finding muse-ux3/helper-page-address-box-breaks-sign-in):
  1. The header's "Canvas site address" box and Go button POSTed
     /navigate, which sent the helper's browser (the one holding the
     Canvas session) to any HTTPS host without a tenant check. A
     sign-in finished on canvas.school.example.edu while CANVAS_BASE is
     canvas.school.instructure.com never counts: /status keeps
     logged_in false and the badge says "checking…" forever, so the
     educator signs in again on a page that cannot accept them.
  2. The box also let the session browser open any other site, while
     the sign-in playbook says the helper browser goes to Canvas only.

CANVAS_BASE is set by the agent after install.sh's probe; the page has
no address box. POST /navigate refuses any URL outside the configured
tenant base (same origin), and HelperBrowser.navigate refuses it too
(the handler path and any future caller), before the CDP navigate
runs. Hermetic: a stub CDP records the URL; no Chromium starts.
"""

import importlib.util
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
for _p in (TREE, os.path.join(TREE, "transport"), HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _server_module():
    import config.selftest_home  # noqa: F401  (scratch HOME/MORROW_HOME)
    spec = importlib.util.spec_from_file_location(
        "helper_server_addrbox", os.path.join(HERE, "server.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _StubCdp:
    def __init__(self):
        self.navigated = []

    def navigate(self, tab, url, timeout=30):
        self.navigated.append(url)

    def evaluate(self, tab, expression, timeout=15, await_promise=False):
        return '{"href": "about:blank"}'


def _browser(server, base):
    browser = server.HelperBrowser.__new__(server.HelperBrowser)
    browser._lock = threading.Lock()
    browser.cdp = _StubCdp()
    browser.tab = {"id": "STUB", "type": "page", "url": "about:blank"}
    browser.base_url = server._normalize_tenant_base(base)
    browser._cookie_expiry_read_ok = True
    return browser


BASE = "https://lincolnhs.instructure.com"
OTHER_HOST = "https://canvas.lincolnhs.edu"


def test_navigate_refuses_a_url_outside_the_tenant():
    server = _server_module()
    browser = _browser(server, BASE)
    try:
        browser.navigate(OTHER_HOST)
    except ValueError as exc:
        assert "Canvas" in str(exc), str(exc)
    else:
        raise AssertionError("off-tenant navigate accepted")
    assert browser.cdp.navigated == [], browser.cdp.navigated


def test_navigate_still_accepts_the_tenant_itself():
    server = _server_module()
    browser = _browser(server, BASE)
    browser.navigate(BASE + "/courses/1")
    assert browser.cdp.navigated == [BASE + "/courses/1"]
    browser.navigate(BASE + "/")  # the same origin, plain
    assert browser.cdp.navigated == [BASE + "/courses/1", BASE + "/"]


def test_navigate_still_refuses_non_https():
    server = _server_module()
    browser = _browser(server, BASE)
    for bad in ("http://lincolnhs.instructure.com/", "file:///etc/passwd",
                "javascript:alert(1)", ""):
        try:
            browser.navigate(bad)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted %r" % bad)
    assert browser.cdp.navigated == []


def test_a_tenant_origin_with_another_scheme_or_port_is_refused():
    server = _server_module()
    browser = _browser(server, BASE)
    for bad in ("https://other.instructure.com", "https://lincolnhs.evil.com"):
        try:
            browser.navigate(bad)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted %r" % bad)
    assert browser.cdp.navigated == []


def test_the_page_has_no_address_box_and_no_navigate_call():
    with open(os.path.join(HERE, "index.html"), encoding="utf-8") as fh:
        page = fh.read()
    assert "Canvas site address" not in page
    assert 'id="tenant"' not in page
    assert 'id="go"' not in page
    assert "goTenant" not in page
