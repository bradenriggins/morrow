"""Expiry revokes claim authority without proving that a write did not apply."""
import json
import time
import uuid
from datetime import datetime, timezone, timedelta

import pytest

from dispatch import executor as ex
from transport import browser_backend as bb


@pytest.fixture
def state(tmp_path, monkeypatch):
    home = tmp_path / 'home'
    tree = home / 'tree'
    monkeypatch.setenv('MORROW_HOME', str(home))
    monkeypatch.setenv('MORROW_TREE_STATE_DIR', str(tree))
    monkeypatch.setattr(ex, 'MORROW_HOME', str(home))
    monkeypatch.setattr(ex, 'TREE_STATE_DIR', str(tree))
    monkeypatch.setattr(ex, 'JOURNAL_PATH', str(tree / 'journal' / 'ops.jsonl'))
    monkeypatch.setattr(ex, 'LEGACY_JOURNAL_PATH', str(home / 'absent.jsonl'))
    pending = tmp_path / 'pending'
    briefs = tmp_path / 'briefs'
    pending.mkdir()
    briefs.mkdir()
    return pending, briefs


def old_claim(monkeypatch, effect='write'):
    op = str(uuid.uuid4())
    with monkeypatch.context() as m:
        m.setattr(ex, 'utc_now_iso', lambda: (
            datetime.now(timezone.utc) - timedelta(days=8)).isoformat())
        token = ex.claim_op_id(op, 'dispatch', 'synthetic.create', effect, 'digest')
    return op, token


def envelope(state, op):
    pending, briefs = state
    path = pending / (op + '.json')
    path.write_text(json.dumps({
        'op_id': op,
        'created_at': (datetime.now(timezone.utc) - timedelta(days=8)).isoformat(),
        'brief_dir': str(briefs), 'response_payload': {'id': 441}}))
    brief = briefs / (op + '-request.txt')
    brief.write_text('synthetic recovery request')
    bb._save_locks(str(pending), {op: {
        'entry_name': 'synthetic.create', 'created_at_ts': time.time() - 8 * 86400,
        'created_mono': 0}})
    return path, brief


def test_automatic_sweep_retains_pending_write_and_expired_authority(state, monkeypatch):
    op, token = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    assert bb.sweep_stale_pending(str(state[0])) == 0
    assert path.exists() and brief.exists()
    assert bb.conflict_lock_held(op, str(state[0]))
    with pytest.raises(bb.ConflictLockHeld):
        bb.acquire_conflict_lock(op, 'synthetic.create', str(state[0]))
    with pytest.raises(ex.DuplicateOpId):
        ex.claim_op_id(op, 'dispatch', 'synthetic.create', 'write', 'digest')
    with pytest.raises(ex.DuplicateOpId, match='expired'):
        ex.recheck_claim(op, token)


def test_manual_sweep_retains_write_but_releases_read(state, monkeypatch):
    write, token = old_claim(monkeypatch)
    read, _ = old_claim(monkeypatch, 'read')
    result = ex.sweep_expired_claims()
    assert result['swept'] == [read]
    assert result['retained_unresolved_writes'] == [write]
    with pytest.raises(ex.DuplicateOpId):
        ex.claim_op_id(write, 'dispatch', 'synthetic.create', 'write', 'digest')
    with pytest.raises(ex.DuplicateOpId, match='expired'):
        ex.journal_claimed_outcome(write, {'op_id': write, 'verification': 'verified'}, token)
    assert ex.claim_op_id(read, 'dispatch', 'synthetic.read', 'read', 'digest')


@pytest.mark.parametrize('verification', ['pass', 'verified', 'closed_by_person'])
def test_settled_outcome_allows_old_recovery_cleanup(state, monkeypatch, verification):
    op, _ = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    ex.journal_append({'op_id': op, 'wal': 'complete', 'effect': 'write',
                       'verification': verification, 'uncertain': False})
    assert bb.sweep_stale_pending(str(state[0])) == 1
    assert not path.exists() and not brief.exists()
    assert not bb.conflict_lock_held(op, str(state[0]))
    with pytest.raises(ex.DuplicateOpId):
        ex.claim_op_id(op, 'dispatch', 'synthetic.create', 'write', 'digest')


def test_presend_release_allows_cleanup_and_reclaim(state, monkeypatch):
    op, token = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    ex.release_op_id(op, token, 'local prevalidation refused; nothing sent')
    assert bb.sweep_stale_pending(str(state[0])) == 1
    assert not path.exists() and not brief.exists()
    assert ex.claim_op_id(op, 'dispatch', 'synthetic.create', 'write', 'digest')


@pytest.mark.parametrize('outcome', ['absent', 'uncertain', 'forced_release'])
def test_unknown_or_unverified_outcome_retains_evidence(state, monkeypatch, outcome):
    op, _ = old_claim(monkeypatch)
    if outcome == 'absent':
        op = str(uuid.uuid4())
    elif outcome == 'uncertain':
        ex.journal_append({'op_id': op, 'wal': 'complete', 'effect': 'write',
                           'verification': 'applied_or_unknown', 'uncertain': True})
    else:
        ex.release_op_id_forced(op, 'old expiry; outcome unknown')
    path, brief = envelope(state, op)
    assert bb.sweep_stale_pending(str(state[0])) == 0
    assert path.exists() and brief.exists()
    assert bb.conflict_lock_held(op, str(state[0]))


