#!/usr/bin/env python3
"""Governed Moodle dispatch: Plan/Edit/halt behavior and no-replay rules.

Hermetic: no browser, no provider, no live credentials. The transport,
adapter loader, privacy boundary, and admission gate are faked at the
MoodleDispatcher boundary; the executor's real write gates, journal
claim, halt check, approval burn, and outcome journal run against a
tmp_path MORROW_HOME. This pins the remainder the BROWSER-CONTRACT
names as required: Plan/Edit admission, the write halt, approval
single-use, and uncertain-effect no-replay for the new controller in
moodle/dispatch.py.
"""

import json
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dispatch import executor as ex
import dispatch.admission as admission_mod
from dispatch.admission import AdmissionRefused
from moodle import dispatch as md
from moodle.session import MoodleLaneError
from reauth import state_machine as rsm


READ_KEY = 'moodle.read.course_state.v1'
WRITE_KEY = 'moodle.write.forum_post.v1'
ROSTER_KEY = 'moodle.native.participants_table.privacy_roster.v1'
STATE_KEY = 'moodle.ajax.core_courseformat_get_state.v1'
BASE = 'https://lms.example.edu'
DIGEST = 'a' * 64


@pytest.fixture
def hermetic(tmp_path, monkeypatch):
    home = tmp_path / 'home'
    (home / 'journal').mkdir(parents=True)
    (home / 'approvals').mkdir()
    monkeypatch.setenv('MORROW_HOME', str(home))
    monkeypatch.setenv('MORROW_TREE_STATE_DIR', str(home / 'tree'))
    monkeypatch.setattr(ex, 'JOURNAL_PATH', str(home / 'journal' / 'ops.jsonl'))
    monkeypatch.setattr(ex, 'MORROW_HOME', str(home))
    monkeypatch.setattr(ex, 'WRITE_HALT_PATH', str(home / 'write_halt'))
    monkeypatch.setattr(rsm, 'HALT_PATH', str(home / 'write_halt'))
    monkeypatch.setattr(rsm, 'QUAR_PATH', str(home / 'quarantine.jsonl'))
    monkeypatch.setattr(rsm, 'NOTIFY_PATH', str(home / 'notify.txt'))
    monkeypatch.setattr(rsm, 'STATE_PATH', str(home / 'reauth_state.json'))
    monkeypatch.setattr(admission_mod, 'APPROVALS_DIR', str(home / 'approvals'))
    monkeypatch.setattr(admission_mod, 'CONSUMED_PATH',
                        str(home / 'approvals' / 'consumed.json'))
    monkeypatch.delenv('MORROW_APPROVAL_SIGNING_KEY', raising=False)
    yield home


class FakeStaged:
    slot = '"slot-1"'


class FakeCdp:
    def __init__(self, result=None):
        self.result = result if result is not None else {'ok': True}
        self.closed = []

    def evaluate(self, tab, expression, context_id=None, await_promise=False,
                 timeout=None):
        return json.dumps(self.result)

    def close_tab(self, tab):
        self.closed.append(tab)


class FakeTransport:
    def __init__(self, result=None):
        self.base = BASE
        self.principal_id = '42'
        self.cdp = FakeCdp(result)
        self.staged_requests = []

    def _stage_operation(self, loader, operation_key, request):
        self.staged_requests.append((operation_key, request))
        return ('tab-1', 'ctx-1', FakeStaged())


def _operations():
    return {
        READ_KEY: {'toolName': 'moodle_get_course_state', 'readOnly': True,
                   'inputKind': 'operation', 'functionSha256': 'a' * 64},
        WRITE_KEY: {'toolName': 'moodle_create_forum_post', 'readOnly': False,
                    'inputKind': 'operation', 'functionSha256': 'b' * 64},
        ROSTER_KEY: {'toolName': 'moodle_roster', 'readOnly': True,
                     'inputKind': 'roster', 'functionSha256': 'c' * 64},
        STATE_KEY: {'toolName': 'moodle_course_state', 'readOnly': True,
                    'inputKind': 'operation', 'functionSha256': 'd' * 64},
    }


