"""Input failure cases, specified before implementation.

A platform round trip per key makes sign-in slow. Concurrent down/up loses
ordering. A timeout retry can type twice; a partial CDP failure is ambiguous.
A helper restart must reject pending old input. Malformed later operations
must not apply earlier text. Memory must stay bounded and retain no raw text.
Text must support Unicode/paste/IME, while control keys stay ordered.
"""
import importlib.util
import os
import sys
import threading

import pytest

HERE = os.path.dirname(__file__)
TREE = os.path.dirname(HERE)
for path in (TREE, os.path.join(TREE, 'transport'), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)


def module():
    import config.selftest_home  # noqa: F401
    spec = importlib.util.spec_from_file_location('helper_batch_test', os.path.join(HERE, 'server.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def payload(manager, seq=1, operations=None, stream='a' * 32):
    return {'epoch': manager.epoch, 'stream_id': stream, 'sequence': seq,
            'operations': operations or [{'type': 'text', 'text': 'dummy-é漢字'}]}


def test_ordered_text_and_control_keys():
    server = module()
    manager = server.InputBatches()
    seen = []
    body = payload(manager, operations=[{'type': 'text', 'text': 'dummy'},
        {'type': 'key', 'key': 'Tab', 'code': 'Tab', 'keyCode': 9, 'modifiers': 0},
        {'type': 'text', 'text': '漢字'}])
    assert manager.run(body, seen.extend) == {'ok': True, 'sequence': 1, 'replayed': False}
    assert seen == body['operations']
    assert manager.run(body, seen.extend)['replayed'] is True
    assert len(seen) == 3
    assert 'dummy' not in repr(manager.__dict__)


def test_replay_conflict_stale_sequence_and_gap_refuse():
    server = module()
    manager = server.InputBatches()
    seen = []
    manager.run(payload(manager), seen.extend)
    for bad in (payload(manager, operations=[{'type': 'text', 'text': 'different'}]),
                payload(manager, seq=3)):
        with pytest.raises(server._HttpError):
            manager.run(bad, seen.extend)
    manager.run(payload(manager, seq=2), seen.extend)
    with pytest.raises(server._HttpError):
        manager.run(payload(manager), seen.extend)
    assert len(seen) == 2


def test_restart_refuses_old_input():
    server = module()
    first, second = server.InputBatches(), server.InputBatches()
    assert first.epoch != second.epoch
    with pytest.raises(server._HttpError):
        second.run(payload(first), lambda operations: pytest.fail('old input applied'))


def test_partial_failure_never_retries_or_advances():
    server = module()
    manager = server.InputBatches()
    seen = []
    def fail(operations):
        seen.extend(operations)
        raise RuntimeError('no credential-bearing error details should escape')
    with pytest.raises(server._HttpError) as error:
        manager.run(payload(manager), fail)
    assert error.value.message == 'input outcome unknown; refresh before typing again'
    for body in (payload(manager), payload(manager, seq=2)):
        with pytest.raises(server._HttpError):
            manager.run(body, seen.extend)
    assert len(seen) == 1


@pytest.mark.parametrize('change', [
    {'operations': []}, {'operations': [{'type': 'text', 'text': ''}]},
    {'operations': [{'type': 'text', 'text': 'x' * 4097}]},
    {'operations': [{'type': 'text', 'text': '\ud800'}]},
    {'operations': [{'type': 'text', 'text': 'ok'}, {'type': 'evaluate', 'expression': 'bad'}]},
    {'operations': [{'type': 'key', 'key': 'Tab', 'code': 'Tab', 'keyCode': 9, 'modifiers': True}]},
    {'operations': [{'type': 'text', 'text': 'ok'}] * 33},
    {'sequence': True}, {'stream_id': '../wrong'}, {'unknown': 'value'},
])
def test_invalid_batch_applies_nothing(change):
    server = module()
    manager = server.InputBatches()
    body = payload(manager)
    body.update(change)
    with pytest.raises(server._HttpError):
        manager.run(body, lambda operations: pytest.fail('invalid input applied'))
    assert not manager.streams


def test_stream_capacity_refuses_without_evicting_replay_guard():
    server = module()
    manager = server.InputBatches()
    for n in range(32):
        manager.run(payload(manager, stream=f'{n:032x}'), lambda operations: None)
    with pytest.raises(server._HttpError):
        manager.run(payload(manager, stream='f' * 32), lambda operations: pytest.fail('over cap'))
    assert len(manager.streams) == 32
    assert manager.run(payload(manager, stream='0' * 32), lambda operations: pytest.fail('duplicate'))['replayed']


def test_browser_inserts_text_once_and_pairs_control_key():
    server = module()
    browser = server.HelperBrowser.__new__(server.HelperBrowser)
    browser._lock = threading.Lock()
    browser.tab = {'id': 'isolated'}
    calls = []
    class CDP:
        def call(self, tab, method, params, timeout):
            calls.append((method, params))
    browser.cdp = CDP()
    browser.input_batch([{'type': 'text', 'text': 'dummy-é漢字'},
        {'type': 'key', 'key': 'Tab', 'code': 'Tab', 'keyCode': 9, 'modifiers': 0}])
    assert calls[0] == ('Input.insertText', {'text': 'dummy-é漢字'})
    assert [item[1]['type'] for item in calls[1:]] == ['keyDown', 'keyUp']
