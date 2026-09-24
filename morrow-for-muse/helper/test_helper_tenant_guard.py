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

Security review 2026-09-24: the same rules cover the CDP proxy routes
(the /cdp/* token is one bearer secret, so /cdp/new-tab and
/cdp/navigate cannot be weaker than /navigate), a target with no host
("https:evil.com" is scheme https, host none, and CDP Page.navigate
normalizes it to https://evil.com/), and a sibling host whose name
makes the target string start with the base URL.
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
        self.opened = []

    def navigate(self, tab, url, timeout=30):
        self.navigated.append(url)

    def new_tab(self, url, timeout=30):
        self.opened.append(url)
        return {"id": "NEW", "type": "page", "url": url}

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


def test_navigate_refuses_a_target_with_no_host():
    # "https:evil.com" is scheme https with an empty netloc; CDP
    # Page.navigate normalizes it to https://evil.com/, so the old
    # netloc-presence gate let the session browser leave the tenant.
    server = _server_module()
    browser = _browser(server, BASE)
    for bad in ("https:attacker.example/", "https:lincolnhs.instructure.com",
                "https:/attacker.example/"):
        try:
            browser.navigate(bad)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted %r" % bad)
    assert browser.cdp.navigated == []


def test_navigate_refuses_a_sibling_host_the_base_is_a_prefix_of():
    # The old startswith() gate accepted this: the target string starts
    # with the base URL, but the origin is a different host.
    server = _server_module()
    browser = _browser(server, BASE)
    try:
        browser.navigate(BASE + ".evil.example/courses/1")
    except ValueError:
        pass
    else:
        raise AssertionError("accepted a sibling host")
    assert browser.cdp.navigated == []


def _proxy_browser(server):
    browser = _browser(server, BASE)
    browser._proxy_resolve = lambda target_id: (
        {"id": target_id, "type": "page", "url": "about:blank"}
        if target_id else None)
    return browser


def test_cdp_proxy_new_tab_refuses_an_off_tenant_target():
    server = _server_module()
    browser = _proxy_browser(server)
    try:
        browser.cdp_proxy_new_tab("https://canvas.lincolnhs.edu/")
    except server._HttpError as exc:
        assert exc.code == 400, exc.code
    else:
        raise AssertionError("off-tenant new-tab accepted")
    assert browser.cdp.opened == [], browser.cdp.opened
    assert browser.cdp.navigated == [], browser.cdp.navigated


def test_cdp_proxy_new_tab_still_allows_blank_and_the_tenant():
    server = _server_module()
    browser = _proxy_browser(server)
    browser.cdp_proxy_new_tab("about:blank")
    browser.cdp_proxy_new_tab(BASE + "/courses/1")
    assert browser.cdp.opened == ["about:blank", BASE + "/courses/1"]


def test_cdp_proxy_navigate_refuses_an_off_tenant_target():
    server = _server_module()
    browser = _proxy_browser(server)
    for bad in ("https://canvas.lincolnhs.edu/",
                "https:attacker.example/",
                BASE + ".evil.example/courses/1"):
        try:
            browser.cdp_proxy_navigate("STUB", bad, 30)
        except server._HttpError as exc:
            assert exc.code == 400, (bad, exc.code)
        else:
            raise AssertionError("off-tenant proxy navigate accepted %r" % bad)
    assert browser.cdp.navigated == [], browser.cdp.navigated


def test_cdp_proxy_navigate_still_allows_the_tenant():
    server = _server_module()
    browser = _proxy_browser(server)
    browser.cdp_proxy_navigate("STUB", BASE + "/courses/1", 30)
    assert browser.cdp.navigated == [BASE + "/courses/1"]


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
