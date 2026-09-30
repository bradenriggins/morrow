"""Proof-tool failure cases, with real catalog parsing and no provider calls."""
import importlib.util
import json
import os
from pathlib import Path
import sys

import pytest

TREE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TREE))


def load_driver():
    spec = importlib.util.spec_from_file_location(
        "learner_reads_battery", Path(__file__).with_name("learner_data_reads_battery.py"))
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    return driver


@pytest.fixture
def driver(monkeypatch, tmp_path):
    monkeypatch.setenv("LOGIN_HELPER_PORT", "18901")
    value = load_driver()
    catalog = tmp_path / "OPERATION_CATALOG.md"
    catalog.write_bytes((TREE / "proof-battery/OPERATION_CATALOG.md").read_bytes())
    monkeypatch.setattr(value, "CATALOG_PATH", str(catalog))
    monkeypatch.setattr(value, "EVIDENCE_DIR", str(tmp_path / "evidence"))
    return value


def fields(line):
    return [part.strip() for part in line.strip().strip("|").split("|")]


def proof(driver, row_id):
    row = next(fields(line) for line in Path(driver.CATALOG_PATH).read_text().splitlines()
               if line.startswith(f"| {row_id} |"))
    return {"row": row_id, "status": "PROVEN", "tool": row[1], "method": row[2],
            "path_template": row[3], "effect": row[4], "mechanism": row[5]}


def test_import_preserves_selected_helper_route(monkeypatch):
    monkeypatch.setenv("LOGIN_HELPER_PORT", "18901")
    load_driver()
    assert os.environ["LOGIN_HELPER_PORT"] == "18901"


def test_promotion_preserves_http_identity_and_real_parser(driver, monkeypatch):
    outcome = proof(driver, "C-419")
    before = Path(driver.CATALOG_PATH).read_text()
    updates, lines = driver._catalog_updates([outcome], "stamp", "proof.json")
    assert len(updates) == 1
    old, new = fields(updates[0][2]), fields(updates[0][3])
    assert new[:6] == old[:6]
    assert new[6] == "live-proven [LEARNER-DATA]"
    for row_id in ["C-415", "C-416", "C-417", "C-418"]:
        original = next(line for line in before.splitlines() if line.startswith(f"| {row_id} |"))
        assert original in "".join(lines).splitlines()
    from dispatch import executor
    Path(driver.CATALOG_PATH).write_text("".join(lines))
    monkeypatch.setattr(executor, "_OPERATION_CATALOG_PATH", driver.CATALOG_PATH)
    monkeypatch.setattr(executor, "_OPERATION_CATALOG_CACHE", None)
    parsed = executor.catalog_descriptor_for(outcome["tool"])
    assert parsed["path"] == outcome["path_template"]
    assert parsed["effect"] == "read"
    assert parsed["status"] == "live-proven"


def test_wrong_endpoint_evidence_cannot_promote(driver):
    outcome = proof(driver, "C-420")
    outcome["path_template"] = "/api/v1/courses/{course_id}/gradebook_history/days"
    before = Path(driver.CATALOG_PATH).read_bytes()
    with pytest.raises(ValueError):
        driver._catalog_updates([outcome], "stamp", "proof.json")
    assert Path(driver.CATALOG_PATH).read_bytes() == before


def run_row(driver, row_id, reader):
    row = next(row for row in driver.ROWS if row[0] == row_id)
    return driver._prove_row(*row, reader, "https://school.example.edu", "Educator", "7",
                             driver._admission.load_policy(), {
                                 "course": "42", "assignment": "9", "user_id": "912345",
                                 "anonymous_id": "ANON-SECRET-ID",
                                 "student_ids_param": "student_ids[]=912345"})


def test_c420_uses_assignment_gradeable_students_and_pagination(driver):
    calls = []
    class Reader:
        def get_paginated(self, url):
            calls.append(url)
            assert url.split("?", 1)[0] == "/api/v1/courses/42/assignments/9/gradeable_students"
            return 200, [], None
        def get_json(self, url):
            raise driver._live_read.LiveReadError("non-paginated read refused")
    result = run_row(driver, "C-420", Reader())
    assert result["status"] == "EMPTY"
    assert len(calls) == 1


