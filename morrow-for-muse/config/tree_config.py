#!/usr/bin/env python3
"""This tree's configuration, resolved the way the helper resolves it.

The educator sets CANVAS_BASE, and optionally the helper's ports and
TLS files, in <tree>/helper/env. install.sh requires CANVAS_BASE there,
because keepalive.sh reads only that file, so an agent's shell has no
such variables. Every Python reader resolves a setting in the order
keepalive.sh and helper/server.py use:

  1. the process environment (an explicit export wins);
  2. <tree>/helper/env (MORROW_HELPER_ENV_FILE overrides the path: the
     test seam helper/server.py also honors);
  3. for CANVAS_BASE only, the legacy global <MORROW_HOME>/env. Port,
     profile, and TLS settings there are ignored: one global file must
     not configure every tree.

normalize_tenant_base() is the tenant rule the packet requires the
installer and the helper to share (muse UX audit 3, item
muse-ux3/installer-probes-before-tenant-rules): install.sh validates
CANVAS_BASE with it BEFORE the curl probe, so a pasted address that
embeds an account and password, an http:// address, a private IP
literal, or an unconfirmed custom domain fails the install with the
helper's plain reason instead of being sent to the network.

Stdlib only.
"""

import ipaddress
import os
import urllib.parse

from config.paths import morrow_home

TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_HELPER_PORT = 8901
_LEGACY_GLOBAL_KEYS = ("CANVAS_BASE",)


def env_file_path():
    """This tree's env file: <tree>/helper/env."""
    return os.environ.get("MORROW_HELPER_ENV_FILE") \
        or os.path.join(TREE_ROOT, "helper", "env")


def parse_env_file(path):
    """KEY=VALUE lines as a dict. Blank lines and # comments are
    skipped, one leading "export " is allowed, one layer of matching
    quotes is removed, and only shell-identifier keys count. A missing
    or unreadable file is empty."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return {}
    out = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if (len(value) >= 2 and value[0] == value[-1]
                and value[0] in ("'", '"')):
            value = value[1:-1]
        if (key and (key[0].isalpha() or key[0] == "_")
                and all(c.isalnum() or c == "_" for c in key)):
            out[key] = value
    return out


def setting(name, default=None):
    """One setting: the environment, then helper/env, then (CANVAS_BASE
    only) the legacy global env. An empty value counts as unset."""
    value = os.environ.get(name)
    if value:
        return value
    value = parse_env_file(env_file_path()).get(name)
    if value:
        return value
    if name in _LEGACY_GLOBAL_KEYS:
        value = parse_env_file(os.path.join(morrow_home(), "env")).get(name)
        if value:
            return value
    return default


def canvas_base():
    """The educator's Canvas origin without a trailing slash, or ""."""
    return (setting("CANVAS_BASE") or "").strip().rstrip("/")


def int_setting(name, default):
    """An integer setting, or default when it is unset or not a number."""
    try:
        return int(setting(name, default))
    except (TypeError, ValueError):
        return default


def helper_port(default=DEFAULT_HELPER_PORT):
    """The login helper's HTTP port (LOGIN_HELPER_PORT)."""
    return int_setting("LOGIN_HELPER_PORT", default)


def normalize_tenant_base(base_url):
    """The helper's tenant rule, shared with install.sh (W2-P0-11).

    Normalizes the tenant base to EXACTLY scheme://netloc/ (with a
    trailing slash). Paths, queries, fragments, and any deep link
    hiding in CANVAS_BASE are discarded: the helper always lands on
    the tenant origin root, and status() keeps a direct
    href.startswith(base_url) prefix check against that root, so
    sibling hostnames like tenant.instructure.com.evil.com can never
    match (the trailing slash makes the prefix check origin-exact).

    CANVAS_BASE is a server-side request primitive (the helper drives
    Chromium at it; install.sh probes it), so validation is strict:
    - absolute http(s) URL with a host (unchanged);
    - https required, unless CANVAS_BASE_ALLOW_HTTP=1 documents an
      explicit local-dev override;
    - no userinfo (a URL carrying user:pass credentials is rejected);
    - no non-routable IP literals (loopback, link-local, RFC1918,
      multicast, reserved, unspecified);
    - a Canvas-shaped tenant: *.instructure.com, or a self-hosted
      Canvas domain the educator explicitly confirms with
      CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=<that exact host>.
    - placeholder hosts are refused (the helper is the runtime gate:
      CANVAS_BASE can be set or changed after install, so the doc
      placeholders fail here too. Bare instructure.com is the
      corporate site, never a Canvas tenant.)

    Raises ValueError with a plain reason. helper/server.py's
    _normalize_tenant_base is this function (moved here 2026-09-23 so
    install.sh and the helper cannot drift; muse UX audit 3).
    """
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(
            "CANVAS_BASE must be an absolute http(s) URL with a host, "
            "got %r" % (base_url,))
    if parsed.username or parsed.password:
        raise ValueError(
            "CANVAS_BASE must not embed credentials (userinfo); got %r"
            % (base_url,))
    if parsed.scheme != "https" \
            and os.environ.get("CANVAS_BASE_ALLOW_HTTP") != "1":
        raise ValueError(
            "CANVAS_BASE must be https (got %r); set "
            "CANVAS_BASE_ALLOW_HTTP=1 for a documented local-dev override"
            % (base_url,))
    host = (parsed.hostname or "").lower()
    _PLACEHOLDER_HOSTS = frozenset({
        "instructure.com",
        "example.com",
        "example.instructure.com",
        "myschool.instructure.com",
        "canvas.instructure.com",
    })
    _PLACEHOLDER_LABELS = frozenset({
        "your-school", "yourschool", "your_school", "example", "myschool",
    })
    labels = host.split(".")
    if host in _PLACEHOLDER_HOSTS or any(
            lab in _PLACEHOLDER_LABELS for lab in labels):
        raise ValueError(
            "CANVAS_BASE looks like a placeholder (%r); set your school's "
            "real Canvas URL, e.g. https://<your-school>.instructure.com "
            "(got %r)" % (host, base_url))
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and not literal.is_global:
        raise ValueError(
            "CANVAS_BASE must not point at a non-routable address "
            "(loopback, link-local, or private); got %r" % (base_url,))
    confirmed = os.environ.get(
        "CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED", "").strip().lower()
    if not (host == "instructure.com"
            or host.endswith(".instructure.com")
            or (confirmed and host == confirmed)):
        raise ValueError(
            "CANVAS_BASE must be a Canvas tenant (*.instructure.com); for "
            "a self-hosted Canvas domain set "
            "CANVAS_BASE_CUSTOM_DOMAIN_CONFIRMED=%s (got %r)"
            % (host, base_url))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))
