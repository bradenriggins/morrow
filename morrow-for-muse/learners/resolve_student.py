#!/usr/bin/env python3
"""Student identity resolution: an instructor's "student X" -> Canvas user_id.

This is the single resolution point for the Canvas lane (Morrow for
Muse, workstream 2 of the 2026-09-22 polish campaign). Every path that
turns an instructor query (name, login id, SIS id, email, numeric
Canvas user id) into a user_id must go through `resolve_in_course` or
the pure `match_query` below, so the precedence ladder and the
ambiguity contract are enforced in one place instead of reimplemented
ad hoc per op.

Resolution contract (fail-closed, never a silent wrong pick):

* Candidate pool: GET /api/v1/courses/{id}/users with
  enrollment_type[]=student and include[]=enrollments, paginated via
  Link headers. Each user object carries id, name, sortable_name,
  short_name, sis_user_id, sis_login_id, login_id, email, plus its
  enrollments (type, role, enrollment_state, section_id).
* Identifier precedence (highest first):
    1. numeric Canvas user_id (exact)
    2. sis_user_id (exact, case-sensitive; Canvas treats SIS ids as
       case-sensitive strings)
    3. login_id / sis_login_id (exact, case-insensitive)
    4. email (exact, case-insensitive)
    5. name (exact, normalized: casefold, whitespace collapsed,
       diacritics kept; sortable_name "Last, First" also matches
       "First Last")
    6. name (fuzzy: diacritics stripped, punctuation dropped, tokens
       sorted; SequenceMatcher ratio >= 0.85)
  The first ladder rung with at least one candidate wins. One
  candidate -> resolve, except at the fuzzy rung: a close spelling is
  never auto-picked, so even one fuzzy candidate is StudentAmbiguous
  (the educator confirms). More than one -> StudentAmbiguous. None at
  any rung -> StudentNotFound. The query itself is never put into the
  agent-visible evidence.
* State filtering (applied before matching, so stale records never
  shadow live ones): default pool is enrollment_state == "active".
  include_inactive adds "inactive"; include_concluded adds
  "completed". "deleted" and "rejected" never match. Excluded counts
  are reported in the no-match evidence so the educator knows why a
  name that "should" be there was skipped.
* Roles: a user is a student candidate when ANY of their enrollments
  in the course has type StudentEnrollment. Extra roles (e.g. the
  same user enrolled as both student and TA) do not disqualify; the
  resolution records all roles in the evidence.
* Test students (type StudentViewEnrollment) are excluded by default;
  include_test_student=True admits them, flagged in the evidence.
* Section scoping: section_id restricts the pool. A name matching in
  several sections without a section filter is StudentAmbiguous.
* Ambiguity and no-match raise StudentAmbiguous / StudentNotFound.
  Both funnel through failures/translator.py (catalog ids
  "student-resolution-ambiguous" and "student-resolution-no-match"):
  the agent-visible message asks the educator to disambiguate using
  stable labels or section descriptors, never a guessed pick, and
  str(exc) carries NO raw PII (names, emails, logins stay in the
  structured .matches attribute, which is provider-side only and is
  never rendered into agent-visible evidence).

Tenant handling: tenant_base is a parameter. The module validates it
is an exact http(s) origin (so a privacy binding can be built) and
never restricts the host. No tenant is special-cased anywhere here;
that would be tenant-gating and is refused by design.

Stdlib only.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import unicodedata
import urllib.parse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STUDENT_TYPES = frozenset({"StudentEnrollment"})
TEST_STUDENT_TYPES = frozenset({"StudentViewEnrollment"})
DEAD_STATES = frozenset({"deleted", "rejected"})
ACTIVE_STATES = frozenset({"active"})
INACTIVE_STATES = frozenset({"inactive"})
CONCLUDED_STATES = frozenset({"completed"})

FUZZY_THRESHOLD = 0.85

# Ladder rungs, in precedence order. The rung names double as the
# match_kind recorded on a Resolution.
RUNG_USER_ID = "user_id"
RUNG_SIS_USER_ID = "sis_user_id"
RUNG_LOGIN = "login_id"
RUNG_EMAIL = "email"
RUNG_NAME_EXACT = "name_exact"
RUNG_NAME_FUZZY = "name_fuzzy"

_DIGITS_RE = re.compile(r"^\d+$")


# ---------------------------------------------------------------------------
# Errors (funnel through failures/translator.py)
# ---------------------------------------------------------------------------

class StudentResolutionError(Exception):
    """Base for student-resolution outcomes that are not resolutions.

    str(exc) is PII-free by construction: only the query text and
    counts appear. Structured candidate detail lives on .matches /
    .excluded (provider-side; never rendered into agent-visible
    evidence). .resolution_evidence is a flat scalar map that
    failures/translator.py merges into the agent-visible evidence.
    """

    def __init__(self, message, *, query="", evidence=None):
        super().__init__(message)
        self.query = query
        self.resolution_evidence = dict(evidence or {})


class StudentAmbiguous(StudentResolutionError):
    """The query matched more than one roster entry: ask the educator.

    .matches: list of candidate dicts (full provider detail).
    .public_candidates: PII-free disambiguation list (labels or
    section/role descriptors), safe for the agent-visible message.
    """


class StudentNotFound(StudentResolutionError):
    """The query matched no roster entry.

    .excluded: counts of candidates skipped by each filter, so the
    educator can see why a name that "should" be there was skipped.
    """


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def _collapse_ws(text):
    return re.sub(r"\s+", " ", text).strip()


def name_exact_key(text):
    """Normalization for exact name matching: casefold + collapsed ws."""
    if not isinstance(text, str):
        return ""
    return _collapse_ws(text).casefold()


def fuzzy_key(text):
    """Normalization for fuzzy name matching.

    Strips diacritics, drops punctuation, lowercases, sorts tokens, so
    "Garcia, Maria-Jose" and "maria jose garcia" share a key. Unicode
    confusable/homoglyph handling is deliberately out of scope: names
    that differ only by spoof characters must NOT fuzzy-resolve to each
    other (that would be a silent wrong pick); they land as no-match.
    """
    if not isinstance(text, str):
        return ""
    lowered = _collapse_ws(text).casefold()
    stripped = "".join(
        ch for ch in unicodedata.normalize("NFKD", lowered)
        if not unicodedata.combining(ch))
    tokens = re.findall(r"[a-z0-9]+", stripped)
    return " ".join(sorted(tokens))


def _name_variants(candidate):
    """All name strings a candidate can be matched against, exact-keyed."""
    variants = []
    for field in ("name", "sortable_name", "short_name"):
        raw = candidate.get(field)
        if isinstance(raw, str) and raw.strip():
            variants.append(name_exact_key(raw))
            # sortable_name is "Last, First": also offer "First Last".
            if field == "sortable_name" and "," in raw:
                parts = [p.strip() for p in raw.split(",", 1)]
                if parts[0] and parts[1]:
                    variants.append(name_exact_key(parts[1] + " " + parts[0]))
    # Deduplicate, drop empties, keep order.
    seen = set()
    out = []
    for variant in variants:
        if variant and variant not in seen:
            seen.add(variant)
            out.append(variant)
    return out


# ---------------------------------------------------------------------------
# Candidate pool
# ---------------------------------------------------------------------------

def build_candidate(user):
    """Normalize one /users entry (with embedded enrollments) to a candidate.

    Returns None when the dict is not a usable user record (no id).
    """
    if not isinstance(user, dict):
        return None
    uid = user.get("id")
    try:
        uid = int(uid)
    except (TypeError, ValueError):
        return None
    enrollments = []
    for enr in user.get("enrollments") or []:
        if not isinstance(enr, dict):
            continue
        enrollments.append({
            "type": str(enr.get("type") or ""),
            "role": str(enr.get("role") or enr.get("type") or ""),
            "enrollment_state": str(enr.get("enrollment_state") or ""),
            "section_id": enr.get("course_section_id"),
            "last_activity_at": enr.get("last_activity_at")
            if isinstance(enr.get("last_activity_at"), str) else None,
        })
    return {
        "user_id": uid,
        "name": user.get("name") if isinstance(user.get("name"), str) else None,
        "sortable_name": user.get("sortable_name")
        if isinstance(user.get("sortable_name"), str) else None,
        "short_name": user.get("short_name")
        if isinstance(user.get("short_name"), str) else None,
        "sis_user_id": user.get("sis_user_id")
        if isinstance(user.get("sis_user_id"), str) else None,
        "sis_login_id": user.get("sis_login_id")
        if isinstance(user.get("sis_login_id"), str) else None,
        "login_id": user.get("login_id")
        if isinstance(user.get("login_id"), str) else None,
        "email": user.get("email")
        if isinstance(user.get("email"), str) else None,
        "enrollments": enrollments,
    }


def candidate_is_student(candidate):
    """True when any enrollment in this course is a student enrollment.

    StudentViewEnrollment (the test student) counts here so it reaches
    the test-student branch of the filter instead of being misfiled as
    a non-student role.
    """
    return any(e["type"] in STUDENT_TYPES | TEST_STUDENT_TYPES
               for e in candidate["enrollments"])


def candidate_is_test_student(candidate):
    """True when every enrollment is a test-student enrollment."""
    types = {e["type"] for e in candidate["enrollments"]}
    return bool(types) and types <= TEST_STUDENT_TYPES


def candidate_states(candidate):
    return {e["enrollment_state"] for e in candidate["enrollments"]}


def candidate_sections(candidate):
    return {e["section_id"] for e in candidate["enrollments"]
            if e["section_id"] is not None}


def candidate_roles(candidate):
    return sorted({e["role"] for e in candidate["enrollments"] if e["role"]})


def filter_candidates(candidates, *, section_id=None, include_states=ACTIVE_STATES,
                      include_test_student=False):
    """Apply pool filters at the enrollment level. Returns (kept, excluded).

    A user is kept when ANY of their enrollments in this course survives
    the filters: a deleted enrollment in one section never disqualifies
    an active enrollment in another. Only users with no surviving
    enrollment are excluded, and the reason is counted so a no-match
    can explain itself.
    """
    include_states = set(include_states)
    kept = []
    excluded = {"non_student_role": 0, "test_student": 0, "dead_state": 0,
                "inactive": 0, "concluded": 0, "wrong_section": 0,
                "no_usable_enrollment": 0}
    for cand in candidates:
        if not candidate_is_student(cand):
            excluded["non_student_role"] += 1
            continue
        if candidate_is_test_student(cand) and not include_test_student:
            excluded["test_student"] += 1
            continue
        enrollments = cand["enrollments"]
        if not enrollments:
            excluded["no_usable_enrollment"] += 1
            continue
        if section_id is not None:
            in_scope = [e for e in enrollments
                        if e["section_id"] == section_id]
            if not in_scope:
                excluded["wrong_section"] += 1
                continue
            enrollments = in_scope
        live = [e for e in enrollments
                if e["enrollment_state"] in include_states]
        if live:
            kept.append(cand)
            continue
        states = {e["enrollment_state"] for e in enrollments}
        if states & DEAD_STATES or states <= DEAD_STATES:
            excluded["dead_state"] += 1
        elif states & INACTIVE_STATES:
            excluded["inactive"] += 1
        elif states & CONCLUDED_STATES:
            excluded["concluded"] += 1
        else:
            # invited, creation_pending, or another unlisted state.
            excluded["no_usable_enrollment"] += 1
    return kept, excluded


# ---------------------------------------------------------------------------
# Matching ladder
# ---------------------------------------------------------------------------

def _exact(value):
    return value if isinstance(value, str) else ""


def _match_rung(candidates, query, rung):
    """Return the candidates matching `query` at one ladder rung."""
    if rung == RUNG_USER_ID:
        if not _DIGITS_RE.match(query):
            return []
        want = int(query)
        return [c for c in candidates if c["user_id"] == want]
    if rung == RUNG_SIS_USER_ID:
        return [c for c in candidates
                if _exact(c["sis_user_id"]) and c["sis_user_id"] == query]
    if rung == RUNG_LOGIN:
        want = query.casefold()
        return [c for c in candidates
                if (_exact(c["login_id"]) and c["login_id"].casefold() == want)
                or (_exact(c["sis_login_id"])
                    and c["sis_login_id"].casefold() == want)]
    if rung == RUNG_EMAIL:
        want = query.casefold()
        return [c for c in candidates
                if _exact(c["email"]) and c["email"].casefold() == want]
    if rung == RUNG_NAME_EXACT:
        want = name_exact_key(query)
        if not want:
            return []
        return [c for c in candidates if want in _name_variants(c)]
    if rung == RUNG_NAME_FUZZY:
        want = fuzzy_key(query)
        if not want:
            return []
        scored = []
        for cand in candidates:
            best = 0.0
            for variant in _name_variants(cand):
                ratio = difflib.SequenceMatcher(
                    None, want, fuzzy_key(variant)).ratio()
                if ratio > best:
                    best = ratio
            if best >= FUZZY_THRESHOLD:
                scored.append((best, cand))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [cand for _score, cand in scored]
    raise ValueError("unknown rung %r" % (rung,))


_RUNGS = (RUNG_USER_ID, RUNG_SIS_USER_ID, RUNG_LOGIN, RUNG_EMAIL,
          RUNG_NAME_EXACT, RUNG_NAME_FUZZY)


def public_candidate_summary(candidates, label_for=None):
    """PII-free disambiguation list for the agent-visible message.

    label_for(user_id) -> "Student A1"-style label when the source
    vault is available; without it, candidates are described by
    section and roles only, never by name or id.
    """
    parts = []
    for cand in candidates:
        if label_for is not None:
            try:
                who = str(label_for(cand["user_id"]))
            except Exception:
                who = "a student"
        else:
            who = "a student"
        sections = sorted(candidate_sections(cand))
        section_bit = ("section %s" % (", ".join(str(s) for s in sections))
                       if sections else "no section recorded")
        roles = candidate_roles(cand)
        role_bit = ("roles: %s" % ", ".join(roles)) if roles else "no roles"
        test_bit = " (test student)" if candidate_is_test_student(cand) else ""
        parts.append("%s (%s; %s)%s" % (who, section_bit, role_bit, test_bit))
    return "; ".join(parts)


class Resolution:
    """A successful, unambiguous resolution."""

    def __init__(self, user_id, candidate, match_kind, evidence):
        self.user_id = user_id
        self.candidate = candidate
        self.match_kind = match_kind
        self.evidence = evidence

    def __repr__(self):
        return "Resolution(user_id=%r, match_kind=%r)" % (
            self.user_id, self.match_kind)


def match_query(candidates, query, *, label_for=None, fuzzy_threshold=None):
    """Pure resolution: candidates + query -> Resolution.

    Raises StudentAmbiguous (ask the educator) or StudentNotFound.
    The pool filters in filter_candidates must already have run.
    """
    query = _collapse_ws(query) if isinstance(query, str) else ""
    if not query:
        raise StudentNotFound(
            "empty student query matches no roster entry",
            query=query,
            evidence={"match_count": 0,
                      "candidates_examined": len(candidates)})
    global FUZZY_THRESHOLD
    saved_threshold = FUZZY_THRESHOLD
    if fuzzy_threshold is not None:
        FUZZY_THRESHOLD = float(fuzzy_threshold)
    try:
        for rung in _RUNGS:
            hits = _match_rung(candidates, query, rung)
            if not hits:
                continue
            # A fuzzy (typo) match is never auto-picked, even when only
            # one student is close: the educator confirms which student
            # they mean (round-4 privacy audit H3).
            if len(hits) == 1 and rung != RUNG_NAME_FUZZY:
                cand = hits[0]
                evidence = {
                    "match_kind": rung,
                    "match_count": 1,
                    "candidates_examined": len(candidates),
                    "roles": ",".join(candidate_roles(cand)),
                    "sections": ",".join(
                        str(s) for s in sorted(candidate_sections(cand))),
                    "test_student": candidate_is_test_student(cand),
                }
                return Resolution(cand["user_id"], cand, rung, evidence)
            # More than one hit at the winning rung, or a fuzzy hit:
            # ambiguous, ask. The educator's query is never echoed into
            # the evidence (it is agent-visible).
            public = public_candidate_summary(hits, label_for=label_for)
            raise StudentAmbiguous(
                "student query matched %d roster entries%s; "
                "asking the educator to disambiguate"
                % (len(hits), " by a close spelling only"
                   if rung == RUNG_NAME_FUZZY else ""),
                query=query,
                evidence={"match_kind": rung,
                          "match_count": len(hits),
                          "candidates_examined": len(candidates),
                          "candidates_public": public})
    finally:
        FUZZY_THRESHOLD = saved_threshold
    raise StudentNotFound(
        "student query matched no roster entry",
        query=query,
        evidence={"match_count": 0,
                  "candidates_examined": len(candidates)})


# ---------------------------------------------------------------------------
# Fetch layer (pagination; injectable fetcher for tests)
# ---------------------------------------------------------------------------

def check_tenant_base(tenant_base):
    """Validate the tenant base is an exact http(s) origin.

    Never restricts the host: any tenant is allowed. Raises
    ValueError on a malformed base (fail-closed: no privacy binding
    can be built).
    """
    parts = urllib.parse.urlsplit(tenant_base or "")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(
            "tenant base %r is not an exact http(s) origin" % (tenant_base,))
    host = parts.hostname
    port = parts.port
    if port and port not in (80, 443):
        host = "%s:%d" % (host, port)
    return "%s://%s" % (parts.scheme, host)


def _parse_link_next(headers):
    """Extract the rel=next URL from Link headers, or None."""
    link = ""
    for key, value in (headers or {}).items():
        if str(key).lower() == "link" and isinstance(value, str):
            link = value
            break
    if not link:
        return None
    for part in link.split(","):
        segments = part.split(";")
        if len(segments) < 2:
            continue
        url = segments[0].strip().strip("<>")
        for rel in segments[1:]:
            normalized = rel.strip().lower()
            if normalized in ('rel="next"', "rel='next'", "rel=next"):
                return url or None
    return None


def fetch_paginated(fetcher, first_url, *, max_pages=100):
    """Follow a Canvas paginated list. Returns (items, pages_fetched).

    fetcher(url) -> (status:int, headers:dict, body_text:str).
    Non-2xx raises RuntimeError (fail-closed: a partial roster must
    never resolve). A non-list body raises RuntimeError.
    """
    items = []
    url = first_url
    pages = 0
    seen_urls = set()
    while url is not None:
        if url in seen_urls:
            raise RuntimeError(
                "pagination loop detected at %r; refusing a partial roster"
                % (url,))
        seen_urls.add(url)
        status, headers, body_text = fetcher(url)
        pages += 1
        if not (200 <= status < 300):
            raise RuntimeError(
                "roster fetch failed: HTTP %d at %r" % (status, url))
        try:
            body = json.loads(body_text) if body_text else []
        except ValueError:
            raise RuntimeError(
                "roster fetch returned unparseable JSON at %r" % (url,))
        if isinstance(body, dict) and "errors" in body:
            raise RuntimeError(
                "roster fetch returned an error object at %r: %s"
                % (url, json.dumps(body)[:200]))
        if not isinstance(body, list):
            raise RuntimeError(
                "roster fetch returned a non-list body at %r" % (url,))
        items.extend(body)
        if pages >= max_pages:
            raise RuntimeError(
                "roster pagination exceeded %d pages; refusing a partial "
                "roster" % (max_pages,))
        url = _parse_link_next(headers)
    return items, pages


def users_url(tenant_base, course_id, *, per_page=100):
    base = check_tenant_base(tenant_base)
    query = urllib.parse.urlencode([
        ("enrollment_type[]", "student"),
        ("include[]", "enrollments"),
        ("per_page", str(per_page)),
    ])
    return "%s/api/v1/courses/%s/users?%s" % (base, course_id, query)


def fetch_course_candidates(fetcher, tenant_base, course_id, *, per_page=100):
    """Fetch and normalize the student candidate pool for a course."""
    raw_users, pages = fetch_paginated(
        fetcher, users_url(tenant_base, course_id, per_page=per_page))
    candidates = []
    skipped = 0
    for raw in raw_users:
        cand = build_candidate(raw)
        if cand is None:
            skipped += 1
        else:
            candidates.append(cand)
    return candidates, {"pages": pages, "raw_users": len(raw_users),
                        "skipped_unparseable": skipped}


def resolve_in_course(fetcher, tenant_base, course_id, query, *,
                      section_id=None, include_inactive=False,
                      include_concluded=False, include_test_student=False,
                      label_for=None, make_label_for=None):
    """Full pipeline: fetch, filter, match. Returns Resolution.

    make_label_for(tenant_base, course_id, candidates) -> label_for,
    when given, builds the labeler from the fetched roster (so labels
    come from the same course-scoped vault the executor projects with).

    Raises StudentAmbiguous / StudentNotFound (funnel via
    failures/translator.py), ValueError (bad tenant base), or
    RuntimeError (fetch failure). Read-only: only GET list calls.
    """
    check_tenant_base(tenant_base)
    include_states = set(ACTIVE_STATES)
    if include_inactive:
        include_states |= INACTIVE_STATES
    if include_concluded:
        include_states |= CONCLUDED_STATES
    candidates, fetch_ev = fetch_course_candidates(
        fetcher, tenant_base, course_id)
    if make_label_for is not None:
        label_for = make_label_for(tenant_base, course_id, candidates)
    kept, excluded = filter_candidates(
        candidates, section_id=section_id, include_states=include_states,
        include_test_student=include_test_student)
    try:
        resolution = match_query(kept, query, label_for=label_for)
    except StudentNotFound as exc:
        exc.excluded = excluded
        exc.resolution_evidence.update({
            "course_id": str(course_id),
            "candidates_examined": len(kept),
            "pool_size": len(candidates),
            "fetch_pages": fetch_ev["pages"],
            "excluded_summary": ",".join(
                "%s=%d" % (key, excluded[key])
                for key in sorted(excluded) if excluded[key]),
        })
        raise
    except StudentAmbiguous as exc:
        exc.resolution_evidence.update({
            "course_id": str(course_id),
            "candidates_examined": len(kept),
            "pool_size": len(candidates),
            "fetch_pages": fetch_ev["pages"],
        })
        raise
    resolution.evidence.update({
        "course_id": str(course_id),
        "candidates_examined": len(kept),
        "pool_size": len(candidates),
        "fetch_pages": fetch_ev["pages"],
        "include_inactive": include_inactive,
        "include_concluded": include_concluded,
        "include_test_student": include_test_student,
        "section_id": section_id if section_id is not None else "",
    })
    return resolution


# ---------------------------------------------------------------------------
# Live helper-browser fetch (read-only; auth stays in the browser context)
# ---------------------------------------------------------------------------

def _cdp_capture_with_headers(cdp, tab, url, timeout=60):
    """Capture (status, headers, body) for a GET navigation via CDP.

    Mirrors transport.local_chromium.CDP.capture_network_response but
    also returns the HTTP status and response headers (the resolver
    needs the Link header for pagination).
    """
    import base64 as _base64
    import time as _time
    from local_chromium import CDPError as _CDPError
    session = cdp.tab_session(tab)
    cdp.call(tab, "Network.enable", {}, timeout=30)
    try:
        cdp.navigate(tab, url, timeout=60)
        deadline = _time.monotonic() + timeout
        pending = {}
        while True:
            remaining = deadline - _time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    "no response for %r observed within %ds"
                    % (url, timeout))
            for ev in cdp.poll_session_events(session, min(remaining, 5)):
                if not isinstance(ev, dict):
                    continue
                method = ev.get("method")
                if method == "Inspector.targetCrashed":
                    raise _CDPError("the tab crashed during the read")
                params = ev.get("params") or {}
                if method == "Network.responseReceived":
                    response = params.get("response") or {}
                    if "/api/v1/" in str(response.get("url") or ""):
                        pending[params.get("requestId")] = response
                elif method == "Network.loadingFinished":
                    rid = params.get("requestId")
                    if rid in pending:
                        response = pending.pop(rid)
                        try:
                            body = cdp.call(
                                tab, "Network.getResponseBody",
                                {"requestId": rid}, timeout=30)
                        except _CDPError:
                            continue
                        text = body.get("body", "")
                        if body.get("base64Encoded"):
                            text = _base64.b64decode(
                                text.encode("ascii")).decode(
                                    "utf-8", "replace")
                        return (response.get("status"),
                                dict(response.get("headers") or {}),
                                text)
    finally:
        try:
            cdp.call(tab, "Network.disable", {}, timeout=10)
        except Exception:
            pass


def helper_fetch_factory(canvas_base, timeout=60):
    """Build a fetcher(url) -> (status, headers, body) via the login helper.

    The Canvas session lives in the helper Chromium; this process never
    sees credentials and never performs shell-side HTTPS to Canvas.
    Mirrors proof-battery/users_self_proof.py: attaches through the
    verified launcher (W4-P2-16), opens a dedicated tab, captures each
    JSON response via CDP network interception, and closes the tab.
    Read-only: only GET navigations, no form writes.

    In an installed tree the helper's port, token, and profile resolve
    from the tree itself (helper/env and the tree state dir, as
    keepalive writes them). A dev harness that drives a live helper
    elsewhere sets MORROW_TREE_STATE_DIR and LOGIN_HELPER_PROFILE_DIR
    first (the failures/live_verify.py pattern).
    """
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    transport_dir = os.path.join(repo, "transport")
    for entry in (repo, transport_dir):
        if entry not in sys.path:
            sys.path.insert(0, entry)
    from local_chromium import (ChromiumLauncher, default_binary,
                                helper_status, tree_cdp_port,
                                tree_helper_profile_dir)

    try:
        status_doc = helper_status(timeout=10)
    except Exception as exc:
        raise RuntimeError("helper status unreachable: %s" % exc)
    if not status_doc.get("logged_in"):
        raise RuntimeError("helper reports logged_in:false; refusing fetch")

    launcher = ChromiumLauncher(
        default_binary(), tree_helper_profile_dir(),
        cdp_port=tree_cdp_port())
    mode = launcher.start()
    cdp = launcher.cdp
    tab = cdp.new_tab("about:blank")

    def fetch(url):
        status, headers, body = _cdp_capture_with_headers(
            cdp, tab, url, timeout=timeout)
        return status, headers, body or ""

    def close():
        try:
            cdp.close_tab(tab)
        except Exception:
            pass
        if mode == "launched":
            try:
                launcher.stop()
            except Exception:
                pass

    fetch.close = close
    return fetch


def vault_label_for(tenant_base, course_id, candidates):
    """label_for(user_id) -> the course-scoped "Student A<n>" label.

    Labels come from the privacy boundary (privacy/executor_wire.py),
    the same vault and course binding the executor projects learner
    receipts with, so a label printed here names the same student
    everywhere. Raises when no label can be issued (for example, the
    optional vault dependency is missing): the caller fails closed.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    if repo not in sys.path:
        sys.path.insert(0, repo)
    from privacy import executor_wire
    # Every identifier the roster knows goes into the vault record, so a
    # later read that mentions this student's email or login in free
    # text still projects it to the label.
    identities = []
    for c in candidates:
        identity = {"id": str(c["user_id"])}
        for src, dst in (("name", "name"), ("email", "email"),
                         ("login_id", "loginId"),
                         ("sis_user_id", "sisUserId")):
            if c.get(src):
                identity[dst] = c[src]
        aliases = [c[k] for k in ("sortable_name", "short_name",
                                  "sis_login_id")
                   if c.get(k) and c.get(k) != c.get("name")]
        if aliases:
            identity["aliases"] = aliases
        identities.append(identity)
    issued = executor_wire.issue_labels(tenant_base, course_id, identities)
    labels = {}
    for c, label in zip(candidates, issued):
        if not isinstance(label, str) or not label.startswith("Student A"):
            raise RuntimeError("the privacy boundary returned no label")
        labels[c["user_id"]] = label
    return lambda uid: labels[int(uid)]