@pytest.mark.parametrize('outcome', ['pending', 'uncertain', 'missing', 'journal_error'])
def test_normal_purge_keeps_unresolved_envelopes_and_orphan_briefs(
        state, monkeypatch, outcome):
    op, _ = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    orphan = state[1] / (op + '-dupcheck.txt')
    orphan.write_text('synthetic readback recovery')
    if outcome == 'uncertain':
        ex.journal_append({'op_id': op, 'wal': 'complete', 'effect': 'write',
                           'verification': 'applied_or_unknown', 'uncertain': True})
    elif outcome == 'missing':
        path.unlink()
    elif outcome == 'journal_error':
        def refuse(*args):
            raise ex.JournalIntegrityError('synthetic journal corruption')
        monkeypatch.setattr(ex, '_journal_recovery_settled_locked', refuse)
    removed, briefs_removed, skipped = bb.purge_transient_state(
        str(state[0]), str(state[1]))
    assert removed == 0 and briefs_removed == 0
    assert brief.exists() and orphan.exists()
    assert path.exists() or outcome == 'missing'
    assert bb.conflict_lock_held(op, str(state[0]))


@pytest.mark.parametrize('presend', [False, True])
def test_normal_purge_removes_only_settled_recovery(state, monkeypatch, presend):
    op, token = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    if presend:
        ex.release_op_id(op, token, 'nothing sent; local validation refused')
    else:
        ex.journal_append({'op_id': op, 'wal': 'complete', 'effect': 'write',
                           'verification': 'verified', 'uncertain': False})
    removed, _, skipped = bb.purge_transient_state(str(state[0]), str(state[1]))
    assert removed == 1 and skipped == 0
    assert not path.exists() and not brief.exists()


def test_explicit_whole_tree_removal_can_erase_unknown_recovery(state, monkeypatch):
    op, _ = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    removed, _, skipped = bb.purge_transient_state(
        str(state[0]), str(state[1]), force=True)
    assert removed == 1 and skipped == 0
    assert not path.exists() and not brief.exists()


def test_malformed_envelope_is_preserved(state):
    path = state[0] / (str(uuid.uuid4()) + '.json')
    path.write_text('[]')
    assert bb.sweep_stale_pending(str(state[0])) == 0
    removed, _, skipped = bb.purge_transient_state(str(state[0]), str(state[1]))
    assert removed == 0 and skipped == 1 and path.exists()


@pytest.mark.parametrize('mode', ['sweep', 'purge', 'orphan', 'locks'])
def test_cleanup_holds_journal_lock_until_deletion(state, monkeypatch, mode):
    import threading
    from contextlib import contextmanager

    op, token = old_claim(monkeypatch)
    path, brief = envelope(state, op)
    ex.release_op_id(op, token, 'nothing sent; validation refused')
    if mode != 'locks':
        bb.release_conflict_lock(op, str(state[0]))
    if mode == 'orphan':
        path.unlink()
    attempted = threading.Event()
    reclaimed = threading.Event()
    errors = []
    threads = []
    original_lock = ex._journal_locked
    original_delete = bb._delete_brief_files
    original_save = bb._save_locks
    original_remove = bb.os.remove

    @contextmanager
    def observed_lock():
        if threading.current_thread().name == 'reclaim':
            attempted.set()
        with original_lock():
            yield

    def reclaim():
        try:
            ex.claim_op_id(op, 'dispatch', 'synthetic.create', 'write', 'new-digest')
            reclaimed.set()
            bb.acquire_conflict_lock(op, 'synthetic.create', str(state[0]))
            path.write_text(json.dumps({
                'op_id': op, 'created_at': datetime.now(timezone.utc).isoformat(),
                'brief_dir': str(state[1]), 'response_payload': {'id': 442}}))
            brief.write_text('new recovery evidence')
        except Exception as error:
            errors.append(error)

    def try_reclaim():
        if not threads:
            writer = threading.Thread(target=reclaim, name='reclaim')
            threads.append(writer)
            writer.start()
            assert attempted.wait(2), 'reclaim did not reach the journal lock'
            assert not reclaimed.wait(0.05), 'UUID reclaimed before deletion finished'

    def paused_delete(*args):
        try_reclaim()
        return original_delete(*args)

    def paused_remove(want):
        if str(want) == str(brief):
            try_reclaim()
        return original_remove(want)

    def paused_save(*args):
        if threading.current_thread().name != 'reclaim':
            try_reclaim()
        return original_save(*args)

    monkeypatch.setattr(ex, '_journal_locked', observed_lock)
    if mode in ('sweep', 'purge'):
        monkeypatch.setattr(bb, '_delete_brief_files', paused_delete)
    elif mode == 'orphan':
        monkeypatch.setattr(bb.os, 'remove', paused_remove)
    else:
        monkeypatch.setattr(bb, '_save_locks', paused_save)
    if mode == 'sweep':
        assert bb.sweep_stale_pending(str(state[0])) == 1
    elif mode in ('purge', 'orphan'):
        removed, count, _ = bb.purge_transient_state(str(state[0]), str(state[1]))
        assert removed == (1 if mode == 'purge' else 0)
        assert count == 1
    else:
        assert bb.sweep_stale_locks(str(state[0])) == 1
    assert threads
    threads[0].join(5)
    assert not threads[0].is_alive(), 'journal/conflict lock order deadlocked'
    assert not errors
    assert ex.claim_is_live(op)
    assert json.loads(path.read_text())['response_payload']['id'] == 442
    assert brief.read_text() == 'new recovery evidence'
    assert bb.conflict_lock_held(op, str(state[0]))
