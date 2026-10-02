#!/usr/bin/env python3
"""The --verify-direct probe never leaks session cookies cross-host.

Failure mode pinned down (written before the fix): direct_probe
attached the raw session cookies to a stock urllib opener, which
follows 301/302/303/307/308 silently and re-sends the Cookie header
to the redirect target, cross-host. The probe now goes through
_SameOriginRedirectHandler (the executor's _NoDowngradeRedirectHandler
policy): off-host and https->http redirects are refused, same-origin
redirects are followed.
"""

import http.server
import os
import socketserver
import sys
import threading
import urllib.error
import urllib.request

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import capture  # noqa: E402


class _ThreadingTCPServer(socketserver.ThreadingMixIn,
                          socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


@pytest.fixture
def servers():
    """(tenant_url, evil_url, evil_hits): the tenant 302s the probe path
    off-host; the evil server records every request it sees."""
    evil_hits = []

    class _Evil(http.server.BaseHTTPRequestHandler):
        def _record(self):
            evil_hits.append((self.path,
                              self.headers.get("Cookie")))
            body = b"evil"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = _record
        do_POST = _record

        def log_message(self, *a):
            pass

    evil = _ThreadingTCPServer(("127.0.0.1", 0), _Evil)
    evil_url = "http://127.0.0.1:%d" % evil.server_address[1]

    class _Tenant(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/api/v1/users/self":
                target = evil_url + "/collect"
                body = b"moved"
                self.send_response(302)
                self.send_header("Location", target)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/api/v1/users/self-final":
                body = b'{"id": 1}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/api/v1/users/self-hop":
                body = b"moved"
                self.send_response(302)
                self.send_header("Location",
                                 "/api/v1/users/self-final")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *a):
            pass

    tenant = _ThreadingTCPServer(("127.0.0.1", 0), _Tenant)
    tenant_url = "http://127.0.0.1:%d" % tenant.server_address[1]
    for srv in (evil, tenant):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield tenant_url, evil_url, evil_hits
    finally:
        tenant.shutdown()
        evil.shutdown()
        tenant.server_close()
        evil.server_close()


def test_cross_host_redirect_is_refused_and_cookies_stay_home(servers):
    tenant_url, _evil_url, evil_hits = servers
    status = capture.direct_probe(
        tenant_url, "canvas_session=SECRET-VALUE; _csrf_token=CSRF")
    assert status == 302
    assert evil_hits == [], evil_hits


def test_same_origin_redirect_is_followed(servers):
    tenant_url, _evil_url, evil_hits = servers
    rq = urllib.request.Request(
        tenant_url + "/api/v1/users/self-hop",
        headers={"Cookie": "canvas_session=SECRET-VALUE"})
    with capture._SAFE_OPENER.open(rq, timeout=20) as resp:
        assert resp.status == 200
        assert resp.read() == b'{"id": 1}'
    assert evil_hits == []


def test_downgrade_redirect_is_refused_without_network():
    handler = capture._SameOriginRedirectHandler()
    req = urllib.request.Request("https://tenant.example.edu/api")
    with pytest.raises(urllib.error.HTTPError):
        handler.redirect_request(req, None, 302, "Found", {},
                                 "http://tenant.example.edu/plain")


def test_off_host_redirect_is_refused_without_network():
    handler = capture._SameOriginRedirectHandler()
    req = urllib.request.Request("https://tenant.example.edu/api")
    with pytest.raises(urllib.error.HTTPError):
        handler.redirect_request(req, None, 302, "Found", {},
                                 "https://evil.example.net/collect")


def test_same_origin_redirect_passes_without_network():
    # In the real flow http_error_30x absolutizes Location via urljoin
    # before this hook, so unit calls use absolute targets (relative
    # Location is covered end-to-end above).
    handler = capture._SameOriginRedirectHandler()
    req = urllib.request.Request(
        "https://tenant.example.edu/api",
        headers={"Cookie": "canvas_session=SECRET-VALUE"})
    redir = handler.redirect_request(req, None, 302, "Found", {},
                                     "https://tenant.example.edu/api/next")
    assert redir is not None
    assert redir.full_url == "https://tenant.example.edu/api/next"