@pytest.mark.parametrize("row_id", ["C-414", "C-413", "C-422"])
def test_request_identifiers_and_exception_text_never_enter_evidence(driver, row_id):
    class Reader:
        def get_json(self, url):
            raise driver._live_read.LiveReadError(f"URL={url}; Student Secret Name; 912345")
        def get_paginated(self, url):
            raise driver._live_read.LiveReadError(f"URL={url}; Student Secret Name; 912345")
    encoded = json.dumps(run_row(driver, row_id, Reader()))
    for secret in ["912345", "ANON-SECRET-ID", "Student Secret Name", "student_ids[]=912345"]:
        assert secret not in encoded


def test_incomplete_pagination_is_failed_without_leaking_note(driver):
    class Reader:
        def get_paginated(self, url):
            return 200, [], "truncated at learner 912345 Student Secret Name"
    result = run_row(driver, "C-419", Reader())
    assert result["status"] == "FAILED"
    assert "912345" not in json.dumps(result)
    assert "Student Secret Name" not in json.dumps(result)


def test_installed_package_refuses_apply_before_contacting_helper(driver, monkeypatch, tmp_path):
    root = tmp_path / "installed"
    root.mkdir()
    (root / "release-manifest.json").write_text("{}")
    monkeypatch.setattr(driver, "_TREE_ROOT", str(root))
    monkeypatch.setattr(driver._live_read, "LiveReader", lambda *args: pytest.fail("contacted helper"))
    before = Path(driver.CATALOG_PATH).read_bytes()
    with pytest.raises(SystemExit):
        driver.main(["--course", "42", "--assignment", "9", "--apply"])
    assert Path(driver.CATALOG_PATH).read_bytes() == before


def test_failed_evidence_publication_keeps_catalog(driver, monkeypatch):
    before = Path(driver.CATALOG_PATH).read_bytes()
    def fail_write(*args, **kwargs):
        raise OSError("injected disk failure")
    monkeypatch.setattr(driver, "_write_evidence", fail_write)
    with pytest.raises(OSError):
        driver._publish_results([proof(driver, "C-419")], "stamp", {"rows": []}, apply=True)
    assert Path(driver.CATALOG_PATH).read_bytes() == before


def test_failed_candidate_validation_keeps_catalog(driver, monkeypatch):
    before = Path(driver.CATALOG_PATH).read_bytes()
    monkeypatch.setattr(driver, "_validate_catalog_candidate", lambda *args: (_ for _ in ()).throw(ValueError("invalid candidate")))
    with pytest.raises(ValueError):
        driver._publish_results([proof(driver, "C-419")], "stamp", {"rows": []}, apply=True)
    assert Path(driver.CATALOG_PATH).read_bytes() == before


def test_complete_submission_read_harvests_only_valid_learner_user_ids(driver, monkeypatch):
    class Reader:
        calls = 0
        def get_paginated(self, url):
            self.calls += 1
            assert self.calls == 1, "proof must not repeat the raw learner read"
            return 200, [{"id": "998877", "user_id": "912345"}, {"id": "888888"},
                         {"user_id": "invalid&student_ids[]=secret"}, {"user_id": "7"},
                         {"user_id": "912345"}, {"user_id": 912346}], None
    monkeypatch.setattr(driver._wire, "project_learner_result", lambda *a, **k: {"receipt": {"learnerToken": "Student A1"}})
    monkeypatch.setattr(driver, "_harvest_identifiers", lambda *a: ([], 2))
    ctx = {"course": "42", "assignment": "9", "anonymous_id": "", "user_id": None, "student_ids_param": ""}
    row = next(row for row in driver.ROWS if row[0] == "C-419")
    result = driver._prove_row(*row, Reader(), "https://school.example.edu", "Educator", "7", driver._admission.load_policy(), ctx)
    assert result["status"] == "PROVEN"
    assert ctx["user_id"] == "912345"
    assert ctx["student_ids_param"] == "student_ids[]=912345&student_ids[]=912346"
    assert "912345" not in json.dumps(result)
    assert "998877" not in json.dumps(result)
