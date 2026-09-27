#!/usr/bin/env python3
"""Whether the educator disconnected Morrow from Canvas on this tree.

`bin/morrow disconnect` (scripts/uninstall.sh --disconnect) records the
disconnect in the marker file `disconnected` in this tree's state dir
(<MORROW_HOME>/trees/<tree id>/, as transport.local_chromium resolves
it) before it stops the helper and deletes the Canvas sign-in.
install.sh clears the marker only after its helper-launch step
succeeds (and re-marks it if a later step fails), which is how the
educator reconnects. While the marker is there, students find, the
failed-students chain, and every Chromium-lane command refuse with
CanvasDisconnected before they reach the helper, and `bin/morrow start`
starts nothing: nothing brings the helper back until the educator asks.

CLI (prints one JSON object): disconnect.py mark | clear | status

Stdlib only.
"""

import json
import os
import sys
import time

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

MARKER_NAME = "disconnected"


class CanvasDisconnected(Exception):
    """The educator disconnected Morrow from Canvas. Raised before any
    helper, browser, or Canvas request, so nothing was sent."""

    nothing_sent = True


def marker_path():
    from transport.local_chromium import tree_state_dir
    return os.path.join(tree_state_dir(_TREE_ROOT), MARKER_NAME)


def is_disconnected():
    return os.path.isfile(marker_path())


def refuse_if_disconnected():
    if is_disconnected():
        raise CanvasDisconnected(
            "the educator disconnected Morrow from Canvas on this computer "
            "(bin/morrow disconnect deleted the sign-in); nothing was sent. "
            "Rerun install.sh only when the educator asks to reconnect.")


def mark():
    path = marker_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"disconnected_at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, fh)
        fh.write("\n")
    os.replace(tmp, path)
    return path


def clear():
    """Remove the marker. True when there was one."""
    try:
        os.unlink(marker_path())
    except FileNotFoundError:
        return False
    return True


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv == ["mark"]:
        out = {"disconnected": True, "marker": mark()}
    elif argv == ["clear"]:
        out = {"disconnected": False, "cleared": clear()}
    elif argv == ["status"]:
        out = {"disconnected": is_disconnected(), "marker": marker_path()}
    else:
        print("usage: disconnect.py mark | clear | status", file=sys.stderr)
        return 2
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
