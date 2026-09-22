#!/usr/bin/env python3
"""Integrated adversarial tests: modes + settings + admission gate.

Workstreams A (modes/state.py), B (settings/store.py), and C
(failures/) meet the dispatch admission gate here, with the REAL
packages (no fakes): the educator's grant, the conversational session,
and the write gate must all agree, and every attack must fail closed.

Covers:
  - self-promotion refused at every layer (modes, settings, switch)
  - educator-confirmed session/grant admits a write with no approval
  - settings.effective_mode == modes.current_mode in every scenario
  - plan-mode write without approval -> PlanModeWriteWithoutApproval,
    translated to plan_mode_write_without_approval
  - an ended grant (revoked, or a legacy timed grant) is plain plan
    mode: the write asks for approval and a signed approval lands
  - ambiguous course refused; confirmed ambiguous course admitted
  - destructive gate: on (refuse), confirmed (admit), setting off (admit)
  - tampered grant file fails closed
  - conversation isolation: bound grants do not leak across
    conversations; end_conversation revokes them
  - most-recent-wins between override and grant
  - switch_mode("plan") turns edit off everywhere, standing default too

MORROW_HOME is redirected to scratch under .selftest-work/ so the real
~/.morrow is never touched. Stdlib only.
"""

import json
import os
import sys
import unittest
from datetime import timedelta

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if TREE not in sys.path:
    sys.path.insert(0, TREE)

from dispatch.admission import check_mode_authority, WriteApprovalMissing
from failures import translate
from modes import errors as mode_errors
from modes import state as mode_state
from settings import store as settings
from settings.store import SettingsTamperRefused


def _write_entry(name="canvas_create_page", method="POST"):
    return {
        "name": name,
        "effects": "write",
        "provider": "canvas",
        "request": {"method": method,
                    "url": "{canvas_base}/api/v1/courses/{course_id}/pages"},
    }


def _confirmation(text):
    return {"by": "educator", "authorization": text,
            "channel": "educator-chat"}


