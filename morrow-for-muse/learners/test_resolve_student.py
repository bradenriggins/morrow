#!/usr/bin/env python3
"""Unit + adversarial tests for learners/resolve_student.py.

Every case defines the CORRECT resolution first (see the module
docstring's contract), then asserts the resolver produces it. Synthetic
fixtures only; no network, no credentials, no tenant.

Run from the tree root: python3 -m unittest learners.test_resolve_student
Stdlib unittest only.
"""

import os
import sys
import unittest

TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE_ROOT not in sys.path:
    sys.path.insert(0, TREE_ROOT)

from learners.resolve_student import (  # noqa: E402
    ACTIVE_STATES,
    Resolution,
    StudentAmbiguous,
    StudentNotFound,
    build_candidate,
    candidate_is_student,
    candidate_is_test_student,
    check_tenant_base,
    fetch_course_candidates,
    fetch_paginated,
    filter_candidates,
    fuzzy_key,
    match_query,
    name_exact_key,
    public_candidate_summary,
    resolve_in_course,
    users_url,
)


def _user(uid, name, **kw):
    enrollments = kw.pop("enrollments", None)
    if enrollments is None:
        enrollments = [{
            "type": "StudentEnrollment",
            "role": "StudentEnrollment",
            "enrollment_state": "active",
            "course_section_id": kw.pop("section_id", 11),
        }]
    user = {
        "id": uid,
        "name": name,
        "sortable_name": kw.pop("sortable_name", None),
        "short_name": kw.pop("short_name", None),
        "sis_user_id": kw.pop("sis_user_id", None),
        "sis_login_id": kw.pop("sis_login_id", None),
        "login_id": kw.pop("login_id", None),
        "email": kw.pop("email", None),
        "enrollments": enrollments,
    }
    assert not kw, "unused fixture kw: %r" % (kw,)
    return user


def _cands(*users):
    return [build_candidate(u) for u in users]


def _fetcher(pages):
    """pages: list of (status, headers, body_text) per page URL in order."""
    calls = []

    def fetch(url):
        calls.append(url)
        idx = len(calls) - 1
        if idx >= len(pages):
            raise AssertionError("unexpected fetch #%d: %s" % (idx, url))
        return pages[idx]

    fetch.calls = calls
    return fetch


class NormalizationTests(unittest.TestCase):
    def test_exact_key_case_and_whitespace(self):
        self.assertEqual(name_exact_key("  Jane   SMITH "),
                         name_exact_key("jane smith"))

    def test_fuzzy_key_ignores_order_punctuation_diacritics(self):
        self.assertEqual(fuzzy_key("Garcia, Maria-Jose"),
                         fuzzy_key("maria jose garcia"))
        self.assertEqual(fuzzy_key("Jose Garcia"), fuzzy_key("jose garcia"))

    def test_fuzzy_key_homoglyph_does_not_collide(self):
        # Cyrillic 'o' (U+043E) must NOT normalize onto Latin 'o': a
        # spoof name must never fuzzy-resolve to the real one.
        self.assertNotEqual(fuzzy_key("J\u043ehn Smith"),
                            fuzzy_key("John Smith"))