class PassthroughBoundary:
    def invoke(self, tool_name, args, meta, handler):
        return handler(dict(args))


def _binding(course_id):
    return {'sourceBindingId': 'bind-%s' % course_id, 'provider': 'moodle',
            'courseId': str(course_id), 'origin': BASE, 'siteUrl': BASE,
            'principalId': '42', 'principalFingerprint': 'p' * 16,
            'accountFingerprint': 'a' * 16, 'sessionGeneration': 7,
            'catalogDigest': '0' * 64, 'runtimeVerified': True}


@pytest.fixture
def dispatcher(monkeypatch):
    transport = FakeTransport(
        {'ok': True, 'verification': {'status': 'verified'}})
    disp = md.MoodleDispatcher.__new__(md.MoodleDispatcher)
    disp.transport = transport
    disp.registry_sha256 = '0' * 64

    class FakeLoader:
        operations = _operations()
        definitions = {
            WRITE_KEY: {'toolName': 'moodle_create_forum_post', 'readOnly': False,
                        'reviewTool': 'moodle_get_course_state'},
            READ_KEY: {'key': READ_KEY, 'toolName': 'moodle_get_course_state',
                       'readOnly': True, 'inputSchema': {
                           'properties': {'course_id': {}}, 'required': ['course_id']}},
        }

    disp.loader = FakeLoader()
    monkeypatch.setattr(md, 'moodle_source_history_available', lambda name, data_class=None: True)
    monkeypatch.setattr(md.MoodleDispatcher, '_binding',
                        lambda self, course_id: _binding(course_id))
    monkeypatch.setattr(md.MoodleDispatcher, '_boundary',
                        lambda self, binding: PassthroughBoundary())
    monkeypatch.setattr(md.MoodleDispatcher, '_private_read',
                        lambda self, key, args, binding, mode='execute': {
                            'ok': True, 'snapshot_digest': DIGEST,
                            'data': {'id': 7, 'name': 'Bio 101'}})
    monkeypatch.setattr(md.MoodleDispatcher, '_invoke',
                        lambda self, key, request: {
                            'ok': True, 'data': {'id': 7, 'name': 'Bio 101'}})
    return disp


def _plan_mode_admit(monkeypatch, mode='plan'):
    def fake_admit(entry, params, tenant_base=None, approval=None, op_id=None,
                   vault_ready=False, require_educator_channel=True,
                   mode_ctx=None, journal=True):
        if entry['effects'] == 'read':
            return None, None
        if mode_ctx is not None and mode_ctx.get('mode') == 'edit':
            return {'mode': 'edit'}, {'digest': 'signed-edit'}
        if mode == 'edit':
            return {'mode': 'edit'}, {'digest': 'signed-edit'}
        if approval is None:
            raise AdmissionRefused('write needs approval')
        return {'mode': 'plan'}, approval
    monkeypatch.setattr(md.admission, 'admit', fake_admit)
    # Approval seal/consumption is covered by the admission suites; the
    # dispatcher tests pin gating, not the seal. Burn is a no-op here
    # unless a test overrides it with a refusal.
    monkeypatch.setattr(ex, '_burn_write_approval',
                        lambda record, op: None)


def _write_args(course_id=7):
    return {'course_id': course_id, 'expected_digest': DIGEST,
            'subject': 'Week 1 announcement'}


def _frozen_plan(dispatcher, op_id, arguments):
    return dispatcher.plan(WRITE_KEY, arguments, op_id=op_id)


def _pending(op_id):
    return [p for p in ex.journal_pending_ops() if p['op_id'] == op_id]


def test_plan_freezes_target_identity(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())
    assert plan.op_id == op_id
    assert plan.target_identity == {'course_id': 7, 'course_name': 'Bio 101'}
    assert plan.before_state_digest == DIGEST


