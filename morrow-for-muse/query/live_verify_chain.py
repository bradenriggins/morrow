#!/usr/bin/env python3
"""Final live GET verification for the failed-students chain (2026-09-22).

GET-only against course 89585 through the authenticated helper. Prints
record counts, pagination evidence, field presence, and shape facts only.
Never prints learner names, ids, tokens, or the helper token.
"""

import os
import sys

_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)

from query.live_read import LiveReader


def main():
    r = LiveReader()
    r.health_check()
    print("health_check: principal id 28206 verified in-page")
    course = "89585"

    me = r.get_json("/api/v1/users/self")
    print("users/self: id=%s (expected 28206)" % me.get("id"))

    status, quizzes, note = r.get_paginated(
        "/api/v1/courses/%s/quizzes?per_page=100" % course)
    dated = [q for q in quizzes if any(
        q.get(k) for k in ("due_at", "lock_at", "unlock_at"))]
    linked = [q for q in quizzes if q.get("assignment_id") is not None]
    print("classic quizzes: HTTP %s, records=%d, pagination_note=%r, "
          "dated=%d, linked_to_assignment=%d"
          % (status, len(quizzes), note, len(dated), len(linked)))

    status, assigns, note = r.get_paginated(
        "/api/v1/courses/%s/assignments?per_page=100" % course)
    with_dates = [a for a in assigns if any(
        a.get(k) for k in ("due_at", "lock_at", "unlock_at"))]
    print("assignments: HTTP %s, records=%d, pagination_note=%r, "
          "with_date_fields=%d" % (status, len(assigns), note, len(with_dates)))

    nq = r.get_json("/api/quiz/v1/courses/%s/quizzes?per_page=100" % course)
    nq = nq if isinstance(nq, list) else []
    nq_dated = [q for q in nq if any(
        q.get(k) for k in ("due_at", "lock_at", "unlock_at"))]
    print("new quizzes: records=%d, dated=%d" % (len(nq), len(nq_dated)))

    gs = r.get_json("/api/v1/courses/%s?include[]=grading_standard" % course)
    print("course grading_standard_id: %r" % gs.get("grading_standard_id"))

    status, subs, note = r.get_paginated(
        "/api/v1/courses/%s/assignments/4045391/submissions"
        "?per_page=100&include[]=user" % course)
    states = {}
    fields = set()
    for s in subs:
        states[s.get("workflow_state")] = states.get(
            s.get("workflow_state"), 0) + 1
        fields.update(k for k in s if s[k] is not None)
    print("submissions(4045391): HTTP %s, rows=%d, pagination_note=%r"
          % (status, len(subs), note))
    print("  workflow_states: %s" % states)
    print("  non_null_fields: %s" % sorted(fields))

    status, enr, note = r.get_paginated(
        "/api/v1/courses/%s/enrollments?per_page=100&type[]=StudentEnrollment"
        % course)
    print("student enrollments: HTTP %s, rows=%d, pagination_note=%r"
          % (status, len(enr), note))
    r.close()
    print("LIVE VERIFY OK")


if __name__ == "__main__":
    main()
