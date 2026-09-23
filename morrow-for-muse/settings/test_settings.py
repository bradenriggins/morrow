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
plan), turning edit off landing in plan mode everywhere, the typed
mode and settings commands (no free text decides anything), audit journaling with old/new/educator
(including override and edit-off records), user_id sanitization, fail-closed corrupt files, and the
Agent A contract (get_setting(user_id, key) exact signature).

Test scratch lives under .selftest-work/ next to this test (tree
convention: never /tmp). MORROW_HOME is redirected there so the real
~/.morrow is never touched.

Stdlib only. Run: python3 settings/test_settings.py
"""
import os as _home_os, sys as _home_sys  # noqa: E401
_home_sys.path.insert(0, _home_os.path.join(
    _home_os.path.dirname(_home_os.path.abspath(__file__)), '..'))
import config.selftest_home  # noqa: E402,F401  (scratch HOME/MORROW_HOME)
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
        # Conversation overrides and grants are persisted and sealed.
        # Reset both so each test starts clean.
        store.clear_conversation_overrides(self.user)
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
            ("work_summary", "sometimes"),
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
                           ("default_course_id", "12345")]:
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
        with no expiry. A per-conversation plan override is persisted
        too: every dispatch is a new process, so an in-memory override
        never reached the write gate.
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
            "assert s.effective_mode(%r, %r) == 'plan';"  # override kept
            "assert s.get_conversation_mode(%r, %r) == 'plan';"
            "assert s.effective_mode(%r, 'other-conv') == 'edit';"
            "print('restart-ok')"
            % (_TREE, self.user, self.user,
               self.user, self.conv, self.user, self.conv, self.user))
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
        self.assertEqual(len(records), 4)
        self.assertEqual(records[1]["kind"], "settings.conversation_mode")
        self.assertEqual(records[1]["new_value"], "plan")
        self.assertEqual(records[1]["educator"], "braden")
        self.assertEqual(records[1]["conversation_id"], self.conv)
        self.assertEqual(records[2]["kind"],
                         "settings.conversation_overrides_cleared")
        self.assertIn(self.conv, records[2]["old_value"])
        self.assertEqual(records[2]["educator"], "braden")
        self.assertEqual(records[3]["kind"], "settings.change")
        self.assertEqual(records[3]["key"], "default_mode")
        self.assertEqual(records[3]["old_value"], "edit")
        self.assertEqual(records[3]["new_value"], "plan")
        self.assertEqual(records[3]["educator"], "braden")
        self.assertEqual(store.verify_audit(self.user), 4)

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
        for bad in ["../evil", "..\\evil", "/abs", "", "a" * 161,
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

    def test_no_em_dashes_in_schema_descriptions(self):
        for key, entry in store.SETTINGS_SCHEMA.items():
            self.assertNotIn("\u2014", entry["description"], msg=key)


class CommandTest(unittest.TestCase):
    """The typed mode and settings commands (settings/commands.py).

    The agent decides what the educator means and calls these; no free
    text reaches them. Tests assert the resulting state and the truth of
    the message, never a phrasing of the educator's request."""

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
        store.clear_conversation_overrides(self.user)
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

    def test_parser_is_gone(self):
        # No free text decides a mode or a setting.
        for name in ("parse_command", "apply_command", "is_confirmation",
                     "is_cancellation", "_mode_intent"):
            self.assertFalse(hasattr(commands, name), msg=name)
        for name, fn in inspect.getmembers(commands, inspect.isfunction):
            if fn.__module__ != commands.__name__:
                continue
            params = inspect.signature(fn).parameters
            self.assertNotIn("text", params, msg=name)
            self.assertNotIn("utterance", params, msg=name)

    def test_no_command_forces_a_confirmation_round_trip(self):
        # The agent acts on what the educator said; no command holds a
        # change back for a second "confirmed" call.
        for name in ("mode_set", "setting_set"):
            params = inspect.signature(getattr(commands, name)).parameters
            self.assertNotIn("educator_confirmed", params, msg=name)
        with self.assertRaises(SystemExit):
            commands.main(["mode", "set", "edit", "--user-id", self.user,
                           "--educator-confirmed"])

    def test_edit_default_takes_effect_and_says_what_it_means(self):
        out = commands.mode_set(self.user, "edit", self.conv)
        self.assertEqual((out["status"], out["mode"]), ("done", "edit"))
        self.assertIn("apply without asking", out["message"])
        self.assertIn("no time limit", out["message"])
        self.assertEqual(store.get_setting(self.user, "default_mode"), "edit")
        self.assertIn("edit mode", out["message"])
        self.assertIn("until you turn it off", out["message"])
        rec = store.read_audit(self.user)[-1]
        self.assertEqual((rec["kind"], rec["key"], rec["old_value"],
                          rec["new_value"]),
                         ("settings.change", "default_mode", "plan", "edit"))

    def test_plan_everywhere_actually_puts_educator_in_plan(self):
        from dispatch.admission import check_mode_authority
        from modes import errors as mode_errors
        entry = {"name": "canvas_create_page", "effects": "write",
                 "provider": "canvas",
                 "request": {"method": "POST", "url": "{canvas_base}"
                             "/api/v1/courses/{course_id}/pages"}}
        self._enter_edit_everywhere()
        self.assertEqual(store.effective_mode(self.user, self.conv), "edit")
        out = commands.mode_set(self.user, "plan", self.conv)
        self.assertEqual((out["status"], out["mode"]), ("done", "plan"))
        self.assertEqual(store.get_setting(self.user, "default_mode"), "plan")
        for conv in (self.conv, "other-conv", None):
            self.assertEqual(store.effective_mode(self.user, conv), "plan",
                             msg=conv)
        with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval):
            check_mode_authority(entry, {"course_id": "1"}, None,
                                 {"user_id": self.user,
                                  "conversation_id": self.conv})
        self.assertIn("plan mode", out["message"])
        self.assertIn("ask for your approval", out["message"])
        self.assertNotIn("—", out["message"])

    def test_plan_reports_the_true_mode(self):
        from modes import state as mode_state
        self._enter_edit_everywhere()
        real = commands.effective_mode
        commands.effective_mode = lambda *a, **k: "edit"
        try:
            out = commands.mode_set(self.user, "plan", self.conv)
        finally:
            commands.effective_mode = real
        self.assertEqual(out["status"], "error")
        self.assertIn("still in edit mode", out["message"])
        self.assertNotIn("You are in plan mode", out["message"])
        del mode_state

    def test_plan_for_this_conversation_applies_at_once(self):
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        out = commands.mode_set(self.user, "plan", self.conv,
                                this_conversation=True)
        self.assertEqual((out["status"], out["mode"]), ("done", "plan"))
        self.assertEqual(store.get_conversation_mode(self.user, self.conv),
                         "plan")
        self.assertIn("plan override for this conversation", out["message"])
        self.assertEqual(store.effective_mode(self.user, "another"), "edit")

    def test_edit_for_this_conversation_takes_effect_and_stays_scoped(self):
        out = commands.mode_set(self.user, "edit", self.conv,
                                this_conversation=True)
        self.assertEqual((out["status"], out["mode"]), ("done", "edit"))
        self.assertIn("apply without asking", out["message"])
        self.assertEqual(store.get_setting(self.user, "default_mode"), "plan")
        self.assertIn("edit override for this conversation", out["message"])

    def test_this_conversation_requires_an_id(self):
        out = commands.mode_set(self.user, "edit", None,
                                this_conversation=True)
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["mode"], "plan")

    def test_bad_mode_changes_nothing(self):
        out = commands.mode_set(self.user, "turbo", self.conv)
        self.assertEqual((out["status"], out["mode"]), ("error", "plan"))
        self.assertEqual(store.read_audit(self.user), [])

    def test_status_names_the_source(self):
        out = commands.mode_status(self.user, self.conv)
        self.assertEqual(out["mode"], "plan")
        self.assertIn("plan mode", out["message"])
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        out = commands.mode_status(self.user, self.conv)
        self.assertEqual((out["mode"], out["default_mode"]), ("edit", "edit"))
        self.assertIn("your saved default", out["message"])
        self.assertIn("until you turn it off", out["message"])
        self.assertNotIn(" left", out["message"])

    def test_destructive_note_is_true_for_a_new_educator(self):
        # The default is off, and a new educator never turned it off.
        out = commands.mode_set(self.user, "edit", self.conv)
        self.assertNotIn("You have turned off", out["message"])
        self.assertIn("that is the default", out["message"])
        store.set_setting(self.user, "confirm_destructive_writes", True,
                          educator_confirmed=True)
        out = commands.mode_set(self.user, "edit", self.conv)
        self.assertIn("will still ask you first", out["message"])
        store.set_setting(self.user, "confirm_destructive_writes", False,
                          educator_confirmed=True)
        out = commands.mode_set(self.user, "edit", self.conv)
        self.assertIn("you turned them off", out["message"])

    def test_deletion_confirmations_setting(self):
        out = commands.setting_set(self.user, "confirm_destructive_writes",
                                   True)
        self.assertEqual(out["status"], "done")
        self.assertTrue(store.destructive_confirmation_required(self.user))
        out = commands.setting_set(self.user, "confirm_destructive_writes",
                                   False)
        self.assertFalse(store.destructive_confirmation_required(self.user))
        self.assertIn("Deletion confirmations are off", out["message"])
        # Turning deletion confirmations off never touches the mode.
        self.assertEqual(store.get_setting(self.user, "default_mode"), "plan")

    def test_every_setting_applies_in_one_call_and_is_journaled(self):
        values = {
            "verbosity": "concise", "confirm_destructive_writes": True,
            "failure_verbosity": "concise",
            "proactivity": "suggestive", "read_confirmations": True,
            "work_summary": "brief",
            "default_course_id": "12345", "timezone": "America/Denver",
        }
        self.assertEqual(set(values) | {"default_mode"},
                         set(store.SETTINGS_SCHEMA))
        for key, value in values.items():
            out = commands.setting_set(self.user, key, value)
            self.assertEqual(out["status"], "done", msg=key)
            self.assertEqual(store.get_setting(self.user, key), value,
                             msg=key)
            rec = store.read_audit(self.user)[-1]
            self.assertEqual((rec["key"], rec["new_value"]), (key, value))
        self.assertEqual(store.verify_audit(self.user), len(values))

    def test_invalid_setting_values_change_nothing(self):
        for key, value in (("timezone", "Mars/Olympus"),
                           ("default_course_id", "12 345"),
                           ("verbosity", "loud"),
                           ("read_confirmations", "yes")):
            out = commands.setting_set(self.user, key, value)
            self.assertEqual(out["status"], "error", msg=key)
        out = commands.setting_set(self.user, "no_such_key", 1)
        self.assertEqual(out["status"], "error")
        self.assertEqual(store.read_audit(self.user), [])

    def test_default_mode_setting_routes_through_mode_set(self):
        out = commands.setting_set(self.user, "default_mode", "edit")
        self.assertEqual((out["status"], out["mode"]), ("done", "edit"))
        out = commands.setting_set(self.user, "default_mode", "plan")
        self.assertEqual((out["status"], out["mode"]), ("done", "plan"))

    def test_settings_show_uses_friendly_labels(self):
        out = commands.settings_show(self.user, self.conv)
        self.assertIn("Default course: none set", out["message"])
        self.assertIn("Timezone: none set", out["message"])
        self.assertIn("Work summary detail: full", out["message"])
        self.assertNotIn("default_course_id", out["message"])
        self.assertEqual(out["settings"]["default_mode"], "plan")

    def test_setting_get(self):
        store.set_setting(self.user, "default_course_id", "999",
                          educator_confirmed=True)
        out = commands.setting_get(self.user, "default_course_id")
        self.assertEqual(out["value"], "999")
        self.assertIn("999", out["message"])

    def test_turn_off_after_tamper_reports_truthfully(self):
        store.set_setting(self.user, "default_mode", "edit",
                          educator_confirmed=True)
        path = store._settings_path(self.user)
        with open(path) as fh:
            doc = json.load(fh)
        doc["settings"]["verbosity"] = "detailed"
        with open(path, "w") as fh:
            json.dump(doc, fh)
        out = commands.mode_set(self.user, "plan", self.conv)
        self.assertEqual((out["status"], out["mode"]), ("done", "plan"))
        self.assertTrue(out["settings_untrusted"])
        self.assertIn("plan mode", out["message"])
        self.assertIn("restore", out["message"])
        status = commands.mode_status(self.user, self.conv)
        self.assertEqual(status["mode"], "plan")
        self.assertTrue(status["settings_untrusted"])

    def test_no_em_dashes_in_any_message(self):
        outs = [commands.mode_status(self.user, self.conv),
                commands.mode_set(self.user, "edit", self.conv),
                commands.mode_set(self.user, "edit", self.conv,
                                  this_conversation=True),
                commands.mode_set(self.user, "plan", self.conv,
                                  this_conversation=True),
                commands.mode_set(self.user, "plan", self.conv),
                commands.settings_show(self.user, self.conv),
                commands.setting_set(self.user, "read_confirmations",
                                     False),
                commands.setting_get(self.user, "timezone")]
        for out in outs:
            self.assertNotIn("—", out["message"])

    def test_cli_mode_and_settings(self):
        env = dict(os.environ)
        env["MORROW_HOME"] = self.home
        env.pop("MORROW_USER_ID", None)
        script = os.path.join(_TREE, "bin", "morrow")

        def run(*argv):
            proc = subprocess.run([sys.executable, script] + list(argv),
                                  capture_output=True, text=True, env=env,
                                  timeout=120)
            return proc.returncode, json.loads(proc.stdout.strip()
                                               .splitlines()[-1])

        code, out = run("mode", "set", "edit", "--user-id", self.user)
        self.assertEqual((code, out["status"], out["mode"]),
                         (0, "done", "edit"))
        code, out = run("mode", "status", "--user-id", self.user)
        self.assertEqual(out["mode"], "edit")
        code, out = run("settings", "set", "confirm_destructive_writes",
                        "true", "--user-id", self.user)
        self.assertEqual((code, out["value"]), (0, True))
        code, out = run("settings", "set", "confirm_destructive_writes",
                        "yes please", "--user-id", self.user)
        self.assertEqual((code, out["status"]), (1, "error"))
        code, out = run("mode", "set", "plan", "--user-id", self.user)
        self.assertEqual((code, out["mode"]), (0, "plan"))
        code, out = run("mode", "status")
        self.assertEqual(code, 2)


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
        store.clear_conversation_overrides(self.user)
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

    # -- new settings: validation --------------------------------------------

    def test_new_settings_defaults(self):
        self.assertEqual(store.get_setting(self.user, "work_summary"),
                         "full")
        self.assertEqual(store.get_setting(self.user, "default_course_id"),
                         "")
        self.assertEqual(store.get_setting(self.user, "timezone"), "")

    def test_new_settings_bad_values_refused(self):
        bad = [
            ("work_summary", "verbose"),
            ("work_summary", "FULL"),
            ("work_summary", 1),
            ("default_course_id", "../evil"),
            ("default_course_id", "a" * 65),
            ("default_course_id", 12345),
            ("default_course_id", "has space"),
            ("timezone", "Mars/Olympus"),
            ("timezone", "Eastern"),
            ("timezone", 123),
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
        self.assertEqual(store.get_setting(self.user, "work_summary"),
                         "brief")

    def test_consequential_new_settings_need_confirmation(self):
        for key, value in [("default_course_id", "12345")]:
            with self.assertRaises(store.SettingsTamperRefused,
                                   msg="key=%r" % key):
                store.set_setting(self.user, key, value,
                                  educator_confirmed=False)
        for key, value in [("work_summary", "brief"),
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
