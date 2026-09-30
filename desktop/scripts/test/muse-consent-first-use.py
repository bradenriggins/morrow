"""Read-only product probe. Synthetic failure cases, defined before probe:
1 action denial/uncertainty signed then full fake dispatch;
2 identity denial/uncertainty signed then admission;
3 edit denial/uncertainty grants write authority without per-op approval;
4 quarantine denial/uncertainty unlocks actual fake redispatch.
No provider network. All state redirected before product imports.
"""
import contextlib, io, json, os, pathlib, sys, tempfile, uuid
TREE = pathlib.Path(__file__).resolve().parents[3] / 'morrow-for-muse'
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='morrow-consent-first-use-'))
os.environ.update(HOME=str(ROOT), MORROW_HOME=str(ROOT / '.morrow'), MORROW_HELPER_ENV_FILE=str(ROOT / 'empty-helper-env'))
for key in ('MORROW_TREE_STATE_DIR','MORROW_SOURCE_VAULT_PATH','MORROW_APPROVAL_SIGNING_KEY','MORROW_USER_ID','MORROW_CONVERSATION_ID','LOGIN_HELPER_PROFILE_DIR','LOGIN_HELPER_PORT','LOGIN_HELPER_CDP_PORT'):
    os.environ.pop(key, None)
sys.path.insert(0, str(TREE))
import pytest
from dispatch import admission as adm
from dispatch import test_round4_write_ceremony as fixture
from dispatch.test_direct_lane_hardening import hermetic, FakeSession, _pack
from modes import state as modes
from reauth import state_machine as rsm
from transport import state as lane
results = []
def snapshot(home):
    import hashlib
    return {str(file.relative_to(home)): hashlib.sha256(file.read_bytes()).hexdigest() for file in home.rglob('*') if file.is_file()}

@contextlib.contextmanager
def rig(label):
    root=ROOT / label; root.mkdir()
    with pytest.MonkeyPatch.context() as mp:
        gen=hermetic.__wrapped__(root, mp); home=next(gen)
        mp.setattr(adm, 'SECRETS_DIR', str(home/'secrets'))
        mp.setattr(adm, 'SIGNING_KEY_PATH', str(home/'secrets'/'approval-signing.key'))
        mp.setattr(rsm, 'STORE_DIR', str(home))
        for name in ('STATE_PATH','HALT_PATH','QUAR_PATH','NOTIFY_PATH','APPROVAL_PATH','SESSION_PATH','SESSION_PREV','LAST_DEATH_PATH','SESSION_PREV_MONO'):
            mp.setattr(rsm, name, str(home/pathlib.Path(getattr(rsm,name)).name))
        mp.setattr(lane, 'STATE_PATH', str(home/'browser_lane.json'))
        try: yield home
        finally:
            try: next(gen)
            except StopIteration: pass
