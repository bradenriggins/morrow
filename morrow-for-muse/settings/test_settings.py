#!/usr/bin/env python3
"""Unit tests for the settings package (WORKSTREAM B, revised philosophy).

The mode model is simple: the ONLY difference between plan and edit mode
is whether writes surface approval. Plan: writes require approval.
Edit: they do not. Reads are unrestricted in both modes.

Covers: schema validation (bad values refused), defaults, persistence
across a simulated restart (fresh interpreter process), tamper refusal
(consequential sets and conversation overrides without educator
confirmation), effective-mode resolution (override, then persisted
default), edit mode not being timed (legacy timed grants lapse to
plan), every "edit off" phrase landing in plan mode everywhere, the
conversational parser cases, audit journaling with old/new/educator
(including override and edit-off records), user_id sanitization, fail-closed corrupt files, and the
Agent A contract (get_setting(user_id, key) exact signature).

Test scratch lives under .selftest-work/ next to this test (tree
convention: never /tmp). MORROW_HOME is redirected there so the real
~/.morrow is never touched.

Stdlib only. Run: python3 settings/test_settings.py
"""
import inspect
import json
import os
import subprocess
import sys
import unittest
from datetime import timedelta

_HERE = os.path.dirname(os.path.abspath(__file__))
_TREE = os.path.join(_HERE, "..")
sys.path.insert(0, _TREE)

