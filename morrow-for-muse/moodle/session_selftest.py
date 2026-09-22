#!/usr/bin/env python3
"""Selftest: Moodle lane auth-lifecycle remediation (wave 4, auth family).

Hermetic: no network, no Moodle, no credentials. A fake requests.Session
is injected; all journals land under moodle/.selftest-work (allowed by
the installer's integrity gate, cleaned up after the suites run).

Covers:
  W4-P1-5  HTTPS enforcement on the Moodle base: http:// is refused
           loudly before any session or cookie exists; the
           MOODLE_BASE_ALLOW_HTTP=1 override is honored explicitly;
           https:// and bare hosts normalize to https://; the same
           normalizer guards moodle/login.bootstrap,
           MoodleSession.__init__, and lanes/detect._normalize_base_url.
  W4-P2-1  Moodle session-death lifecycle (same requirements as the
           Chromium lane): a classified reauth signal on write or read
           engages the re-auth machine (halt + quarantine + notify) and
           raises loudly; nothing is retried against the dead session;
           subsequent writes are refused while the halt stands; a
           provider (non-reauth) error does NOT engage the machine.
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRATCH = os.path.join(HERE, ".selftest-work")

shutil.rmtree(SCRATCH, ignore_errors=True)
os.makedirs(SCRATCH, exist_ok=True)

for _p in (REPO,):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from moodle.session import (  # noqa: E402
    MoodleSession, MoodleLaneError, normalize_moodle_base)

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("PASS %s" % name)
    else:
        FAIL.append(name)
        print("FAIL %s%s" % (name, (" (%s)" % detail) if detail else ""))


# ----------------------------------------------------------------- W4-P1-5

def t_normalize():
    check("https: accepted and normalized",
          normalize_moodle_base("https://m.edu/") == "https://m.edu")
    check("https: bare host becomes https",
          normalize_moodle_base("m.edu") == "https://m.edu")
    try:
        normalize_moodle_base("http://m.edu")
        refused = None
    except ValueError as e:
        refused = str(e)
    check("https: http refused", refused is not None)
    check("https: refusal names plaintext risk",
          refused is not None and "plaintext" in refused, refused)
    check("https: refusal names the override",
          refused is not None and "MOODLE_BASE_ALLOW_HTTP=1" in refused)
    os.environ["MOODLE_BASE_ALLOW_HTTP"] = "1"
    try:
        check("https: override explicitly accepted",
              normalize_moodle_base("http://m.edu") == "http://m.edu")
    finally:
        del os.environ["MOODLE_BASE_ALLOW_HTTP"]
    try:
        normalize_moodle_base("")
        empty_ok = False
    except ValueError:
        empty_ok = True
    check("https: empty base refused", empty_ok)
    # MoodleSession normalizes before any journal dir is created: an
    # http base raises before the session or any cookie exists.
    jd = os.path.join(SCRATCH, "j-nope")
    try:
        MoodleSession("http://m.edu", object(), "sesskey",
                      journal_dir=jd)
        constructed = True
    except ValueError:
        constructed = False
    check("https: MoodleSession refuses http before construction",
          constructed is False)
    check("https: no journal dir created on refusal",
          not os.path.exists(jd))
    # lanes/detect routes through the same normalizer.
    sys.path.insert(0, os.path.join(REPO, "lanes"))
    import detect as lane_detect
    try:
        lane_detect._normalize_base_url("http://m.edu")
        lane_refused = False
    except ValueError:
        lane_refused = True
    check("https: lanes/detect refuses http", lane_refused)


# ------------------------------------------------- W4-P2-1 fake transport

class FakeResp:
    def __init__(self, status, url, location=None, payload=None,
                 json_raises=False):
        self.status_code = status
        self.url = url
        self.headers = {"Location": location} if location else {}
        self._payload = payload
        self._json_raises = json_raises

    def json(self):
        if self._json_raises:
            raise ValueError("no JSON body")
        return self._payload


class FakeSession:
    """Stub requests.Session: canned responses, records cookie use."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.posts = []
        self.cookies = {}

    def post(self, url, **kw):
        self.posts.append(url)
        return self._responses.pop(0)


def _make_sess(responses, tag):
    jd = os.path.join(SCRATCH, "journal-%s" % tag)
    return MoodleSession("https://m.edu", FakeSession(responses),
                         "sesskey-%s" % tag, journal_dir=jd)


def rsm_op_ids(machine):
    return [o.get("op_id") for o in machine.quarantine]


