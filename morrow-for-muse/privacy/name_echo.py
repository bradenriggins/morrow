"""Educator-introduced names: the "name echo" store.

The educator works by name ("extend Jane Doe's due date"). The name they
typed is already in the model's context, because the educator typed it.
Once `morrow students find` resolves that typed name to a course label,
this store records (tenant, course, conversation, label, the name as the
educator typed it). Projection then shows that label as
"<name as typed> (Student A3)" in THAT conversation only. A name the
educator did not type never enters this store, so it never reaches the
model.

Storage: a sibling of the learner vault (<vault>.echo), AES-256-GCM
sealed under a key derived (HMAC-SHA256) from the vault key, 0600, never
plaintext. Records end with the conversation (end_conversation, called
by settings.store.end_conversation), expire after MAX_AGE_HOURS as a
backstop, and go with every vault purge. A vault key rotation makes the
old echo file unreadable; it then reads as empty (the names stop
echoing, nothing leaks).
"""

import base64
import datetime
import hashlib
import hmac
import json
import os

from privacy import core as _core

MAX_AGE_HOURS = 24
_SCHEMA = "morrow.name-echo.v1"
_MAX_BYTES = 4 * 1024 * 1024
_MAX_RECORDS = 5000


def _vault_path():
    from privacy import executor_wire as _wire
    return _wire._source_vault_path()


def echo_path():
    return _vault_path() + ".echo"


def _subkey():
    vault = _core.LearnerVault(_vault_path())
    try:
        return hmac.new(bytes(vault._key.view()), b"morrow.name-echo.v1",
                        hashlib.sha256).digest()
    finally:
        vault.close()


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _load(path, key):
    content = _core._read_exact_file(path, "name echo", 1, _MAX_BYTES)
    if content is None:
        return []
    try:
        envelope = json.loads(content.decode("utf-8"))
        if envelope.get("schema") != _SCHEMA:
            return []
        iv = base64.urlsafe_b64decode(envelope["iv"] + "==")
        sealed = base64.urlsafe_b64decode(envelope["ciphertext"] + "==")
        plain = _core._require_aesgcm()(key).decrypt(iv, sealed, None)
        records = json.loads(plain.decode("utf-8"))
    except Exception:
        return []
    if not isinstance(records, list):
        return []
    cutoff = _now() - datetime.timedelta(hours=MAX_AGE_HOURS)
    live = []
    for rec in records:
        try:
            at = datetime.datetime.fromisoformat(rec["at"])
        except (KeyError, TypeError, ValueError):
            continue
        if at >= cutoff:
            live.append(rec)
    return live


def _save(path, key, records):
    records = records[-_MAX_RECORDS:]
    iv = os.urandom(12)
    sealed = _core._require_aesgcm()(key).encrypt(
        iv, json.dumps(records, sort_keys=True).encode("utf-8"), None)
    envelope = {"schema": _SCHEMA,
                "iv": base64.urlsafe_b64encode(iv).decode("ascii")
                .rstrip("="),
                "ciphertext": base64.urlsafe_b64encode(sealed)
                .decode("ascii").rstrip("=")}
    _core._replace_exact_file(path, (json.dumps(envelope) + "\n")
                              .encode("utf-8"), "name echo", 1, _MAX_BYTES)


def _update(mutate):
    path = _core._canonical_private_state_file_path(echo_path(), "name echo")
    key = _subkey()
    with _core._file_lock(path):
        records = _load(path, key)
        records, result = mutate(records)
        _save(path, key, records)
    return result


def _origin(tenant_base):
    return _core._normalize_tenant_origin(tenant_base)


def record_introduction(tenant_base, course_id, conversation_id, label,
                        typed_name):
    """Record that the educator introduced label by typed_name here."""
    if not conversation_id:
        raise ValueError("a name echo needs a conversation id")
    if not _core._LABEL_RE.match(str(label or "")):
        raise ValueError("a name echo needs a course label")
    typed = " ".join(str(typed_name or "").split())
    if not typed or len(typed) > 200:
        raise ValueError("a name echo needs the name the educator typed")
    rec = {"origin": _origin(tenant_base), "course": str(course_id),
           "conversation": str(conversation_id), "label": label,
           "typed": typed, "at": _now().isoformat()}

    def mutate(records):
        kept = [r for r in records
                if not (r.get("origin") == rec["origin"]
                        and r.get("course") == rec["course"]
                        and r.get("conversation") == rec["conversation"]
                        and r.get("label") == label)]
        return kept + [rec], rec
    return _update(mutate)


def introductions(tenant_base, course_id, conversation_id):
    """{label: name as the educator typed it} for one conversation and
    course. Empty without a conversation id, a vault, or cryptography."""
    if not conversation_id or _core.AESGCM is None:
        return {}
    path = echo_path()
    if not os.path.exists(path) or not os.path.exists(_vault_path()):
        return {}
    try:
        origin = _origin(tenant_base)
        key = _subkey()
        with _core._file_lock(path):
            records = _load(path, key)
    except Exception:
        return {}
    return {r["label"]: r["typed"] for r in records
            if r.get("origin") == origin
            and r.get("course") == str(course_id)
            and r.get("conversation") == str(conversation_id)}


def end_conversation(conversation_id):
    """Drop every echo record of one conversation. Returns the count."""
    if not conversation_id or not os.path.exists(echo_path()):
        return 0

    def mutate(records):
        kept = [r for r in records
                if r.get("conversation") != str(conversation_id)]
        return kept, len(records) - len(kept)
    return _update(mutate)


def purge(tenant_base, course_id=None):
    """Drop one tenant's (or one course's) echo records."""
    if not os.path.exists(echo_path()):
        return 0
    origin = _origin(tenant_base)

    def mutate(records):
        kept = [r for r in records
                if not (r.get("origin") == origin
                        and (course_id is None
                             or r.get("course") == str(course_id)))]
        return kept, len(records) - len(kept)
    return _update(mutate)


def remove_all():
    """Delete the echo file. Returns True when a file was removed."""
    try:
        os.remove(echo_path())
        return True
    except OSError:
        return False
