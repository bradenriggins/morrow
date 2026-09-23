#!/usr/bin/env python3
"""A restored backup keeps Morrow working as it was.

Failure modes this suite pins down (written before the fix; final sweep
2026-09-23). The operator runs the documented backup, the Muse
computer's home is lost, and the operator restores:
  1. The backup left out the approval signing key
     (secrets/approval-signing.key). The used-approval record, the
     settings, and the mode grants are sealed with it, so after a
     restore every approval check failed ("sealed but the approval
     signing key is missing ... restore from backup"), and the backup
     could not supply the key.
  2. Its vault set named the legacy learner_vault/ folder, not the
     vault Morrow writes (morrow_source_vault.json with its .key and
     .echo files). After a restore the student labels in the journal
     and in approvals mapped to no student: the next read gave the same
     student a new label, and the names the educator typed no longer
     echoed.
  3. It left out the pinned Canvas account (browser_lane.json and the
     pin record), the educator's settings, and the mode grants, so the
     restored install forgot who the educator is, their "always
     confirm deletions" setting, and their Edit for the conversation.
  4. Restore made missing state folders with the default permissions,
     not 0700.

Each step runs the documented command (`python3 -m
dispatch.state_backup create|restore`) in its own process against a
scratch home, the way the operator runs it.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAS_CRYPTOGRAPHY = __import__("importlib").util.find_spec(
    "cryptography") is not None

TENANT = "https://c.example.edu"
USER_ID = "canvas:42@c.example.edu"
CONVERSATION = "conv-1"

_PRELUDE = r"""
import json, os, sys
sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.join(os.getcwd(), "transport"))
from dispatch import admission as adm, executor as ex
from transport import state as lane
from settings import store
from modes import state as modes
TENANT, USER_ID, CONVERSATION = %r, %r, %r
HAS_CRYPTOGRAPHY = %r
PAGE = ex.catalog_descriptor_to_entry(
    "canvas_update_create_page_courses", "PUT",
    "/api/v1/courses/{course_id}/pages/{url_or_id}", "write",
    extra={"body": {"wiki_page": {"title": "Week 1"}}})
PARAMS = {"course_id": "101", "url_or_id": "week-1"}


def approve_once():
    rec = adm.mint_approval(PAGE, PARAMS, TENANT, target_identity={
        "course_id": "101", "course_name": "Biology 101"})
    signed = adm.sign_approval(rec, "Yes", channel="educator-chat")
    adm.check_write_approval(PAGE, PARAMS, signed, None, tenant_base=TENANT)
    adm.consume_approval(signed)
""" % (TENANT, USER_ID, CONVERSATION, HAS_CRYPTOGRAPHY)

# The state an installed tree builds up in normal use.
_SEED = _PRELUDE + r"""
approve_once()
lane.save(TENANT, "42", "Pat Teacher")
store.set_setting(USER_ID, "confirm_destructive_writes", True,
                  educator_confirmed=True)
modes.request_edit_grant(USER_ID, educator_confirmation={
    "by": "educator", "authorization": "yes, use edit mode here",
    "channel": "educator-chat"}, conversation_id=CONVERSATION)
ex.journal_append({"op_id": "00000000-0000-4000-8000-000000000001",
                   "wal": "audit", "event": "backup-test"})
out = {"mode": modes.current_mode(USER_ID, CONVERSATION)}
if HAS_CRYPTOGRAPHY:
    from privacy import core, executor_wire as wire, name_echo
    vault = core.LearnerVault(wire._source_vault_path())
    scope = wire.learner_scope(TENANT, "101")
    students = [{"id": "98765", "name": "Jane Doe"},
                {"id": "11111", "name": "Sam Roe"}]
    labels = vault.tokenize_many(scope, students)
    vault.close()
    # The vault numbers students in no fixed order; the check reads back
    # the one it called Student A2.
    second = students[labels.index("Student A2")]
    out["second"] = second
    name_echo.record_introduction(TENANT, "101", CONVERSATION,
                                  "Student A2", second["name"])
print(json.dumps(out))
"""

# What the restored install knows, read through the product's own code.
_CHECK = _PRELUDE + r"""
import stat
SECOND = None
out = {}
try:
    adm._load_consumed()
    approve_once()
    out["approvals"] = "ok"
except Exception as exc:
    out["approvals"] = "%s: %s" % (type(exc).__name__, exc)
try:
    pin = (lane.load() or {}).get("canvas", {}).get("principal", {})
    out["pinned"] = pin.get("id")
except Exception as exc:
    out["pinned"] = "%s: %s" % (type(exc).__name__, exc)
try:
    out["confirm_deletions"] = store.get_setting(
        USER_ID, "confirm_destructive_writes")