# ---------------------------------------------------------------------------
# CLI (read-only resolution probe)
# ---------------------------------------------------------------------------

def _cli():
    parser = argparse.ArgumentParser(
        description="Resolve an instructor's student query to the "
                    "student's course-scoped label (read-only, via the "
                    "login helper browser; raw ids and names never print).")
    parser.add_argument("--tenant-base", required=True,
                        help="Canvas origin, e.g. https://x.instructure.com")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--query", required=True,
                        help="name, login id, SIS id, email, or user id")
    parser.add_argument("--section-id", default=None)
    parser.add_argument("--include-inactive", action="store_true")
    parser.add_argument("--include-concluded", action="store_true")
    parser.add_argument("--include-test-student", action="store_true")
    args = parser.parse_args()

    section_id = None
    if args.section_id is not None:
        try:
            section_id = int(args.section_id)
        except ValueError:
            section_id = args.section_id

    # The output is agent-visible: students appear only as course-scoped
    # labels from the privacy boundary. No label, no answer.
    labels = {}

    def make_label_for(tenant_base, course_id, candidates):
        labels["fn"] = vault_label_for(tenant_base, course_id, candidates)
        return labels["fn"]

    fetch = helper_fetch_factory(args.tenant_base)
    try:
        resolution = resolve_in_course(
            fetch, args.tenant_base, args.course_id, args.query,
            section_id=section_id,
            include_inactive=args.include_inactive,
            include_concluded=args.include_concluded,
            include_test_student=args.include_test_student,
            make_label_for=make_label_for)
    except StudentResolutionError as exc:
        print(json.dumps({
            "resolved": False,
            "error_class": type(exc).__name__,
            "message": str(exc),
            "evidence": exc.resolution_evidence,
        }, indent=1))
        return 1
    except Exception as exc:
        if "fn" in labels:
            raise
        print(json.dumps({
            "resolved": False,
            "error_class": "StudentLabelUnavailable",
            "message": "no course-scoped student label could be issued "
                       "(%s); refusing to print raw student identity"
                       % type(exc).__name__,
        }, indent=1))
        return 2
    finally:
        fetch.close()
    evidence = {k: v for k, v in resolution.evidence.items()
                if k not in ("user_id", "query")}
    print(json.dumps({
        "resolved": True,
        "student": labels["fn"](resolution.user_id),
        "match_kind": resolution.match_kind,
        "evidence": evidence,
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
