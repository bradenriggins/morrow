#!/usr/bin/env python3
"""Managed-browser launch driver for Item Bank credential capture.

Concrete ``ManagedBrowserLaunchDriver`` built on the local Chromium lane
(transport/local_chromium.py): headless Chromium on this VM, CDP loopback,
page-context JS execution. The driver owns the browser mechanics; the
provisioner (provision.py) owns validation, binding, and the memory-only
credential handle.

Flow:
  probe_session()      - start Chromium if needed; page-context fetch of
                         /api/v1/users/self; a login redirect fails closed.
  resolve_placement()  - page-context fetch of /api/v1/courses/{id}/tabs;
                         exactly one "Item Banks" external-tool tab is
                         required; zero or more than one fails closed.
  launch_and_capture() - open an inactive temp tab; watch Network events on
                         the transport's capture_request_headers
                         (Network events over the owned CDP client, no raw
                         websocket); navigate to the launch URL; capture
                         the Authorization header from Canvas's own first
                         /api/banks request. Nothing is minted,
                         synthesized, or replayed.
  close_tab()          - close the temp tab; best effort.

Credential material never touches disk, logs, or stdout. This module logs
shapes, statuses, lengths, and IDs only, never the captured token value.

Offline selftest: python3 provision/launch_driver_selftest.py
"""

import importlib.util
import json
import os
import re
import sys
import time
import urllib.parse
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))

_PROV = None


