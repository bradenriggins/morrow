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

Stdlib only.
"""

import os

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