def test_plan_refuses_read_operations(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    with pytest.raises(ValueError, match='Only Moodle writes'):
        dispatcher.plan(READ_KEY, {'course_id': 7}, op_id=str(uuid.uuid4()))


def test_plan_digest_mismatch_refuses_before_send(hermetic, dispatcher,
                                                 monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())
    changed = _write_args()
    changed['expected_digest'] = 'b' * 64
    monkeypatch.setattr(md.MoodleDispatcher, '_private_read',
                        lambda self, key, args, binding, mode='execute': {
                            'ok': True, 'snapshot_digest': changed['expected_digest'],
                            'data': {'id': 7, 'name': 'Bio 101'}})
    with pytest.raises(ex.MissingFrozenPlan, match='plan digest differs'):
        dispatcher.dispatch(WRITE_KEY, changed, op_id=op_id, plan=plan,
                            approval={'digest': 'signed-plan'})
    assert _pending(op_id) == []
    token = ex.claim_op_id(op_id, 'dispatch', 'reuse-probe', 'write', 'probe')
    ex.release_op_id(op_id, token, 'test cleanup')


def test_target_identity_change_refuses_before_send(hermetic, dispatcher,
                                                   monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())
    monkeypatch.setattr(md.MoodleDispatcher, '_private_read',
                        lambda self, key, args, binding, mode='execute': {
                            'ok': True, 'snapshot_digest': DIGEST,
                            'data': {'id': 7, 'name': 'Renamed'}})
    with pytest.raises(ex.TargetIdentityMismatch):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id, plan=plan,
                            approval={'digest': 'signed-plan'})
    assert _pending(op_id) == []
    token = ex.claim_op_id(op_id, 'dispatch', 'reuse-probe', 'write', 'probe')
    ex.release_op_id(op_id, token, 'test cleanup')


def test_plan_mode_write_without_plan_is_refused(hermetic, dispatcher,
                                                monkeypatch):
    _plan_mode_admit(monkeypatch, mode='plan')
    with pytest.raises(ex.MissingFrozenPlan, match='frozen plan'):
        dispatcher.dispatch(WRITE_KEY, _write_args(),
                            op_id=str(uuid.uuid4()),
                            approval={'digest': 'signed-plan'})


def test_edit_mode_write_without_plan_succeeds(hermetic, dispatcher,
                                              monkeypatch):
    _plan_mode_admit(monkeypatch, mode='edit')
    out = dispatcher.dispatch(WRITE_KEY, _write_args(),
                              op_id=str(uuid.uuid4()),
                              mode_ctx={'mode': 'edit'})
    assert out.get('ok') is True


def test_write_halt_refuses_writes_but_allows_reads(hermetic, dispatcher,
                                                   monkeypatch):
    _plan_mode_admit(monkeypatch, mode='edit')
    (Path(str(hermetic)) / 'write_halt').write_text(
        json.dumps({'halted_at': '2026-10-06T00:00:00Z',
                    'reason': 'synthetic halt', 'cause': 'manual'}))
    with pytest.raises(ex.WriteHaltActive):
        dispatcher.dispatch(WRITE_KEY, _write_args(),
                            op_id=str(uuid.uuid4()),
                            mode_ctx={'mode': 'edit'})
    out = dispatcher.dispatch(READ_KEY, {'course_id': 7},
                              op_id=str(uuid.uuid4()))
    assert out.get('ok') is True


def test_completed_op_id_cannot_replay(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())
    first = dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                                plan=plan,
                                approval={'digest': 'signed-plan'})
    assert first.get('ok') is True
    with pytest.raises(ex.DuplicateOpId):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                            plan=plan, approval={'digest': 'signed-plan'})


def test_provider_exception_after_send_stays_reserved(hermetic, dispatcher,
                                                     monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())

    def boom(tab, expression, context_id=None, await_promise=False,
             timeout=None):
        raise RuntimeError('synthetic provider loss')
    monkeypatch.setattr(dispatcher.transport.cdp, 'evaluate', boom)
    with pytest.raises(RuntimeError, match='synthetic provider loss'):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                            plan=plan, approval={'digest': 'signed-plan'})
    outcome = ex.find_journal_op(op_id)
    assert outcome is not None and outcome.get('uncertain') is True
    assert _pending(op_id) == []
    with pytest.raises(ex.DuplicateOpId):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                            plan=plan, approval={'digest': 'signed-plan'})


