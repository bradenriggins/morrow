#!/usr/bin/env python3
"""Lane 2 re-authentication state machine for the Moodle lane.

Architecture section 3.2, ported to Moodle session semantics:

  1. DETECT.   Expiry signals are specific (live-characterized, not
               guessed). On Moodle 5.2 + the AJAX path:
                 - envelope errorcode `servicerequireslogin`
                   (thrown by call_external_function when the session is
                   gone; HTTP 200 with the error envelope), or the older
                   `requireloginerror` / `sessionerror` on other branches;
                 - a 30x whose Location header targets /login. The AJAX
                   and form paths use allow_redirects=False, so the
                   redirect is never followed: the classifier inspects
                   the Location response header (the redirect target),
                   not resp.url, which is the request URL. Page-format
                   requests (redirects followed) surface the same way
                   via the final URL.
                 - an HTTP 200 with a non-JSON body on the AJAX path
                   (dead session serving the login page instead of the
                   AJAX envelope).
               A wrong sesskey (`invalidsesskey`) is NOT expiry: the
               session is fine, the visible value is refreshed from a
               live page and the op retried once.
  2. HALT.     New writes stop immediately. In-flight ops are
               quarantined, never retried blind against a dead session.
  3. NOTIFY.   Plain-language: which connection expired, what is paused,
               nothing was lost.
  4. RE-SIGN-IN. The bootstrap runs again (form login on the sandbox;
               the production Lane 2 flow is the VM browser sign-in).
  5. VERIFIED RESUME. The principal after re-auth must match the stored
               principal (id + username pinning, the port of the
               principalFingerprint check). The pinning is
               NON-VACUOUS: an empty field on either side is not
               evidence, so at least one non-empty field (id or
               username) must actually match; two empty extractions
               can never produce principal_match=True. Quarantined ops
               replay only with fresh per-action approval, and only
               after a verified (non-vacuous) match.

The drill below exercises the machine against SIMULATED dead-session
signals (a scrubbed session jar and a garbled sesskey), because the
real expiry on this sandbox is the hourly site reset, which cannot be
scheduled on demand. Every transition is journaled; the drill emits a
receipt with the exact observed signals.

Usage:
  reauth.py --base https://sandbox.moodledemo.net --username teacher --password <published demo password>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore

try:  # package import, e.g. "from moodle.reauth import ReauthMachine"
    from .login import bootstrap, resolve_password
    from .session import (MoodleSession, MoodleLaneError, classify_signal,
                          SafeRedirectSession)
except ImportError:  # script usage: python3 reauth.py (moodle/ on sys.path)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from login import bootstrap, resolve_password  # noqa: E402
    from session import (MoodleSession, MoodleLaneError, classify_signal,  # noqa: E402
                         SafeRedirectSession)

DEFAULT_TIMEOUT = 25


def characterize_dead_session_signals(sess: MoodleSession) -> Dict[str, Any]:
    """Observe, live, what a dead session and a bad sesskey look like.

    Two simulations, no real expiry needed:
      A. a session jar with the session cookie scrubbed (as after the
         hourly sandbox reset or an any-logout-anywhere);
      B. a live session with a garbled sesskey.
    Returns the exact signals for the classifier evidence table.
    """
    out: Dict[str, Any] = {}

    # A. Dead session: fresh jar, no cookies, same AJAX call shape.
    # W4-P2-7: SafeRedirectSession so the characterization probes
    # inherit the downgrade-refusal policy.
    dead = SafeRedirectSession()
    r = dead.post(
        sess.base + "/lib/ajax/service.php",
        params={"sesskey": "XXXXXXXXXX", "info": "core_course_get_enrolled_courses_by_timeline_classification"},
        data=json.dumps([{"index": 0,
                          "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
                          "args": {"classification": "all"}}]),
        headers={"Content-Type": "application/json"},
        timeout=DEFAULT_TIMEOUT,
        allow_redirects=False,
    )
    try:
        payload = r.json()
    except Exception:
        payload = None
    env = payload[0] if isinstance(payload, list) and payload else None
    kind, detail = classify_signal(r.status_code, r.url, env,
                                   location=r.headers.get("Location"))
    out["dead_session_ajax"] = {
        "http": r.status_code,
        "envelope_errorcode": (env or {}).get("exception", {}).get("errorcode"),
        "classified_as": kind,
        "detail": detail,
    }

    # A2. Dead session on a page-format request: expect a redirect to /login.
    # Redirects are not followed here, so the target is the Location
    # header; the page body is HTML, so no envelope is expected.
    r2 = dead.get(sess.base + "/my/", timeout=DEFAULT_TIMEOUT,
                  allow_redirects=False)
    loc = r2.headers.get("Location", "")
    k2, d2 = classify_signal(r2.status_code, r2.url, None,
                             expect_envelope=False, location=loc)
    out["dead_session_page"] = {
        "http": r2.status_code,
        "location": loc[:80],
        "classified_as": k2,
        "detail": d2,
    }

    # B. Live session, garbled sesskey: expect invalidsesskey, NOT reauth.
    r3 = sess.session.post(
        sess.base + "/lib/ajax/service.php",
        params={"sesskey": "XXXXXXXXXX",
                "info": "core_course_get_enrolled_courses_by_timeline_classification"},
        data=json.dumps([{"index": 0,
                          "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
                          "args": {"classification": "all"}}]),
        headers={"Content-Type": "application/json"},
        timeout=DEFAULT_TIMEOUT,
        allow_redirects=False,
    )
    try:
        payload3 = r3.json()
    except Exception:
        payload3 = None
    env3 = payload3[0] if isinstance(payload3, list) and payload3 else None
    k3, d3 = classify_signal(r3.status_code, r3.url, env3,
                             location=r3.headers.get("Location"))
    out["garbled_sesskey"] = {
        "http": r3.status_code,
        "envelope_errorcode": (env3 or {}).get("exception", {}).get("errorcode"),
        "classified_as": k3,
        "detail": d3,
    }
    return out


class ReauthMachine:
    """The five-step state machine. Journaled at every transition."""

    def __init__(self, sess: MoodleSession):
        self.sess = sess
        self.state = "healthy"
        self.quarantine: List[Dict[str, Any]] = []
        self.transitions: List[Dict[str, Any]] = []

    def _step(self, to: str, note: str) -> None:
        self.transitions.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "from": self.state, "to": to, "note": note,
        })
        self.sess.journal("reauth.transition",
                          {"from": self.state, "to": to},
                          {"note": note})
        self.state = to

    def on_signal(self, signal: Dict[str, Any]) -> str:
        """Step 1+2: detect the classified signal, halt writes, quarantine."""
        if self.state != "healthy":
            return self.state
        if signal.get("classified_as") == "reauth":
            self._step("halted", "expiry detected: %s" % signal.get("detail"))
            return self.state
        return self.state

    def park_inflight(self, op: Dict[str, Any]) -> None:
        """Step 2: quarantine an in-flight op instead of blind retry."""
        op = dict(op)
        op["parked_at"] = datetime.now(timezone.utc).isoformat()
        self.quarantine.append(op)
        self.sess.journal("reauth.quarantine", {"op_id": op.get("op_id")},
                          {"parked": True})

    def notify(self) -> str:
        """Step 3: the plain-language educator message."""
        self._step("notified", "educator told: connection expired, "
                               "%d op(s) paused, nothing lost"
                   % len(self.quarantine))
        return ("Your Moodle connection expired (the sandbox resets every "
                "hour, which ends sessions). %d action(s) paused, nothing "
                "was lost. Sign in again and I will verify it is really "
                "you, then resume only what you approve."
                % len(self.quarantine))

    def reauthenticate(self, base: str, username: str,
                       password: str) -> Dict[str, Any]:
        """Step 4+5: re-bootstrap and verify the principal matches.

        The pinning is NON-VACUOUS: an empty field on either side is
        not evidence. At least one non-empty field (id or username)
        must actually match between the stored and the fresh
        principal; when theme-scraped extraction returns {} on both
        sides, principal_match is False and resuming is refused.
        """
        self._step("reauthenticating", "running the sign-in bootstrap again")
        bundle = bootstrap(base, username, password, self.sess.timeout)
        new_principal = bundle["principal"]
        old = self.sess.principal
        old_id = str(old.get("id") or "")
        new_id = str(new_principal.get("id") or "")
        old_username = str(old.get("username") or "")
        new_username = str(bundle.get("username") or "")
        id_match = bool(old_id and new_id) and old_id == new_id
        username_match = (bool(old_username and new_username)
                          and old_username == new_username)
        match = id_match or username_match
        # Refresh the session's live material.
        self.sess.session = bundle["session"]
        self.sess.sesskey = bundle["sesskey"]
        self._step("verified" if match else "principal_mismatch",
                   "principal pinning: old=%s new=%s" % (old, new_principal))
        return {"principal_match": match,
                "old_principal": old, "new_principal": new_principal}

    def resume(self, approved_op_ids: List[str]) -> Dict[str, Any]:
        """Step 5: replay quarantined ops only with fresh approval.

        Callers must only pass approvals after a verified (non-vacuous)
        principal match; run_drill enforces this by approving nothing
        when principal_match is False.
        """
        resumed = [o for o in self.quarantine
                   if o.get("op_id") in set(approved_op_ids)]
        dropped = [o for o in self.quarantine
                   if o.get("op_id") not in set(approved_op_ids)]
        self.quarantine = []
        self._step("healthy", "resumed %d approved op(s), dropped %d"
                   % (len(resumed), len(dropped)))
        return {"resumed": [o.get("op_id") for o in resumed],
                "dropped": [o.get("op_id") for o in dropped]}


def run_drill(sess: MoodleSession, base: str, username: str,
              password: str) -> Dict[str, Any]:
    """Full drill: characterize signals, drive the machine, receipt it."""
    signals = characterize_dead_session_signals(sess)

    machine = ReauthMachine(sess)
    # Park one in-flight op (a no-op marker, never dispatched).
    marker = {"op_id": str(uuid.uuid4()), "tool": "marker.read",
              "note": "drill placeholder, never dispatched"}
    machine.on_signal(signals["dead_session_ajax"])
    machine.park_inflight(marker)
    message = machine.notify()
    reauth_result = machine.reauthenticate(base, username, password)
    # A failed (or vacuous) principal pinning must NOT approve resuming
    # quarantined ops: nothing is approved unless the match is verified.
    approved = [marker["op_id"]] if reauth_result["principal_match"] else []
    resume_result = machine.resume(approved)

    receipt = {
        "tool": "morrow-moodle-reauth-drill",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "signals": signals,
        "transitions": machine.transitions,
        "principal_match": reauth_result["principal_match"],
        "resume": resume_result,
        "educator_message": message,
        "verdict": (
            "PASS" if (
                signals["dead_session_ajax"]["classified_as"] == "reauth"
                and signals["garbled_sesskey"]["classified_as"] == "sesskey"
                and reauth_result["principal_match"]
                and resume_result["resumed"] == [marker["op_id"]]
            ) else "FAIL"),
    }
    sess.journal("reauth.drill", {}, receipt)
    return receipt


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Moodle lane re-auth drill.")
    p.add_argument("--base", default="https://sandbox.moodledemo.net")
    p.add_argument("--username", default="teacher")
    p.add_argument("--password", default=None,
                   help="DISCOURAGED: visible in the process table and shell "
                        "history. Prefer the MOODLE_PASSWORD environment "
                        "variable or the stdin prompt. Never put a real "
                        "credential here; argv is for the published demo "
                        "password only.")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    password = resolve_password(args.password, args.base)

    bundle = bootstrap(args.base, args.username, password, args.timeout)
    sess = MoodleSession.from_bundle(bundle, timeout=args.timeout)
    receipt = run_drill(sess, args.base, args.username, password)
    if args.json:
        print(json.dumps(receipt, indent=2, default=str))
    else:
        print("re-auth drill: %s" % receipt["verdict"])
        for name, sig in receipt["signals"].items():
            print("  %-18s http=%s -> %s (%s)" % (
                name, sig["http"], sig["classified_as"], sig["detail"][:70]))
        print("  principal_match=%s resume=%s" % (
            receipt["principal_match"], receipt["resume"]))
        print("  educator message: %s" % receipt["educator_message"])
    return 0 if receipt["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