from settings import store  # noqa: E402
from settings import commands  # noqa: E402


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.work = os.path.join(_HERE, ".selftest-work")
        self.home = os.path.join(self.work, "home-%d" % os.getpid())
        os.makedirs(self.home, exist_ok=True)
        self._old_env = os.environ.get("MORROW_HOME")
        os.environ["MORROW_HOME"] = self.home
        # Hermetic signing key: dispatch.admission freezes
        # SECRETS_DIR/SIGNING_KEY_PATH at import time, so point both at
        # this test's home (tree convention: tests override the module
        # constants directly).
        import dispatch.admission as _adm
        self._old_secrets_dir = _adm.SECRETS_DIR
        self._old_signing_key = _adm.SIGNING_KEY_PATH
        _adm.SECRETS_DIR = os.path.join(self.home, "secrets")
        _adm.SIGNING_KEY_PATH = os.path.join(self.home, "secrets",
                                             "approval-signing.key")
        self.user = "educator-test-%d" % os.getpid()
        self.conv = "conv-%d" % os.getpid()
        # Session-scoped state: conversation overrides are process-global
        # in-memory; conversation grants are persisted and sealed.
        # Reset both so each test starts clean.
        with store._SESSION_LOCK:
            store._CONVERSATION_MODES.clear()
        import modes.state as _mode_state
        _mode_state.revoke_edit_grant(self.user, reason="test reset")

    def tearDown(self):
        import dispatch.admission as _adm
        _adm.SECRETS_DIR = self._old_secrets_dir
        _adm.SIGNING_KEY_PATH = self._old_signing_key
        if self._old_env is None:
            os.environ.pop("MORROW_HOME", None)
        else:
            os.environ["MORROW_HOME"] = self._old_env
        for root, dirs, files in os.walk(self.work, topdown=False):
            for name in files:
                try:
                    os.unlink(os.path.join(root, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass
        for root, dirs, files in os.walk(self.work, topdown=False):
            for name in files:
                try:
                    os.unlink(os.path.join(root, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass

    # -- Agent A contract ----------------------------------------------------

    def test_agent_a_contract_signature(self):
        sig = inspect.signature(store.get_setting)
        self.assertEqual(list(sig.parameters), ["user_id", "key"])
        self.assertEqual(store.get_setting(self.user, "default_mode"), "plan")

    # -- defaults ------------------------------------------------------------

    def test_defaults_for_new_user(self):
        self.assertEqual(store.get_setting(self.user, "default_mode"), "plan")
        self.assertEqual(store.get_setting(self.user, "verbosity"), "balanced")
        self.assertEqual(
            store.get_setting(self.user, "confirm_destructive_writes"), False)
        self.assertEqual(store.get_setting(self.user, "write_approval_style"),
                         "per_write")
        self.assertEqual(store.get_setting(self.user, "failure_verbosity"),
                         "detailed")
        self.assertEqual(store.get_setting(self.user, "proactivity"),
                         "reactive")
        self.assertEqual(store.get_setting(self.user, "read_confirmations"),
                         False)

    def test_unknown_key(self):
        with self.assertRaises(store.SettingsUnknownKey):
            store.get_setting(self.user, "nope")
        with self.assertRaises(store.SettingsUnknownKey):
            store.set_setting(self.user, "nope", 1, True)

    def test_list_settings_marks_changed(self):
        items = store.list_settings(self.user)
        self.assertEqual(set(items), set(store.SETTINGS_SCHEMA))
        for info in items.values():
            self.assertFalse(info["changed"])
            self.assertEqual(info["value"], info["default"])
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        items = store.list_settings(self.user)
        self.assertTrue(items["verbosity"]["changed"])
        self.assertFalse(items["default_mode"]["changed"])

    # -- schema validation -----------------------------------------------------

    def test_bad_values_refused(self):
        bad = [
            ("default_mode", "turbo"),
            ("default_mode", 1),
            ("verbosity", "verbose"),
            ("verbosity", "BALANCED"),
            ("confirm_destructive_writes", "yes"),
            ("confirm_destructive_writes", 1),
            ("write_approval_style", "sometimes"),
            ("failure_verbosity", "verbose"),
            ("proactivity", "hyper"),
            ("read_confirmations", "yes"),
        ]
        for key, value in bad:
            with self.assertRaises(store.SettingsValidationError,
                                   msg="key=%r value=%r" % (key, value)):
                store.set_setting(self.user, key, value,
                                  educator_confirmed=True)

    def test_edit_mode_is_not_timed(self):
        # Edit is one blanket grant that stays on until the educator
        # turns it off: there is no session length to set and no timed
        # session API to call.
        self.assertNotIn("edit_grant_duration_min", store.SETTINGS_SCHEMA)
        with self.assertRaises(store.SettingsUnknownKey):
            store.set_setting(self.user, "edit_grant_duration_min", 60,
                              educator_confirmed=True)
        for name in ("start_edit_session", "end_edit_session",
                     "edit_session_active", "edit_session_remaining",
                     "EDIT_GRANT_DURATION_MIN", "EDIT_GRANT_DURATION_MAX"):
            self.assertFalse(hasattr(store, name), msg=name)

    def test_legacy_stored_duration_setting_is_ignored(self):
        # An older install sealed edit_grant_duration_min into the
        # settings file. It must not break reads or reappear as a knob.
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        path = store._settings_path(self.user)
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        doc.pop("sig", None)
        doc["settings"]["edit_grant_duration_min"] = 60
        store._write_doc_atomic(path, doc)
        self.assertEqual(store.get_setting(self.user, "verbosity"),
                         "concise")
        self.assertNotIn("edit_grant_duration_min",
                         store.list_settings(self.user))

    # -- tamper refusal ----------------------------------------------------------

    def test_consequential_requires_educator_confirmation(self):
        for key, value in [("default_mode", "edit"),
                           ("confirm_destructive_writes", False),
                           ("write_approval_style", "batched")]:
            with self.assertRaises(store.SettingsTamperRefused,
                                   msg="key=%r" % key):
                store.set_setting(self.user, key, value,
                                  educator_confirmed=False)
            self.assertEqual(store.get_setting(self.user, key),
                             store.SETTINGS_SCHEMA[key]["default"])
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        self.assertEqual(store.get_setting(self.user, "default_mode"), "edit")

    def test_nonconsequential_needs_no_confirmation(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        self.assertEqual(store.get_setting(self.user, "verbosity"), "concise")
        store.set_setting(self.user, "proactivity", "suggestive",
                          educator_confirmed=False)
        self.assertEqual(store.get_setting(self.user, "proactivity"),
                         "suggestive")
        store.set_setting(self.user, "read_confirmations", True,
                          educator_confirmed=False)
        self.assertTrue(store.get_setting(self.user, "read_confirmations"))
        store.set_setting(self.user, "failure_verbosity", "concise",
                          educator_confirmed=False)
        self.assertEqual(store.get_setting(self.user, "failure_verbosity"),
                         "concise")

    def test_conversation_mode_requires_educator_confirmation(self):
        with self.assertRaises(store.SettingsTamperRefused):
            store.set_conversation_mode(self.user, self.conv, "edit",
                                        educator_confirmed=False)
        self.assertIsNone(store.get_conversation_mode(self.user, self.conv))

    def test_conversation_mode_rejects_bad_mode(self):
        with self.assertRaises(store.SettingsValidationError):
            store.set_conversation_mode(self.user, self.conv, "turbo",
                                        educator_confirmed=True)

    # -- effective mode ------------------------------------------------------------

    def test_effective_mode_falls_back_to_default(self):
        self.assertEqual(store.effective_mode(self.user, self.conv), "plan")
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        self.assertEqual(store.effective_mode(self.user, self.conv), "edit")
        self.assertEqual(store.effective_mode(self.user), "edit")

    def test_conversation_override_wins_over_default(self):
        store.set_conversation_mode(self.user, self.conv, "edit",
                                    educator_confirmed=True)
        self.assertEqual(store.effective_mode(self.user, self.conv), "edit")
        # Other conversations are unaffected.
        self.assertEqual(store.effective_mode(self.user, "other-conv"),
                         "plan")

    def _conversation_grant(self):
        import modes.state as mode_state
        return mode_state.request_edit_grant(
            self.user, scope_type="conversation",
            conversation_id=self.conv,
            educator_confirmation={
                "by": "educator", "channel": "educator-chat",
                "authorization": "yes, use edit mode for this conversation"})

    def _legacy_timed_grant(self, expires_at):
        """Plant a timed grant the way an older install persisted it."""
        import modes.state as mode_state
        state = mode_state._load_state(self.user)
        state["revision"] = int(state.get("revision", 0)) + 1
        state["grants"].append({
            "grant_id": "legacy-timed-%d" % state["revision"],
            "revision": state["revision"],
            "scope_type": "timed",
            "conversation_id": None,
            "educator_identity": {"by": "educator", "channel": "driver",
                                  "authorization": "edit for 60 minutes "
                                                   "please, thanks"},
            "source_utterance": "edit for 60 minutes please, thanks",
            "granted_at": store.utc_now_iso(),
            "expires_at": expires_at,
            "duration_min": 60,
            "revoked": False, "revoked_at": None, "revoke_reason": None,
        })
        state.pop("sig", None)
        mode_state._save_state(self.user, state)

    def test_most_recent_action_wins(self):
        self._conversation_grant()
        self.assertEqual(store.effective_mode(self.user, self.conv), "edit")
        # A later explicit plan override for the conversation wins.
        store.set_conversation_mode(self.user, self.conv, "plan",
                                    educator_confirmed=True)
        self.assertEqual(store.effective_mode(self.user, self.conv), "plan")

    def test_legacy_timed_grant_lapses_to_plan(self):
        # A still-unexpired timed grant from an older install must not
        # keep edit on, and must never become a standing grant.
        future = (store.utc_now() + timedelta(hours=2)).isoformat()
        self._legacy_timed_grant(future)
        self.assertEqual(store.effective_mode(self.user, self.conv), "plan")
        self.assertEqual(store.effective_mode(self.user), "plan")
        self.assertEqual(store.get_setting(self.user, "default_mode"),
                         "plan")

    def test_end_edit_mode_turns_edit_off_everywhere(self):
        from modes import state as mode_state
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        self._conversation_grant()
        store.set_conversation_mode(self.user, "other-conv", "edit",
                                    educator_confirmed=True)
        result = mode_state.switch_mode(self.user, "plan",
                                        conversation_id=self.conv)
        self.assertEqual(result["mode"], "plan")
        self.assertTrue(result["default_mode_changed"])
        self.assertEqual(store.get_setting(self.user, "default_mode"),
                         "plan")
        for conv in (self.conv, "other-conv", None):
            self.assertEqual(store.effective_mode(self.user, conv), "plan",
                             msg=conv)

    def test_end_conversation_clears_scoped_state(self):
        store.set_conversation_mode(self.user, self.conv, "edit",
                                    educator_confirmed=True)
        self._conversation_grant()
        store.end_conversation(self.user, self.conv)
        self.assertIsNone(store.get_conversation_mode(self.user, self.conv))
        self.assertEqual(store.effective_mode(self.user, self.conv), "plan")

    def test_destructive_confirmation_helper(self):
        self.assertFalse(store.destructive_confirmation_required(self.user))
        store.set_setting(self.user, "confirm_destructive_writes", True,
                          educator_confirmed=True)
        self.assertTrue(store.destructive_confirmation_required(self.user))

    # -- persistence ------------------------------------------------------------------

    def test_persistence_across_simulated_restart(self):
        """A fresh interpreter process sees persisted changes.

        The standing edit default is persisted and survives a restart
        with no expiry. Per-conversation overrides stay in-memory and
        do NOT survive a restart.
        """
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True, educator="braden")
        store.set_conversation_mode(self.user, self.conv, "plan",
                                    educator_confirmed=True)
        self.assertEqual(store.effective_mode(self.user, self.conv), "plan")
        snippet = (
            "import sys; sys.path.insert(0, %r);"
            "from settings import store as s;"
            "assert s.get_setting(%r, 'default_mode') == 'edit';"
            "assert s.verify_audit(%r) == 2;"
            "assert s.effective_mode(%r, %r) == 'edit';"  # standing edit
            "assert s.get_conversation_mode(%r, %r) is None;"  # override gone
            "print('restart-ok')"
            % (_TREE, self.user, self.user,
               self.user, self.conv, self.user, self.conv))
        proc = subprocess.run([sys.executable, "-c", snippet],
                              capture_output=True, text=True,
                              env=dict(os.environ),
                              cwd=_TREE, timeout=60)
        self.assertEqual(proc.returncode, 0,
                         msg="stderr: %s" % proc.stderr)
        self.assertIn("restart-ok", proc.stdout)

    # -- journaling ---------------------------------------------------------------------

    def test_change_is_journaled_with_old_new_educator(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False, educator="dr-braden")
        records = store.read_audit(self.user)
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual(rec["kind"], "settings.change")
        self.assertEqual(rec["key"], "verbosity")
        self.assertEqual(rec["old_value"], "balanced")
        self.assertEqual(rec["new_value"], "concise")
        self.assertEqual(rec["educator"], "dr-braden")
        self.assertTrue(rec["change_id"])
        self.assertTrue(rec["at"])
        self.assertEqual(store.verify_audit(self.user), 1)

    def test_standing_edit_grant_is_journaled(self):
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True, educator="braden")
        rec = store.read_audit(self.user)[0]
        self.assertEqual(rec["key"], "default_mode")
        self.assertEqual(rec["old_value"], "plan")
        self.assertEqual(rec["new_value"], "edit")

    def test_override_and_end_edit_are_journaled(self):
        from modes import state as mode_state
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True, educator="braden")
        store.set_conversation_mode(self.user, self.conv, "plan",
                                    educator_confirmed=True,
                                    educator="braden")
        mode_state.switch_mode(self.user, "plan", conversation_id=self.conv,
                               educator="braden")
        records = store.read_audit(self.user)
        self.assertEqual(len(records), 3)
        self.assertEqual(records[1]["kind"], "settings.conversation_mode")
        self.assertEqual(records[1]["new_value"], "plan")
        self.assertEqual(records[1]["educator"], "braden")
        self.assertEqual(records[2]["kind"], "settings.change")
        self.assertEqual(records[2]["key"], "default_mode")
        self.assertEqual(records[2]["old_value"], "edit")
        self.assertEqual(records[2]["new_value"], "plan")
        self.assertEqual(records[2]["educator"], "braden")
        self.assertEqual(store.verify_audit(self.user), 3)

    def test_educator_defaults_to_user_id(self):
        store.set_setting(self.user, "read_confirmations", True,
                          educator_confirmed=False)
        rec = store.read_audit(self.user)[0]
        self.assertEqual(rec["educator"], self.user)

    def test_audit_chain_detects_tampering(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        store.set_setting(self.user, "verbosity", "detailed",
                          educator_confirmed=False)
        self.assertEqual(store.verify_audit(self.user), 2)
        path = store._audit_path(self.user)
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        doc = json.loads(lines[0])
        doc["new_value"] = "MUTATED"
        lines[0] = json.dumps(doc, sort_keys=True) + "\n"
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
        with self.assertRaises(store.SettingsAuditError):
            store.verify_audit(self.user)

    def test_audit_chain_detects_truncation(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        store.set_setting(self.user, "verbosity", "detailed",
                          educator_confirmed=False)
        path = store._audit_path(self.user)
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(lines[0])  # drop the second record
        with self.assertRaises(store.SettingsAuditError):
            store.verify_audit(self.user)

    # -- safety ---------------------------------------------------------------------------

    def test_user_id_traversal_rejected(self):
        for bad in ["../evil", "..\\evil", "/abs", "", "a" * 65,
                    "semi;colon", "sp ace"]:
            with self.assertRaises(store.SettingsError, msg=bad):
                store.get_setting(bad, "default_mode")

    def test_corrupt_file_fails_closed(self):
        path = store._settings_path(self.user)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        with self.assertRaises(store.SettingsCorrupt):
            store.get_setting(self.user, "default_mode")
        with self.assertRaises(store.SettingsCorrupt):
            store.set_setting(self.user, "verbosity", "concise",
                              educator_confirmed=False)

    def test_invalid_stored_value_fails_closed(self):
        path = store._settings_path(self.user)
        doc = {"version": 1, "change_count": 0,
               "settings": {"verbosity": "garbage"}}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        with self.assertRaises(store.SettingsCorrupt):
            store.get_setting(self.user, "verbosity")

    def test_settings_file_is_private(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        mode = os.stat(store._settings_path(self.user)).st_mode & 0o777
        self.assertEqual(mode, 0o600)
        amode = os.stat(store._audit_path(self.user)).st_mode & 0o777
        self.assertEqual(amode, 0o600)

    def test_no_em_dashes_in_spoken_text(self):
        samples = []
        for utterance in ["use edit mode", "make edit mode my default",
                          "switch to plan mode",
                          "use plan mode for this conversation",
                          "use edit mode for this conversation",
                          "set my edit sessions to 60 minutes",
                          "set my edit sessions to 500 minutes",
                          "stop asking me to confirm deletions",
                          "show me my settings", "what mode am I in",
                          "be more concise", "end edit mode",
                          "blah blah nothing"]:
            _, reply = commands.parse_command(utterance, user_id=self.user,
                                              conversation_id=self.conv)
            samples.append(reply)
        for s in samples:
            self.assertNotIn("\u2014", s, msg=s)


class ParserTest(unittest.TestCase):
    def setUp(self):
        self.work = os.path.join(_HERE, ".selftest-work")
        self.home = os.path.join(self.work, "parser-home")
        os.makedirs(self.home, exist_ok=True)
        self._old_env = os.environ.get("MORROW_HOME")
        os.environ["MORROW_HOME"] = self.home
        # Hermetic signing key (see SettingsTest.setUp).
        import dispatch.admission as _adm
        self._old_secrets_dir = _adm.SECRETS_DIR
        self._old_signing_key = _adm.SIGNING_KEY_PATH
        _adm.SECRETS_DIR = os.path.join(self.home, "secrets")
        _adm.SIGNING_KEY_PATH = os.path.join(self.home, "secrets",
                                             "approval-signing.key")
        self.user = "parser-user"
        self.conv = "parser-conv"
        # Session-scoped state: conversation overrides are process-global
        # in-memory; conversation grants are persisted and sealed.
        # Reset both so each test starts clean.
        with store._SESSION_LOCK:
            store._CONVERSATION_MODES.clear()
        import modes.state as _mode_state
        _mode_state.revoke_edit_grant(self.user, reason="test reset")

    def tearDown(self):
        import dispatch.admission as _adm
        _adm.SECRETS_DIR = self._old_secrets_dir
        _adm.SIGNING_KEY_PATH = self._old_signing_key
        if self._old_env is None:
            os.environ.pop("MORROW_HOME", None)
        else:
            os.environ["MORROW_HOME"] = self._old_env
        for root, dirs, files in os.walk(self.work, topdown=False):
            for name in files:
                try:
                    os.unlink(os.path.join(root, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass

    def _parse(self, text):
        return commands.parse_command(text, user_id=self.user,
                                      conversation_id=self.conv)

    def test_use_edit_mode_starts_session(self):
        # Braden's model: "use edit mode" is a standing grant, no time
        # handcuffs. It sets default_mode="edit", not a timed session.
        op, reply = self._parse("use edit mode")
        self.assertEqual(op["action"], "set")
        self.assertEqual(op["key"], "default_mode")
        self.assertEqual(op["value"], "edit")
        self.assertTrue(op["needs_confirmation"])

    def test_make_edit_mode_my_default_is_standing_grant(self):
        op, reply = self._parse("make edit mode my default")
        self.assertEqual(op["action"], "set")
        self.assertEqual(op["key"], "default_mode")
        self.assertEqual(op["value"], "edit")
        self.assertTrue(op["needs_confirmation"])
        self.assertIn("standing edit grant", reply)

    def test_switch_to_plan_mode(self):
        op, reply = self._parse("switch to plan mode")
        self.assertEqual(op["action"], "end_edit")
        self.assertEqual(op["value"], "plan")
        self.assertFalse(op["needs_confirmation"])
        self.assertNotIn("Done", reply)

    PLAN_PHRASES = [
        "use plan mode", "stop edit mode", "end edit mode",
        "exit edit mode", "leave edit mode", "back to plan mode",
        "go back to plan mode", "turn off edit mode", "disable edit mode",
        "deactivate edit mode", "switch to plan mode", "turn on plan mode",
        "make plan mode my default", "stop editing without asking",
    ]

    def _enter_edit_everywhere(self):
        from modes import state as mode_state
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        mode_state.request_edit_grant(
            self.user, scope_type="conversation", conversation_id=self.conv,
            educator_confirmation={
                "by": "educator", "channel": "educator-chat",
                "authorization": "yes, use edit mode for this conversation"})
        store.set_conversation_mode(self.user, "other-conv", "edit",
                                    educator_confirmed=True)

    def test_plan_phrases_actually_put_educator_in_plan(self):
        # The defect: these phrases used to end only timed sessions,
        # leaving default_mode "edit" while the reply said "back on your
        # saved default". Writes then ran unapproved.
        from dispatch.admission import check_mode_authority
        from modes import errors as mode_errors
        entry = {"name": "canvas_create_page", "effects": "write",
                 "provider": "canvas",
                 "request": {"method": "POST", "url": "{canvas_base}"
                             "/api/v1/courses/{course_id}/pages"}}
        for phrase in self.PLAN_PHRASES:
            self._enter_edit_everywhere()
            self.assertEqual(store.effective_mode(self.user, self.conv),
                             "edit", msg=phrase)
            op, _ = self._parse(phrase)
            self.assertEqual(op["action"], "end_edit", msg=phrase)
            self.assertFalse(op["needs_confirmation"], msg=phrase)
            reply = commands.apply_command(op, self.user, self.conv,
                                           educator=self.user)
            self.assertEqual(store.get_setting(self.user, "default_mode"),
                             "plan", msg=phrase)
            for conv in (self.conv, "other-conv", None):
                self.assertEqual(store.effective_mode(self.user, conv),
                                 "plan", msg="%s / %s" % (phrase, conv))
            with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval,
                                   msg=phrase):
                check_mode_authority(entry, {"course_id": "1"}, None,
                                     {"user_id": self.user,
                                      "conversation_id": self.conv})
            self.assertIn("plan mode", reply, msg=phrase)
            self.assertIn("ask for your approval", reply, msg=phrase)
            self.assertNotIn("saved default", reply, msg=phrase)
            self.assertNotIn("\u2014", reply, msg=phrase)

    def test_apply_reports_the_true_mode(self):
        # If something still holds edit on after the switch, the reply
        # must say so instead of claiming plan mode.
        from modes import state as mode_state
        self._enter_edit_everywhere()
        op, _ = self._parse("use plan mode")
        real = mode_state.current_mode
        mode_state.current_mode = lambda *a, **k: "edit"
        try:
            reply = commands.apply_command(op, self.user, self.conv)
        finally:
            mode_state.current_mode = real
        self.assertIn("still in edit mode", reply)
        self.assertNotIn("You are in plan mode", reply)

    def test_use_plan_mode_for_this_conversation(self):
        op, reply = self._parse("use plan mode for this conversation")
        self.assertEqual(op["action"], "conversation")
        self.assertEqual(op["key"], "conversation_mode")
        self.assertEqual(op["value"], "plan")
        self.assertTrue(op["needs_confirmation"])
        self.assertIn("this conversation only", reply)

    def test_use_edit_mode_for_this_conversation(self):
        op, reply = self._parse("use edit mode for this conversation")
        self.assertEqual(op["action"], "conversation")
        self.assertEqual(op["value"], "edit")
        self.assertTrue(op["needs_confirmation"])

    def test_edit_sessions_duration_explains_edit_is_not_timed(self):
        for utterance in ("set my edit sessions to 60 minutes",
                          "set my edit sessions to 500 minutes",
                          "edit for 30 minutes",
                          "give me edit mode for 2 hours"):
            op, reply = self._parse(utterance)
            self.assertEqual(op["action"], "invalid", msg=utterance)
            self.assertFalse(op["needs_confirmation"], msg=utterance)
            self.assertIn("no time limit", reply, msg=utterance)
            self.assertIn("turn off edit mode", reply, msg=utterance)

    def test_use_edit_mode_with_duration_says_it_is_not_timed(self):
        op, reply = self._parse("use edit mode for 30 minutes")
        self.assertEqual(op["key"], "default_mode")
        self.assertEqual(op["value"], "edit")
        self.assertTrue(op["needs_confirmation"])
        self.assertIn("no time limit", reply)

    def test_stop_confirming_deletions(self):
        op, reply = self._parse("stop asking me to confirm deletions")
        self.assertEqual(op["action"], "set")
        self.assertEqual(op["key"], "confirm_destructive_writes")
        self.assertEqual(op["value"], False)
        self.assertTrue(op["needs_confirmation"])
        self.assertIn("Turning off deletion confirmations", reply)

    def test_always_confirm_deletions(self):
        op, _ = self._parse("always confirm deletions")
        self.assertEqual(op["key"], "confirm_destructive_writes")
        self.assertEqual(op["value"], True)
        self.assertTrue(op["needs_confirmation"])

    def test_show_settings(self):
        op, reply = self._parse("show me my settings")
        self.assertEqual(op["action"], "show")
        self.assertFalse(op["needs_confirmation"])
        self.assertIn("Default mode", reply)

    def test_what_mode_am_i_in(self):
        op, reply = self._parse("what mode am I in")
        self.assertEqual(op["action"], "status")
        self.assertFalse(op["needs_confirmation"])
        self.assertIn("plan mode", reply)

    def test_what_mode_am_i_in_standing_edit(self):
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        op, reply = self._parse("what mode am I in")
        self.assertIn("edit mode", reply)
        self.assertIn("until you turn it off", reply)
        self.assertNotIn("timed", reply)
        self.assertNotIn(" left", reply)

    def test_be_more_concise(self):
        op, reply = self._parse("be more concise")
        self.assertEqual(op["action"], "set")
        self.assertEqual(op["key"], "verbosity")
        self.assertEqual(op["value"], "concise")
        self.assertFalse(op["needs_confirmation"])

    def test_end_edit_mode(self):
        op, reply = self._parse("end edit mode")
        self.assertEqual(op["action"], "end_edit")
        self.assertFalse(op["needs_confirmation"])

    def test_unknown_utterance(self):
        op, reply = self._parse("tell me a joke about quizzes")
        self.assertEqual(op["action"], "unknown")
        self.assertIn("use edit mode", reply)

    def test_confirmation_recognition(self):
        for yes in ["yes", "Yes", "yeah", "confirm", "do it", "go ahead",
                    "sounds good", "make it so"]:
            self.assertTrue(commands.is_confirmation(yes), msg=yes)
        for no in ["no", "cancel", "never mind", "stop", "not yet"]:
            self.assertFalse(commands.is_confirmation(no), msg=no)
            self.assertTrue(commands.is_cancellation(no), msg=no)

    def test_end_to_end_session_flow(self):
        # Educator asks, agent echoes, educator confirms, agent sets standing grant.
        # Braden's model: "use edit mode" is a standing grant (default_mode="edit"),
        # not a timed session. No time handcuffs.
        op, echo = self._parse("use edit mode")
        self.assertTrue(op["needs_confirmation"])
        self.assertTrue(commands.is_confirmation("yes"))
        self.assertEqual(op["action"], "set")
        self.assertEqual(op["key"], "default_mode")
        self.assertEqual(op["value"], "edit")
        result = store.set_setting(
            self.user, "default_mode", "edit",
            educator_confirmed=True, educator=self.user)
        self.assertEqual(store.effective_mode(self.user, self.conv), "edit")
        rec = store.read_audit(self.user)[0]
        self.assertEqual(rec["kind"], "settings.change")
        self.assertEqual(rec["key"], "default_mode")
        self.assertEqual(rec["old_value"], "plan")
        self.assertEqual(rec["new_value"], "edit")

    def test_end_to_end_default_grant_flow(self):
        op, echo = self._parse("make edit mode my default")
        self.assertTrue(op["needs_confirmation"])
        self.assertTrue(commands.is_confirmation("yes"))
        store.set_setting(self.user, op["key"], op["value"],
                          educator_confirmed=True, educator=self.user)
        self.assertEqual(store.get_setting(self.user, "default_mode"), "edit")


class Lane4HardeningTest(unittest.TestCase):
    """EARTHSHAKE Lane 4 (configuration): tamper sealing, parser gaps,
    new settings, journal hardening. setUp mirrors SettingsTest (hermetic
    MORROW_HOME, hermetic signing key, clean session state)."""

    def setUp(self):
        self.work = os.path.join(_HERE, ".selftest-work")
        self.home = os.path.join(self.work, "lane4-home-%d" % os.getpid())
        os.makedirs(self.home, exist_ok=True)
        self._old_env = os.environ.get("MORROW_HOME")
        os.environ["MORROW_HOME"] = self.home
        import dispatch.admission as _adm
        self._old_secrets_dir = _adm.SECRETS_DIR
        self._old_signing_key = _adm.SIGNING_KEY_PATH
        _adm.SECRETS_DIR = os.path.join(self.home, "secrets")
        _adm.SIGNING_KEY_PATH = os.path.join(self.home, "secrets",
                                             "approval-signing.key")
        self.user = "lane4-user-%d" % os.getpid()
        self.conv = "lane4-conv-%d" % os.getpid()
        with store._SESSION_LOCK:
            store._CONVERSATION_MODES.clear()
        import modes.state as _mode_state
        _mode_state.revoke_edit_grant(self.user, reason="test reset")

    def tearDown(self):
        import dispatch.admission as _adm
        _adm.SECRETS_DIR = self._old_secrets_dir
        _adm.SIGNING_KEY_PATH = self._old_signing_key
        if self._old_env is None:
            os.environ.pop("MORROW_HOME", None)
        else:
            os.environ["MORROW_HOME"] = self._old_env
        for root, dirs, files in os.walk(self.work, topdown=False):
            for name in files:
                try:
                    os.unlink(os.path.join(root, name))
                except OSError:
                    pass
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass

    def _parse(self, text):
        return commands.parse_command(text, user_id=self.user,
                                      conversation_id=self.conv)

    def _raw_doc(self):
        with open(store._settings_path(self.user), "r",
                  encoding="utf-8") as fh:
            return json.load(fh)

    def _write_raw_doc(self, doc):
        with open(store._settings_path(self.user), "w",
                  encoding="utf-8") as fh:
            json.dump(doc, fh)

    # -- tamper sealing ----------------------------------------------------

    def test_settings_file_is_sealed_on_write(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        doc = self._raw_doc()
        self.assertIsInstance(doc.get("sig"), str)
        self.assertTrue(doc["sig"])

    def test_tampered_value_fails_closed(self):
        store.set_setting(self.user, "default_mode", "plan",
                          educator_confirmed=True)
        doc = self._raw_doc()
        doc["settings"]["default_mode"] = "edit"  # bypass the API
        self._write_raw_doc(doc)
        with self.assertRaises(store.SettingsTamper):
            store.get_setting(self.user, "default_mode")
        # SettingsTamper is a SettingsCorrupt: fail-closed either way.
        with self.assertRaises(store.SettingsCorrupt):
            store.get_setting(self.user, "default_mode")

    def test_stripped_seal_fails_closed(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        doc = self._raw_doc()
        del doc["sig"]
        self._write_raw_doc(doc)
        with self.assertRaises(store.SettingsTamper):
            store.get_setting(self.user, "default_mode")

    def test_unsealed_legacy_file_refused(self):
        self._write_raw_doc({"version": 1, "change_count": 0,
                             "settings": {"verbosity": "concise"}})
        with self.assertRaises(store.SettingsTamper):
            store.get_setting(self.user, "verbosity")

    def test_seal_verifies_across_restart(self):
        store.set_setting(self.user, "verbosity", "detailed",
                          educator_confirmed=False)
        snippet = (
            "import sys; sys.path.insert(0, %r);"
            "from settings import store as s;"
            "assert s.get_setting(%r, 'verbosity') == 'detailed';"
            "assert s.verify_audit(%r) == 1;"
            "print('seal-restart-ok')"
            % (_TREE, self.user, self.user))
        proc = subprocess.run([sys.executable, "-c", snippet],
                              capture_output=True, text=True,
                              env=dict(os.environ),
                              cwd=_TREE, timeout=60)
        self.assertEqual(proc.returncode, 0,
                         msg="stderr: %s" % proc.stderr)
        self.assertIn("seal-restart-ok", proc.stdout)

    # -- parser gaps --------------------------------------------------------

    def test_conversation_override_verb_variants(self):
        for utterance, mode in [
                ("switch to edit mode for this conversation", "edit"),
                ("change to plan mode for this conversation", "plan"),
                ("for this conversation, use edit mode", "edit"),
                ("for this chat, use plan mode", "plan"),
                ("use edit mode for this chat", "edit")]:
            op, reply = self._parse(utterance)
            self.assertEqual(op["action"], "conversation", msg=utterance)
            self.assertEqual(op["value"], mode, msg=utterance)
            self.assertTrue(op["needs_confirmation"], msg=utterance)

    def test_conversation_override_never_becomes_standing_grant(self):
        # The over-granting defect: a conversation-scoped ask must never
        # parse as a persisted default_mode change.
        op, _ = self._parse("switch to edit mode for this conversation")
        self.assertNotEqual(op["key"], "default_mode")

    def test_turn_on_off_verbs(self):
        cases = [("turn on edit mode", "edit"),
                 ("enable edit mode", "edit"),
                 ("activate edit mode", "edit"),
                 ("disable plan mode", "edit")]
        for utterance, mode in cases:
            op, reply = self._parse(utterance)
            self.assertEqual(op["action"], "set", msg=utterance)
            self.assertEqual(op["key"], "default_mode", msg=utterance)
            self.assertEqual(op["value"], mode, msg=utterance)
            self.assertTrue(op["needs_confirmation"], msg=utterance)
        # Turning edit off is the safe direction: it applies at once,
        # everywhere, with no confirmation round trip.
        for utterance in ("turn off edit mode", "disable edit mode",
                          "deactivate edit mode", "turn on plan mode"):
            op, reply = self._parse(utterance)
            self.assertEqual(op["action"], "end_edit", msg=utterance)
            self.assertFalse(op["needs_confirmation"], msg=utterance)

    def test_what_is_default_mode(self):
        op, reply = self._parse("what is my default mode")
        self.assertEqual(op["action"], "status")
        self.assertIn("plan", reply)
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        _, reply = self._parse("what is my default mode")
        self.assertIn("edit", reply)

    def test_confirmation_broadening(self):
        for yes in ["yes please", "yes, go ahead and do it", "ok thanks",
                    "absolutely", "definitely", "sure thing"]:
            self.assertTrue(commands.is_confirmation(yes), msg=yes)
        for not_yes in ["yesterday I changed my mind", "yepper"]:
            self.assertFalse(commands.is_confirmation(not_yes),
                             msg=not_yes)
        # Hedge cues defer, never confirm: fail safe toward reprompt.
        for hedge in ["okay, but first a question", "yes, but make it brief",
                      "sure, hold on a second", "yes, wait"]:
            self.assertFalse(commands.is_confirmation(hedge), msg=hedge)
            self.assertFalse(commands.is_cancellation(hedge), msg=hedge)
        for no in ["nah", "not now", "no, don't do that"]:
            self.assertTrue(commands.is_cancellation(no), msg=no)
            self.assertFalse(commands.is_confirmation(no), msg=no)

    def test_parser_confirmation_matches_schema(self):
        utterances = {
            "default_mode": "make edit mode my default",
            "verbosity": "be more concise",
            "confirm_destructive_writes":
                "stop asking me to confirm deletions",
            "write_approval_style": "use batched approvals",
            "failure_verbosity": "keep failure reports short",
            "proactivity": "suggest follow-ups",
            "read_confirmations": "narrate what you are about to read",
            "work_summary": "keep work summaries brief",
            "auto_cleanup_test_objects": "clean up test objects when done",
            "default_course_id": "my default course is 12345",
            "timezone": "my timezone is Eastern",
            "confirm_bulk_actions": "ask me before bulk actions",
        }
        self.assertEqual(set(utterances), set(store.SETTINGS_SCHEMA),
                         "every schema key needs a parser utterance here")
        for key, utterance in utterances.items():
            op, _ = self._parse(utterance)
            self.assertEqual(op["action"], "set",
                             msg="utterance=%r" % utterance)
            self.assertEqual(op["key"], key, msg="utterance=%r" % utterance)
            self.assertEqual(
                op["needs_confirmation"],
                bool(store.SETTINGS_SCHEMA[key]["consequential"]),
                msg="utterance=%r key=%r" % (utterance, key))

    # -- new settings: validation --------------------------------------------

    def test_new_settings_defaults(self):
        self.assertEqual(store.get_setting(self.user, "work_summary"),
                         "full")
        self.assertEqual(
            store.get_setting(self.user, "auto_cleanup_test_objects"), True)
        self.assertEqual(store.get_setting(self.user, "default_course_id"),
                         "")
        self.assertEqual(store.get_setting(self.user, "timezone"), "")
        self.assertEqual(store.get_setting(self.user, "confirm_bulk_actions"),
                         True)

    def test_new_settings_bad_values_refused(self):
        bad = [
            ("work_summary", "verbose"),
            ("work_summary", "FULL"),
            ("work_summary", 1),
            ("auto_cleanup_test_objects", "yes"),
            ("auto_cleanup_test_objects", 1),
            ("default_course_id", "../evil"),
            ("default_course_id", "a" * 65),
            ("default_course_id", 12345),
            ("default_course_id", "has space"),
            ("timezone", "Mars/Olympus"),
            ("timezone", "Eastern"),
            ("timezone", 123),
            ("confirm_bulk_actions", "yes"),
            ("confirm_bulk_actions", 0),
        ]
        for key, value in bad:
            with self.assertRaises(store.SettingsValidationError,
                                   msg="key=%r value=%r" % (key, value)):
                store.set_setting(self.user, key, value,
                                  educator_confirmed=True)

    def test_new_settings_boundaries_accepted(self):
        store.set_setting(self.user, "default_course_id", "a" * 64,
                          educator_confirmed=True)
        self.assertEqual(store.get_setting(self.user, "default_course_id"),
                         "a" * 64)
        store.set_setting(self.user, "default_course_id", "",
                          educator_confirmed=True)
        self.assertEqual(store.get_setting(self.user, "default_course_id"),
                         "")
        store.set_setting(self.user, "timezone", "America/Denver",
                          educator_confirmed=False)
        self.assertEqual(store.get_setting(self.user, "timezone"),
                         "America/Denver")
        store.set_setting(self.user, "work_summary", "brief",
                          educator_confirmed=False)
        store.set_setting(self.user, "auto_cleanup_test_objects", False,
                          educator_confirmed=False)
        self.assertFalse(
            store.get_setting(self.user, "auto_cleanup_test_objects"))

    def test_consequential_new_settings_need_confirmation(self):
        for key, value in [("default_course_id", "12345"),
                           ("confirm_bulk_actions", False)]:
            with self.assertRaises(store.SettingsTamperRefused,
                                   msg="key=%r" % key):
                store.set_setting(self.user, key, value,
                                  educator_confirmed=False)
        for key, value in [("work_summary", "brief"),
                           ("auto_cleanup_test_objects", False),
                           ("timezone", "America/Chicago")]:
            store.set_setting(self.user, key, value,
                              educator_confirmed=False)  # no raise

    def test_new_settings_are_journaled(self):
        store.set_setting(self.user, "default_course_id", "12345",
                          educator_confirmed=True, educator="braden")
        rec = store.read_audit(self.user)[0]
        self.assertEqual(rec["key"], "default_course_id")
        self.assertEqual(rec["old_value"], "")
        self.assertEqual(rec["new_value"], "12345")
        self.assertEqual(rec["educator"], "braden")
        self.assertEqual(store.verify_audit(self.user), 1)

    # -- new settings: parser ---------------------------------------------------

    def test_default_course_parser(self):
        op, reply = self._parse("my default course is 12345")
        self.assertEqual((op["action"], op["key"], op["value"]),
                         ("set", "default_course_id", "12345"))
        self.assertTrue(op["needs_confirmation"])
        self.assertIn("12345", reply)
        op, _ = self._parse("clear my default course")
        self.assertEqual(op["value"], "")
        op, reply = self._parse("what is my default course")
        self.assertEqual(op["action"], "status")
        self.assertIn("no default course", reply)
        store.set_setting(self.user, "default_course_id", "999",
                          educator_confirmed=True)
        _, reply = self._parse("what is my default course")
        self.assertIn("999", reply)

    def test_timezone_parser(self):
        cases = [("my timezone is Eastern", "America/New_York"),
                 ("my timezone is pacific", "America/Los_Angeles"),
                 ("set timezone to america/denver", "America/Denver"),
                 ("set timezone to America/Chicago", "America/Chicago"),
                 ("timezone: UTC", "UTC")]
        for utterance, zone in cases:
            op, reply = self._parse(utterance)
            self.assertEqual(op["action"], "set", msg=utterance)
            self.assertEqual(op["key"], "timezone", msg=utterance)
            self.assertEqual(op["value"], zone, msg=utterance)
            self.assertFalse(op["needs_confirmation"], msg=utterance)
            self.assertIn(zone, reply, msg=utterance)

    def test_timezone_invalid(self):
        op, reply = self._parse("my timezone is Mars/Olympus")
        self.assertEqual(op["action"], "invalid")
        self.assertEqual(op["key"], "timezone")

    def test_timezone_question_reports_current(self):
        _, reply = self._parse("what timezone am I in")
        self.assertIn("don't have a timezone set", reply)
        store.set_setting(self.user, "timezone", "America/Denver",
                          educator_confirmed=False)
        _, reply = self._parse("what timezone am I in")
        self.assertIn("America/Denver", reply)

    def test_bulk_actions_parser(self):
        op, reply = self._parse("ask me before bulk actions")
        self.assertEqual((op["action"], op["key"], op["value"]),
                         ("set", "confirm_bulk_actions", True))
        self.assertTrue(op["needs_confirmation"])
        op, reply = self._parse("don't ask before bulk actions")
        self.assertEqual(op["value"], False)
        self.assertTrue(op["needs_confirmation"])
        self.assertIn("Say 'yes' to confirm", reply)

    def test_work_summary_parser(self):
        op, _ = self._parse("keep work summaries brief")
        self.assertEqual((op["key"], op["value"]),
                         ("work_summary", "brief"))
        self.assertFalse(op["needs_confirmation"])
        op, _ = self._parse("give me full work summaries")
        self.assertEqual(op["value"], "full")

    def test_auto_cleanup_parser(self):
        op, _ = self._parse("clean up test objects when done")
        self.assertEqual((op["key"], op["value"]),
                         ("auto_cleanup_test_objects", True))
        op, _ = self._parse("keep test objects")
        self.assertEqual(op["value"], False)
        op, _ = self._parse("delete proof objects after checks")
        self.assertEqual(op["value"], True)

    def test_show_sentence_uses_friendly_labels(self):
        _, reply = self._parse("show me my settings")
        self.assertIn("Default course: none set", reply)
        self.assertIn("Timezone: none set", reply)
        self.assertIn("Work summary detail: full", reply)
        self.assertNotIn("default_course_id", reply)

    # -- journal hardening -------------------------------------------------------

    def test_journal_extra_keys_cannot_collide(self):
        rec = store._journal_change(
            self.user, "settings.change", "verbosity", "balanced",
            "concise", self.user,
            extra={"kind": "forged", "change_id": "forged",
                   "new_value": "forged", "custom": "kept"})
        self.assertEqual(rec["kind"], "settings.change")
        self.assertEqual(rec["new_value"], "concise")
        self.assertEqual(rec["custom"], "kept")
        self.assertNotEqual(rec["change_id"], "forged")
        # Reserved fields kept their values; the record is intact in the
        # journal. (No verify_audit here: _journal_change called
        # directly bypasses _transact's counter bump by design; every
        # real caller goes through _transact.)
        self.assertEqual(len(store.read_audit(self.user)), 1)

    def test_torn_journal_tail_reports_line(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        path = store._audit_path(self.user)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write('{"torn": true,\n')
        with self.assertRaises(store.SettingsAuditError) as ctx:
            store.read_audit(self.user)
        self.assertIn("line 2", str(ctx.exception))

    def test_deleted_settings_file_fails_audit_closed(self):
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        os.unlink(store._settings_path(self.user))
        # Reads fall back to defaults for a missing file...
        self.assertEqual(store.get_setting(self.user, "verbosity"),
                         "balanced")
        # ...but the audit journal still holds the change, so verify
        # fails closed instead of silently blessing the reset.
        with self.assertRaises(store.SettingsAuditError):
            store.verify_audit(self.user)

    def test_corrupt_message_names_both_files(self):
        path = store._settings_path(self.user)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        try:
            store.get_setting(self.user, "verbosity")
        except store.SettingsCorrupt as exc:
            self.assertIn("journal", str(exc))
            self.assertIn("together", str(exc))
        else:
            self.fail("expected SettingsCorrupt")

    def test_journal_first_doc_write_failure_truncates_journal(self):
        # Journal-first ordering with compensating truncation: if the
        # settings-doc write fails after the journal append, the
        # journal line is rolled back off, so no orphan record
        # survives a failed transaction.
        real_write = store._write_doc_atomic

        def failing_write(path, doc):
            raise OSError("simulated disk failure")

        store._write_doc_atomic = failing_write
        try:
            with self.assertRaises(OSError):
                store.set_setting(self.user, "verbosity", "concise",
                                  educator_confirmed=False)
        finally:
            store._write_doc_atomic = real_write
        # Nothing landed: journal empty, doc unwritten, audit verifies
        # clean, and the old (safe) value is still in force.
        self.assertEqual(store.read_audit(self.user), [])
        self.assertEqual(store.verify_audit(self.user), 0)
        self.assertEqual(store.get_setting(self.user, "verbosity"),
                         "balanced")

    def test_orphan_journal_record_fails_audit_closed(self):
        # A crash between journal append and doc write leaves a journal
        # record whose change never landed. verify_audit fails closed
        # on the journal-count vs change-counter mismatch, while
        # get_setting keeps returning the old (safe) value.
        store._journal_change(self.user, "settings.change", "verbosity",
                              "balanced", "concise", self.user)
        with self.assertRaises(store.SettingsAuditError):
            store.verify_audit(self.user)
        self.assertEqual(store.get_setting(self.user, "verbosity"),
                         "balanced")

    def test_torn_journal_tail_refuses_new_change(self):
        # Fail closed: no new record chains onto a broken journal.
        store.set_setting(self.user, "verbosity", "concise",
                          educator_confirmed=False)
        path = store._audit_path(self.user)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write('{"torn": true,\n')
        with self.assertRaises(store.SettingsAuditError):
            store.set_setting(self.user, "verbosity", "detailed",
                              educator_confirmed=False)
        # The torn tail was not silently extended: still exactly one
        # intact record in the journal.
        with open(path, "r", encoding="utf-8") as fh:
            journal = fh.read()
        self.assertEqual(journal.count("rec_hash"), 1)

    # -- spoken text ------------------------------------------------------------------

    def test_no_em_dashes_in_new_spoken_text(self):
        utterances = [
            "switch to edit mode for this conversation",
            "turn on edit mode", "turn off edit mode",
            "what is my default mode",
            "ask me before bulk actions", "don't ask before bulk actions",
            "my default course is 12345", "clear my default course",
            "what is my default course", "my timezone is Eastern",
            "set timezone to America/Denver", "my timezone is Mars/Olympus",
            "what timezone am I in",
            "clean up test objects when done", "keep test objects",
            "keep work summaries brief", "give me full work summaries",
            "help", "what can I change",
        ]
        store.set_setting(self.user, "default_course_id", "12345",
                          educator_confirmed=True)
        store.set_setting(self.user, "timezone", "America/Denver",
                          educator_confirmed=False)
        for utterance in utterances:
            _, reply = self._parse(utterance)
            self.assertNotIn("\u2014", reply, msg=utterance)


if __name__ == "__main__":
    unittest.main(verbosity=2)
