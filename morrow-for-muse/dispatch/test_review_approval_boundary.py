"""Public Chromium approval boundary with a synthetic provider and clock."""
import contextlib
import datetime
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

from dispatch import admission

from dispatch import executor as ex
from dispatch.test_direct_lane_hardening import hermetic, _pack
from dispatch.test_round4_write_ceremony import hermetic_keys
from dispatch.test_chromium_presend_refusals import reauth_home, USER, CONV, BASE, TEACHER, _session
from settings import store
import pytest


@pytest.mark.parametrize("phase", ["discovery", "course", "principal", "at-boundary", "rollback", "lock", "timely", "retry", "batch"])
def test_expiry_during_provider_precheck_refuses_the_write(monkeypatch, phase):
    store.set_setting(USER, "default_mode", "plan", educator_confirmed=True)
    real_datetime = datetime.datetime
    clock = {"now": real_datetime.now(datetime.timezone.utc), "armed": False}
    class ControlledDateTime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"] if tz is not None else clock["now"].replace(tzinfo=None)
    monkeypatch.setattr(datetime, "datetime", ControlledDateTime)
    class Tab:
        def __init__(self):
            self.calls = []
            self.page = {"url": "week-1", "title": "Old", "body": "<p>Lesson</p>", "published": True}
        def api(self, method, path, data=None, as_json=False, timeout=60, max_bytes=None):
            self.calls.append((method,path,clock["now"].isoformat()))
            bare=path.split("?")[0]
            if bare == "/api/v1/users/self":
                if clock.get("final_principal"):
                    clock["now"] += datetime.timedelta(seconds=2)
                    clock["final_principal"] = False
                result={"id":TEACHER,"name":"Synthetic teacher"}
            elif bare.endswith(("/users","/enrollments")):
                if phase == "discovery" and clock["armed"]:
                    clock["now"] += datetime.timedelta(seconds=2)
                    clock["armed"] = False
                result=[]
            elif bare == "/api/v1/courses/101":
                if clock["armed"]:
                    if phase in ("course", "batch"): clock["now"] += datetime.timedelta(seconds=2)
                    elif phase == "at-boundary": clock["now"] += datetime.timedelta(seconds=1)
                    elif phase == "rollback": clock["now"] -= datetime.timedelta(seconds=120)
                    elif phase == "principal": clock["final_principal"] = True
                    clock["armed"] = False
                result={"id":101,"name":"Bio 101"}
            elif bare.endswith("/pages/week-1"):
                if method=="PUT":
                    if phase == "retry" and not clock.get("retried"):
                        clock["retried"] = True
                        clock["now"] += datetime.timedelta(seconds=2)
                        raise ConnectionRefusedError("synthetic connection refused before send")
                    self.page.update((data or {}).get("wiki_page",{}))
                result=self.page
            else: raise AssertionError((method,path))
            return 200,{},json.dumps(result)
    tab=Tab(); session=_session(tab)
    csm=ex._chromium_session_mod()
    monkeypatch.setattr(csm.ChromiumSession,"load",classmethod(lambda cls,base_url=None:session))
    display=io.StringIO()
    with contextlib.redirect_stdout(display):
        status=ex.main(["plan-write","--name","canvas_update_create_page_courses","--method","PUT","--path","/api/v1/courses/{course_id}/pages/{url_or_id}","--params",json.dumps({"course_id":"101","url_or_id":"week-1"}),"--body",json.dumps({"wiki_page":{"title":"New"}}),"--backend","chromium","--user-id",USER,"--conversation-id",CONV])
    assert status == 0, display.getvalue()
    prepared=json.loads(display.getvalue())
    assert (real_datetime.fromisoformat(prepared["expires_at"])-clock["now"]).total_seconds()==3600
    clock["now"]=real_datetime.fromisoformat(prepared["expires_at"])-datetime.timedelta(seconds=1)
    clock["armed"]=True
    if phase == "batch":
        from reauth import state_machine as rsm
        rsm.quarantine_op(prepared["op_id"], "canvas_update_create_page_courses", "Synthetic reviewed title")
        assert rsm.mark_ops_awaiting_approval() == 1
        assert rsm.approve_all_awaiting("Yes, reapprove these reviewed changes") == [prepared["op_id"]]
        assert rsm.op_quarantine_status(prepared["op_id"]) == "approved"
    if phase == "lock":
        real_flock = admission.fcntl.flock
        def delayed_flock(fd, operation):
            real_flock(fd, operation)
            lock = Path(admission.CONSUMED_PATH + ".lock")
            if operation == admission.fcntl.LOCK_EX and lock.exists():
                held = os.fstat(fd)
                target = lock.stat()
                if (held.st_dev, held.st_ino) == (target.st_dev, target.st_ino):
                    clock["consumption_lock_checked"] = True
                    clock["now"] += datetime.timedelta(seconds=2)
        monkeypatch.setattr(admission.fcntl, "flock", delayed_flock)
    monkeypatch.setattr(ex, "_backoff_sleep", lambda *args: None)
    output=io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            status=ex.main(["approve-write","--op-id",prepared["op_id"],"--authorization","Yes","--backend","chromium","--user-id",USER,"--conversation-id",CONV])
        except Exception as error:
            status=2;output.write(type(error).__name__+":"+str(error))
    writes=[call for call in tab.calls if call[0]=="PUT"]
    evidence={"expires_at":prepared["expires_at"],"now":clock["now"].isoformat(),"writes":writes,"status":status,"output":output.getvalue()}
    if phase in ("timely", "retry"):
        assert status==0 and len(writes)==(2 if phase == "retry" else 1),evidence
        assert json.loads(output.getvalue())["outcome"]=="verified"
    else:
        assert not writes,evidence
        if phase == "lock":
            assert clock.get("consumption_lock_checked"), evidence
        assert status != 0,evidence
        assert ("clock" if phase=="rollback" else "expired") in output.getvalue().lower(),evidence
        assert ex.journal_pending_ops()==[],evidence
        assert not list((Path(ex._approvals_dir())).glob(prepared["op_id"]+'.json'))
        if phase == "course":
            # A failed first dispatch retains no uncertain reservation; a freshly
            # reviewed operation can be approved while the old grant stays expired.
            refreshed = io.StringIO()
            with contextlib.redirect_stdout(refreshed):
                next_status = ex.main(["plan-write", "--name", "canvas_update_create_page_courses", "--method", "PUT", "--path", "/api/v1/courses/{course_id}/pages/{url_or_id}", "--params", json.dumps({"course_id": "101", "url_or_id": "week-1"}), "--body", json.dumps({"wiki_page": {"title": "New"}}), "--backend", "chromium", "--user-id", USER, "--conversation-id", CONV])
            assert next_status == 0, refreshed.getvalue()
            replacement = json.loads(refreshed.getvalue())
            assert replacement["op_id"] != prepared["op_id"]
            accepted = io.StringIO()
            with contextlib.redirect_stdout(accepted):
                next_status = ex.main(["approve-write", "--op-id", replacement["op_id"], "--authorization", "Yes", "--backend", "chromium", "--user-id", USER, "--conversation-id", CONV])
            assert next_status == 0 and json.loads(accepted.getvalue())["outcome"] == "verified", accepted.getvalue()
            assert len([call for call in tab.calls if call[0] == "PUT"]) == 1



