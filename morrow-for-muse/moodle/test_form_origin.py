from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from moodle.session import MoodleSession, MoodleLaneError


class Response:
    status_code = 200
    url = "https://lms.example.edu/moodle/mod/forum/post.php"
    headers = {}


class Provider:
    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return Response()


def make_session(tmp_path):
    provider = Provider()
    return MoodleSession("https://lms.example.edu/moodle", provider,
                         "private-session-key", journal_dir=str(tmp_path)), provider


@pytest.mark.parametrize("path", [
    "@foreign.example/post.php", "https://foreign.example/post.php",
    "//foreign.example/post.php", "/../post.php", "/%2e%2e/post.php",
    "/mod/../post.php", "/mod/%2fpost.php", "/mod\\post.php",
    "/mod/\npost.php", "/mod/forum/post.php#private-fragment", "post.php", None,
])
def test_unsafe_form_path_refused_before_session_key_can_leave(tmp_path, path):
    sess, provider = make_session(tmp_path)
    with pytest.raises(MoodleLaneError, match="form path"):
        sess.form_write(path, {"subject": "dummy"})
    assert provider.calls == []


def test_form_receipt_does_not_echo_query_secrets(tmp_path):
    sess, provider = make_session(tmp_path)
    receipt = sess.form_write("/mod/forum/post.php?code=private-query-token", {})
    assert "private-query-token" not in str(receipt)
    assert receipt["form_posted"] == "/mod/forum/post.php"
    assert len(provider.calls) == 1


def test_root_site_cannot_send_session_key_to_a_foreign_authority(tmp_path):
    provider = Provider()
    sess = MoodleSession("https://lms.example.edu", provider,
                         "private-session-key", journal_dir=str(tmp_path))
    with pytest.raises(MoodleLaneError, match="form path"):
        sess.form_write("@foreign.example/post.php", {})
    assert provider.calls == []


def test_valid_prefixed_form_and_query_keep_the_request_contract(tmp_path):
    sess, provider = make_session(tmp_path)
    receipt = sess.form_write("/mod/forum/post.php?edit=17", {"subject": "dummy"})
    url, kwargs = provider.calls[0]
    assert url == "https://lms.example.edu/moodle/mod/forum/post.php?edit=17"
    assert kwargs["data"]["sesskey"] == "private-session-key"
    assert kwargs["allow_redirects"] is False
    assert receipt["http"] == 200