except Exception as exc:
    out["confirm_deletions"] = "%s: %s" % (type(exc).__name__, exc)
try:
    out["mode"] = modes.current_mode(USER_ID, CONVERSATION)
except Exception as exc:
    out["mode"] = "%s: %s" % (type(exc).__name__, exc)
if HAS_CRYPTOGRAPHY:
    from privacy import core, executor_wire as wire, name_echo
    out["vault_restored"] = os.path.exists(wire._source_vault_path())
    vault = core.LearnerVault(wire._source_vault_path())
    out["label_second"] = vault.tokenize_many(
        wire.learner_scope(TENANT, "101"), [SECOND])[0]
    vault.close()
    out["echo"] = name_echo.introductions(TENANT, "101", CONVERSATION)
home = os.environ["MORROW_HOME"]
out["modes"] = {name: oct(stat.S_IMODE(os.stat(os.path.join(home, name))
                                        .st_mode))
                for name in ("secrets", "settings", "modes", "approvals")
                if os.path.isdir(os.path.join(home, name))}
print(json.dumps(out))
"""


def _env(home):
    env = dict(os.environ)
    for name in ("MORROW_TREE_STATE_DIR", "MORROW_SOURCE_VAULT_PATH",
                 "MORROW_APPROVAL_SIGNING_KEY", "MORROW_SELFTEST_HOME",
                 "MORROW_USER_ID", "MORROW_CONVERSATION_ID"):
        env.pop(name, None)
    env.update(HOME=home, MORROW_HOME=os.path.join(home, ".morrow"),
               MORROW_HELPER_ENV_FILE=os.path.join(home, "helper-env"),
               PYTHONDONTWRITEBYTECODE="1")
    return env


def _run(env, *args):
    proc = subprocess.run([sys.executable] + list(args), cwd=TREE,
                          env=env, capture_output=True, text=True,
                          timeout=120)
    assert proc.returncode == 0, (args, proc.stdout, proc.stderr)
    return proc.stdout


@pytest.fixture(scope="module")
def cycle():
    work = os.path.join(TREE, ".selftest-work")
    os.makedirs(work, exist_ok=True)
    home = tempfile.mkdtemp(prefix="backup-restore-", dir=work)
    try:
        env = _env(home)
        seeded = json.loads(_run(env, "-c", _SEED))
        backups = os.path.join(home, "backups")
        os.makedirs(backups)
        made = json.loads(_run(env, "-m", "dispatch.state_backup",
                               "create", backups))
        with open(os.path.join(made["backup"], "manifest.json"),
                  encoding="utf-8") as fh:
            manifest = json.load(fh)
        # The home is lost; the backup survives elsewhere.
        shutil.rmtree(env["MORROW_HOME"])
        _run(env, "-m", "dispatch.state_backup", "restore",
             made["backup"], "--yes")
        restored = json.loads(_run(env, "-c", _CHECK.replace(
            "SECOND = None", "SECOND = %r" % (seeded.get("second"),))))
        yield seeded, manifest, restored
    finally:
        shutil.rmtree(home, ignore_errors=True)


def test_the_seeded_install_is_in_edit_mode(cycle):
    seeded, _manifest, _restored = cycle
    assert seeded["mode"] == "edit"


def test_approvals_work_after_a_restore(cycle):
    _seeded, manifest, restored = cycle
    assert restored["approvals"] == "ok"
    assert manifest["sets"]["secrets"]["files"], manifest["sets"]


def test_the_pinned_account_comes_back(cycle):
    _seeded, _manifest, restored = cycle
    assert restored["pinned"] == "42"


def test_settings_and_edit_mode_come_back(cycle):
    _seeded, _manifest, restored = cycle
    assert restored["confirm_deletions"] is True
    assert restored["mode"] == "edit"


def test_restored_state_folders_are_private(cycle):
    _seeded, _manifest, restored = cycle
    assert set(restored["modes"]) == {"secrets", "settings", "modes",
                                      "approvals"}
    for name, mode in restored["modes"].items():
        assert mode == "0o700", (name, mode)


@pytest.mark.skipif(not HAS_CRYPTOGRAPHY,
                    reason="the learner vault needs 'cryptography'")
def test_student_labels_and_typed_names_come_back(cycle):
    seeded, manifest, restored = cycle
    assert restored["vault_restored"] is True
    # A fresh vault would call the first student it meets Student A1.
    assert restored["label_second"] == "Student A2"
    assert restored["echo"] == {"Student A2": seeded["second"]["name"]}
    files = manifest["sets"]["source-vault"]["files"]
    assert {"vault", "vault.key", "vault.echo"} <= set(files)
