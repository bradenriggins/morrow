"""The educator user-id contract, shared by modes/ and settings/.

One definition, so every layer that keys state by user id accepts
exactly the same ids: a grant the modes layer accepts must be one the
settings layer can turn off. The id becomes a file name under
MORROW_HOME, so it starts with a letter or digit (no ".", "..", or
option-like leading "-") and carries no path separators. ":" and "@"
are allowed because Muse ids look like "muse:educator@school.edu".

Stdlib only.
"""

import re

USER_ID_RULE = ("1-160 characters of letters, digits, underscore, dot, "
                "colon, at sign, or dash, starting with a letter or digit")
_USER_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}")


def is_valid_user_id(user_id):
    return isinstance(user_id, str) and \
        _USER_ID_RE.fullmatch(user_id) is not None