for index, words in enumerate(('no', 'not mine', 'not sure', 'maybe', 'cancel', ' NO ', 'No, thank you.', 'I am not sure', "I don't approve", 'Yes', 'ok', 'Yes, go ahead.', 'Use edit mode for this conversation', 'Ada')):
    for kind in ('action','action_cli','action_driver','identity','mode','quarantine'):
        label=f'{index}-{kind}'
        out={'path':kind, 'reply':words}
        denied=index < 9
        with rig(label) as home:
            before_state=snapshot(home)
            try:
                entry=fixture._entry(fixture.APPROVED_BODY)
                params=dict(fixture.PARAMS)
                if kind=='action_cli':
                    session=FakeSession(fixture._canvas())
                    with pytest.MonkeyPatch.context() as cli_mp:
                        fixture._fake_store(cli_mp, session)
                        plan_code, plan_text=fixture._cli(fixture._plan_write_argv(fixture.APPROVED_BODY))
                        assert plan_code==0, plan_text
                        prepared=json.loads(plan_text)
                        code, result=fixture._cli(['approve-write','--op-id',prepared['op_id'],'--authorization',words,'--backend','https','--user-id',fixture.USER,'--conversation-id',fixture.CONV])
                    out.update(cli_code=code, fake_write_count=len(fixture._writes(session)), result=json.loads(result) if code==0 else result)
                elif kind=='identity':
                    token='lrn_'+'a'*20
                    params['student']=token
                    rec=adm.mint_approval(entry, params, fixture.BASE, target_identity=fixture.TARGET)
                    signed=adm.sign_approval(rec, 'Yes', channel='educator-chat', resolved_identities=[{'token':token,'displayed_as':'Ada'}], identity_authorization=words)
                    audit, record=adm.admit(entry, params, fixture.BASE, signed, str(uuid.uuid4()))
                    out.update(admitted=record is not None, resolution_authority=record['resolution_authority'], identity_authorization=record['identity_authorization'])
                elif kind=='mode':
                    user='consent:test'; conv='synthetic-conversation'
                    grant=modes.request_edit_grant(user, educator_confirmation={'by':'educator','authorization':words,'channel':'educator-chat'}, conversation_id=conv)
                    ctx={'user_id':user,'conversation_id':conv,'course_resolution':{'course_id':'101','confidence':1.0,'user_confirmed':True}}
                    audit, record=adm.admit(entry, params, fixture.BASE, approval=None, op_id=str(uuid.uuid4()), mode_ctx=ctx)
                    out.update(mode=modes.current_mode(user,conv), admitted_without_per_op_approval=record is None and audit['mode']=='edit', grant_id=grant['grant_id'], authorization=audit['authorization'])
                else:
                    op_id=str(uuid.uuid4())
                    if kind=='quarantine':
                        lane.save(fixture.BASE,777,'Synthetic Educator')
                        rsm.impose_halt({'signal':'synthetic'})
                        rsm.quarantine_op(op_id,fixture.NAME,'synthetic paused operation')
                        with contextlib.redirect_stdout(io.StringIO()):
                            out['resumed_count']=rsm.verified_resume_after_manual_signin(777,'Synthetic Educator')
                        out['before']=rsm.op_quarantine_status(op_id)
                        before_ledger=pathlib.Path(rsm.QUAR_PATH).read_bytes()
                        before_state=snapshot(home)
                        before_session=FakeSession(fixture._canvas())
                        try:
                            fixture.ex.dispatch_catalog_op(fixture.NAME,fixture.METHOD,fixture.PATH,'write',params,plan=fixture._plan(home,op_id),op_id=op_id,extra={'body':fixture.APPROVED_BODY},approval=fixture._signed(fixture.APPROVED_BODY,'Yes'),session=before_session,pack=_pack())
                            out['before_refused']=False
                        except fixture.ex.WriteHaltActive:
                            out['before_refused']=True
                            out['before_fake_write_count']=len(fixture._writes(before_session))
                        before_state=snapshot(home)
                        out['approve_return']=rsm.approve_op(op_id, words)
                        out['after']=rsm.op_quarantine_status(op_id)
                    session=FakeSession(fixture._canvas())
                    if kind=='action_driver':
                        signed=adm.sign_approval(adm.mint_approval(entry, params, fixture.BASE, target_identity=fixture.TARGET), words, channel='driver')
                    else:
                        signed=fixture._signed(fixture.APPROVED_BODY, words if kind=='action' else 'Yes')
                    outcome=fixture.ex.dispatch_catalog_op(fixture.NAME,fixture.METHOD,fixture.PATH,'write',params, plan=fixture._plan(home,op_id),op_id=op_id,extra={'body':fixture.APPROVED_BODY},approval=signed,session=session,pack=_pack())
                    out.update(outcome=outcome['outcome'], fake_write_count=len(fixture._writes(session)))
            except Exception as exc:
                out.update(refused=type(exc).__name__, error=str(exc))
                if kind=='quarantine':
                    out['quarantine_unchanged']=pathlib.Path(rsm.QUAR_PATH).read_bytes()==before_ledger
                    out['after']=rsm.op_quarantine_status(op_id)
            out['state_unchanged']=snapshot(home)==before_state
        if kind=='action_cli':
            passed = out.get('cli_code', 0) != 0 and out.get('fake_write_count') == 0 if denied else out.get('cli_code') == 0 and out.get('fake_write_count') == 1
        elif kind=='action_driver':
            passed = 'refused' in out and out.get('fake_write_count', 0)==0
        elif denied:
            passed = 'refused' in out and out['state_unchanged']
            if kind=='quarantine': passed = passed and out.get('quarantine_unchanged') and out.get('after')=='awaiting_approval'
        elif kind=='identity': passed = out.get('admitted') is True
        elif kind=='mode': passed = out.get('admitted_without_per_op_approval') is True
        else: passed = out.get('outcome')=='verified' and out.get('fake_write_count')==1
        out['passed']=bool(passed)
        results.append(out)
receipt={'schema':'morrow.muse-consent-first-use.v1','scratch':str(ROOT),'real':'production approval, CLI, admission, mode grant and quarantine paths','injected':'synthetic Canvas provider and isolated state','passed':sum(item['passed'] for item in results),'failed':sum(not item['passed'] for item in results),'results':results}
encoded=json.dumps(receipt, indent=2)+'\n'
if len(sys.argv)>1: pathlib.Path(sys.argv[1]).write_text(encoded)
print(encoded)
raise SystemExit(0 if receipt['failed']==0 else 1)