class IntegrationCase(unittest.TestCase):
    def setUp(self):
        self.work = os.path.join(TREE, "modes", ".selftest-work",
                                 "integration")
        self.home = os.path.join(self.work, "morrow-home")
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
        self.user = "integ-educator-%d" % os.getpid()
        self.conv = "integ-conv-%d" % os.getpid()
        settings.clear_conversation_overrides(self.user)
        mode_state.revoke_edit_grant(self.user, reason="test reset")

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

    # -- helpers ------------------------------------------------------

    def _grant(self, **kw):
        kw.setdefault("educator_confirmation",
                      _confirmation("yes, use edit mode for the next while"))
        return mode_state.request_edit_grant(self.user, **kw)

    def _ctx(self, **kw):
        ctx = {"user_id": self.user, "conversation_id": self.conv}
        ctx.update(kw)
        return ctx

    def _agree(self, conversation_id="SENTINEL"):
        """settings.effective_mode and modes.current_mode agree."""
        conv = self.conv if conversation_id == "SENTINEL" else conversation_id
        a = settings.effective_mode(self.user, conv)
        b = mode_state.current_mode(self.user, conv)
        self.assertEqual(a, b,
                         "resolvers disagree: settings=%r modes=%r" % (a, b))
        return a

    # -- self-promotion ------------------------------------------------

    def test_self_promotion_refused_everywhere(self):
        with self.assertRaises(mode_errors.ModeSelfGrantRefused):
            mode_state.request_edit_grant(self.user)  # no confirmation
        with self.assertRaises(mode_errors.ModeSelfGrantRefused):
            mode_state.request_edit_grant(
                self.user,
                educator_confirmation={"by": "agent",
                                       "authorization": "x" * 30,
                                       "channel": "educator-chat"})
        with self.assertRaises(mode_errors.ModeSelfGrantRefused):
            mode_state.switch_mode(self.user, "edit")
        with self.assertRaises(SettingsTamperRefused):
            settings.set_conversation_mode(self.user, self.conv, "edit",
                                           educator_confirmed=False)
        with self.assertRaises(SettingsTamperRefused):
            settings.set_setting(self.user, "default_mode", "edit",
                                 educator_confirmed=False)
        self.assertEqual(self._agree(), "plan")

    # -- educator grant admits writes ---------------------------------

    def test_educator_grant_admits_write_without_approval(self):
        self._grant()
        audit, record = check_mode_authority(
            _write_entry(), {"course_id": "89585"}, None, self._ctx())
        self.assertEqual(audit["mode"], "edit")
        self.assertIsNone(record, "no approval record in edit mode")
        self.assertEqual(self._agree(), "edit")

    def test_settings_conversation_override_admits_write(self):
        settings.set_conversation_mode(self.user, self.conv, "edit",
                                       educator_confirmed=True)
        audit, record = check_mode_authority(
            _write_entry(), {"course_id": "89585"}, None, self._ctx())
        self.assertEqual(audit["mode"], "edit")
        self.assertIsNone(record)
        self.assertEqual(self._agree(), "edit")

    def test_standing_default_edit_admits_write(self):
        settings.set_setting(self.user, "default_mode", "edit",
                             educator_confirmed=True)
        audit, record = check_mode_authority(
            _write_entry(), {"course_id": "89585"}, None, self._ctx())
        self.assertEqual(audit["mode"], "edit")
        self.assertEqual(audit["scope_type"], "standing")
        self.assertIsNone(record)
        self.assertEqual(self._agree(), "edit")

    # -- plan mode -----------------------------------------------------

    def test_plan_write_without_approval_translates(self):
        with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval):
            check_mode_authority(_write_entry(), {"course_id": "89585"},
                                 None, self._ctx())
        try:
            check_mode_authority(_write_entry(), {"course_id": "89585"},
                                 None, self._ctx())
        except mode_errors.PlanModeWriteWithoutApproval as exc:
            tr = translate("create a wiki page", exc)
            self.assertEqual("plan_mode_write_without_approval", tr.mode_id)
            self.assertIn("plan mode", tr.agent_message)
        self.assertEqual(self._agree(), "plan")

    def test_no_user_id_fails_closed_to_legacy_path(self):
        # No identity: the legacy approval path, unchanged.
        with self.assertRaises(WriteApprovalMissing):
            check_mode_authority(_write_entry(), {"course_id": "89585"},
                                 None, None)

    # -- ended grants are plan mode ---------------------------------------

    def _signed_approval(self, entry, params):
        from dispatch import admission as adm
        rec = adm.mint_approval(entry, params)
        return adm.sign_approval(
            rec, "yes, create that page in Biology exactly as shown",
            channel="educator-chat")

    def test_revoked_grant_asks_for_approval_and_approval_lands(self):
        self._grant()
        mode_state.revoke_edit_grant(self.user, reason="test revoke")
        self.assertEqual(self._agree(), "plan")
        entry, params = _write_entry(), {"course_id": "89585"}
        with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval):
            check_mode_authority(entry, params, None, self._ctx())
        audit, record = check_mode_authority(
            entry, params, self._signed_approval(entry, params), self._ctx())
        self.assertIsNotNone(record, "the signed approval must land")
        self.assertEqual(record["by"], "educator")

    def test_legacy_timed_grant_asks_for_approval_and_approval_lands(self):
        grant = self._grant()
        st = mode_state._load_state(self.user)
        for gg in st["grants"]:
            if gg["grant_id"] == grant["grant_id"]:
                gg["scope_type"] = "timed"
                gg["duration_min"] = 60
                gg["expires_at"] = "2999-01-01T00:00:00+00:00"
        mode_state._save_state(self.user, st)
        self.assertEqual(self._agree(), "plan")
        entry, params = _write_entry(), {"course_id": "89585"}
        with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval):
            check_mode_authority(entry, params, None, self._ctx())
        _audit, record = check_mode_authority(
            entry, params, self._signed_approval(entry, params), self._ctx())
        self.assertIsNotNone(record)

    # -- ambiguous course ------------------------------------------------

    def test_ambiguous_course_refused_then_confirmed_admitted(self):
        self._grant()
        ambiguous = {"course_id": None, "confidence": 0.5,
                     "user_confirmed": False, "query": "Biology 101",
                     "candidates_public": "Biology 101 (Fall), "
                                          "Biology 101 (Spring)"}
        with self.assertRaises(mode_errors.AmbiguousCourseWriteRefused):
            check_mode_authority(_write_entry(), {"course_id": "89585"},
                                 None, self._ctx(
                                     course_resolution=ambiguous))
        confirmed = dict(ambiguous, user_confirmed=True,
                         course_id="89585", confidence=1.0)
        audit, record = check_mode_authority(
            _write_entry(), {"course_id": "89585"}, None,
            self._ctx(course_resolution=confirmed))
        self.assertEqual(audit["mode"], "edit")
        self.assertIsNone(record)

    def test_high_confidence_resolution_admitted(self):
        self._grant()
        resolution = {"course_id": "89585", "confidence": 0.95,
                      "user_confirmed": False, "query": "Biology 101 A"}
        audit, _ = check_mode_authority(
            _write_entry(), {"course_id": "89585"}, None,
            self._ctx(course_resolution=resolution))
        self.assertEqual(audit["mode"], "edit")

    # -- destructive gate -------------------------------------------------

    def _delete_entry(self):
        return _write_entry(name="canvas_wiki_page_delete", method="DELETE")

    def test_destructive_write_needs_confirmation(self):
        # Guardrail is opt-in: with confirm_destructive_writes on,
        # destructive writes in edit mode need explicit confirmation.
        settings.set_setting(self.user, "confirm_destructive_writes", True,
                             educator_confirmed=True)
        self._grant()
        with self.assertRaises(mode_errors.DestructiveConfirmationRequired):
            check_mode_authority(self._delete_entry(),
                                 {"course_id": "89585"}, None, self._ctx())
        # Non-destructive writes are unaffected.
        audit, _ = check_mode_authority(_write_entry(),
                                        {"course_id": "89585"}, None,
                                        self._ctx())
        self.assertEqual(audit["mode"], "edit")

    def test_destructive_write_default_no_confirmation(self):
        # Default (Braden's model): edit mode does not ask per write,
        # including destructive writes.
        self._grant()
        audit, _ = check_mode_authority(self._delete_entry(),
                                        {"course_id": "89585"}, None,
                                        self._ctx())
        self.assertEqual(audit["mode"], "edit")

    def test_destructive_write_confirmed_admitted(self):
        self._grant()
        audit, record = check_mode_authority(
            self._delete_entry(), {"course_id": "89585"}, None,
            self._ctx(destructive_confirmed="yes, delete that page"))
        self.assertEqual(audit["mode"], "edit")
        self.assertIsNone(record)

    def test_destructive_refusal_translates(self):
        settings.set_setting(self.user, "confirm_destructive_writes", True,
                             educator_confirmed=True)
        self._grant()
        try:
            check_mode_authority(self._delete_entry(),
                                 {"course_id": "89585"}, None, self._ctx())
        except mode_errors.DestructiveConfirmationRequired as exc:
            tr = translate("delete the page", exc)
            self.assertEqual("destructive_write_confirmation_required",
                             tr.mode_id)
            self.assertIn("destroys data", tr.agent_message)

    # -- tamper -----------------------------------------------------------

    def test_tampered_grant_file_fails_closed(self):
        self._grant()
        path = mode_state._grants_path(self.user)
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
        state["grants"][0]["expires_at"] = "2999-01-01T00:00:00+00:00"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f)
        with self.assertRaises(mode_errors.ModeSettingsTamper):
            settings.effective_mode(self.user, self.conv)
        with self.assertRaises(mode_errors.ModeSettingsTamper):
            mode_state.current_mode(self.user, self.conv)

    # -- conversation isolation --------------------------------------------

    def test_conversation_bound_grant_does_not_leak(self):
        self._grant(conversation_id=self.conv)
        self.assertEqual(self._agree(), "edit")
        # Another conversation sees plan mode: the grant is bound.
        self.assertEqual(self._agree(conversation_id="other-conv"), "plan")
        decision, code = mode_state.check_write_authority(
            self.user, conversation_id="other-conv")
        self.assertEqual((decision, code),
                         ("defer", "plan_mode_approval_required"))

    def test_end_conversation_revokes_bound_grants(self):
        self._grant(conversation_id=self.conv)
        settings.set_conversation_mode(self.user, self.conv, "plan",
                                       educator_confirmed=True)
        settings.end_conversation(self.user, self.conv)
        self.assertIsNone(settings.get_conversation_mode(self.user,
                                                         self.conv))
        self.assertIsNone(mode_state._live_grant(
            self.user, conversation_id=self.conv))
        self.assertEqual(self._agree(), "plan")

    def test_most_recent_action_wins(self):
        self._grant()
        self.assertEqual(self._agree(), "edit")
        settings.set_conversation_mode(self.user, self.conv, "plan",
                                       educator_confirmed=True)
        self.assertEqual(self._agree(), "plan")
        # And back: a newer grant beats the older override.
        self._grant()
        self.assertEqual(self._agree(), "edit")

    # -- admission honors the same resolver (no grant-alone path) ------
    #
    # Regression: authorize_write used to consult the live grant alone,
    # so a newer conversation "plan" override reported plan in
    # current_mode while admission still admitted the write under the
    # older grant. These tests pin admission to the same
    # most-recent-wins decision as the resolver.

    def test_admission_newer_plan_override_defeats_live_grant(self):
        self._grant(conversation_id=self.conv)
        self.assertEqual(self._agree(), "edit")
        settings.set_conversation_mode(self.user, self.conv, "plan",
                                       educator_confirmed=True)
        self.assertEqual(self._agree(), "plan")
        decision, code, auth = mode_state.authorize_write(
            self.user, conversation_id=self.conv)
        self.assertEqual((decision, code),
                         ("defer", "plan_mode_approval_required"))
        self.assertIsNone(auth)

    def test_admission_newer_grant_defeats_older_plan_override(self):
        settings.set_conversation_mode(self.user, self.conv, "plan",
                                       educator_confirmed=True)
        self.assertEqual(self._agree(), "plan")
        grant = self._grant(conversation_id=self.conv)
        self.assertEqual(self._agree(), "edit")
        decision, code, auth = mode_state.authorize_write(
            self.user, conversation_id=self.conv)
        self.assertEqual((decision, code), ("allow", "ok"))
        self.assertEqual(auth["grant_id"], grant["grant_id"])

    def test_admission_bare_edit_override_admits_with_override_auth(self):
        settings.set_conversation_mode(self.user, self.conv, "edit",
                                       educator_confirmed=True)
        self.assertEqual(self._agree(), "edit")
        decision, code, auth = mode_state.authorize_write(
            self.user, conversation_id=self.conv)
        self.assertEqual((decision, code), ("allow", "ok"))
        self.assertEqual(auth["scope_type"], "conversation_override")
        self.assertIsNone(auth["grant_id"])
        self.assertEqual(auth["conversation_id"], self.conv)

    def test_admission_revoked_grant_defers_to_approval(self):
        grant = self._grant(conversation_id=self.conv)
        mode_state.revoke_edit_grant(self.user, grant_id=grant["grant_id"])
        decision, code, _auth = mode_state.authorize_write(
            self.user, conversation_id=self.conv)
        self.assertEqual((decision, code),
                         ("defer", "plan_mode_approval_required"))

    # -- executor dispatch ----------------------------------------------

    def _dry_run(self, mode_ctx, plan=None):
        from dispatch import executor as ex
        entry = _write_entry()
        session = ex.SessionStore(
            {"canvas": {"base": "https://example.instructure.com"}})
        ctx = dict(mode_ctx)
        ctx.setdefault("course_resolution", {
            "course_id": "89585", "confidence": 1.0, "user_confirmed": True})
        return ex.dispatch_entry(entry, {"course_id": "89585"}, session, {},
                                 plan=plan, dry_run=True, mode_ctx=ctx,
                                 require_educator_channel=False)

    def test_executor_edit_write_needs_no_frozen_plan(self):
        # The full dispatch pipeline (not just the admission gate) must
        # admit an edit-mode write with plan=None: the frozen plan is
        # the plan-mode ceremony's artifact.
        self._grant()
        report = self._dry_run(self._ctx())
        gates = {g["gate"]: g["result"] for g in report["gates"]}
        self.assertEqual(gates["admission"], "pass")

    def test_executor_plan_write_without_approval_refused(self):
        from dispatch import executor as ex
        with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval):
            self._dry_run(self._ctx())

    def test_check_write_gates_legacy_still_needs_frozen_plan(self):
        # Without edit-mode authorization, the frozen plan is still
        # required (legacy plan-mode ceremony intact).
        from dispatch import executor as ex
        with self.assertRaises(ex.MissingFrozenPlan):
            ex._check_write_gates(_write_entry(), {"course_id": "89585"},
                                  None, None, dry_run=True)
        # With edit-mode authorization, plan=None passes the gate.
        ex._check_write_gates(_write_entry(), {"course_id": "89585"},
                              None, None, dry_run=True,
                              plan_not_required=True)

    # -- switch_mode ---------------------------------------------------------

    def test_switch_to_plan_turns_edit_off_everywhere(self):
        settings.set_setting(self.user, "default_mode", "edit",
                             educator_confirmed=True)
        self._grant()
        settings.set_conversation_mode(self.user, "other-conv", "edit",
                                       educator_confirmed=True)
        self.assertEqual(self._agree(), "edit")
        result = mode_state.switch_mode(self.user, "plan",
                                        conversation_id=self.conv)
        self.assertEqual(result["mode"], "plan")
        self.assertEqual(result["revoked_grants"], 1)
        self.assertTrue(result["default_mode_changed"])
        self.assertEqual(settings.get_setting(self.user, "default_mode"),
                         "plan")
        self.assertEqual(self._agree(), "plan")
        self.assertEqual(self._agree(conversation_id="other-conv"), "plan")
        self.assertEqual(self._agree(conversation_id=None), "plan")
        with self.assertRaises(mode_errors.PlanModeWriteWithoutApproval):
            check_mode_authority(_write_entry(), {"course_id": "89585"},
                                 None, self._ctx())

    def test_conversation_override_beats_standing_default(self):
        settings.set_setting(self.user, "default_mode", "edit",
                             educator_confirmed=True)
        settings.set_conversation_mode(self.user, self.conv, "plan",
                                       educator_confirmed=True)
        self.assertEqual(self._agree(), "plan")
        self.assertEqual(self._agree(conversation_id="other-conv"), "edit")


if __name__ == "__main__":
    unittest.main(verbosity=2)
