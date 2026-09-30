"""Refuse explicit denial or uncertainty in a caller-verified consent citation."""

import re
import unicodedata


_NONAPPROVAL = re.compile(
    r"^(?:no\b|nope\b|nah\b|not\b|maybe\b|perhaps\b|unsure\b|uncertain\b|"
    r"cancel\b|stop\b|deny\b|decline\b|reject\b|"
    r"do\s+not\b|don't\b|"
    r"(?:actually\s+|i\s+said\s+)no\b|"
    r"i\s+(?:am\s+not\s+sure\b|am\s+unsure\b|don't\s+approve\b|do\s+not\s+approve\b|refuse\b)|"
    r"i'm\s+(?:not\s+sure\b|unsure\b))"
)


def explicit_nonapproval(reply):
    if not isinstance(reply, str):
        return False
    normalized = unicodedata.normalize("NFKC", reply).strip().casefold()
    normalized = normalized.replace("’", "'").replace("‘", "'")
    return bool(_NONAPPROVAL.match(normalized.lstrip("\"'([{ ")))
