#!/usr/bin/env python3
"""Natural-language intent parsing for the failed-students query chain.

Recognizes educator phrasings of the "show me the students that failed
X" family and extracts:
  - quiz reference: "last week's quiz" | "this week's quiz" |
    named ("Quiz 3", a title fragment) | "the quiz" (requires context)
  - explicit threshold: "below 70%", "under 40 points", "who got an F"

Anything not matching raises IntentNotRecognized so the caller can
route it through failures/translator.py instead of guessing.

Stdlib only.
"""

from __future__ import annotations

import re


class IntentNotRecognized(Exception):
    """The text is not a failed-students query this chain understands."""

    def __init__(self, text):
        super().__init__(
            "could not parse %r as a failed-students query; the chain "
            "only answers 'students that failed <quiz>' phrasings" % text)
        self.text = text


# Trigger verbs/nouns for the failed-students family.
_TRIGGER_RE = re.compile(
    r"\b(show|list|tell|give|which|who|what|get|find|name)\b.*"
    r"\b(students?|learners?|kids|pupils|everyone|anybody|anyone)\b.*"
    r"\b(fail(?:ed|s|ing)?|didn'?t pass|not pass|below|under|bombed|"
    r"got an? [fF]|scored? (?:below|under)|less than)\b",
    re.IGNORECASE)

# Also catch the reversed order: "which students failed".
_TRIGGER_RE2 = re.compile(
    r"\b(students?|learners?)\b.{0,40}\b(fail(?:ed|s|ing)?|didn'?t pass)\b",
    re.IGNORECASE)

_LAST_WEEK_RE = re.compile(
    r"\blast\s+week'?s?\s+(?:quiz|test|exam|assessment)s?\b", re.IGNORECASE)
_THIS_WEEK_RE = re.compile(
    r"\bthis\s+week'?s?\s+(?:quiz|test|exam|assessment)s?\b", re.IGNORECASE)
_YESTERDAY_RE = re.compile(
    r"\byesterday'?s?\s+(?:quiz|test|exam|assessment)s?\b", re.IGNORECASE)

# Named quiz: "Quiz 3", "quiz #2", "the 'Mid-Term Exam' quiz", a quoted title.
_NAMED_NUM_RE = re.compile(
    r"\bquiz\s*#?\s*(\d+)\b", re.IGNORECASE)
_TEST_NUM_RE = re.compile(
    r"\b(test|exam|assessment)\s*#?\s*(\d+)\b", re.IGNORECASE)
# Quoted quiz titles: "Pop Quiz #1", 'Mid-Term'. Single quotes need
# non-word boundaries on both sides so contractions ("didn't",
# "week's") are never treated as quote characters.
_QUOTED_RE = re.compile(
    r"""["]([^'"]{2,120})["]|(?<!\w)'([^'"]{2,120})'(?!\w)""")

# Explicit thresholds: "below 70%", "under 70 percent", "less than 40 points".
# Note: (?![\w]) not \b after %/percent/points, so "70%?" still matches.
_PCT_RE = re.compile(
    r"\b(?:below|under|less than|scored? (?:below|under)|<)\s*"
    r"(\d+(?:\.\d+)?)\s*(?:%|percent)(?![\w])", re.IGNORECASE)
_POINTS_RE = re.compile(
    r"\b(?:below|under|less than|scored? (?:below|under)|<)\s*"
    r"(\d+(?:\.\d+)?)\s*points?(?![\w])", re.IGNORECASE)
_F_GRADE_RE = re.compile(r"\bgot an? [fF]\b")
# "who got an F" names no "students" word but unambiguously means them.
_TRIGGER_RE3 = re.compile(
    r"\bwho\b.{0,40}\bgot an? [fF]\b", re.IGNORECASE)


def parse(text):
    """Parse educator text into an intent dict.

    Returns {"action": "failed_students", "quiz_ref": {...},
             "threshold": {...} or None}.
    Raises IntentNotRecognized for anything else.
    """
    if not isinstance(text, str) or not text.strip():
        raise IntentNotRecognized(text)
    lowered = text.lower()
    if not (_TRIGGER_RE.search(lowered) or _TRIGGER_RE2.search(lowered)
            or _TRIGGER_RE3.search(text)):
        raise IntentNotRecognized(text)

    quiz_ref = _parse_quiz_ref(text)
    threshold = _parse_threshold(text)
    return {"action": "failed_students", "quiz_ref": quiz_ref,
            "threshold": threshold}


def _parse_quiz_ref(text):
    if _LAST_WEEK_RE.search(text):
        return {"kind": "last_week"}
    if _THIS_WEEK_RE.search(text):
        return {"kind": "this_week"}
    if _YESTERDAY_RE.search(text):
        return {"kind": "yesterday"}
    m = _NAMED_NUM_RE.search(text)
    if m:
        return {"kind": "named_number", "number": m.group(1),
                "label": m.group(0)}
    m = _TEST_NUM_RE.search(text)
    if m:
        return {"kind": "named_number", "number": m.group(2),
                "label": m.group(0)}
    m = _QUOTED_RE.search(text)
    if m:
        return {"kind": "named_title", "title": (m.group(1) or m.group(2)).strip()}
    # A bare "the quiz" with no disambiguator: not resolvable.
    if re.search(r"\bthe\s+(?:quiz|test|exam|assessment)\b", text,
                 re.IGNORECASE):
        return {"kind": "unspecified"}
    return {"kind": "unspecified"}


def _parse_threshold(text):
    m = _PCT_RE.search(text)
    if m:
        return {"kind": "percent", "value": float(m.group(1))}
    m = _POINTS_RE.search(text)
    if m:
        return {"kind": "points", "value": float(m.group(1))}
    if _F_GRADE_RE.search(text):
        return {"kind": "letter_f"}
    return None
