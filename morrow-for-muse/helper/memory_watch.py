#!/usr/bin/env python3
"""Chromium memory watch (W2-P2-6). Read-only probe.

Run on healthy keepalive ticks. Measures THIS TREE's Chromium process
tree (exact profile-dir + --remote-debugging-pipe identity, never a
port or substring match) and advises a restart when the tree's RSS
exceeds CHROMIUM_MAX_RSS_MB or the browser is older than
CHROMIUM_MAX_BROWSER_AGE_H.

W4-P0-3: with --remote-debugging-pipe there is no CDP TCP port; the
number formerly called "CDP port" is only this tree's identity label.
W4-P2-16: this script can no longer reap tabs. Tab reaping runs
in-process inside the login-helper server (the browser's owner), which
holds the private CDP pipe; memory_watch stays a read-only probe and
never touches CDP.

Exit 0: browser fine, or no browser for this identity (nothing to do).
Exit 3: restart advised. keepalive.sh acts on 3, and only on a healthy
        helper, only when the journal is quiet (no dispatch in flight),
        and only outside the restart cooldown.
Always prints one summary line for keepalive.log.

Env:
  MEMORY_WATCH_PROFILE_DIR   exact profile dir (this tree's)
  MEMORY_WATCH_CDP_PORT      legacy, ignored (pipe identity now)
  CHROMIUM_MAX_RSS_MB        default 2048
  CHROMIUM_MAX_BROWSER_AGE_H default 0 (disabled)
  CHROMIUM_IDLE_TAB_MINUTES  default 30

Never kills anything. Never touches another tree's (or the live
helper's) browser: identity is profile+pipe-flag, resolved from the env
the tree's own keepalive exports.
"""
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "transport"))
import local_chromium as lc


def _float_env(name, default):
    try:
        return float(os.environ.get(name, default) or default)
    except (TypeError, ValueError):
        return float(default)


def main():
    profile = os.environ.get("MEMORY_WATCH_PROFILE_DIR", "")
    # MEMORY_WATCH_CDP_PORT is legacy and ignored: with
    # --remote-debugging-pipe there is no CDP port, identity is the
    # exact profile dir. Read (and ignore) for backward compatibility.
    _legacy_port = os.environ.get("MEMORY_WATCH_CDP_PORT", "0")
    max_rss_mb = _float_env("CHROMIUM_MAX_RSS_MB", 2048)
    max_age_h = _float_env("CHROMIUM_MAX_BROWSER_AGE_H", 0)
    idle_min = _float_env("CHROMIUM_IDLE_TAB_MINUTES", 30)

    if not profile:
        print("memory_watch: misconfigured (profile missing); no action")
        return 0

    pids = lc.find_chromium_pids(profile)
    if not pids:
        print("memory_watch: no chromium for this identity; no action")
        return 0

    # W4-P2-16: reaping runs inside the helper server (the browser's
    # owner), not here; this probe only measures.
    reaped = 0

    tree = lc.subtree_pids_for(pids)
    rss_mb = lc.subtree_rss_bytes(tree) / 1048576.0
    ages = [a for a in (lc.process_age_seconds(p) for p in pids)
            if a is not None]
    age_h = (max(ages) / 3600.0) if ages else 0.0

    verdict = "ok"
    if rss_mb > max_rss_mb:
        verdict = "rss"
    elif max_age_h > 0 and age_h > max_age_h:
        verdict = "age"

    print("memory_watch: rss=%.0fMB(max %.0f) age=%.1fh(max %.1f) "
          "reaped=%d tree_pids=%d main=%s verdict=%s"
          % (rss_mb, max_rss_mb, age_h, max_age_h, reaped,
             len(tree), ",".join(map(str, pids)), verdict))
    return 3 if verdict != "ok" else 0


if __name__ == "__main__":
    sys.exit(main())
