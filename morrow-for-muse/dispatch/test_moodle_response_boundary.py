"""Moodle response failures specified before the implementation repair.

Oversized results must not escape the byte cap. Malformed AJAX envelopes
must fail with a typed error, without false success or an attribute crash.
All requests and journals are disposable; no Moodle site is contacted.
"""

import json

import pytest

from moodle.session import MoodleLaneError, MoodleSession, RESULT_MAX_BYTES


class Response:
    status_code = 200
    url = "https://m.edu/lib/ajax/service.php"
    headers = {}

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class Transport:
    cookies = {}

    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    def post(self, *args, **kwargs):
        self.calls += 1
        return Response(self.payload)


def session(tmp_path, payload):
    transport = Transport(payload)
    return MoodleSession("https://m.edu", transport, "0123456789",
                         journal_dir=str(tmp_path / "journal")), transport


@pytest.mark.parametrize("text", ["x" * 4096, "漢" * 900])
def test_oversized_data_is_refused_in_utf8_bytes(tmp_path, text):
    data = {"description": text}
    assert len(json.dumps(data, ensure_ascii=False).encode()) > RESULT_MAX_BYTES
    sess, transport = session(tmp_path, [{"error": False, "data": data}])
    with pytest.raises(MoodleLaneError) as caught:
        sess.ajax("core_course_get_contents", {"courseid": 2})
    assert caught.value.kind == "incomplete"
    assert text not in str(caught.value)
    assert transport.calls == 1


@pytest.mark.parametrize("payload", [
    ["unexpected"], [1], [{}], [{"data": {"id": 1}}],
    [{"error": "false", "data": {"id": 1}}],
    [{"error": False, "data": 1}, {"error": False, "data": 2}],
    [{"error": True, "exception": "unexpected"}],
    [{"error": True, "exception": {}}],
])
def test_malformed_envelope_is_typed_provider_failure(tmp_path, payload):
    sess, transport = session(tmp_path, payload)
    with pytest.raises(MoodleLaneError) as caught:
        sess.ajax("core_course_get_contents", {"courseid": 2})
    assert caught.value.kind == "provider"
    assert transport.calls == 1


def test_null_data_is_valid(tmp_path):
    sess, _ = session(tmp_path, [{"error": False, "data": None}])
    result = sess.ajax("core_course_get_contents", {"courseid": 2})
    assert result["data"] is None
    assert result["truncated"] is False


def test_auth_error_keeps_its_classification(tmp_path):
    sess, _ = session(tmp_path, [{"error": True, "exception": {
        "errorcode": "servicerequireslogin", "message": "Sign in"}}])
    with pytest.raises(MoodleLaneError) as caught:
        sess._ajax_call("core_course_get_contents", {"courseid": 2})
    assert caught.value.kind == "reauth"
