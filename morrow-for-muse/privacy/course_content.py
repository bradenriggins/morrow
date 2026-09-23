"""Course content with course labels on the way in, exact text on the way out.

Course content (a page body, an assignment description, a quiz question,
a module or group name) can name a student. The model must see the
student's course label ("Student A3"), never the name, so every
course-scoped result is projected through the course roster. Content is
also what an educator edits and saves back, so the projection must be
reversible: a label that stood for "Jane" goes back as "Jane", an email
goes back as the email, and a word that only looks like a name ("Brown
v. Board" in a course with a student named Kevin Brown) goes back
exactly as written.

Each replaced span becomes the label plus a marker that names the form
it replaced:

    Student A3                          the full name
    Student A3 (first name)             the first name alone
    Student A3 (last name)              the last name alone
    Student A3 (name, last name first)  "Doe, Jane"
    Student A3 (email) / (login) / (SIS id) / (user id)
    Student A3 (other name N)           another roster spelling (a
                                        nickname, the name without its
                                        middle initial, ...)
    Student A3 or Student A4 (first name)
                                        a form two students share
    Student A3 or Student A4 (name)     a full name two students share

Text that already reads like a label is marked "(as written)", so it
goes back unchanged and never becomes a student's name. restore_text()
turns every marker back into the form the roster spells; a label with
no marker (one the model wrote) goes back as the full name.

Without the encrypted learner vault there are no labels. prepare_hidden()
then hides every form one way ("[hidden: student name]", "[hidden:
student email]"), and has_hidden() finds such text so it is never saved
back into the course.

Matching reuses the learner boundary's text view (privacy/core.py):
HTML entities, percent escapes, NFKC, lookalike letters, and invisible
characters cannot hide a name. A replaced span inside a link is
percent-encoded so the link stays intact, and restores the same way.
"""

import re
import unicodedata
import urllib.parse

from privacy import core as _core

FULL = ""
SHARED_NAME = "name"
FIRST = "first name"
LAST = "last name"
LAST_FIRST = "name, last name first"
EMAIL = "email"
LOGIN = "login"
SIS = "SIS id"
USER_ID = "user id"
OTHER = "other name"
AS_WRITTEN = "as written"
# A form one student can own; when two students own the same spelling
# the lower rank wins the marker (both labels are still named).
_FORM_RANK = {FULL: 0, LAST_FIRST: 1, OTHER: 2, EMAIL: 3, LOGIN: 4, SIS: 5,
              FIRST: 6, LAST: 7}

_LABEL = r"Student A[1-9][0-9]*"
_LABEL_RE = re.compile(r"(?<![A-Za-z0-9])%s(?![0-9])" % _LABEL)
_MARKER_FORMS = (AS_WRITTEN, SHARED_NAME, FIRST, LAST, LAST_FIRST, EMAIL,
                 LOGIN, SIS, USER_ID)


def _marker_pattern(quote):
    fixed = "|".join(re.escape(quote(f)) for f in
                     sorted(_MARKER_FORMS, key=len, reverse=True))
    return r"(?:%s|%s(?:%s[1-9][0-9]*)?)" % (
        fixed, re.escape(quote(OTHER)), re.escape(quote(" ")))


def _quoted(text):
    return urllib.parse.quote(text, safe="")


# One reference: a label with an optional marker, or several labels
# joined by " or " that always carry a marker (the projection writes
# them only for a form two students share). "Student A1 or Student A2"
# with no marker is two references, as a writer would mean it.
_PLAIN_REF_RE = re.compile(
    r"(?<![A-Za-z0-9])(%s)(?:((?: or %s)+)(?![0-9]) \((%s)\)"
    r"|(?![0-9])(?: \((%s)\))?)"
    % (_LABEL, _LABEL, _marker_pattern(lambda t: t),
       _marker_pattern(lambda t: t)))
_ENCODED_REF_RE = re.compile(
    r"(?<![A-Za-z0-9])Student%%20A[1-9][0-9]*(?:"
    r"(?:%%20or%%20Student%%20A[1-9][0-9]*)+(?![0-9])%%20%%28%s%%29"
    r"|(?![0-9])(?:%%20%%28%s%%29)?)"
    % (_marker_pattern(_quoted), _marker_pattern(_quoted)))
