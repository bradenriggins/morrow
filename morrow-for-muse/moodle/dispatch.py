"""Governed execution of pinned Moodle adapters in the owner's Chromium."""
import hashlib
import json
import re
import time
from urllib.parse import urlsplit

from dispatch import admission
from dispatch import executor
from moodle.browser_operations import MoodleAdapterLoader
from moodle.session import MoodleLaneError
from privacy.boundary import SourceMcpPrivacyBoundary, moodle_source_history_available
from privacy.executor_wire import _source_vault_path


_ROSTER = 'moodle.native.participants_table.privacy_roster.v1'
_STATE = 'moodle.ajax.core_courseformat_get_state.v1'


def _freeze(value):
    return json.loads(json.dumps(value, allow_nan=False, ensure_ascii=False))


def _digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


class MoodleDispatcher:
    def __init__(self, transport, assets, *, registry_sha256):
        self.transport = transport
        self.loader = MoodleAdapterLoader(assets, registry_sha256=registry_sha256)
        self.registry_sha256 = registry_sha256

    def descriptor(self, operation_key, arguments):
        route = self.loader.operations.get(operation_key)
        if route is None or route['inputKind'] != 'operation':
            raise ValueError('Unknown public Moodle operation')
        arguments = _freeze(arguments)
        if not isinstance(arguments, dict):
            raise ValueError('Moodle arguments must be an object')
        cid = arguments.get('course_id')
        if cid is not None and (type(cid) is not int or not 1 <= cid <= 9007199254740991):
            raise ValueError('Moodle course ID must be an exact integer')
        if not route['readOnly'] and not re.fullmatch(r'[a-f0-9]{64}', str(arguments.get('expected_digest', ''))):
            raise ValueError('Moodle writes need a fresh provider digest')
        return {'name': route['toolName'], 'provider': 'moodle',
                'effects': 'read' if route['readOnly'] else 'write',
                'request': {'method': 'GET' if route['readOnly'] else 'POST',
                            'url': self.transport.base + '/course/view.php',
                            'body': {'operation_key': operation_key,
                                     'registry_sha256': self.registry_sha256,
                                     'function_sha256': route['functionSha256'],
                                     'site': self.transport.base,
                                     'principal_id': self.transport.principal_id,
                                     'arguments_json': json.dumps(arguments, sort_keys=True, ensure_ascii=False),
                                     'privacy': 'morrow.source-roster-v1'}}}

    def _binding(self, course_id):
        identity = self.transport.operation_identity()
        if identity.get('id') != self.transport.principal_id or identity.get('site_url') != self.transport.base:
            raise MoodleLaneError('principal', 'Moodle paired account changed')
        generation = identity.get('session_generation')
        if type(generation) is not int or not 1 <= generation <= 9007199254740991:
            raise MoodleLaneError('principal', 'Moodle session could not be verified')
        parsed = urlsplit(self.transport.base)
        account = _digest(self.transport.base + '\n' + identity['id'])
        return {'sourceBindingId': 'moodle-' + _digest(account + ':' + str(course_id)),
                'provider': 'moodle', 'courseId': str(course_id),
                'origin': parsed.scheme + '://' + parsed.netloc,
                'siteUrl': self.transport.base, 'principalId': identity['id'],
                'principalFingerprint': _digest(identity['id']),
                'accountFingerprint': account, 'sessionGeneration': generation,
                'catalogDigest': self.registry_sha256, 'runtimeVerified': True}

    def _request(self, key, arguments, binding, *, mode='execute'):
        route = self.loader.operations[key]
        request = {'mode': mode,
                   'operation': {'key': key, 'toolName': route['toolName'],
                                 'provider': 'moodle', 'readOnly': route['readOnly']},
                   'binding': binding, 'arguments': arguments,
                   'expiresAt': int(time.time() * 1000) + 60000}
        if mode == 'check_course' or route['inputKind'] == 'roster':
            request['courseId'] = binding['courseId']
        return request

    def _invoke(self, key, request):
        tab, context, staged = self.transport._stage_operation(self.loader, key, request)
        try:
            slot = json.dumps(staged.slot)
            expression = '(async () => {const s = globalThis[%s]; if (!s || location.href !== s.href) throw new Error("moodle_context_changed"); return JSON.stringify(await s.fn(s.input));})()' % slot
            raw = self.transport.cdp.evaluate(tab, expression, context_id=context,
                                              await_promise=True, timeout=90)
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError('Moodle result is not an object')
            return result
        finally:
            try:
                self.transport.cdp.close_tab(tab)
            except Exception:
                pass

    def _boundary(self, binding):
        def roster(current):
            request = self._request(_ROSTER, {'course_id': int(current['courseId'])}, current)
            result = self._invoke(_ROSTER, request)
            if result.get('complete') is not True or result.get('status') != 'complete':
                raise ValueError('Moodle roster is incomplete')
            return result['identities']

        return SourceMcpPrivacyBoundary({
            'source': 'moodle', 'learner_vault_path': _source_vault_path(),
            'bindings': lambda: [self._binding(int(binding['courseId']))],
            'load_roster': roster,
        })

    def _private_read(self, key, arguments, binding, *, mode='execute'):
        boundary = self._boundary(binding)
        return boundary.invoke(self.loader.operations[key]['toolName'],
            {**arguments, '_morrow': {'source_binding_id': binding['sourceBindingId']}}, {},
            lambda resolved: self._invoke(key, self._request(key,
                {k: v for k, v in resolved.items() if k != '_morrow'}, binding, mode=mode)))

    def plan(self, operation_key, arguments, *, op_id):
        arguments = _freeze(arguments)
        entry = self.descriptor(operation_key, arguments)
        if entry['effects'] != 'write':
            raise ValueError('Only Moodle writes need a frozen plan')
        binding = self._binding(arguments.get('course_id'))
        identity = self._private_read(_STATE, {'course_id': arguments['course_id']}, binding, mode='check_course')
        if identity.get('ok') is not True:
            raise MoodleLaneError('provider', 'Moodle course target could not be verified')
        subject = admission.request_subject(entry, arguments)
        data = identity['data']
        return executor.FrozenPlan({'op_id': op_id, 'entry_name': entry['name'],
            'params': arguments, 'before_state_digest': arguments['expected_digest'],
            'frozen_readback': {'course_id': data['id'], 'course_name': data['name']},
            'target_identity': {'course_id': data['id'], 'course_name': data['name']},
            'request': subject, 'request_digest': admission.request_digest(subject)}, '<Moodle browser plan>')

    def dispatch(self, operation_key, arguments, *, op_id, plan=None, approval=None,
                 mode_ctx=None, require_educator_channel=True):
        arguments = _freeze(arguments)
        entry = self.descriptor(operation_key, arguments)
        is_write = entry['effects'] == 'write'
        if not moodle_source_history_available(entry['name']):
            raise MoodleLaneError('privacy', 'Moodle historical learner data is not proven by the current roster')
        audit, signed = admission.admit(entry, arguments, tenant_base=self.transport.base,
            approval=approval, op_id=op_id, vault_ready=True,
            mode_ctx=mode_ctx, require_educator_channel=require_educator_channel)
        binding = self._binding(arguments.get('course_id'))
        state = {'claim': None, 'started': False}
        boundary = self._boundary(binding)

        def invoke(resolved):
            params = {k: v for k, v in resolved.items() if k != '_morrow'}
            if is_write and plan is not None:
                if plan.before_state_digest != arguments.get('expected_digest'):
                    raise executor.MissingFrozenPlan('Moodle plan digest differs from the approved arguments')
                identity = self._invoke(_STATE, self._request(_STATE,
                    {'course_id': arguments['course_id']}, binding, mode='check_course'))
                if (identity.get('ok') is not True or
                        str(identity['data']['id']) != str(plan.target_identity.get('course_id')) or
                        identity['data']['name'] != plan.target_identity.get('course_name')):
                    raise executor.TargetIdentityMismatch('Moodle course target changed after the plan')
            tab, context, staged = self.transport._stage_operation(self.loader, operation_key,
                self._request(operation_key, params, binding))
            try:
                admission.admit(entry, arguments, tenant_base=self.transport.base,
                    approval=approval, op_id=op_id, vault_ready=True,
                    mode_ctx=mode_ctx, require_educator_channel=require_educator_channel,
                    journal=False)
                _, state['claim'] = executor._check_write_gates(entry, arguments, plan, op_id,
                    plan_not_required=bool(is_write and audit and audit.get('mode') == 'edit'))
                if is_write:
                    try:
                        executor._burn_write_approval(signed, op_id)
                    except Exception:
                        executor.release_op_id(op_id, state['claim'], 'Approval refused; nothing dispatched')
                        state['claim'] = None
                        raise
                state['started'] = True
                slot = json.dumps(staged.slot)
                expression = '(async () => {const s = globalThis[%s]; if (!s || location.href !== s.href) throw new Error("moodle_context_changed"); return JSON.stringify(await s.fn(s.input));})()' % slot
                raw = self.transport.cdp.evaluate(tab, expression, context_id=context,
                    await_promise=True, timeout=90)
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ValueError('Moodle result is not an object')
                return result
            finally:
                try:
                    self.transport.cdp.close_tab(tab)
                except Exception:
                    pass

        result = boundary.invoke(entry['name'],
            {**arguments, '_morrow': {'source_binding_id': binding['sourceBindingId']}}, {}, invoke)
        if result.get('isError'):
            result = {'ok': False, 'error': 'moodle_execution_or_privacy_unconfirmed'}
        verified = result.get('ok') is True and (not is_write or
            (result.get('verification') or {}).get('status') == 'verified')
        if is_write and not verified:
            result['ok'] = False
        if state['claim']:
            uncertain = bool(is_write and state['started'] and not verified and result.get('sent') is not False)
            executor.journal_claimed_outcome(op_id, {'op_id': str(op_id),
                'kind': 'dispatch', 'entry_name': entry['name'], 'effects': entry['effects'],
                'params_digest': executor.digest_of(arguments), 'receipt': result,
                'verification': 'verified' if verified else 'unconfirmed' if uncertain else 'refused',
                'uncertain': uncertain}, state['claim'])
        return result