@pytest.mark.parametrize("lane", ["canvas", "sdk"])
@pytest.mark.parametrize("timely", [False, True])
def test_actual_transport_commits_after_world_or_credential_preparation(monkeypatch, lane, timely):
    from dispatch.test_approval_single_use import _signed, RENAMED
    from transport import local_chromium, item_bank_sdk
    import uuid
    real_datetime = datetime.datetime
    clock = {"now": real_datetime.now(datetime.timezone.utc)}
    class ControlledDateTime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"] if tz is not None else clock["now"].replace(tzinfo=None)
    monkeypatch.setattr(datetime, "datetime", ControlledDateTime)
    record = _signed(RENAMED)
    expiry = real_datetime.fromisoformat(record["expires_at"])
    clock["now"] = expiry - datetime.timedelta(seconds=1)
    sends = []
    class Cdp:
        def evaluate(self, *args, **kwargs):
            sends.append(clock["now"])
            return json.dumps({"status": 200, "headers": {}, "body": "{}"}) if lane == "canvas" else {"ok": True, "status": 200, "body": "{}"}
        def create_isolated_world(self, *args):
            if not timely:
                clock["now"] += datetime.timedelta(seconds=2)
            return 73
    cdp = Cdp()
    if lane == "canvas":
        transport = local_chromium.LocalChromiumTransport(BASE, SimpleNamespace(cdp=cdp))
        transport._tenant_tab = lambda: {"id": "synthetic"}
        send = lambda: transport.api("PUT", "/api/v1/courses/101/pages/week-1")
    else:
        transport = item_bank_sdk.ItemBankSdk(cdp, BASE, 101)
        def launch():
            if not timely:
                clock["now"] += datetime.timedelta(seconds=2)
            transport._context_id = 73
            transport._token = "synthetic-credential"
            transport._api_origin = "https://synthetic.quiz-api-1.instructure.com"
            transport._tab = {"id": "synthetic"}
            transport._launched = True
        transport.launch = launch
        transport._get_tab = lambda: transport._tab
        send = lambda: transport.request("POST", "/api/banks/123/items", {}, course_id=101)
    session = SimpleNamespace(defers_write_approval=True)
    with ex._write_approval_boundary(session):
        ex._burn_write_approval(record, str(uuid.uuid4()))
        assert not admission.approval_used(record)
        if timely:
            send()
            assert len(sends) == 1 and admission.approval_used(record)
            # The first attempt grants the documented lease for this operation.
            clock["now"] = expiry + datetime.timedelta(seconds=5)
            send()
            assert len(sends) == 2
        else:
            with pytest.raises(ex.WriteNotAttempted, match="expired"):
                send()
            assert not sends and not admission.approval_used(record)
    # A new operation cannot inherit that lease or reuse the original grant.
    with ex._write_approval_boundary(session):
        ex._burn_write_approval(record, str(uuid.uuid4()))
        with pytest.raises(ex.WriteNotAttempted):
            send()
    assert len(sends) == (2 if timely else 0)
