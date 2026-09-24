"""The educator user-id contract, shared by modes/ and settings/.

One definition, so every layer that keys state by user id accepts
exactly the same ids: a grant the modes layer accepts must be one the
settings layer can turn off. The id becomes a file name under
MORROW_HOME, so it starts with a letter or digit (no ".", "..", or
option-like leading "-") and carries no path separators. ":" and "@"
are allowed because Muse ids look like "muse:educator@school.edu".

default_user_id() is where a command gets the id when the caller names
none: MORROW_USER_ID, else the Canvas account pinned at first sign-in.

Stdlib only at import.
"""

import os
import re
import urllib.parse

USER_ID_RULE = ("1-160 characters of letters, digits, underscore, dot, "
                "colon, at sign, or dash, starting with a letter or digit")
_USER_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}")


def is_valid_user_id(user_id):
    return isinstance(user_id, str) and \
        _USER_ID_RE.fullmatch(user_id) is not None


def default_user_id():
    """The educator's id when a command is given none.

    MORROW_USER_ID when it is set; otherwise the Canvas account pinned
    at first sign-in, as "canvas:<account id>@<Canvas host>", so one
    educator keeps one id in every conversation without anyone choosing
    it. None before an account is pinned, or when the pin record cannot
    be trusted: the caller then treats the educator as in plan mode.
    """
    value = os.environ.get("MORROW_USER_ID")
    if value:
        return value
    try:
        from reauth import state_machine as rsm
        pin = rsm.pinned_principal()
    except Exception:
        return None
    if not pin or pin.get("id") in (None, ""):
        return None
    host = (urllib.parse.urlsplit(str(pin.get("base") or "")).hostname
            or "").lower()
    user_id = "canvas:%s" % pin["id"]
    if host:
        user_id += "@" + host
    return user_id if is_valid_user_id(user_id) else None