_ENCODED_LITERAL_RE = re.compile(r"(?<![A-Za-z0-9])Student%20A[1-9][0-9]*"
                                 r"(?![0-9])")
_SYNTHESIZED_NAME_RE = re.compile(r"^Learner \S+$")
# A user id counts only after a person word, as in the learner
# boundary's contextual patterns: an assignment or page id that happens
# to equal a student's id is left alone.
_USER_ID_RES = (
    re.compile(r"((?:[\"']?(?:learner|student|user|recipient|enrollment|"
               r"submission)[_-]?id[\"']?)\s*[:=]\s*[\"']?)([0-9]{1,20})"
               r"(?![0-9])", re.IGNORECASE),
    re.compile(r"(\b(?:learner|student|user|recipient)\b\s*(?:id\b\s*)?"
               r"[#:=]?\s*)([0-9]{1,20})(?![0-9])", re.IGNORECASE),
    re.compile(r"(/(?:users|learners|students)/)([0-9]{1,20})(?![0-9])",
               re.IGNORECASE),
)


HIDDEN = "[hidden: student %s]"
_HIDDEN_PREFIX = "[hidden: student "
_HIDDEN_WORDS = {FULL: "name", SHARED_NAME: "name", LAST_FIRST: "name",
                 FIRST: FIRST, LAST: LAST, EMAIL: EMAIL, LOGIN: LOGIN,
                 SIS: SIS, USER_ID: USER_ID}


class RestoreError(ValueError):
    """A label or marker in text Morrow is about to send cannot be put
    back into the student's real text."""


def _letters(text):
    return sum(1 for c in text if unicodedata.category(c).startswith("L"))


def _name_parts(name):
    """(given, surname) of a roster name, each "" when not plausible.
    Generational suffixes (Jr., III) are neither."""
    normalized = _core._without_name_suffixes(str(name))
    if "," in normalized:
        last, _, first = normalized.partition(",")
        given = first.split()[0] if first.split() else ""
        surname = last.split()[-1] if last.split() else ""
    else:
        parts = normalized.split(" ")
        given = parts[0] if len(parts) >= 2 else ""
        surname = parts[-1] if len(parts) >= 2 else ""
    return (given if _letters(given) >= 2 else "",
            surname if _letters(surname) >= 2 else "")


def _real_name(identity):
    name = identity.get("name")
    if not isinstance(name, str) or not name.strip() \
            or _SYNTHESIZED_NAME_RE.match(name.strip()):
        return ""
    return " ".join(name.split())


def _named_forms(identity):
    """{form: spelling} for the forms derived from the roster name and
    identifiers; OTHER is handled by _other_spellings."""
    forms = {}
    name = _real_name(identity)
    if name:
        forms[FULL] = name
        given, surname = _name_parts(name)
        if given:
            forms[FIRST] = given
        if surname:
            forms[LAST] = surname
        if given and surname and "," not in name:
            forms[LAST_FIRST] = "%s, %s" % (surname, given)
    for form, key in ((EMAIL, "email"), (LOGIN, "loginId"),
                      (SIS, "sisUserId")):
        value = identity.get(key)
        if isinstance(value, str) and value.strip():
            forms[form] = value.strip()
    return forms


def _other_spellings(identity):
    """Every other roster spelling of the student, in a fixed order: the
    roster's aliases (short name, sortable name, SIS login), the name
    last name first without the comma, and the first and last name
    without a middle name. Spellings a named form already covers are
    left out."""
    forms = _named_forms(identity)
    taken = {_core._normalize_alias(v) for v in forms.values()}
    candidates = [a for a in identity.get("aliases") or []
                  if isinstance(a, str) and a.strip()]
    name = forms.get(FULL)
    if name:
        candidates.append(_core._without_name_suffixes(name))
    if name and "," not in name:
        given, surname = _name_parts(name)
        if given and surname:
            candidates.append("%s %s" % (surname, given))
            candidates.append("%s %s" % (given, surname))
    out = {}
    for spelling in candidates:
        key = _core._normalize_alias(spelling)
        if key and key not in taken and key not in out:
            out[key] = " ".join(spelling.split())
    return [out[key] for key in sorted(out)]


def _rank(form):
    return _FORM_RANK.get(OTHER if form.startswith(OTHER) else form, 9)