def _prov_module(prov=None):
    """Return the provision module that owns the shared exceptions.

    The executor passes its own provision module instance so that the
    exceptions this driver raises are the exact classes the executor
    catches. A standalone lazy load is kept for direct use.
    """
    global _PROV
    if prov is not None:
        return prov
    if _PROV is None:
        spec = importlib.util.spec_from_file_location(
            "morrow_provision_for_launch_driver",
            os.path.join(_HERE, "provision.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _PROV = mod
    return _PROV


_LC = None


def _lc_module():
    """Lazy import of transport/local_chromium.py (same pattern as
    dispatch/executor.py: the transport directory is not a package)."""
    global _LC
    if _LC is None:
        tdir = os.path.join(os.path.dirname(_HERE), "transport")
        if tdir not in sys.path:
            sys.path.insert(0, tdir)
        import local_chromium
        _LC = local_chromium
    return _LC


class ManagedBrowserLaunchDriver:
    """Abstract launch driver. Subclasses implement the four mechanics."""

    def probe_session(self):
        raise NotImplementedError

    def resolve_placement(self, course_id):
        raise NotImplementedError

    def launch_and_capture(self, launch_spec, timeout_s=20):
        raise NotImplementedError

    def close_tab(self, tab_id):
        raise NotImplementedError


def build_default_driver(canvas_base, prov=None):
    """Build a LocalChromiumLaunchDriver with the platform Chromium.

    Raises RuntimeError when no Chromium binary is present (callers fail
    closed through ProvisionBlocked). Building the driver does not start
    Chromium; probe_session starts it on demand.

    The agent VM has no direct internet egress: Chromium is pointed at the
    platform egress proxy from the environment (https_proxy/https_proxy).
    The launcher fronts proxy auth with its local forwarder; Chrome cannot
    do proxy auth itself.
    """
    lc = _lc_module()
    proxy = (os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
             or os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY"))

    def _factory():
        # W2-P0-5: tree-derived launcher (env override, else the
        # tree-relative default profile/ports), never the hardcoded live
        # profile.
        return lc.ChromiumLauncher(lc.default_binary(),
                                   lc.tree_helper_profile_dir(),
                                   cdp_port=lc.tree_cdp_port(),
                                   proxy=proxy)

    return LocalChromiumLaunchDriver(canvas_base=canvas_base,
                                     launcher_factory=_factory,
                                     prov=prov)


class LocalChromiumLaunchDriver(ManagedBrowserLaunchDriver):
    """Capture Item Bank credentials through a real Canvas launch.

    The educator's managed browser session is the credential: page-context
    fetch carries the session cookies, and the Authorization value comes
    from Canvas's own Item Banks client request, observed on the wire.
    """

    def __init__(self, canvas_base=None, launcher=None, launcher_factory=None,
                 cdp=None, network_watcher=None, prov=None):
        self.canvas_base = (canvas_base or "").rstrip("/")
        self._launcher = launcher
        self._launcher_factory = launcher_factory
        self._cdp = cdp
        self._network_watcher = network_watcher
        self._prov = _prov_module(prov)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _lc(self):
        return _lc_module()

    def _ensure_launcher(self):
        if self._launcher is None:
            factory = self._launcher_factory
            if factory is None:
                # W2-P0-5: tree-derived launcher, never the hardcoded
                # live profile/CDP port.
                factory = lambda: self._lc().ChromiumLauncher(
                    self._lc().default_binary(),
                    self._lc().tree_helper_profile_dir(),
                    cdp_port=self._lc().tree_cdp_port())
            try:
                self._launcher = factory()
            except Exception as exc:
                raise self._prov.ProvisionFailed(
                    "launch_driver_unavailable: could not build the Chromium "
                    "launcher (%s); failing closed" % exc)
        if self._cdp is None:
            try:
                self._launcher.start()
            except Exception as exc:
                raise self._prov.ProvisionFailed(
                    "launch_driver_unavailable: Chromium did not start "
                    "(%s); failing closed" % exc)
            self._cdp = self._launcher.cdp
        return self._cdp

    def _page(self):
        """Page-context transport for the educator's Canvas session."""
        if not self.canvas_base:
            raise self._prov.ProvisionFailed(
                "launch_driver_unavailable: no canvas_base configured; "
                "failing closed")
        self._ensure_launcher()
        return self._lc().LocalChromiumTransport(self.canvas_base,
                                                 self._launcher)

    def _watcher(self):
        return self._network_watcher or self._default_network_watcher

    # ------------------------------------------------------------------
    # ManagedBrowserLaunchDriver mechanics
    # ------------------------------------------------------------------

    def probe_session(self):
        """Verify the educator's session is alive. Fail closed otherwise."""
        page = self._page()
        try:
            user_id, _name = page.ensure_session()
        except self._lc().SessionDead as exc:
            raise self._prov.SessionDead(
                "probe_session: the managed browser is not signed in to "
                "Canvas (%s); refusing to provision" % exc)
        return {
            "session_ok": True,
            "login_redirect": False,
            "canvas_base": self.canvas_base,
            "principal_ref": "user:%s" % user_id,
        }

    def resolve_placement(self, course_id):
        """Resolve the Item Banks LTI tool placement from the course tabs.

        Returns a dict with tool_id, launch_url, match_count, and
        tabs_checked. Exactly one label match is required; the provisioner
        enforces that.
        """
        page = self._page()
        status, _api_headers, body = page.api(
            "GET", "/api/v1/courses/%s/tabs" % course_id)
        if status != 200:
            raise self._prov.PlacementUnresolved(
                "resolve_placement: tabs request for course %s returned "
                "HTTP %s; refusing to guess a placement"
                % (course_id, status))
        try:
            tabs = json.loads(body)
        except (ValueError, TypeError):
            raise self._prov.PlacementUnresolved(
                "resolve_placement: tabs response for course %s was not "
                "JSON; refusing to guess a placement" % course_id)
        matches = [t for t in (tabs if isinstance(tabs, list) else [])
                   if isinstance(t, dict)
                   and str(t.get("label", "")).strip().lower()
                   == "item banks"]
        tool_id = None
        launch_url = None
        if len(matches) == 1:
            tab = matches[0]
            tool_id = self._extract_tool_id(tab)
            if tool_id:
                launch_url = ("%s/courses/%s/external_tools/%s"
                              % (self.canvas_base, course_id, tool_id))
        return {
            "tool_id": tool_id,
            "launch_url": launch_url,
            "match_count": len(matches),
            "tabs_checked": len(tabs) if isinstance(tabs, list) else 0,
        }

    @staticmethod
    def _extract_tool_id(tab):
        """Extract the LTI tool id from a tabs entry. None when the entry
        does not carry an extractable tool id; the caller fails closed."""
        tab_id = str(tab.get("id") or "")
        prefix = "context_external_tool_"
        if tab_id.startswith(prefix) and tab_id[len(prefix):].isdigit():
            return tab_id[len(prefix):]
        html_url = str(tab.get("html_url") or "")
        m = re.search(r"/external_tools/(\d+)", html_url)
        if m:
            return m.group(1)
        return None

    def launch_and_capture(self, launch_spec, timeout_s=20):
        """Open a temp tab, navigate to the launch URL, and capture the
        Authorization header from Canvas's own first GET /api/banks
        request. Raises CaptureTimeout, ProvisionFailed, or the provision
        exceptions on every failure path. Never synthesizes a token."""
        prov = self._prov
        launch_url = launch_spec.get("launch_url")
        tool_id = launch_spec.get("tool_id")
        for field in ("launch_url", "course_id", "course_uuid", "tool_id",
                      "tenant"):
            if not launch_spec.get(field):
                raise prov.ProvisionFailed(
                    "launch_spec_invalid: launch spec is missing %r; "
                    "refusing to launch" % field)
        # W4-P2-8: the launch URL must be https. The transport's
        # navigate guard would refuse anything else; fail here with the
        # provisioner's own error instead of a raw ValueError.
        if not isinstance(launch_url, str) or \
                not launch_url.lower().startswith("https://"):
            raise prov.ProvisionFailed(
                "launch_spec_invalid: launch_url must be an https:// URL; "
                "refusing to launch")
        cdp = self._ensure_launcher()
        try:
            tab = cdp.new_tab("about:blank")
        except Exception as exc:
            raise prov.ProvisionFailed(
                "launch_tab_failed: could not open a temp tab (%s); "
                "failing closed" % exc)
        tab_id = (tab or {}).get("id")
        if not tab_id:
            raise prov.ProvisionFailed(
                "launch_tab_failed: the browser returned no tab id; "
                "failing closed")
        launched_at = int(time.time())
        # The watcher navigates after subscribing so the first banks
        # request cannot slip past it; it receives the tab dict (no
        # websocket paths exist anymore).
        event = self._watcher()(tab, launch_url, timeout_s)
        # The watcher consumed the event stream; the temp tab is closed by
        # the provisioner via close_tab after validation.
        if event is None:
            raise prov.CaptureTimeout(
                "capture_timeout: no GET /api/banks request was observed "
                "within %ss of launching %s; the launch may or may not "
                "have completed, so this is uncertain, never replayed"
                % (timeout_s, launch_url))
        headers = event.get("headers") or {}
        authorization = None
        for name, value in headers.items():
            if str(name).lower() == "authorization" and value:
                authorization = str(value)
                break
        if not authorization:
            raise prov.ProvisionFailed(
                "capture_missing_authorization: Canvas's banks request "
                "carried no Authorization header; refusing to synthesize "
                "one")
        captured_at = int(time.time())
        api_origin = self._origin_of(event.get("url") or launch_url)
        return {
            "authorization": authorization,
            "nonce": str(uuid.uuid4()),
            "tab_id": tab_id,
            "frame_id": event.get("frame_id") or tab_id,
            "launch_url": launch_url,
            "external_tool_id": str(tool_id),
            "api_origin": api_origin,
            "launched_at": launched_at,
            "captured_at": captured_at,
        }

    @staticmethod
    def _origin_of(url):
        parts = urllib.parse.urlparse(url)
        return "%s://%s" % (parts.scheme, parts.netloc)

    def close_tab(self, tab_id):
        """Close a temp tab. Best effort: never raises."""
        if not tab_id:
            return
        try:
            cdp = self._ensure_launcher()
        except Exception:
            return
        # W4-P0-3: no /json/close anymore; close through the owned CDP
        # client (pipe or helper proxy).
        try:
            cdp.close_tab({"id": str(tab_id)})
        except Exception:
            pass
        # W2-P2-6: drop the registry entry so idle-tab reaping never
        # chases a tab that no longer exists. Best effort.
        try:
            unreg = getattr(self._launcher, "unregister_tab", None)
            if unreg is not None:
                unreg(tab_id)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # default network watcher: transport CDP event stream (W4-P0-3)
    # ------------------------------------------------------------------

    def _default_network_watcher(self, tab, launch_url, timeout_s):
        """Watch Network.requestWillBeSent until Canvas's own /api/banks
        request appears, via the transport's capture_request_headers
        (no raw websocket; the owned CDP client handles framing).

        Returns {"headers", "frame_id", "url"}, None on timeout, or
        raises ProvisionFailed when the launch frame collapses.
        """
        cdp = self._ensure_launcher()
        prov = self._prov
        tenant_host = (urllib.parse.urlsplit(launch_url).hostname or ""
                       ).lower()

        def match(rurl, headers):
            # Canvas's own banks request: tenant-bound host, /api/banks
            # path, carrying an Authorization header. The header VALUE is
            # never inspected here beyond presence; the provisioner
            # extracts it after a match.
            try:
                host = (urllib.parse.urlsplit(rurl).hostname or "").lower()
            except ValueError:
                return False
            if host != tenant_host or "/api/banks" not in rurl:
                return False
            return any(str(n).lower() == "authorization" and v
                       for n, v in (headers or {}).items())

        try:
            rurl, headers = cdp.capture_request_headers(
                tab, launch_url, match, timeout=timeout_s)
        except TimeoutError:
            return None
        except Exception as exc:
            # A crashed tab (or a dead CDP link) means the launch frame
            # collapsed: uncertain, never replayed.
            raise prov.ProvisionFailed(
                "launch_frame_collapsed: %s during the launch; the "
                "capture may or may not have happened, so this is "
                "uncertain, never replayed" % type(exc).__name__)
        return {"headers": headers, "frame_id": (tab or {}).get("id"),
                "url": rurl}