class CandidateTests(unittest.TestCase):
    def test_build_candidate_drops_unparseable(self):
        self.assertIsNone(build_candidate({"name": "No Id"}))
        self.assertIsNone(build_candidate("not a dict"))
        cand = build_candidate(_user(5, "Jane"))
        self.assertEqual(cand["user_id"], 5)

    def test_dual_role_student_and_ta_is_student(self):
        cand = build_candidate(_user(7, "Dual Role", enrollments=[
            {"type": "StudentEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "active", "course_section_id": 11},
            {"type": "TaEnrollment", "role": "TaEnrollment",
             "enrollment_state": "active", "course_section_id": 11},
        ]))
        self.assertTrue(candidate_is_student(cand))
        self.assertFalse(candidate_is_test_student(cand))

    def test_test_student_detected(self):
        cand = build_candidate(_user(9, "Test Student", enrollments=[
            {"type": "StudentViewEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "active", "course_section_id": 11},
        ]))
        self.assertTrue(candidate_is_test_student(cand))
        # A pure test student still counts as a student candidate so
        # the pool filter files it under test_student, not under
        # non_student_role.
        self.assertTrue(candidate_is_student(cand))


class LadderTests(unittest.TestCase):
    def test_exact_name_resolves(self):
        cands = _cands(_user(1, "Jane Smith"), _user(2, "Bob Jones"))
        res = match_query(cands, "jane smith")
        self.assertIsInstance(res, Resolution)
        self.assertEqual(res.user_id, 1)
        self.assertEqual(res.match_kind, "name_exact")

    def test_duplicate_display_names_ambiguous(self):
        # CORRECT: two active "Jane Smith" entries must NOT silently
        # pick one; the educator disambiguates.
        cands = _cands(_user(1, "Jane Smith"), _user(2, "Jane Smith"))
        with self.assertRaises(StudentAmbiguous) as ctx:
            match_query(cands, "Jane Smith")
        exc = ctx.exception
        self.assertEqual(exc.resolution_evidence["match_count"], 2)
        self.assertEqual(exc.resolution_evidence["match_kind"], "name_exact")
        # str(exc) must carry no PII.
        self.assertNotIn("Jane", str(exc))
        self.assertNotIn("Smith", str(exc))

    def test_numeric_query_prefers_canvas_user_id_over_sis(self):
        # CORRECT: a numeric query is a Canvas user id first.
        cands = _cands(
            _user(42, "Canvas Forty-Two", sis_user_id="999"),
            _user(7, "Sis NineNineNine", sis_user_id="42"))
        res = match_query(cands, "42")
        self.assertEqual(res.user_id, 42)
        self.assertEqual(res.match_kind, "user_id")

    def test_numeric_sis_id_matches_when_no_user_id(self):
        cands = _cands(_user(7, "Sis Kid", sis_user_id="424242"))
        res = match_query(cands, "424242")
        self.assertEqual(res.user_id, 7)
        self.assertEqual(res.match_kind, "sis_user_id")

    def test_sis_id_beats_fuzzy_name(self):
        # CORRECT: identifiers outrank fuzzy names, always.
        cands = _cands(
            _user(1, "Jon Smith", sis_user_id="S-1"),
            _user(2, "John Smith", sis_user_id="S-2"))
        res = match_query(cands, "S-2")
        self.assertEqual(res.user_id, 2)
        self.assertEqual(res.match_kind, "sis_user_id")

    def test_login_id_case_insensitive(self):
        cands = _cands(_user(3, "Casey Login", login_id="c_login"))
        res = match_query(cands, "C_LOGIN")
        self.assertEqual(res.user_id, 3)
        self.assertEqual(res.match_kind, "login_id")

    def test_login_beats_name(self):
        cands = _cands(
            _user(1, "Sam Login", login_id="sam"),
            _user(2, "Sam"))
        res = match_query(cands, "sam")
        self.assertEqual(res.user_id, 1)
        self.assertEqual(res.match_kind, "login_id")

    def test_email_match(self):
        cands = _cands(_user(4, "Em Ay", email="Em.Ay@Example.edu"))
        res = match_query(cands, "em.ay@example.edu")
        self.assertEqual(res.user_id, 4)
        self.assertEqual(res.match_kind, "email")

    def test_sortable_name_last_first_matches_first_last(self):
        # CORRECT: a name change recorded as sortable_name "Smith,
        # Jane" (display name "Jane Doe") resolves on "Jane Smith".
        cands = _cands(_user(8, "Jane Doe", sortable_name="Smith, Jane"))
        res = match_query(cands, "Jane Smith")
        self.assertEqual(res.user_id, 8)
        self.assertEqual(res.match_kind, "name_exact")

    def test_fuzzy_typo_single_match_resolves(self):
        cands = _cands(_user(1, "John Smith"), _user(2, "Zara Khan"))
        res = match_query(cands, "Jonh Smith")
        self.assertEqual(res.user_id, 1)
        self.assertEqual(res.match_kind, "name_fuzzy")

    def test_fuzzy_multiple_matches_ambiguous(self):
        # CORRECT: a typo near two similar names is ambiguous.
        cands = _cands(_user(1, "John Smith"), _user(2, "John Smyth"))
        with self.assertRaises(StudentAmbiguous) as ctx:
            match_query(cands, "John Smoth")
        self.assertEqual(ctx.exception.resolution_evidence["match_kind"],
                         "name_fuzzy")

    def test_fuzzy_spoof_name_does_not_resolve(self):
        cands = _cands(_user(1, "John Smith"))
        with self.assertRaises(StudentNotFound):
            match_query(cands, "J\u043ehn Smith")

    def test_empty_query_no_match(self):
        with self.assertRaises(StudentNotFound):
            match_query(_cands(_user(1, "Jane")), "   ")

    def test_user_with_no_sis_id_resolves_by_name(self):
        cands = _cands(_user(1, "No Sis", sis_user_id=None,
                             sis_login_id=None, login_id=None))
        res = match_query(cands, "no sis")
        self.assertEqual(res.user_id, 1)


class FilterTests(unittest.TestCase):
    def test_inactive_only_is_no_match_with_excluded_evidence(self):
        # CORRECT: an inactive-only enrollment does not resolve by
        # default, and the no-match says why.
        cands = _cands(_user(1, "Inactive Ivy", enrollments=[
            {"type": "StudentEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "inactive", "course_section_id": 11}]))
        kept, excluded = filter_candidates(cands)
        self.assertEqual(kept, [])
        self.assertEqual(excluded["inactive"], 1)
        with self.assertRaises(StudentNotFound):
            match_query(kept, "Inactive Ivy")
        kept2, _ = filter_candidates(
            cands, include_states=ACTIVE_STATES | {"inactive"})
        res = match_query(kept2, "Inactive Ivy")
        self.assertEqual(res.user_id, 1)

    def test_concluded_enrollment_needs_opt_in(self):
        cands = _cands(_user(1, "Concluded Connie", enrollments=[
            {"type": "StudentEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "completed", "course_section_id": 11}]))
        kept, excluded = filter_candidates(cands)
        self.assertEqual(kept, [])
        self.assertEqual(excluded["concluded"], 1)
        kept2, _ = filter_candidates(
            cands, include_states=ACTIVE_STATES | {"completed"})
        self.assertEqual(match_query(kept2, "Concluded Connie").user_id, 1)

    def test_deleted_enrollment_excluded(self):
        cands = _cands(_user(1, "Deleted Dan", enrollments=[
            {"type": "StudentEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "deleted", "course_section_id": 11}]))
        kept, excluded = filter_candidates(cands)
        self.assertEqual(kept, [])
        self.assertEqual(excluded["dead_state"], 1)

    def test_active_plus_deleted_in_other_section_still_resolves(self):
        # CORRECT: a deleted enrollment in section B must not kill an
        # active enrollment in section A.
        cands = _cands(_user(1, "Mixed Mike", enrollments=[
            {"type": "StudentEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "active", "course_section_id": 11},
            {"type": "StudentEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "deleted", "course_section_id": 12},
        ]))
        kept, _ = filter_candidates(cands)
        self.assertEqual(len(kept), 1)
        self.assertEqual(match_query(kept, "Mixed Mike").user_id, 1)

    def test_test_student_excluded_by_default(self):
        cands = _cands(_user(9, "Test Student", enrollments=[
            {"type": "StudentViewEnrollment", "role": "StudentEnrollment",
             "enrollment_state": "active", "course_section_id": 11}]))
        kept, excluded = filter_candidates(cands)
        self.assertEqual(kept, [])
        self.assertEqual(excluded["test_student"], 1)
        kept2, _ = filter_candidates(cands, include_test_student=True)
        res = match_query(kept2, "Test Student")
        self.assertEqual(res.user_id, 9)
        self.assertTrue(res.evidence["test_student"])

    def test_non_student_roles_excluded(self):
        cands = _cands(_user(5, "Terry Teacher", enrollments=[
            {"type": "TeacherEnrollment", "role": "TeacherEnrollment",
             "enrollment_state": "active", "course_section_id": 11}]))
        kept, excluded = filter_candidates(cands)
        self.assertEqual(kept, [])
        self.assertEqual(excluded["non_student_role"], 1)

    def test_same_name_two_sections_ambiguous_then_section_resolves(self):
        # CORRECT: "Jane Smith" in sections 11 and 12 is ambiguous
        # until a section scopes it.
        cands = _cands(
            _user(1, "Jane Smith", section_id=11),
            _user(2, "Jane Smith", section_id=12))
        kept, _ = filter_candidates(cands)
        with self.assertRaises(StudentAmbiguous):
            match_query(kept, "Jane Smith")
        kept_sec, _ = filter_candidates(cands, section_id=12)
        res = match_query(kept_sec, "Jane Smith")
        self.assertEqual(res.user_id, 2)

    def test_wrong_section_is_no_match_with_count(self):
        cands = _cands(_user(1, "Section Sam", section_id=11))
        kept, excluded = filter_candidates(cands, section_id=99)
        self.assertEqual(kept, [])
        self.assertEqual(excluded["wrong_section"], 1)


class PublicSummaryTests(unittest.TestCase):
    def test_summary_has_no_pii_without_labels(self):
        cands = _cands(
            _user(1, "Jane Smith", login_id="jsmith",
                  email="jane@example.edu", section_id=11),
            _user(2, "Jane Smith", section_id=12))
        summary = public_candidate_summary(cands)
        for pii in ("Jane", "Smith", "jsmith", "jane@example.edu", " 1 ", " 2 "):
            self.assertNotIn(pii, summary)
        self.assertIn("section 11", summary)
        self.assertIn("section 12", summary)

    def test_summary_uses_labels_when_provided(self):
        cands = _cands(_user(1, "Jane Smith", section_id=11))
        summary = public_candidate_summary(
            cands, label_for=lambda uid: "Student A%d" % uid)
        self.assertIn("Student A1", summary)
        self.assertNotIn("Jane", summary)


class FetchTests(unittest.TestCase):
    def test_pagination_follows_link_next(self):
        import json as _json
        page1 = (200,
                 {"Link": '<https://x.test/api/v1/courses/1/users?page=2>; rel="next"'},
                 _json.dumps([_user(1, "Page One")]))
        page2 = (200, {}, _json.dumps([_user(2, "Page Two")]))
        items, pages = fetch_paginated(_fetcher([page1, page2]),
                                       "https://x.test/api/v1/courses/1/users")
        self.assertEqual(pages, 2)
        self.assertEqual([u["id"] for u in items], [1, 2])

    def test_real_canvas_link_header_without_next_is_single_page(self):
        # Regression: captured live 2026-09-22 from
        # /api/v1/courses/89585/users. rel="current"/"first"/"last" with
        # no rel="next" must terminate pagination after one page (the
        # earlier parser stripped the quotes off rel="next" and never
        # matched anything). The captured host is replaced with a
        # documentation-only example host: the Link-header shape is what
        # the test exercises, not the tenant.
        import json as _json
        real_link = (
            '<https://school.example.edu/api/v1/courses/89585/users?'
            'enrollment_type%5B%5D=student&include%5B%5D=enrollments&'
            'page=1&per_page=100>; rel="current",'
            '<https://school.example.edu/api/v1/courses/89585/users?'
            'enrollment_type%5B%5D=student&include%5B%5D=enrollments&'
            'page=1&per_page=100>; rel="first",'
            '<https://school.example.edu/api/v1/courses/89585/users?'
            'enrollment_type%5B%5D=student&include%5B%5D=enrollments&'
            'page=1&per_page=100>; rel="last"')
        page = (200, {"Link": real_link}, _json.dumps([_user(1, "Solo")]))
        items, pages = fetch_paginated(
            _fetcher([page]),
            "https://school.example.edu/api/v1/courses/89585/users")
        self.assertEqual(pages, 1)
        self.assertEqual(len(items), 1)

    def test_pagination_loop_refused(self):
        import json as _json
        looping = (200,
                   {"Link": '<https://x.test/loop>; rel="next"'},
                   _json.dumps([]))
        with self.assertRaises(RuntimeError):
            fetch_paginated(_fetcher([looping, looping]),
                            "https://x.test/loop")

    def test_http_error_refused_never_partial(self):
        with self.assertRaises(RuntimeError):
            fetch_paginated(_fetcher([(500, {}, "boom")]),
                            "https://x.test/bad")

    def test_non_list_body_refused(self):
        with self.assertRaises(RuntimeError):
            fetch_paginated(_fetcher([(200, {}, '{"id": 1}')]),
                            "https://x.test/shape")

    def test_error_object_body_refused(self):
        import json as _json
        with self.assertRaises(RuntimeError):
            fetch_paginated(
                _fetcher([(200, {}, _json.dumps({"errors": ["nope"]}))]),
                "https://x.test/err")

    def test_users_url_shape(self):
        url = users_url("https://canvas.example.edu/", "89585")
        self.assertTrue(url.startswith(
            "https://canvas.example.edu/api/v1/courses/89585/users?"))
        self.assertIn("enrollment_type%5B%5D=student", url)
        self.assertIn("include%5B%5D=enrollments", url)


class TenantTests(unittest.TestCase):
    def test_any_host_allowed_no_tenant_gating(self):
        # Any well-formed origin works; no tenant is special-cased.
        # Hosts are documentation-only examples (no real tenants).
        for base in ("https://canvas.example.edu",
                     "https://school.example.edu",
                     "https://weird-college.example.edu:8443"):
            self.assertTrue(check_tenant_base(base).startswith("https://"))

    def test_malformed_base_refused(self):
        for bad in ("", "not a url", "ftp://x.test", "https://",
                    "///courses/1"):
            with self.assertRaises(ValueError, msg=bad):
                check_tenant_base(bad)


class EndToEndTests(unittest.TestCase):
    def test_resolve_in_course_full_pipeline(self):
        import json as _json
        body = _json.dumps([
            _user(1, "Jane Smith", login_id="jsmith", section_id=11),
            _user(2, "Bob Jones", section_id=11),
        ])
        fetch = _fetcher([(200, {}, body)])
        res = resolve_in_course(
            fetch, "https://canvas.example.edu", "89585", "jsmith")
        self.assertEqual(res.user_id, 1)
        self.assertEqual(res.match_kind, "login_id")
        self.assertEqual(res.evidence["course_id"], "89585")
        self.assertEqual(res.evidence["fetch_pages"], 1)

    def test_resolve_in_course_no_match_carries_excluded_summary(self):
        import json as _json
        body = _json.dumps([
            _user(1, "Inactive Ivy", enrollments=[
                {"type": "StudentEnrollment", "role": "StudentEnrollment",
                 "enrollment_state": "inactive", "course_section_id": 11}]),
        ])
        fetch = _fetcher([(200, {}, body)])
        with self.assertRaises(StudentNotFound) as ctx:
            resolve_in_course(
                fetch, "https://canvas.example.edu", "89585", "Inactive Ivy")
        exc = ctx.exception
        self.assertIn("inactive=1", exc.resolution_evidence["excluded_summary"])
        self.assertNotIn("Ivy", str(exc))

    def test_resolve_in_course_ambiguous_asks_educator(self):
        import json as _json
        body = _json.dumps([
            _user(1, "Jane Smith", section_id=11),
            _user(2, "Jane Smith", section_id=12),
        ])
        fetch = _fetcher([(200, {}, body)])
        with self.assertRaises(StudentAmbiguous) as ctx:
            resolve_in_course(
                fetch, "https://canvas.example.edu", "89585", "Jane Smith",
                label_for=lambda uid: "Student A%d" % uid)
        exc = ctx.exception
        public = exc.resolution_evidence["candidates_public"]
        self.assertIn("Student A1", public)
        self.assertIn("Student A2", public)
        self.assertNotIn("Jane", public)
        self.assertNotIn("Jane", str(exc))


class CliPrivacyBoundaryTests(unittest.TestCase):
    """The CLI output is agent-visible: it must carry course-scoped
    labels, never raw Canvas user ids or names, and must fail closed
    when no label can be issued."""

    def _run_cli(self, argv, labeler):
        import contextlib
        import io
        import json as _json
        from learners import resolve_student as rs
        body = _json.dumps([
            _user(5550101, "Jane Doe", login_id="jdoe"),
            _user(5550102, "Omar Haddad", section_id=12),
        ])
        fetch = _fetcher([(200, {}, body)])
        fetch.close = lambda: None
        saved = (rs.helper_fetch_factory, rs.vault_label_for, sys.argv)
        rs.helper_fetch_factory = lambda base, timeout=60: fetch
        rs.vault_label_for = labeler
        sys.argv = ["resolve_student.py", "--tenant-base",
                    "https://canvas.example.edu", "--course-id", "89585"] \
            + argv
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = rs._cli()
        finally:
            rs.helper_fetch_factory, rs.vault_label_for, sys.argv = saved
        return code, out.getvalue()

    def _labeler(self, tenant_base, course_id, candidates):
        labels = {c["user_id"]: "Student A%d" % (i + 1)
                  for i, c in enumerate(candidates)}
        return lambda uid: labels[uid]

    def test_resolved_prints_label_not_raw_id(self):
        code, out = self._run_cli(["--query", "jdoe"], self._labeler)
        self.assertEqual(code, 0, out)
        self.assertIn("Student A1", out)
        for raw in ("5550101", "Jane", "jdoe\"", "user_id"):
            self.assertNotIn(raw, out)

    def test_ambiguous_lists_labels_not_names(self):
        code, out = self._run_cli(["--query", "Student"], self._labeler)
        self.assertNotIn("Jane", out)
        self.assertNotIn("5550101", out)

    def test_no_vault_fails_closed(self):
        def broken(*_a):
            raise RuntimeError("vault unavailable (cryptography missing)")
        code, out = self._run_cli(["--query", "jdoe"], broken)
        self.assertNotEqual(code, 0)
        self.assertNotIn("5550101", out)
        self.assertNotIn("Jane", out)
        self.assertIn("label", out)


if __name__ == "__main__":
    unittest.main()