def _label_number(label):
    return int(label.split("A", 1)[1])


def prepare(pairs):
    """The matching context for [(identity, label)] of one course."""
    aliases = {}
    ids = {}
    for identity, label in pairs:
        if not label:
            continue
        ids[str(identity.get("id"))] = label
        spellings = list(_named_forms(identity).items())
        spellings += [("%s %d" % (OTHER, i) if i > 1 else OTHER, text)
                      for i, text in enumerate(_other_spellings(identity), 1)]
        for form, text in spellings:
            key = _core._normalize_alias(text)
            if not key:
                continue
            entry = aliases.setdefault(key, {"forms": {},
                                             "name_token": False})
            known = entry["forms"].get(label)
            if known is None or _rank(form) < _rank(known):
                entry["forms"][label] = form
            # A one-word name fragment can also be an ordinary word
            # ("Brown", "Will"); it is rewritten only when capitalized.
            if form in (FIRST, LAST) or (form.startswith(OTHER)
                                         and " " not in key):
                entry["name_token"] = True
    for entry in aliases.values():
        entry["labels"] = sorted(entry["forms"], key=_label_number)
        # The marker is the first label's form: restoration reads that
        # student's spelling, which normalizes to the same text as the
        # others' (they matched the same key).
        entry["form"] = entry["forms"][entry["labels"][0]]
    return {"aliases": aliases, "ids": ids,
            "matcher": _core._build_alias_matcher(aliases)}


def prepare_hidden(identities):
    """The matching context without labels (no encrypted vault): every
    roster form is hidden one way."""
    prepared = prepare([(identity, "Student A%d" % n)
                        for n, identity in enumerate(identities, 1)])
    prepared["hidden"] = True
    return prepared


def _reference(prepared, labels, form):
    if prepared.get("hidden"):
        word = _HIDDEN_WORDS.get(form)
        return HIDDEN % (word or ("name" if form.startswith(OTHER)
                                  else form))
    head = " or ".join(labels)
    if form == FULL:
        return head if len(labels) == 1 else "%s (%s)" % (head, SHARED_NAME)
    return "%s (%s)" % (head, form)


def has_hidden(value):
    """True when value still carries a form hidden without labels,
    plain or percent-encoded (inside a link)."""
    if isinstance(value, str):
        return _HIDDEN_PREFIX in value or \
            _HIDDEN_PREFIX in urllib.parse.unquote(value)
    if isinstance(value, list):
        return any(has_hidden(v) for v in value)
    if isinstance(value, dict):
        return any(has_hidden(v) for v in value.values())
    return False


def project_text(text, prepared, protect_literals=True):
    """text with every roster form replaced by its label and marker.
    protect_literals=False leaves text that reads like a label alone:
    for text whose labels a projection already wrote."""
    if not isinstance(text, str) or not text:
        return text
    if prepared.get("hidden"):
        protect_literals = False
    view = _core._normalized_identity_text_view(text)
    url_spans = _core._url_token_spans(text)
    replacements = []
    taken = []

    def add(start, end, replacement):
        if any(s < end and start < e for s, e in taken if s != e) \
                and start != end:
            return
        taken.append((start, end))
        replacements.append({"start": start, "end": end,
                             "replacement": replacement})

    for match in _LABEL_RE.finditer(text):
        if protect_literals:
            add(match.end(), match.end(), " (%s)" % AS_WRITTEN)
        taken.append(match.span())
    for match in _ENCODED_LITERAL_RE.finditer(text):
        if protect_literals:
            add(match.end(), match.end(), _quoted(" (%s)" % AS_WRITTEN))
        taken.append(match.span())
    matcher = prepared.get("matcher")
    if matcher is not None:
        folded, index_map = _core._fold_match_text(view["text"])
        for match in matcher.finditer(folded):
            entry = prepared["aliases"].get(_core._normalize_alias(
                match.group(0)))
            if entry is None:
                continue
            vstart = index_map[match.start()]
            vend = index_map[match.end() - 1] + 1
            if entry["name_token"] and not _core._name_token_case_ok(
                    view["text"], vstart, vend):
                continue
            source = _core._source_range_for_view(view, vstart, vend)
            if source is None:
                continue
            add(source["start"], source["end"], _core._url_safe_replacement(
                source, _reference(prepared, entry["labels"],
                                   entry["form"]),
                url_spans))
    for pattern in _USER_ID_RES:
        for match in pattern.finditer(view["text"]):
            label = prepared["ids"].get(match.group(2))
            if not label:
                continue
            start = match.start(2)
            source = _core._source_range_for_view(
                view, start, start + len(match.group(2)))
            if source is None:
                continue
            add(source["start"], source["end"], _core._url_safe_replacement(
                source, _reference(prepared, [label], USER_ID),
                url_spans))
    if not replacements:
        return text
    return _core._apply_source_replacements(text, replacements)