def test_presend_refusal_releases_claim_for_retry(hermetic, dispatcher,
                                                 monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())
    calls = {'n': 0}
    real_stage = dispatcher.transport._stage_operation

    def flaky(loader, operation_key, request):
        calls['n'] += 1
        if calls['n'] == 1:
            raise MoodleLaneError('provider', 'synthetic pre-send refusal')
        return real_stage(loader, operation_key, request)
    monkeypatch.setattr(dispatcher.transport, '_stage_operation', flaky)
    with pytest.raises(MoodleLaneError, match='pre-send'):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                            plan=plan, approval={'digest': 'signed-plan'})
    assert _pending(op_id) == []
    out = dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                              plan=plan, approval={'digest': 'signed-plan'})
    assert out.get('ok') is True


def test_read_exception_releases_claim_for_retry(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())

    def interrupted(*args, **kwargs):
        raise RuntimeError('read interrupted after reservation')

    monkeypatch.setattr(dispatcher.transport.cdp, 'evaluate', interrupted)
    with pytest.raises(RuntimeError, match='read interrupted'):
        dispatcher.dispatch(READ_KEY, {'course_id': 7}, op_id=op_id)
    assert _pending(op_id) == []
    assert ex.find_journal_op(op_id) is None
    monkeypatch.setattr(dispatcher.transport.cdp, 'evaluate',
                        lambda *args, **kwargs: json.dumps({'ok': True}))
    assert dispatcher.dispatch(READ_KEY, {'course_id': 7}, op_id=op_id)['ok'] is True


def test_privacy_refusal_after_write_stays_reserved(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())

    class RefusingBoundary:
        def invoke(self, tool_name, args, meta, handler):
            handler(dict(args))
            return {'isError': True}

    monkeypatch.setattr(md.MoodleDispatcher, '_boundary',
                        lambda self, binding: RefusingBoundary())
    result = dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                                 plan=plan, approval={'digest': 'signed-plan'})
    assert result['ok'] is False
    assert ex.find_journal_op(op_id)['uncertain'] is True
    with pytest.raises(ex.DuplicateOpId):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                            plan=plan, approval={'digest': 'signed-plan'})


def test_burn_refusal_releases_claim(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())

    def refused(record, op):
        raise admission_mod.ApprovalMismatch('synthetic approval race')
    monkeypatch.setattr(ex, '_burn_write_approval', refused)
    with pytest.raises(admission_mod.ApprovalMismatch):
        dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                            plan=plan, approval={'digest': 'signed-plan'})
    assert _pending(op_id) == []
    token = ex.claim_op_id(op_id, 'dispatch', 'reuse-probe', 'write', 'probe')
    ex.release_op_id(op_id, token, 'test cleanup')


def test_unverified_write_is_not_success(hermetic, dispatcher, monkeypatch):
    _plan_mode_admit(monkeypatch)
    op_id = str(uuid.uuid4())
    plan = _frozen_plan(dispatcher, op_id, _write_args())
    dispatcher.transport.cdp.result = {'ok': True,
                                       'verification': {'status': 'mismatch'}}
    out = dispatcher.dispatch(WRITE_KEY, _write_args(), op_id=op_id,
                              plan=plan, approval={'digest': 'signed-plan'})
    assert out.get('ok') is False


def test_descriptor_rejects_bad_course_and_missing_digest(hermetic,
                                                         dispatcher):
    with pytest.raises(ValueError, match='exact integer'):
        dispatcher.descriptor(WRITE_KEY, {'course_id': '7',
                                          'expected_digest': DIGEST})
    with pytest.raises(ValueError, match='fresh provider digest'):
        dispatcher.descriptor(WRITE_KEY, {'course_id': 7})
    with pytest.raises(ValueError, match='Unknown public Moodle'):
        dispatcher.descriptor('moodle.nope.v1', {'course_id': 7})