def _reauth_ajax_responses():
    # A 302 to /login on the AJAX path: the classified reauth signal.
    return [FakeResp(302, "https://m.edu/lib/ajax/service.php",
                     location="https://m.edu/login/index.php",
                     json_raises=True)]


def t_write_death():
    sess = _make_sess(_reauth_ajax_responses(), "wdeath")
    plan = {"op_id": "op-wdeath-1", "tool": "core_x_write",
            "args": {"x": 1}}
    try:
        sess.write(plan)
        raised = None
    except MoodleLaneError as e:
        raised = e
    check("moodle: write on dead session raises", raised is not None)
    check("moodle: raised as reauth",
          raised is not None and raised.kind == "reauth",
          getattr(raised, "kind", None))
    check("moodle: re-auth machine engaged",
          sess._reauth_machine is not None)
    check("moodle: machine halted (state notified: detect -> halt -> "
          "quarantine -> notify)",
          sess._reauth_machine.state == "notified",
          sess._reauth_machine.state)
    check("moodle: op parked in quarantine",
          [o.get("op_id") for o in sess._reauth_machine.quarantine]
          == ["op-wdeath-1"])
    check("moodle: notification names expiry",
          "expired" in str(raised).lower(), str(raised)[:80])
    check("moodle: nothing retried (one provider call only)",
          len(sess.session.posts) == 1, len(sess.session.posts))
    check("moodle: op_id reservation released for approved re-dispatch",
          "op-wdeath-1" not in sess.used_op_ids)
    # The halt refuses subsequent writes loudly.
    sess2_responses = [FakeResp(200, "https://m.edu/lib/ajax/service.php",
                                payload=[{"error": False, "data": {}}])]
    sess.session._responses.extend(sess2_responses)
    try:
        sess.write({"op_id": "op-wdeath-2", "tool": "core_x_write",
                    "args": {}})
        halted = None
    except MoodleLaneError as e:
        halted = e
    check("moodle: writes refused while halt stands",
          halted is not None and halted.kind == "reauth")
    check("moodle: refused write made no provider call",
          len(sess.session.posts) == 1)


def t_read_death():
    sess = _make_sess(_reauth_ajax_responses(), "rdeath")
    try:
        sess.ajax("core_course_get_contents", {"courseid": 2})
        raised = None
    except MoodleLaneError as e:
        raised = e
    check("moodle: read on dead session engages the machine",
          raised is not None and sess._reauth_machine is not None
          and sess._reauth_machine.state == "notified",
          getattr(sess._reauth_machine, "state", None))
    # A write after a read-discovered death is refused.
    try:
        sess.write({"op_id": "op-rdeath-2", "tool": "core_x_write",
                    "args": {}})
        halted = None
    except MoodleLaneError as e:
        halted = e
    check("moodle: write refused after read-discovered death",
          halted is not None and "halted" in str(halted).lower())


def t_provider_error_no_machine():
    # A provider errorcode is NOT a session death: no machine, plain raise.
    resp = FakeResp(200, "https://m.edu/lib/ajax/service.php",
                    payload=[{"error": True,
                              "exception": {"errorcode": "invalidrecord",
                                            "message": "no such record"}}])
    sess = _make_sess([resp], "perr")
    try:
        sess.write({"op_id": "op-perr-1", "tool": "core_x_write",
                    "args": {}})
        raised = None
    except MoodleLaneError as e:
        raised = e
    check("moodle: provider error raises",
          raised is not None and raised.kind == "provider",
          getattr(raised, "kind", None))
    check("moodle: provider error does not engage the machine",
          sess._reauth_machine is None)


def t_resume_flow():
    sess = _make_sess(_reauth_ajax_responses(), "resume")
    try:
        sess.write({"op_id": "op-resume-1", "tool": "core_x_write",
                    "args": {}})
    except MoodleLaneError:
        pass
    m = sess._reauth_machine
    check("moodle: resume needs verified principal + approval "
          "(machine notified, op quarantined)",
          m.state == "notified"
          and rsm_op_ids(m) == ["op-resume-1"], m.state)
    out = m.resume(["op-resume-1"])
    check("moodle: resume replays only the approved op",
          out == {"resumed": ["op-resume-1"], "dropped": []}, repr(out))


def main():
    t_normalize()
    t_write_death()
    t_read_death()
    t_provider_error_no_machine()
    t_resume_flow()
    print("moodle_session_selftest: %d passed, %d failed"
          % (len(PASS), len(FAIL)))
    if FAIL:
        print("FAILED: %s" % FAIL)
    shutil.rmtree(SCRATCH, ignore_errors=True)
    return not FAIL


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
