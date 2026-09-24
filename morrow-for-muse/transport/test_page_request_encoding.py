#!/usr/bin/env python3
"""The Chromium lane sends a list parameter as Canvas reads it.

Failure modes this suite pins down (written before the fix; muse engine
round 2, 2026-09-23):
  1. A read whose parameters carry a list (Canvas include[] or
     user_ids[]) went out with the values joined by commas as one
     parameter: the page program built the query with
     new URLSearchParams(data), which turns an array into one
     comma-joined string. Canvas received include[]=overrides,all_dates,
     ignored it, and the read reported success with the data missing.
     Each value is its own pair: include[]=overrides&include[]=all_dates.
  2. DELETE sends its parameters in the query the same way.
  3. A parameter whose value is an object, or a list holding an object,
     has no query form ("[object Object]"): it is refused before
     anything is sent (RequestNotSendable), not sent as that text.
  4. A form-encoded body with a repeated key (a[]=1&a[]=2) kept only
     the last value, because it was decoded into a flat dict. The pairs
     are sent in order, repeats included.
The page program itself is run in Node, when Node is installed, to
check the exact query string and form body it sends.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (TREE, os.path.join(TREE, "transport")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import chromium_session as cs  # noqa: E402
import local_chromium as lc  # noqa: E402

BASE = "https://school.instructure.com"
INCLUDES = {"include[]": ["overrides", "all_dates"], "per_page": 50}
INCLUDES_QUERY = ("include%5B%5D=overrides&include%5B%5D=all_dates"
                  "&per_page=50")


class _Transport:
    def __init__(self):
        self.calls = []

    def api(self, method, path, data=None, as_json=False, timeout=60,
            max_bytes=None):
        self.calls.append({"method": method, "path": path, "data": data,
                           "as_json": as_json})
        return 200, {"Content-Type": "application/json"}, "[]"


@pytest.fixture
def session(monkeypatch):
    from reauth import state_machine as rsm
    monkeypatch.setattr(rsm, "pinned_principal", lambda: None)
    transport = _Transport()
    sess = cs.ChromiumSession(BASE, transport=transport)
    sess._check_expiry_warning = lambda: None
    return sess, transport


def _send(sess, method, path, body, form=False):
    headers = {"Content-Type": "application/x-www-form-urlencoded"} \
        if form else {}
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return sess.raw_request(method, BASE + path, headers, raw,
                            is_write=False)


# -- 1, 2 ---------------------------------------------------------------------

def test_a_read_sends_each_include_as_its_own_parameter(session):
    sess, transport = session
    _send(sess, "GET", "/api/v1/courses/1/assignments", INCLUDES)
    call = transport.calls[-1]
    assert call["path"] == "/api/v1/courses/1/assignments?" + INCLUDES_QUERY
    assert call["data"] is None


def test_a_read_keeps_the_query_its_address_already_has(session):
    sess, transport = session
    _send(sess, "GET", "/api/v1/courses/1/users?enrollment_type[]=student",
          {"user_ids[]": [5, 6], "include_inactive": True, "search": None})
    assert transport.calls[-1]["path"] == (
        "/api/v1/courses/1/users?enrollment_type[]=student"
        "&user_ids%5B%5D=5&user_ids%5B%5D=6&include_inactive=true")


def test_a_delete_sends_its_list_the_same_way(session):
    sess, transport = session
    _send(sess, "DELETE", "/api/v1/courses/1/usage_rights",
          {"file_ids[]": [11, 12]})
    call = transport.calls[-1]
    assert call["path"] == ("/api/v1/courses/1/usage_rights"
                            "?file_ids%5B%5D=11&file_ids%5B%5D=12")
    assert call["data"] is None


# -- 3 ------------------------------------------------------------------------

@pytest.mark.parametrize("method", ["GET", "DELETE"])
@pytest.mark.parametrize("body", [
    {"assignment": {"name": "Essay"}},
    {"include[]": [{"a": 1}]},
    {"include[]": [["overrides"]]},
    [{"id": 1}],
], ids=["object", "list-of-objects", "list-of-lists", "array-body"])
def test_a_parameter_with_no_query_form_is_refused(session, method, body):
    sess, transport = session
    with pytest.raises(cs.RequestNotSendable) as info:
        _send(sess, method, "/api/v1/courses/1/assignments", body)
    assert "nothing was sent" in str(info.value).lower()
    assert transport.calls == []


# -- 4 ------------------------------------------------------------------------

def test_a_form_body_keeps_every_repeated_key_in_order(session):
    sess, transport = session
    _send(sess, "POST", "/api/v1/courses/1/quizzes/5/groups",
          b"quiz_groups[][name]=A&quiz_groups[][pick_count]=1"
          b"&quiz_groups[][name]=B&quiz_groups[][pick_count]=2",
          form=True)
    call = transport.calls[-1]
    assert call["data"] == [["quiz_groups[][name]", "A"],
                            ["quiz_groups[][pick_count]", "1"],
                            ["quiz_groups[][name]", "B"],
                            ["quiz_groups[][pick_count]", "2"]]
    assert call["as_json"] is False


def test_a_form_read_puts_every_pair_in_the_query(session):
    sess, transport = session
    _send(sess, "GET", "/api/v1/courses/1/assignments",
          b"include[]=overrides&include[]=all_dates&per_page=50", form=True)
    assert transport.calls[-1]["path"] == \
        "/api/v1/courses/1/assignments?" + INCLUDES_QUERY


# -- the page program ---------------------------------------------------------

_NODE = shutil.which("node")
_HARNESS = r"""
globalThis.document = {cookie: '_csrf_token=t0ken'};
let seen = null;
globalThis.fetch = async (url, init) => {
  seen = {url: url, body: init.body,
          contentType: init.headers['Content-Type'] || null};
  return new Response('[]', {status: 200,
                             headers: {'Content-Type': 'application/json'}});
};
const out = JSON.parse(await PROGRAM);
if (out.status !== 200) throw new Error('program failed: ' + JSON.stringify(out));
process.stdout.write(JSON.stringify(seen));
"""


def _run_page_program(method, path, data, as_json=False):
    program = lc._API_JS % (json.dumps(method), json.dumps(path),
                            json.dumps(data), json.dumps(as_json),
                            json.dumps(None))
    script = _HARNESS.replace("PROGRAM", program)
    done = subprocess.run([_NODE, "--input-type=module", "-e", script],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.mark.skipif(_NODE is None, reason="Node is not installed")
def test_the_page_program_sends_each_list_value_as_its_own_pair():
    seen = _run_page_program("GET", "/api/v1/courses/1/assignments",
                             INCLUDES)
    assert seen["url"] == "/api/v1/courses/1/assignments?" + INCLUDES_QUERY
    seen = _run_page_program("DELETE", "/api/v1/x?a=1",
                             [["ids[]", "1"], ["ids[]", "2"]])
    assert seen["url"] == "/api/v1/x?a=1&ids%5B%5D=1&ids%5B%5D=2"


@pytest.mark.skipif(_NODE is None, reason="Node is not installed")
def test_the_page_program_sends_form_pairs_in_order():
    seen = _run_page_program("POST", "/api/v1/x",
                             [["g[][n]", "A"], ["g[][n]", "B"]])
    assert seen["body"] == "g%5B%5D%5Bn%5D=A&g%5B%5D%5Bn%5D=B"
    assert seen["contentType"] == "application/x-www-form-urlencoded"
    seen = _run_page_program("POST", "/api/v1/x", INCLUDES)
    assert seen["body"] == INCLUDES_QUERY