def project_value(value, prepared, protect_literals=True):
    """value with every string projected; keys and numbers are kept."""
    if isinstance(value, str):
        return project_text(value, prepared, protect_literals)
    if isinstance(value, list):
        return [project_value(v, prepared, protect_literals) for v in value]
    if isinstance(value, dict):
        return {k: project_value(v, prepared, protect_literals)
                for k, v in value.items()}
    return value


def _spelling(identity, form, label):
    if form == SHARED_NAME:
        form = FULL
    if form == USER_ID:
        value = identity.get("id")
    elif form.startswith(OTHER):
        index = int(form[len(OTHER):].strip() or 1)
        others = _other_spellings(identity)
        value = others[index - 1] if 0 < index <= len(others) else None
    else:
        value = _named_forms(identity).get(form)
    if not value:
        raise RestoreError(
            "%s (%s) cannot be put back: the course roster has no %s for "
            "that student. Nothing was sent." % (label, form or "name",
                                                 form or "name"))
    return str(value)


def _restore_reference(match, identity_for):
    """The real text for one plain reference match."""
    label = match.group(1)
    others = match.group(2) or ""
    form = match.group(3) or match.group(4) or FULL
    if form == AS_WRITTEN:
        if others:
            raise RestoreError(
                "%s cannot be put back: it mixes a label written as text "
                "with other labels. Nothing was sent." % match.group(0))
        return label
    labels = [label] + _LABEL_RE.findall(others)
    identities = []
    for each in labels:
        identity = identity_for(each)
        if not identity:
            raise RestoreError(
                "%s is not a student label in this course, so Morrow "
                "cannot put the student's name back. Use a label Morrow "
                "showed for this course, or write the name as the "
                "educator gave it. Nothing was sent." % each)
        identities.append(identity)
    return _spelling(identities[0], form, label)


def restore_text(text, identity_for):
    """text with every label and marker put back into the student's real
    text. identity_for(label) returns the roster identity or None.
    Raises RestoreError for a label the course never issued or a form
    the roster cannot fill."""
    if not isinstance(text, str) or "Student" not in text:
        return text

    def encoded(match):
        plain = _PLAIN_REF_RE.fullmatch(urllib.parse.unquote(match.group(0)))
        if plain is None:
            return match.group(0)
        return urllib.parse.quote(_restore_reference(plain, identity_for),
                                  safe="@.-_~+:/")
    text = _ENCODED_REF_RE.sub(encoded, text)
    return _PLAIN_REF_RE.sub(
        lambda m: _restore_reference(m, identity_for), text)


def restore_value(value, identity_for):
    if isinstance(value, str):
        return restore_text(value, identity_for)
    if isinstance(value, list):
        return [restore_value(v, identity_for) for v in value]
    if isinstance(value, dict):
        return {k: restore_value(v, identity_for) for k, v in value.items()}
    return value


def labels_in_text(text):
    """Every student label text refers to (not "(as written)" text)."""
    found = set()
    if not isinstance(text, str):
        return found
    decoded = _ENCODED_REF_RE.sub(
        lambda m: urllib.parse.unquote(m.group(0)), text)
    for match in _PLAIN_REF_RE.finditer(decoded):
        if (match.group(3) or match.group(4)) == AS_WRITTEN:
            continue
        found.add(match.group(1))
        found.update(_LABEL_RE.findall(match.group(2) or ""))
    return found


def labels_in_value(value):
    found = set()
    if isinstance(value, str):
        return labels_in_text(value)
    if isinstance(value, list):
        for v in value:
            found |= labels_in_value(v)
    elif isinstance(value, dict):
        for v in value.values():
            found |= labels_in_value(v)
    return found
