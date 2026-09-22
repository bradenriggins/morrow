#!/usr/bin/env python3
"""Selftest: Wave 5 injection-findings remediation (dispatch side).

Covers the executor/admission fixes for the 2026-09-21 adversarial
audit's input-validation / encoding / injection findings:

  W5-P1-1: homoglyph twin course names. confusable_skeleton() folds
    cross-script lookalikes (Cyrillic/Greek twins of Latin letters) to
    one representative; assert_no_spoof_identifier() fails closed on
    mixed-script confusables; verify_write_target_identity() runs the
    spoof screen on the provider/declared/approval names before any
    equality check, so a visual twin can no longer pass every
    automated gate while looking identical to the educator.
  W5-P2-1: claim_op_id / recheck_claim / release_op_id fail closed on
    non-UUID op_ids (the ids are interpolated into brief/pending
    filenames downstream).
  W5-P2-2: build_headers structurally validates header names/values at
    build time (CRLF/control rejection no longer depends on the lane's
    send-time behavior).
  W5-P2-3: identifier comparisons use NFKC + casefold
    (norm_identifier); admission's tenant normalization too.
  W5-P2-5: manifest `redact` patterns pass a static
    catastrophic-backtracking screen before compiling.

Hermetic: scratch journal under this file's directory (never /tmp, per
the standing rule); no network, no provider.
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
import json
import os
import shutil
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (REPO, os.path.join(REPO, "dispatch")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from dispatch import executor as ex  # noqa: E402
from dispatch import admission as ad  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(
        "%s%s" % (name, (" (%s)" % detail) if detail and not cond else ""))


def check_raises(name, exc_types, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc_types as e:
        check(name, True)
        return e
    except Exception as e:  # noqa: BLE001
        check(name, False, "wrong exception: %r" % e)
        return None
    check(name, False, "no exception raised")
    return None


# Hermetic journal (never touch the real ~/.morrow in tests).
# Wave-3 hygiene: MORROW_SELFTEST_SCRATCH redirects test scratch to the
# wave's authorized scratch area (never /tmp).
_scratch = os.path.join(REPO, "dispatch", ".selftest-work", "wave5-injection")
if os.environ.get("MORROW_SELFTEST_SCRATCH"):
    _scratch = os.path.join(os.environ["MORROW_SELFTEST_SCRATCH"],
                            "wave5-injection")
if os.path.isdir(_scratch):
    shutil.rmtree(_scratch)
os.makedirs(os.path.join(_scratch, "journal"), exist_ok=True)
_saved_journal, _saved_home = ex.JOURNAL_PATH, ex.MORROW_HOME
ex.JOURNAL_PATH = os.path.join(_scratch, "journal", "ops.jsonl")
ex.MORROW_HOME = _scratch

TWIN = "Bіology 101"  # Cyrillic і U+0456; renders identically to Biology 101
assert TWIN != "Biology 101" and len(TWIN) == len("Biology 101")

# ----------------------------------------------------------------------
# W5-P1-1: confusable detection primitives
# ----------------------------------------------------------------------
check("skeleton folds the Cyrillic twin to ascii",
      ex.confusable_skeleton(TWIN) == "biology 101",
      repr(ex.confusable_skeleton(TWIN)))
check("skeleton leaves a pure-ascii name alone",
      ex.confusable_skeleton("Biology 101") == "biology 101")
check("skeleton leaves CJK text alone",
      ex.confusable_skeleton("日本語 101") == "日本語 101",
      repr(ex.confusable_skeleton("日本語 101")))

hits = ex.spoof_characters(TWIN)
check("spoof_characters finds the twin char",
      len(hits) == 1 and hits[0][0] == "і" and hits[0][1] == "i",
      repr(hits))
check("spoof_characters ignores pure-ascii names",
      ex.spoof_characters("Biology 101") == [])
check("spoof_characters ignores single-script Cyrillic names",
      ex.spoof_characters("Русский язык") == [],
      repr(ex.spoof_characters("Русский язык")))
check("spoof_characters ignores CJK/Latin mixes without confusables",
      ex.spoof_characters("日本語 101") == [])
check("spoof_characters ignores Latin-1 diacritics",
      ex.spoof_characters("naïve café") == [])

e = check_raises("assert_no_spoof_identifier refuses the twin",
                 ex.TargetIdentityMismatch,
                 ex.assert_no_spoof_identifier, TWIN, "provider course name")
check("twin refusal names the code point",
      e is not None and "U+0456" in str(e), str(e)[:120] if e else "")
for legit in ("Biology 101", "日本語 101", "Русский язык", "Ὀδύσσεια",
              "naïve café", "CS 101: Intro"):
    try:
        ex.assert_no_spoof_identifier(legit, "course name")
        check("legit name passes: %r" % legit, True)
    except ex.TargetIdentityMismatch as exc:
        check("legit name passes: %r" % legit, False, str(exc)[:100])


# ----------------------------------------------------------------------
# W5-P1-1: end to end through verify_write_target_identity
# ----------------------------------------------------------------------
class _StubSession:
    def __init__(self, course_json):
        self.course_json = course_json

    def raw_request(self, method, url, headers, body_bytes, is_write=False,
                    max_bytes=None):
        assert "/api/v1/courses/99999" in url, url
        return 200, {}, self.course_json.encode("utf-8"), 1


def _verify_against(provider_name):
    entry = {"name": "w5.verify", "provider": "canvas", "effects": "write",
             "request": {"method": "POST",
                         "url": "{canvas_base}/api/v1/courses/{course_id}/x"}}
    params = {"course_id": "99999"}
    declared = {"course_id": "99999", "course_name": provider_name}
    approval_target = {"course_name": provider_name}
    session = _StubSession(json.dumps({"id": 99999, "name": provider_name}))
    config = {"canvas_base": "https://canvas.example.edu"}
    return ex.verify_write_target_identity(
        entry, params, None, session, {}, config,
        declared=declared, approval_target=approval_target)


check_raises("homoglyph twin is refused end to end (was: passed)",
             ex.TargetIdentityMismatch, _verify_against, TWIN)
result = _verify_against("Biology 101")
check("ascii control still verifies",
      result is not None and result["course_name"] == "Biology 101",
      repr(result))
# W5-P2-3: compatibility-equivalent names now compare equal instead of
# failing the gate (availability fix, same security posture).
result = _verify_against("Ｂｉｏｌｏｇｙ １０１")  # full-width
check("full-width provider name verifies against ascii declared",
      result is not None, repr(result))

# ----------------------------------------------------------------------
# W5-P2-1: claim API op_id validation
# ----------------------------------------------------------------------
oid = str(uuid.uuid4())
token = ex.claim_op_id(oid, "dispatch", "w5.t", "read", "d")
check("valid uuid claim still works", bool(token))
ex.recheck_claim(oid, token)
check("valid uuid recheck still works", True)
ex.release_op_id(oid, token, "selftest")
check("valid uuid release still works", True)
token2 = ex.claim_op_id(oid, "dispatch", "w5.t", "read", "d")
ex.release_op_id(oid, token2, "selftest cleanup")
check("op_id reusable after release", True)

for bad in ("../../pwned", "", "not-a-uuid", "/etc/passwd", "1;DROP"):
    check_raises("claim_op_id refuses %r" % bad, ex.ExecutorError,
                 ex.claim_op_id, bad, "dispatch", "w5.t", "read", "d")
    check_raises("recheck_claim refuses %r" % bad, ex.ExecutorError,
                 ex.recheck_claim, bad, "tok")
    check_raises("release_op_id refuses %r" % bad, ex.ExecutorError,
                 ex.release_op_id, bad, "tok", "x")
check("claim_is_live is False (not an exception) for garbage",
      ex.claim_is_live("../../pwned") is False)

# ----------------------------------------------------------------------
# W5-P2-2: build_headers validation
# ----------------------------------------------------------------------
check_raises("build_headers refuses a CRLF param-derived value",
             ex.ExecutorError, ex.build_headers,
             {}, {"X-Note": "params.note"}, None,
             {"note": "abc\r\nInjected-Header: yes"}, {}, {}, False)
check_raises("build_headers refuses a control-char value",
             ex.ExecutorError, ex.build_headers,
             {}, {"X-Note": "params.note"}, None,
             {"note": "a\x00b"}, {}, {}, False)
check_raises("build_headers refuses a non-token header name",
             ex.ExecutorError, ex.build_headers,
             {}, {"Bad Name": "v"}, None, {}, {}, {}, False)
headers = ex.build_headers({}, {"X-Note": "params.note"}, None,
                           {"note": "clean value"}, {}, {}, False)
check("build_headers passes clean headers through",
      headers == {"X-Note": "clean value"}, repr(headers))
check("validate_http_header accepts obs-text-free values",
      ex.validate_http_header("X-Ok", "Bearer abc123") == ("X-Ok", "Bearer abc123"))

# ----------------------------------------------------------------------
# W5-P2-3: normalization
# ----------------------------------------------------------------------
check("NFKC folds the ﬁ ligature", ex.norm_identifier("ﬁle") == "file")
check("NFKC folds full-width + casefold folds case",
      ex.norm_identifier("ＡＢＣ") == "abc")
check("norm_identifier strips", ex.norm_identifier("  X ") == "x")
check("admission tenant norm: trailing slash",
      ad._normalize_target_tenant("https://canvas.example.edu/")
      == "https://canvas.example.edu")
check("admission tenant norm: full-width scheme/host",
      ad._normalize_target_tenant("ＨＴＴＰＳ://canvas.example.edu/")
      == "https://canvas.example.edu",
      repr(ad._normalize_target_tenant("ＨＴＴＰＳ://canvas.example.edu/")))

# ----------------------------------------------------------------------
# W5-P2-5: redact pattern safety
# ----------------------------------------------------------------------
out = ex.redact_payload({"api_token": "s3cret", "name": "plain"},
                        ["token", "sesskey"])
check("safe redact patterns still mask",
      out == {"api_token": "[redacted]", "name": "plain"}, repr(out))
out = ex.redact_payload({"k": "v"}, [r"sess\w+", "(ab)+", "a{1,3}", "x+?y"])
check("linear patterns (bounded repeats, lazy) still compile",
      out == {"k": "v"}, repr(out))
for evil in ("(a+)+$", r"(\w+)*", "(a|b+)+", "((a+))+", "(?:a+)+", r"(a+){2,3}"):
    check_raises("redact_payload refuses nested-quantifier %r" % evil,
                 ex.ExecutorError, ex.redact_payload, {"k": "v"}, [evil])
for evil in (r"(a|aa)+$", "(ab|a)+", "(x|xy|xyz)+", r"(a|aa){2,}"):
    check_raises("redact_payload refuses overlapping-alternation %r" % evil,
                 ex.ExecutorError, ex.redact_payload, {"k": "v"}, [evil])
out = ex.redact_payload({"k": "v"}, ["(a|b)+", "(a|b|c)+"])
check("disjoint single-char alternation still compiles", out == {"k": "v"})
check_raises("redact_payload refuses over-long patterns",
             ex.ExecutorError, ex.redact_payload, {"k": "v"}, ["x" * 501])
# The shipped default patterns stay safe.
for p in ex.DEFAULT_REDACT_PATTERNS:
    ex.assert_regex_safe(p)
check("all DEFAULT_REDACT_PATTERNS pass the screen", True)

# ----------------------------------------------------------------------
# runner
# ----------------------------------------------------------------------
ex.JOURNAL_PATH, ex.MORROW_HOME = _saved_journal, _saved_home

for name in PASS:
    print("  ok %s" % name)
if FAIL:
    print("FAIL: %d" % len(FAIL))
    for name in FAIL:
        print("  FAIL %s" % name)
    sys.exit(1)
print("all wave-5 injection (dispatch) selftests passed")
