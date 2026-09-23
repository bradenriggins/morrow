#!/usr/bin/env python3
"""Faithful Python port of the Morrow gateway learner-privacy engine.

Source (read-only): ``~/workspace/origin-morrow/packages/gateway-core/src/privacy.ts``
(1585 lines). This module ports every piece of that engine that the source
privacy boundary needs:

- learner scope / identity normalization (``normalizeLearnerIdentity``)
- ``LearnerVault``: encrypted, scope-exact label vault (``Student A<n>`` labels,
  ``learner_<uuid>`` tokens), persisted with AES-256-GCM
- ``LearnerRoster``: exact-scope roster index with a 60s readiness window
- the learner-text redaction pipeline (HTML-entity / percent-escape aware
  match views, alias matcher, identity-reference patterns, sensitive-text
  refusal, unrostered-address removal)
- ``redactLearnerEgress``: the structural egress walk
- ``resolveLearnerTokens``: the write-direction token resolver

Deliberately NOT ported (documented, not silent): the MCP output-projection
machinery (``OutputPrivacyDescriptor`` / ``projectOutput`` /
``outputDescriptorDigest``) and ``ArtifactGenerationRegistry``. The source
boundary (``boundary.py``) never touches those; they belong to the desktop
gateway's MCP result projection, which this tree does not have.

Divergences from the TypeScript (each documented here, none silent):

1. The vault's cross-process transaction protocol (owner-file claim/reclaim
   dance in ``private-state-file.ts``) is replaced by an ``flock(2)``-guarded
   read-modify-write on the vault files. Same guarantees this deployment
   needs (atomic replace, 0600 files, symlink refusal, owner-uid check, byte
   bounds); the crash-recovery lock protocol is out of scope for a
   single-VM educator deployment.
2. Grapheme segmentation (``Intl.Segmenter``) is approximated as base
   character + following combining marks. Full UAX-29 segmentation (emoji
   ZWJ sequences, regional indicators) is not reproduced; identity matching
   is unaffected for the Latin/CJK names the roster carries.
3. ``\\p{L}`` / ``\\p{N}`` regex classes become Python ``\\w`` under
   ``re.UNICODE`` (equivalent for letter/number/underscore), and
   ``toLocaleLowerCase("en-US")`` becomes ``str.lower()`` (identical for
   en-US locale data).
4. Async becomes sync throughout (``loadRoster`` / handlers are plain
   callables). The semantics are unchanged.

Error convention: every privacy failure raises ``PrivacyError`` whose
``code`` is the exact ``snake_case`` message string the TypeScript throws
(e.g. ``privacy_binding_invalid``), so tests and the adversarial battery
can assert on the same vocabulary.

Optional dependency: the AES-256-GCM file-backed vault needs the
``cryptography`` package (exact pin in requirements-optional.txt). This
module imports fine without it; vault seal/open raise a loud
PrivacyError naming the install command. In-memory vaults, identity
normalization, roster, and redaction never need it.
"""

import base64
import binascii
import contextlib
import fcntl
import functools
import hashlib
import hmac
import json
import math
import os
import re
import stat
import unicodedata
import urllib.parse
import uuid

# Optional dependency (P1-24): the AES-256-GCM vault needs the
# ``cryptography`` package (pinned in requirements-optional.txt). It is
# imported lazily so this module imports fine without it; the two vault
# seal/open call sites raise a loud PrivacyError instead of failing at
# import. Everything that does not touch the encrypted vault (identity
# normalization, roster, redaction, egress walk) works without it.
try:
    import cryptography
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover - depends on the educator's venv
    cryptography = None
    AESGCM = None

# W4-P2-20: the pin in requirements-optional.txt is documentation-only
# once installation is done, so the floor is enforced again here. A
# vulnerable ``cryptography`` (e.g. 48.0.1, which carries
# CVE-2026-69247/69248/69249) must never seal or open the vault
# silently: it fails loudly into the same PrivacyError path as a
# missing install.
_CRYPTOGRAPHY_MIN_VERSION = (50, 0, 1)

# W6-P2-7: the vault AES key lives in a zeroizable buffer, not bytes,
# and is overwritten on close()/rotation (see config/secretbuf.py for
# the honest residual statement).
from config.securebuf import SecretBytes, secret_bytes  # noqa: E402


def _version_tuple(ver):
    """Parse a version string into a comparable int tuple.

    Each dot component contributes its leading numeric run, so
    "50.0.1.post1" compares at-or-above (50, 0, 1) (its extra
    component sorts after the bare release) and "50.0" as (50, 0, 0).
    Numeric tuple comparison avoids the string-comparison trap where
    "9.0.0" > "50.0.1" lexicographically.
    """
    parts = []
    for piece in str(ver).split("."):
        digits = ""
        for ch in piece:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _require_aesgcm():
    if AESGCM is None:
        raise PrivacyError(
            "the encrypted learner vault needs the 'cryptography' "
            "package, which is not installed. Install it with "
            "'pip install -r requirements-optional.txt' (pinned "
            "cryptography==50.0.1), then rerun."
        )
    installed = getattr(cryptography, "__version__", "unknown") \
        if cryptography is not None else "unknown"
    if _version_tuple(installed) < _CRYPTOGRAPHY_MIN_VERSION:
        raise PrivacyError(
            "the encrypted learner vault refuses cryptography %s: the "
            "pin requires cryptography>=50.0.1 (older releases carry "
            "known memory-safety CVEs, e.g. CVE-2026-69247/69248/69249 "
            "in 48.0.1). Upgrade with "
            "'pip install -r requirements-optional.txt', then rerun."
            % (installed,))
    return AESGCM


def learner_vault_problem():
    """Why the encrypted learner vault cannot run with this Python, or
    None when it can. All student-data work needs the vault (working by
    name, the failed-students question, rosters, grades); install.sh
    reports the problem at install time."""
    try:
        _require_aesgcm()
    except PrivacyError as exc:
        return str(exc)
    return None

# How deep a provider answer may nest before the privacy walk refuses it.
MAX_PRIVACY_OUTPUT_DEPTH = 32


class PrivacyError(Exception):
    """A privacy-boundary refusal. ``code`` is the TS error string."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------------------
# contracts helpers (mirrors @morrow/contracts: canonicalJson, isJsonObject,
# sha256Text)
# ---------------------------------------------------------------------------

def is_json_object(value):
    return value is not None and isinstance(value, dict)


def _canonicalize(value, path):
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("%s contains a non-finite number" % path)
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, (list, tuple)):
        return [_canonicalize(entry, "%s[%d]" % (path, index))
                for index, entry in enumerate(value)]
    if isinstance(value, dict):
        output = {}
        for key in sorted(value.keys()):
            if not isinstance(key, str):
                raise TypeError("%s contains a non-string key" % path)
            output[key] = _canonicalize(value[key], "%s.%s" % (path, key))
        return output
    raise TypeError("%s contains a non-JSON value" % path)


def canonical_json(value):
    # json.dumps with compact separators and raw (non-ASCII-escaped) output
    # matches JSON.stringify's shape for these values.
    return json.dumps(_canonicalize(value, "$"), ensure_ascii=False,
                      separators=(",", ":"))


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Learner scope / identity
# ---------------------------------------------------------------------------

_SCOPE_FIELDS = ("canvasOrigin", "account", "course", "principal", "profile")


def exact_scope(scope):
    if not is_json_object(scope):
        raise PrivacyError("learner scope is invalid")
    output = {}
    for field in _SCOPE_FIELDS:
        value = str(scope.get(field) or "").strip()
        if not value or len(value) > 500:
            raise TypeError("learner scope %s is invalid" % field)
        output[field] = value
    return output


def _optional_identity_text(value, label):
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized or len(normalized) > 500:
        raise TypeError("learner %s is invalid" % label)
    return normalized


def exact_identity(value):
    """Port of exactIdentity; exported as normalize_learner_identity."""
    if not is_json_object(value):
        raise TypeError("learner identity is invalid")
    ident = str(value.get("id") or "").strip()
    if not ident or len(ident) > 500:
        raise TypeError("learner id is invalid")
    aliases = value.get("aliases")
    if aliases is not None:
        if not isinstance(aliases, list) or len(aliases) > 100:
            raise TypeError("learner aliases are invalid")
    seen_aliases = []
    for alias in aliases or []:
        normalized = _optional_identity_text(alias, "alias")
        if normalized not in seen_aliases:
            seen_aliases.append(normalized)
    identity = {"id": ident}
    if seen_aliases:
        identity["aliases"] = seen_aliases
    for key, label in (("name", "name"), ("email", "email"),
                       ("loginId", "login id"), ("sisUserId", "SIS user id")):
        normalized = _optional_identity_text(value.get(key), label)
        if normalized:
            identity[key] = normalized
    return identity


def normalize_learner_identity(value):
    return exact_identity(value)


def scope_key(scope):
    return canonical_json(scope)


def identity_key(scope, identity):
    return "%s\x00%s" % (scope_key(scope), identity["id"])


# ---------------------------------------------------------------------------
# Exact private state files (simplified port of private-state-file.ts)
#
# Divergence (documented): the TS cross-process owner-file transaction
# protocol is replaced by flock-guarded read-modify-write. Atomic replace
# (tmp + rename + fsync), 0600 files, symlink refusal, owner-uid check and
# byte bounds are preserved.
# ---------------------------------------------------------------------------

def _canonical_private_state_file_path(path_value, label):
    requested = os.path.abspath(path_value)
    parent = os.path.dirname(requested)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    try:
        parent_stat = os.lstat(parent)
    except OSError:
        raise PrivacyError("%s parent is not one exact directory" % label)
    if not stat.S_ISDIR(parent_stat.st_mode) or os.path.islink(parent):
        raise PrivacyError("%s parent is not one exact directory" % label)
    return os.path.join(os.path.realpath(parent), os.path.basename(requested))


def _read_exact_file(path, label, min_bytes, max_bytes):
    try:
        named = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError:
        raise PrivacyError("%s is not one exact private file" % label)
    if (not stat.S_ISREG(named.st_mode) or os.path.islink(path)
            or named.st_nlink != 1
            or named.st_size < min_bytes or named.st_size > max_bytes):
        raise PrivacyError("%s is not one exact private file" % label)
    if hasattr(os, "getuid") and named.st_uid != os.getuid():
        raise PrivacyError("%s is not one exact private file" % label)
    if stat.S_IMODE(named.st_mode) & 0o077:
        raise PrivacyError("%s is not one exact private file" % label)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, os.O_RDONLY | nofollow)
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
            raise PrivacyError("%s changed during admission" % label)
        data = os.read(fd, max_bytes + 1)
        if len(data) < min_bytes or len(data) > max_bytes:
            raise PrivacyError("%s violates its byte bound" % label)
        return data
    finally:
        os.close(fd)


def _create_exact_file(path, content, label, min_bytes, max_bytes):
    path = _canonical_private_state_file_path(path, label)
    if len(content) < min_bytes or len(content) > max_bytes:
        raise PrivacyError("%s violates its byte bound" % label)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | nofollow,
                     0o600)
    except FileExistsError:
        return False
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        os.write(fd, content)
        os.fsync(fd)
    finally:
        os.close(fd)
    admitted = _read_exact_file(path, label, min_bytes, max_bytes)
    if admitted != content:
        raise PrivacyError("%s failed exact readback" % label)
    _sync_directory(os.path.dirname(path))
    return True


def _replace_exact_file(path, content, label, min_bytes, max_bytes):
    path = _canonical_private_state_file_path(path, label)
    temporary = os.path.join(
        os.path.dirname(path),
        ".%s.tmp-%d-%s" % (os.path.basename(path), os.getpid(),
                           uuid.uuid4().hex))
    try:
        if not _create_exact_file(temporary, content, label, min_bytes,
                                  max_bytes):
            raise PrivacyError("%s temporary file already exists" % label)
        os.rename(temporary, path)
        admitted = _read_exact_file(path, label, min_bytes, max_bytes)
        if admitted != content:
            raise PrivacyError("%s failed exact readback" % label)
        _sync_directory(os.path.dirname(path))
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def _sync_directory(directory):
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def _file_lock(path):
    """Best-effort cross-process mutual exclusion for one vault file."""
    lock_path = path + ".lock"
    _canonical_private_state_file_path(lock_path, "learner vault lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _decode_exact_utf8(content, label):
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        raise PrivacyError("%s is not valid UTF-8" % label)


_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _exact_base64url(value, label, expected_bytes=None):
    if not isinstance(value, str) or not _BASE64URL_RE.match(value):
        raise PrivacyError("%s is invalid" % label)
    padded = value + "=" * (-len(value) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (binascii.Error, ValueError):
        raise PrivacyError("%s is invalid" % label)
    if base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != value:
        raise PrivacyError("%s is invalid" % label)
    if expected_bytes is not None and len(raw) != expected_bytes:
        raise PrivacyError("%s is invalid" % label)
    return raw

# ---------------------------------------------------------------------------
# LearnerVault
# ---------------------------------------------------------------------------

_MAX_VAULT_KEY_BYTES = 128
_MAX_VAULT_FILE_BYTES = 64 * 1024 * 1024
_MAX_VAULT_PLAINTEXT_BYTES = 48 * 1024 * 1024
_MAX_VAULT_ENTRIES = 100_000
_VAULT_SCHEMA = "morrow.learner-vault.v1"
_TOKEN_RE = re.compile(
    r"^learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_LABEL_RE = re.compile(r"^Student A[1-9][0-9]*$")
_KEY_TEXT_RE = re.compile(r"^[A-Za-z0-9_-]{43}\n?$")


def _parse_vault_key(content):
    text = _decode_exact_utf8(content, "learner vault key")
    if not _KEY_TEXT_RE.match(text):
        raise PrivacyError("learner vault key is invalid")
    return _exact_base64url(text[:-1] if text.endswith("\n") else text,
                            "learner vault key", 32)


def _parse_vault_keyring(content):
    """W6-P1-2: parse the vault key file as a 1-or-2-line keyring.

    Line 1 is the ACTIVE key. A second line exists only inside a
    rotation commit window and holds the previous key: readers try each
    listed key, so a crash between the vault-file swap and the key-file
    finalization can never brick the vault (at every instant at least
    one listed key decrypts the live vault file). Outside rotation the
    file holds exactly one line, as before.
    """
    text = _decode_exact_utf8(content, "learner vault key")
    lines = [line for line in text.split("\n") if line]
    if not 1 <= len(lines) <= 2:
        raise PrivacyError("learner vault key is invalid")
    keys = []
    for line in lines:
        if not _KEY_TEXT_RE.match(line + "\n"):
            raise PrivacyError("learner vault key is invalid")
        keys.append(_exact_base64url(line, "learner vault key", 32))
    return keys


def _decode_vault_state_any(content, keys):
    """Decrypt the vault trying each keyring key in order (active first)."""
    last_error = None
    for key in keys:
        try:
            return _decode_vault_state(content, key)
        except PrivacyError as exc:
            last_error = exc
    raise last_error


def _empty_vault_state():
    return {"entries": {}, "by_token": {}, "by_label": {},
            "next_label_by_scope": {}}


def _next_vault_label(state, scope):
    key = scope_key(scope)
    nxt = state["next_label_by_scope"].get(key, 1)
    while "%s\x00Student A%d" % (key, nxt) in state["by_label"]:
        nxt += 1
    state["next_label_by_scope"][key] = nxt + 1
    return "Student A%d" % nxt


def _decode_vault_state(content, key):
    state = _empty_vault_state()
    envelope = json.loads(_decode_exact_utf8(content, "learner vault"))
    if (not is_json_object(envelope)
            or envelope.get("schema") != _VAULT_SCHEMA
            or sorted(envelope.keys()) != ["ciphertext", "iv", "schema", "tag"]):
        raise PrivacyError("learner vault has an unsupported format")
    for field in ("iv", "tag", "ciphertext"):
        if not isinstance(envelope.get(field), str) or not envelope[field]:
            raise PrivacyError("learner vault is invalid")
    iv = _exact_base64url(envelope["iv"], "learner vault IV", 12)
    tag = _exact_base64url(envelope["tag"], "learner vault tag", 16)
    ciphertext = _exact_base64url(envelope["ciphertext"],
                                 "learner vault ciphertext")
    try:
        plain = _require_aesgcm()(key).decrypt(iv, ciphertext + tag, None)
    except PrivacyError:
        raise
    except Exception:
        raise PrivacyError("learner vault is invalid")
    if len(plain) > _MAX_VAULT_PLAINTEXT_BYTES:
        raise PrivacyError("learner vault plaintext is oversized")
    records = json.loads(_decode_exact_utf8(plain, "learner vault plaintext"))
    if not isinstance(records, list) or len(records) > _MAX_VAULT_ENTRIES:
        raise PrivacyError("learner vault entries are invalid")
    for value in records:
        if (not is_json_object(value)
                or not isinstance(value.get("token"), str)
                or not _TOKEN_RE.match(value["token"])
                or value["token"] in state["by_token"]
                or not is_json_object(value.get("scope"))
                or not is_json_object(value.get("identity"))):
            raise PrivacyError("learner vault entry is invalid")
        scope = exact_scope(value["scope"])
        label = value.get("label")
        if label is None:
            label = _next_vault_label(state, scope)
        if (not isinstance(label, str) or not _LABEL_RE.match(label)
                or "%s\x00%s" % (scope_key(scope), label) in state["by_label"]):
            raise PrivacyError("learner vault label is invalid")
        entry = {"token": value["token"], "label": label, "scope": scope,
                 "identity": exact_identity(value["identity"])}
        if identity_key(entry["scope"], entry["identity"]) in state["entries"]:
            raise PrivacyError("learner vault identity is duplicated")
        state["entries"][identity_key(entry["scope"], entry["identity"])] = entry
        state["by_token"][entry["token"]] = entry
        state["by_label"]["%s\x00%s" % (scope_key(scope), label)] = entry
        number = int(label[len("Student A"):])
        skey = scope_key(scope)
        state["next_label_by_scope"][skey] = max(
            state["next_label_by_scope"].get(skey, 1), number + 1)
    return state


def _label_order(order_key, scope, identity):
    """Keyed-hash position of a new learner inside one label batch.

    Round-4 audit L1: labels used to follow first-read order, so a
    roster read in alphabetical order leaked each student's
    alphabetical rank. New labels in one batch are issued in the order
    of an HMAC over (scope, learner id) under the vault key: stable for
    one vault, meaningless without the key. Learners who already have a
    label keep it."""
    return hmac.new(bytes(order_key or b"morrow.label-order"),
                    ("%s\x00%s" % (scope_key(scope), identity["id"]))
                    .encode("utf-8"), hashlib.sha256).hexdigest()


def _add_vault_identities(state, scope, identities, order_key=None):
    changed = False
    labels = [None] * len(identities)
    fresh = []
    for index, identity in enumerate(identities):
        key = identity_key(scope, identity)
        existing = state["entries"].get(key)
        if existing is not None:
            labels[index] = existing["label"]
            continue
        if any(identity_key(scope, identities[i]) == key for i, _ in fresh):
            continue
        fresh.append((index, identity))
    fresh.sort(key=lambda pair: _label_order(order_key, scope, pair[1]))
    for index, identity in fresh:
        key = identity_key(scope, identity)
        token = "learner_%s" % uuid.uuid4()
        while token in state["by_token"]:
            token = "learner_%s" % uuid.uuid4()
        entry = {"token": token, "label": _next_vault_label(state, scope),
                 "scope": scope, "identity": identity}
        state["entries"][key] = entry
        state["by_token"][entry["token"]] = entry
        state["by_label"]["%s\x00%s" % (scope_key(scope),
                                        entry["label"])] = entry
        changed = True
    for index, identity in enumerate(identities):
        if labels[index] is None:
            labels[index] = state["entries"][identity_key(scope,
                                                          identity)]["label"]
    return labels, changed


def _persist_vault_state(path, key, state):
    iv = os.urandom(12)
    plain = canonical_json(list(state["by_token"].values())).encode("utf-8")
    if len(state["by_token"]) > _MAX_VAULT_ENTRIES or \
            len(plain) > _MAX_VAULT_PLAINTEXT_BYTES:
        raise PrivacyError("learner vault capacity is exceeded")
    sealed = _require_aesgcm()(key).encrypt(iv, plain, None)
    envelope = {"schema": _VAULT_SCHEMA,
                "iv": base64.urlsafe_b64encode(iv).decode("ascii").rstrip("="),
                "tag": base64.urlsafe_b64encode(sealed[-16:]).decode("ascii").rstrip("="),
                "ciphertext": base64.urlsafe_b64encode(sealed[:-16]).decode("ascii").rstrip("=")}
    _replace_exact_file(path, (json.dumps(envelope) + "\n").encode("utf-8"),
                        "learner vault", 1, _MAX_VAULT_FILE_BYTES)


class LearnerVault:
    """Encrypted, scope-exact store mapping learner identities to
    ``Student A<n>`` labels. Same learner + same scope = same label across
    restarts; the file never holds plaintext roster data."""

    def __init__(self, path_value=":memory:"):
        if path_value == ":memory:":
            self._path = ":memory:"
            self._key = secret_bytes(os.urandom(32))
            self._state = _empty_vault_state()
            return
        self._path = _canonical_private_state_file_path(path_value,
                                                        "learner vault")
        with _file_lock(self._path):
            content = _read_exact_file(self._path, "learner vault", 1,
                                       _MAX_VAULT_FILE_BYTES)
            key_path = self._path + ".key"
            key_content = _read_exact_file(key_path, "learner vault key", 1,
                                           _MAX_VAULT_KEY_BYTES)
            if key_content is not None:
                # W6-P1-2: keyring; try each listed key (active first).
                # W6-P2-7: the live key is a zeroizable buffer.
                keys = _parse_vault_keyring(key_content)
                self._key = secret_bytes(keys[0])
                self._state = _decode_vault_state_any(content, keys) \
                    if content is not None else _empty_vault_state()
            else:
                if content is not None:
                    raise PrivacyError(
                        "learner vault key is unavailable for the saved vault")
                key = os.urandom(32)
                if not _create_exact_file(
                        key_path,
                        (base64.urlsafe_b64encode(key).decode("ascii")
                         .rstrip("=") + "\n").encode("utf-8"),
                        "learner vault key", 43, _MAX_VAULT_KEY_BYTES):
                    raise PrivacyError(
                        "learner vault key changed during its transaction")
                self._key = secret_bytes(key)
                self._state = _empty_vault_state()

    def _read_current_state(self):
        self._ensure_open()
        key_content = _read_exact_file(self._path + ".key",
                                       "learner vault key", 1,
                                       _MAX_VAULT_KEY_BYTES)
        if key_content is None:
            raise PrivacyError("learner vault key is unavailable")
        # W6-P1-2: the process's key must still be in the ring (active
        # or mid-rotation previous); otherwise a rotation happened under
        # this process and it must re-open instead of writing with a
        # stale key.
        keys = _parse_vault_keyring(key_content)
        if not any(hmac.compare_digest(k, self._key.view()) for k in keys):
            raise PrivacyError("learner vault key changed after admission")
        content = _read_exact_file(self._path, "learner vault", 1,
                                   _MAX_VAULT_FILE_BYTES)
        return _decode_vault_state_any(content, keys) \
            if content is not None else _empty_vault_state()

    def rotate_key(self):
        """W6-P1-2: rotate the vault's AES-256-GCM key.

        Crash-safe three-step commit under the vault file lock:
          1. key file := [NEW, OLD]        (atomic replace)
          2. vault file := encrypt(state, NEW)  (atomic replace)
          3. key file := [NEW]              (atomic replace)
        Readers try each listed key, so at every instant at least one
        listed key decrypts the live vault file: a crash mid-rotation
        can never brick the vault. The retired key is dropped at step 3
        and kept nowhere: pre-rotation backups of the vault file remain
        decryptable only from an (encrypted) backup of the retired key
        file. Returns True.
        """
        self._ensure_open()
        if self._path == ":memory:":
            self._key.zero()
            self._key = secret_bytes(os.urandom(32))
            return True
        with _file_lock(self._path):
            state = self._read_current_state()
            # W6-P2-7: the fresh key lives in a zeroizable buffer from
            # birth; the only immutable copy is os.urandom's return,
            # overwritten below via the buffer copy semantics.
            new_key = secret_bytes(os.urandom(32))
            old_b64 = base64.urlsafe_b64encode(self._key.view()) \
                .decode("ascii").rstrip("=")
            new_b64 = base64.urlsafe_b64encode(new_key.view()) \
                .decode("ascii").rstrip("=")
            _replace_exact_file(
                self._path + ".key",
                (new_b64 + "\n" + old_b64 + "\n").encode("utf-8"),
                "learner vault key", 1, _MAX_VAULT_KEY_BYTES)
            _persist_vault_state(self._path, new_key.view(), state)
            _replace_exact_file(
                self._path + ".key", (new_b64 + "\n").encode("utf-8"),
                "learner vault key", 1, _MAX_VAULT_KEY_BYTES)
            old_key = self._key
            self._key = new_key
            old_key.zero()
            self._state = state
        return True

    def close(self):
        """W6-P2-7: overwrite the in-memory AES key and drop state.

        The files on disk are untouched. After close() the vault must
        not be used; construct a new LearnerVault instead. Idempotent.
        """
        key, self._key = self._key, None
        if key is not None:
            key.zero()
        self._state = _empty_vault_state()

    def _ensure_open(self):
        if self._key is None:
            raise PrivacyError(
                "learner vault is closed; construct a new LearnerVault")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def tokenize(self, scope_value, identity_value):
        return self.tokenize_many(scope_value, [identity_value])[0]

    def tokenize_many(self, scope_value, identity_values):
        return self.prepare_text_references(scope_value,
                                            identity_values)["labels"]

    def prepare_text_references(self, scope_value, identity_values):
        """Publish any missing labels once, then return the exact reference
        index from that same durable vault snapshot for one privacy
        projection."""
        return self.prepare_text_reference_sets(
            [{"scope": scope_value, "identities": identity_values}])[0]

    def prepare_text_reference_sets(self, requests):
        self._ensure_open()
        normalized = [{"scope": exact_scope(item["scope"]),
                       "identities": [exact_identity(i)
                                      for i in item["identities"]]}
                      for item in requests]
        if self._path == ":memory:":
            labels_by_request = [
                _add_vault_identities(self._state, item["scope"],
                                      item["identities"],
                                      self._key.view())[0]
                for item in normalized
            ]
        else:
            with _file_lock(self._path):
                state = self._read_current_state()
                changed = False
                labels = []
                for item in normalized:
                    outcome = _add_vault_identities(state, item["scope"],
                                                    item["identities"],
                                                    self._key.view())
                    changed = changed or outcome[1]
                    labels.append(outcome[0])
                if changed:
                    _persist_vault_state(self._path, self._key.view(),
                                         state)
                self._state = state
                labels_by_request = labels
        output = []
        for item, labels in zip(normalized, labels_by_request):
            reference_labels = {}
            for identity in item["identities"]:
                entry = self._state["entries"].get(
                    identity_key(item["scope"], identity))
                if entry is None:
                    raise PrivacyError(
                        "learner vault identity is unavailable after publication")
                reference_labels[entry["token"]] = entry["label"]
                reference_labels[entry["label"]] = entry["label"]
            output.append({"labels": labels,
                           "reference_labels": reference_labels})
        return output

    def resolve(self, scope_value, token_value):
        return self.resolve_with_token(scope_value, token_value)[0]

    def resolve_with_token(self, scope_value, token_value):
        """(identity, token) for a label or token issued in this exact
        scope. The token (learner_<uuid>) is new on every issue, so it
        tells a re-issued label apart from the one an approval saw."""
        scope = exact_scope(scope_value)
        token = str(token_value or "").strip()
        if self._path != ":memory:":
            with _file_lock(self._path):
                self._state = self._read_current_state()
        entry = self._state["by_label"].get(
            "%s\x00%s" % (scope_key(scope), token))
        if entry is None:
            entry = self._state["by_token"].get(token)
        if entry is None or scope_key(entry["scope"]) != scope_key(scope):
            raise PrivacyError("learner token is unavailable for this exact scope")
        return dict(entry["identity"]), entry["token"]

    def identities_for_scope(self, scope_value):
        """Every identity this vault has published a label for under the
        exact scope, including identities learned by earlier invocations.
        The per-invocation roster is harvested fresh from each receipt
        and is therefore partial (one page per op); seeding the alias
        set from these accumulated identities keeps a vault-known
        learner's free-text mentions projecting to her stable label
        (W3-P0-11)."""
        scope = exact_scope(scope_value)
        key = scope_key(scope)
        if self._path != ":memory:":
            with _file_lock(self._path):
                state = self._read_current_state()
        else:
            state = self._state
        return [dict(entry["identity"])
                for entry in state["entries"].values()
                if scope_key(entry["scope"]) == key]

    def purge_tenant(self, tenant_origin):
        """W4-P2-10: drop every vault record whose scope belongs to one
        tenant (matched on the scope's canvasOrigin), keeping every other
        tenant's records and the vault key. The map is rewritten
        atomically (flock-guarded read-modify-write, tmp + rename +
        fsync via _persist_vault_state), so a crash cannot leave a
        half-purged vault. Labels already issued for the purged tenant
        stop resolving; other tenants are untouched. Returns the number
        of records removed."""
        origin = _normalize_tenant_origin(tenant_origin)
        return self._purge_matching(
            lambda scope: scope.get("canvasOrigin") == origin,
            "tenant %s" % origin)

    def purge_course(self, tenant_origin, course_id):
        """Drop every vault record for one course on one tenant (matched
        on the scope's canvasOrigin + course). Same atomicity as
        purge_tenant. Returns the number of records removed."""
        origin = _normalize_tenant_origin(tenant_origin)
        course = str(course_id).strip()
        if not course:
            raise PrivacyError("learner course id is invalid")
        return self._purge_matching(
            lambda scope: scope.get("canvasOrigin") == origin
            and str(scope.get("course")) == course,
            "course %s on tenant %s" % (course, origin))

    def _purge_matching(self, matches, label):
        if self._path == ":memory:":
            state = self._state
            doomed = [k for k, e in state["entries"].items()
                      if matches(e["scope"])]
            for key in doomed:
                entry = state["entries"].pop(key)
                state["by_token"].pop(entry["token"], None)
                state["by_label"].pop(
                    "%s\x00%s" % (scope_key(entry["scope"]),
                                  entry["label"]), None)
            return len(doomed)
        with _file_lock(self._path):
            state = self._read_current_state()
            doomed = [k for k, e in state["entries"].items()
                      if matches(e["scope"])]
            if not doomed:
                return 0
            kept = [e for k, e in state["entries"].items()
                    if k not in set(doomed)]
            new_state = {"entries": {}, "by_token": {}, "by_label": {},
                         "next_label_by_scope": dict(
                             state["next_label_by_scope"])}
            for entry in kept:
                key = identity_key(entry["scope"], entry["identity"])
                new_state["entries"][key] = entry
                new_state["by_token"][entry["token"]] = entry
                new_state["by_label"]["%s\x00%s" % (
                    scope_key(entry["scope"]), entry["label"])] = entry
            _persist_vault_state(self._path, self._key.view(),
                                 new_state)
            self._state = new_state
            return len(doomed)


def _normalize_tenant_origin(value):
    """Normalize a tenant base/origin the way the privacy boundary does
    (privacy/boundary.py SourceMcpPrivacyBoundary._context): lowercase
    host, default ports dropped, http(s) only. Labels purge against the
    exact canvasOrigin stored on each scope."""
    import urllib.parse
    parts = urllib.parse.urlparse(str(value or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PrivacyError(
            "learner tenant origin is invalid: %r" % (value,))
    host = parts.hostname.lower()
    port = parts.port
    if (parts.scheme == "https" and port == 443) \
            or (parts.scheme == "http" and port == 80):
        port = None
    return "%s://%s%s" % (parts.scheme, host,
                           (":%d" % port) if port else "")


# ---------------------------------------------------------------------------
# LearnerRoster: local, exact-scope roster index used only before learner
# text crosses the boundary.
# ---------------------------------------------------------------------------

class LearnerRoster:
    def __init__(self):
        self._entries_by_scope = {}
        self._registered_at = {}

    def register(self, scope_value, identities):
        import time as _time
        scope = exact_scope(scope_value)
        if not isinstance(identities, list):
            raise TypeError("learner roster is invalid")
        entries = {}
        for value in identities:
            identity = exact_identity(value)
            if identity["id"] in entries:
                raise TypeError("learner roster contains conflicting identities")
            entries[identity["id"]] = identity
        key = scope_key(scope)
        self._entries_by_scope[key] = entries
        self._registered_at[key] = _time.time()

    def is_ready(self, scope_value):
        import time as _time
        key = scope_key(exact_scope(scope_value))
        registered_at = self._registered_at.get(key)
        if registered_at is None:
            return False
        now = _time.time()
        return now >= registered_at and now - registered_at <= 60

    def identities(self, scope_value):
        entries = self._entries_by_scope.get(scope_key(exact_scope(scope_value)))
        if entries is None:
            return []
        return [dict(identity) for identity in entries.values()]

    def observe(self, scope_value, identities):
        scope = exact_scope(scope_value)
        key = scope_key(scope)
        existing = self._entries_by_scope.get(key)
        if existing is None:
            raise PrivacyError("learner_roster_scope_unavailable")
        nxt = dict(existing)
        for value in identities:
            identity = exact_identity(value)
            prior = nxt.get(identity["id"])
            if prior is None:
                raise PrivacyError("learner_roster_identity_unavailable")
            nxt[identity["id"]] = _merge_learner_identity(prior, identity)
        self._entries_by_scope[key] = nxt


def _merge_learner_identity(left, right):
    if left["id"] != right["id"]:
        raise TypeError("learner identity does not match")
    for field in ("name", "email", "loginId", "sisUserId"):
        if left.get(field) and right.get(field) and left[field] != right[field]:
            known = [_normalize_alias(a) for a in
                     (left.get("aliases") or [])
                     + (list(_learner_name_aliases(left))
                        if field == "name" else [])]
            if _normalize_alias(right[field]) not in known:
                raise PrivacyError("learner_roster_identity_conflict")
    merged = {"id": left["id"]}
    aliases = []
    for alias in (left.get("aliases") or []) + (right.get("aliases") or []):
        if alias not in aliases:
            aliases.append(alias)
    if aliases:
        merged["aliases"] = aliases
    for field in ("name", "email", "loginId", "sisUserId"):
        value = left.get(field) or right.get(field)
        if value:
            merged[field] = value
    return merged

# ---------------------------------------------------------------------------
# Alias machinery
# ---------------------------------------------------------------------------

# Confusable folding + format-char stripping (W2-P0-12, W2-P0-13).
#
# Divergence (documented): the TypeScript source normalizes aliases with
# NFKC + whitespace collapse + lower only. This port additionally folds a
# focused Latin/Cyrillic/Greek confusable table (the same pairs as
# privacy/pseudonym.py::_confusables, the other de-id lane in this tree)
# and strips Unicode format characters (category Cf: zero-width spaces,
# joiners, BOM, word joiner, soft hyphen, bidi marks), because both defeat
# alias matching with visually identical names. The stdlib ships no
# confusables map, so the focused table below is curated for the
# lookalike scripts actually observed in adversarial testing; it is
# pinned by selftests (homoglyph + zero-width regression cases).
def _confusable_fold_table():
    pairs = [
        # Cyrillic lookalikes -> Latin
        ("\u0430", "a"), ("\u0410", "a"),  # a
        ("\u0435", "e"), ("\u0415", "e"),  # e
        ("\u0451", "e"), ("\u0401", "e"),  # yo -> e
        ("\u0456", "i"), ("\u0406", "i"),  # i
        ("\u0458", "j"), ("\u0408", "j"),  # je -> j
        ("\u043e", "o"), ("\u041e", "o"),  # o
        ("\u0440", "p"), ("\u0420", "p"),  # er -> p
        ("\u0441", "c"), ("\u0421", "c"),  # es -> c
        ("\u0445", "x"), ("\u0425", "x"),  # kha -> x
        ("\u0443", "y"), ("\u0423", "y"),  # u -> y
        ("\u043a", "k"), ("\u041a", "k"),  # ka -> k
        ("\u043c", "m"), ("\u041c", "m"),  # em -> m
        ("\u043d", "h"), ("\u041d", "h"),  # en -> h
        ("\u0442", "t"), ("\u0422", "t"),  # te -> t
        ("\u0432", "b"), ("\u0412", "b"),  # ve -> b
        # Greek lookalikes -> Latin
        ("\u03b1", "a"), ("\u0391", "a"),  # alpha -> a
        ("\u03b5", "e"), ("\u0395", "e"),  # epsilon -> e
        ("\u03b9", "i"), ("\u0399", "i"),  # iota -> i
        ("\u03bf", "o"), ("\u039f", "o"),  # omicron -> o
        ("\u03c1", "p"), ("\u03a1", "p"),  # rho -> p
        ("\u03c5", "y"), ("\u03a5", "y"),  # upsilon -> y
        ("\u03ba", "k"), ("\u039a", "k"),  # kappa -> k
        ("\u03bc", "m"), ("\u039c", "m"),  # mu -> m
        ("\u03b7", "n"), ("\u0397", "n"),  # eta -> n
        ("\u03c4", "t"), ("\u03a4", "t"),  # tau -> t
        ("\u03c7", "x"), ("\u03a7", "x"),  # chi -> x
        ("\u03bd", "v"), ("\u039d", "v"),  # nu -> v
        ("\u03b6", "z"), ("\u0396", "z"),  # zeta -> z
        ("\u03c9", "w"), ("\u03a9", "w"),  # omega -> w
    ]
    return dict(pairs)


_CONFUSABLE_FOLD = _confusable_fold_table()

# A roster and a course often spell one name with and without accents
# ("Jose Alvarez", "José Álvarez"), and text pasted from a word processor
# carries typographic apostrophes ("O\u2019Brien"). Matching compares base
# letters: accents are dropped (NFD, then the combining marks), letters
# NFD keeps whole fold to the base letters a plain spelling uses, and
# every apostrophe reads as the straight one.
LETTER_FOLD = {
    "\u0142": "l", "\u0141": "L", "\u00f8": "o", "\u00d8": "O",
    "\u0111": "d", "\u0110": "D", "\u0131": "i", "\u00df": "ss",
    "\u00e6": "ae", "\u00c6": "AE", "\u0153": "oe", "\u0152": "OE",
    "\u00fe": "th", "\u00de": "TH",
}
APOSTROPHES = frozenset({"\u2019", "\u2018", "\u02bc", "\u02bb",
                         "\uff07"})


@functools.lru_cache(maxsize=8192)
def base_letters(char):
    """char with its accents dropped and a whole-letter fold applied
    (\u00e9 -> e, \u0141 -> L, \u00df -> ss); case is kept."""
    return "".join(LETTER_FOLD.get(part, part)
                   for part in unicodedata.normalize("NFD", char)
                   if unicodedata.category(part) != "Mn")


@functools.lru_cache(maxsize=8192)
def _fold_char(char):
    """What one character contributes to alias matching: base letters
    (accents dropped), lookalike letters folded (W2-P0-12), every
    apostrophe straight, invisible format characters dropped
    (W2-P0-13), lowercase."""
    out = []
    for part in base_letters(char):
        part = _CONFUSABLE_FOLD.get(part, part)
        if part in APOSTROPHES:
            part = "'"
        # Category Cf: zero-width space/joiner/non-joiner, BOM, word
        # joiner, soft hyphen, bidi marks. Invisible in rendering; their
        # only effect here would be to defeat matching.
        if unicodedata.category(part) == "Cf":
            continue
        out.append(part.lower())
    return "".join(out)


def _normalize_alias(value):
    """Alias key normalization: NFKC, then each character folded
    (_fold_char), whitespace collapsed."""
    folded = "".join(_fold_char(char)
                     for char in unicodedata.normalize("NFKC", value))
    return re.sub(r"\s+", " ", folded.strip()).lower()


def _fold_match_text(text):
    """Confusable-fold + strip format chars for alias matching.

    Returns (folded, index_map): folded[i] came from text[index_map[i]].
    The alias matcher runs on the folded form; match spans map back
    through index_map to view-text positions, then through the view's
    source spans to exact source ranges for splicing.

    The input is view text from _normalized_identity_text_view, which is
    already NFKC-normalized upstream. This function deliberately does NOT
    re-apply NFKC: whole-string NFKC is not position-preserving (it can
    expand ligatures or compose combining marks), so re-applying it here
    would make index_map point at the wrong source positions. The fold
    is strictly per-character (_fold_char: accents dropped, confusable
    map, apostrophes, Cf strip, lower; an expansion such as \u00df -> ss
    is tracked per source char), so the mapping stays exact.
    """
    folded = []
    index_map = []
    for i, char in enumerate(text):
        for out in _fold_char(char):
            folded.append(out)
            index_map.append(i)
    return "".join(folded), index_map


# Generational suffixes: never a given name or a surname. Roman numerals
# stop at IV so a real surname such as "Vi" is never dropped.
_NAME_SUFFIXES = frozenset({"jr", "sr", "jnr", "snr", "ii", "iii", "iv"})


def _without_name_suffixes(name):
    """The name without its generational suffixes ("Martin Luther King
    Jr." -> "Martin Luther King", "King, Jr., Martin" -> "King, Martin").
    The first word is never a suffix, and a suffix stays when dropping it
    would leave a single word."""
    kept = []
    for i, token in enumerate(name.split()):
        if i and token.strip(".,").lower() in _NAME_SUFFIXES:
            # "King Jr., Martin": the suffix carried the name's comma.
            if token.endswith(",") and not kept[-1].endswith(","):
                kept[-1] += ","
            continue
        kept.append(token)
    if len([t for t in kept if t.strip(",")]) < 2:
        return " ".join(name.split())
    kept[-1] = kept[-1].rstrip(",")
    return " ".join(kept)


def _surname_of_name(normalized):
    """Last whitespace-separated token of a normalized full name, when it
    is a plausible surname (2+ letters, and the name is not a single
    word). Comma form ("Thornton, Alice"): the token before the comma.
    Generational suffixes (Jr., III) are never the surname."""
    normalized = _without_name_suffixes(normalized)
    if "," in normalized:
        head = normalized.split(",", 1)[0].strip().split()
        candidate = head[-1] if head else ""
    else:
        parts = normalized.split(" ")
        candidate = parts[-1] if len(parts) >= 2 else ""
    if not candidate:
        return ""
    letters = sum(1 for c in candidate
                  if unicodedata.category(c).startswith("L"))
    return candidate if letters >= 2 else ""


def _learner_name_aliases(identity):
    name = identity.get("name")
    if not name:
        return []
    full = _normalize_alias(name)
    if not full or len(full) > 500:
        return []
    aliases = {full}
    # Given name, surname, and reordered forms come from the name without
    # its generational suffix (Jr., III), which also names the student.
    normalized = _without_name_suffixes(full)
    aliases.add(normalized)
    if "," in normalized:
        given = (normalized.split(",", 1)[1].strip().split() or [""])[0]
    else:
        given = normalized.split()[0]
    letters = sum(1 for c in given if unicodedata.category(c).startswith("L"))
    if letters >= 2:
        aliases.add(given)
    comma = re.match(r"^([^,]+),\s*(.+)$", normalized)
    if comma:
        aliases.add("%s %s" % (comma.group(2), comma.group(1)))
    else:
        parts = normalized.split(" ")
        if len(parts) == 2:
            aliases.add("%s %s" % (parts[1], parts[0]))
    # W2-P1-2: the bare surname is identifying within a course roster
    # ("Thornton said the quiz was easy."). Redact it too, word-boundary
    # and case-insensitive like every other alias (the same
    # confusable/zero-width normalization applies).
    surname = _surname_of_name(normalized)
    if surname:
        aliases.add(surname)
    return sorted(aliases)


def _escape_regexp(value):
    return re.escape(value)


def _add_alias(aliases, alias, token, partial_surnames=(),
               name_token=False):
    """Register one alias key. partial_surnames (W2-P0-13): when the alias
    is a given-name-only form that never names the surname, the surname(s)
    it belongs to are recorded so a later match adjacent to the real
    surname extends the redaction instead of pairing the pseudonym with
    the surname. name_token (W3 follow-up): the alias is a single-word
    person-name fragment (a bare surname or bare given name) that can
    also be an ordinary word; the matcher then requires the source span
    to read like a name (capitalized) before rewriting it."""
    key = _normalize_alias(alias)
    if not key:
        return
    existing = aliases.get(key)
    if existing is None:
        entry = {"token": token}
        if partial_surnames:
            entry["partial_surnames"] = set(partial_surnames)
        if name_token:
            entry["name_token"] = True
        aliases[key] = entry
        return
    if existing["token"] != token:
        existing["token"] = None
    if partial_surnames:
        existing.setdefault("partial_surnames", set()).update(
            partial_surnames)
    if name_token:
        existing["name_token"] = True


def _alias_trie_expression(candidates):
    """One expression for every alias, as a character trie: a course
    roster has thousands of aliases, and a flat alternation tries each
    one at every position. At each node the longer continuations come
    before ending there, so the longest alias the text holds matches
    (the text allows at most one branch per character). A space in an
    alias matches any run of whitespace."""
    trie = {}
    for candidate in candidates:
        node = trie
        for char in candidate:
            node = node.setdefault(char, {})
        node[None] = True

    def emit(node):
        branches = [(r"\s+" if char == " " else _escape_regexp(char))
                    + emit(child)
                    for char, child in sorted(
                        (k, v) for k, v in node.items() if k is not None)]
        if not branches:
            return ""
        if len(branches) == 1 and None not in node:
            return branches[0]
        return "(?:%s)%s" % ("|".join(branches), "?" if None in node else "")
    return emit(trie)


def _build_alias_matcher(aliases):
    candidates = [key for key in aliases if key]
    if not candidates:
        return None
    # A name ends at anything but a letter or a digit: "_" separates
    # words in a file name ("Jane_Doe_essay.pdf") as a space does.
    return re.compile(r"(?<![^\W_])(?:%s)(?![^\W_])"
                      % _alias_trie_expression(candidates),
                      re.IGNORECASE | re.UNICODE)


# ---------------------------------------------------------------------------
# Normalized identity text view: a match-only representation of text where
# every character retains the exact source range it came from, so learner
# redaction recognizes copied HTML and percent escapes without reserializing
# unrelated URL or HTML bytes.
# ---------------------------------------------------------------------------

_IDENTITY_NAMED_ENTITIES = {"nbsp": " ", "amp": "&", "quot": '"', "apos": "'"}


def _append_code_points(atoms, text, start, end):
    for point in text:
        atoms.append({"text": point, "start": start, "end": end})


def _percent_triplet_at(value, offset):
    triplet = value[offset:offset + 3]
    if not re.match(r"^%[0-9a-fA-F]{2}$", triplet):
        return None
    return int(triplet[1:], 16)


def _utf8_scalar_byte_length(first):
    if first <= 0x7F:
        return 1
    if 0xC2 <= first <= 0xDF:
        return 2
    if 0xE0 <= first <= 0xEF:
        return 3
    if 0xF0 <= first <= 0xF4:
        return 4
    return None


def _append_percent_escapes(atoms, value, start, end):
    cursor = start
    while cursor < end:
        first = _percent_triplet_at(value, cursor)
        if first is None:
            raise PrivacyError("percent escape run is invalid")
        width = _utf8_scalar_byte_length(first)
        scalar_end = cursor if width is None else cursor + width * 3
        valid = (width is not None and scalar_end <= end and all(
            (b := _percent_triplet_at(value, cursor + (i + 1) * 3)) is not None
            and 0x80 <= b <= 0xBF
            for i in range(width - 1)))
        if valid:
            try:
                source = value[cursor:scalar_end]
                decoded = bytes(
                    int(source[i + 1:i + 3], 16)
                    for i in range(0, len(source), 3)).decode("utf-8")
                if len(decoded) == 1:
                    _append_code_points(atoms, decoded, cursor, scalar_end)
                    cursor = scalar_end
                    continue
            except (UnicodeDecodeError, ValueError):
                pass
        _append_code_points(atoms, value[cursor:cursor + 3], cursor, cursor + 3)
        cursor += 3


def _grapheme_clusters(text):
    """Approximation of Intl.Segmenter grapheme segmentation: a base
    character plus its following combining marks. Documented divergence
    from full UAX-29 (emoji ZWJ sequences etc. are not merged)."""
    clusters = []
    for char in text:
        if unicodedata.combining(char) and clusters:
            clusters[-1] += char
        else:
            clusters.append(char)
    return clusters


def _normalized_identity_text_view(value):
    if "%" not in value and "&" not in value \
            and unicodedata.normalize("NFKC", value) == value:
        return {"text": value, "spans": None}
    atoms = []
    cursor = 0
    while cursor < len(value):
        entity = re.match(r"&#(?:x([0-9a-fA-F]+)|([0-9]+));",
                          value[cursor:], re.IGNORECASE)
        if entity:
            point = int(entity.group(1) or entity.group(2),
                        16 if entity.group(1) else 10)
            if 0 <= point <= 0x10FFFF:
                try:
                    _append_code_points(atoms, chr(point), cursor,
                                        cursor + len(entity.group(0)))
                    cursor += len(entity.group(0))
                    continue
                except (ValueError, OverflowError):
                    pass
        named = re.match(r"&([a-zA-Z]+);", value[cursor:])
        if named:
            decoded = _IDENTITY_NAMED_ENTITIES.get(named.group(1).lower())
            if decoded is not None:
                _append_code_points(atoms, decoded, cursor,
                                    cursor + len(named.group(0)))
                cursor += len(named.group(0))
                continue
        if re.match(r"%[0-9a-fA-F]{2}", value[cursor:], re.IGNORECASE):
            end = cursor
            while re.match(r"%[0-9a-fA-F]{2}", value[end:end + 3],
                           re.IGNORECASE):
                end += 3
            _append_percent_escapes(atoms, value, cursor, end)
            cursor = end
            continue
        atoms.append({"text": value[cursor], "start": cursor,
                      "end": cursor + 1})
        cursor += 1
    source_text = "".join(atom["text"] for atom in atoms)
    source_spans = []
    for atom in atoms:
        source_spans.extend([(atom["start"], atom["end"])] * len(atom["text"]))
    # Map each cluster back to source spans positionally.
    out_atoms = []
    pos = 0
    for cluster in _grapheme_clusters(source_text):
        spans = source_spans[pos:pos + len(cluster)]
        pos += len(cluster)
        if not spans:
            continue
        start = min(s[0] for s in spans)
        end = max(s[1] for s in spans)
        for point in unicodedata.normalize("NFKC", cluster):
            out_atoms.append({"text": point, "start": start, "end": end})
    text = "".join(atom["text"] for atom in out_atoms)
    # Spans are per code point in Python (RegExp offsets are UTF-16 in JS;
    # both are self-consistent within their runtime).
    spans = []
    for atom in out_atoms:
        spans.extend([(atom["start"], atom["end"])] * len(atom["text"]))
    return {"text": text, "spans": spans}


def _source_range_for_view(view, start, end):
    if start < 0 or end < start or end > len(view["text"]):
        return None
    if view["spans"] is None:
        return None if start == end else {"start": start, "end": end}
    spans = view["spans"][start:end]
    if not spans:
        return None
    return {"start": min(s[0] for s in spans),
            "end": max(s[1] for s in spans)}


def _apply_source_replacements(value, replacements):
    ordered = sorted(replacements,
                     key=lambda r: (r["start"], -r["end"]))
    cursor = 0
    output = []
    for replacement in ordered:
        if replacement["start"] < cursor \
                or replacement["end"] < replacement["start"]:
            continue
        output.append(value[cursor:replacement["start"]])
        output.append(replacement["replacement"])
        cursor = replacement["end"]
    output.append(value[cursor:])
    return "".join(output)


def _name_token_case_ok(text, start, end):
    """Name-like capitalization check for single-word name fragments.

    A bare surname or given name that is also an ordinary word ("Teacher"
    the surname vs "teacher" the role) is only rewritten when the source
    span reads like a name: the first cased character is uppercase.
    Lowercase hits are unrelated words and are left alone. A span with
    no cased characters at all (caseless scripts) still matches, so a
    real name is never failed open for lack of case."""
    for char in text[start:end]:
        if char.isupper():
            return True
        if char.islower():
            return False
    return True


def _replace_known_aliases(value, aliases, matcher):
    if matcher is None:
        return value
    view = _normalized_identity_text_view(value)
    # W2-P0-12/W2-P0-13: match on the confusable-folded, format-char-free
    # view so homoglyph and zero-width name variants match the folded
    # alias keys; spans map back to exact source ranges for splicing.
    folded, index_map = _fold_match_text(view["text"])
    if not index_map:
        return value
    url_spans = _url_token_spans(value)
    replacements = []
    references = [(m.start(), m.start() + len(m.group(0)))
                  for m in re.finditer(r"\bStudent A[1-9][0-9]*\b", folded,
                                       re.IGNORECASE)]
    for match in matcher.finditer(folded):
        if any(match.start() >= rstart and match.start() < rend
               for rstart, rend in references):
            continue
        entry = aliases.get(_normalize_alias(match.group(0)))
        # W3 follow-up: a single-word name fragment ("Teacher" the
        # surname) also matches ordinary words ("the teacher posted").
        # Only rewrite it when the source span reads like a name: its
        # first cased character is uppercase. Lowercase hits are left
        # alone. Spans with no cased characters (caseless scripts)
        # still match, fail-safe.
        if entry and entry.get("name_token") \
                and not _name_token_case_ok(
                    view["text"], index_map[match.start()],
                    index_map[match.end() - 1] + 1):
            continue
        replacement = entry["token"] if entry and entry["token"] \
            else "[learner]"
        match_start, match_end = match.start(), match.end()
        # W2-P0-13: a partial (given-name-only) alias matched. If the word
        # immediately after or before it is the learner's real surname,
        # extend the redaction to cover the surname too: emitting
        # "Student A1 Thornton" would pair the stable pseudonym with the
        # real surname and de-anonymize the label.
        surnames = entry.get("partial_surnames") if entry else None
        if surnames:
            after = re.match(r"\s*(\w+)", folded[match_end:])
            if after and after.group(1) in surnames:
                match_end += after.end()
            else:
                before = re.search(r"(\w+)\s*$", folded[:match_start])
                if before and before.group(1) in surnames:
                    match_start -= len(folded[:match_start]) - before.start()
        source = _source_range_for_view(
            view, index_map[match_start], index_map[match_end - 1] + 1)
        if source is None:
            continue
        replacements.append({
            "start": source["start"], "end": source["end"],
            "replacement": _url_safe_replacement(source, replacement,
                                                 url_spans)})
    return _apply_source_replacements(value, replacements)


# URL/email-shaped tokens: a de-id rewrite inside one must not corrupt
# the token (".../Alice%20B.%20Thornton" -> ".../Student A1" breaks the
# link). W2-P2-4: redact the name INSIDE the token consistently by
# percent-encoding the pseudonym (".../Student%20A1"); the choice is
# documented in privacy/README.md.
_URL_TOKEN_RE = re.compile(
    r"[A-Za-z][A-Za-z0-9+.-]*://[^\s<>\"'\\\])]+|mailto:[^\s<>\"']+",
    re.IGNORECASE)


def _url_token_spans(value):
    return [(m.start(), m.end()) for m in _URL_TOKEN_RE.finditer(value)]


def _url_safe_replacement(source, replacement, url_spans):
    """Percent-encode the replacement when the matched source range sits
    inside a URL/email token, so the token stays syntactically intact."""
    for start, end in url_spans:
        if start <= source["start"] and source["end"] <= end:
            return urllib.parse.quote(replacement, safe="")
    return replacement


# Round-4 audit H1: Canvas puts a learner's id in URL paths under many
# route names (/grades/<id>, /submissions/<id>, speed_grader?student_id=)
# and a list of route names always misses one. Inside a URL, any whole
# path segment or query value equal to a rostered learner id is that
# learner. The one exception is the segment right after a context root
# (/courses/<id>, /accounts/<id>): by Canvas URL grammar that number is
# the course or account, never a person.
_URL_ID_SEGMENT_RE = re.compile(r"/([0-9]{1,500})(?=[/?#]|$)")
_URL_ID_QUERY_RE = re.compile(r"[?&][^=&#]*=([0-9]{1,500})(?=[&#]|$)")
_URL_CONTEXT_ROOTS = frozenset({"courses", "accounts"})


def _replace_url_learner_ids(value, lookup):
    view = _normalized_identity_text_view(value)
    text = view["text"]
    replacements = []
    for span_start, span_end in _url_token_spans(text):
        url = text[span_start:span_end]
        hits = []
        for match in _URL_ID_SEGMENT_RE.finditer(url):
            before = url[:match.start()].rsplit("/", 1)[-1]
            if before.lower() in _URL_CONTEXT_ROOTS:
                continue
            hits.append(match.span(1))
        hits.extend(m.span(1) for m in _URL_ID_QUERY_RE.finditer(url))
        for start, end in hits:
            token = lookup(url[start:end])
            if not token:
                continue
            source = _source_range_for_view(view, span_start + start,
                                            span_start + end)
            if source is not None:
                replacements.append({
                    "start": source["start"], "end": source["end"],
                    "replacement": urllib.parse.quote(token, safe="")})
    return _apply_source_replacements(value, replacements) \
        if replacements else value


def _replace_known_identity_references(value, identities):
    def lookup(ident):
        entry = identities.get(str(ident).strip())
        return entry["token"] if entry and entry["token"] else None

    patterns = [
        re.compile(r"((?:[\"']?(?:learner|student|user|recipient|enrollment|submission)[_-]?id[\"']?)\s*[:=]\s*[\"']?)([0-9]{1,500})",
                   re.IGNORECASE),
        re.compile(r"((?:\b(?:learner|student|user|recipient|enrollment|submission|grade)\b\s*(?:id\b\s*)?[#:=]\s*))([0-9]{1,500})\b",
                   re.IGNORECASE),
        re.compile(r"(/(?:users|learners|students|grades|submissions)/)"
                   r"([0-9]{1,500})\b", re.IGNORECASE),
    ]
    output = _replace_url_learner_ids(value, lookup)
    for matcher in patterns:
        view = _normalized_identity_text_view(output)
        url_spans = _url_token_spans(output)
        replacements = []
        for match in matcher.finditer(view["text"]):
            token = lookup(match.group(2))
            if not token:
                continue
            start = match.start() + len(match.group(1))
            source = _source_range_for_view(view, start,
                                            start + len(match.group(2)))
            if source is not None:
                replacements.append({
                    "start": source["start"], "end": source["end"],
                    "replacement": _url_safe_replacement(source, token,
                                                         url_spans)})
        output = _apply_source_replacements(output, replacements)
    return output

# ---------------------------------------------------------------------------
# Prepared redaction contexts
# ---------------------------------------------------------------------------

def _learner_text_preparation(context):
    scope = exact_scope(context["learnerScope"])
    if not context["learnerRoster"].is_ready(scope):
        raise PrivacyError("learner_roster_scope_unavailable")
    identities = context["learnerRoster"].identities(scope)
    # W3-P0-11: the per-invocation roster is harvested fresh from each
    # receipt, so a later page carries only its own learners. Seed the
    # alias set from the vault's accumulated identities for this exact
    # scope as well, so a vault-known learner named in free text still
    # projects to her stable label. The per-invocation roster wins on
    # id conflicts (it is the fresher record).
    vault = context.get("learnerVault")
    if vault is not None:
        by_id = {identity["id"]: index
                 for index, identity in enumerate(identities)}
        for identity in vault.identities_for_scope(scope):
            index = by_id.get(identity["id"])
            if index is None:
                by_id[identity["id"]] = len(identities)
                identities.append(identity)
                continue
            # The fresher record keeps its fields, but a name the vault
            # already knows for this learner (a receipt such as
            # bulk_user_tags carries only the id) still projects to her
            # label wherever it appears in free text.
            current = identities[index]
            extra = [value for value in (
                identity.get("name"), identity.get("email"),
                identity.get("loginId"), identity.get("sisUserId"))
                + tuple(identity.get("aliases") or ())
                if isinstance(value, str) and value.strip()
                and value != current.get("name")]
            if extra:
                merged = dict(current)
                merged["aliases"] = list(current.get("aliases") or []) + [
                    value for value in extra
                    if value not in (current.get("aliases") or [])]
                identities[index] = merged
    return {"context": context, "scope": scope,
            "identities": identities}


def _prepared_learner_text_context(preparation, prepared_references):
    context = preparation["context"]
    scope = preparation["scope"]
    identities = preparation["identities"]
    identity_by_id = {identity["id"]: identity for identity in identities}
    tokens_by_id = {}
    identity_by_label = {}
    aliases = {}
    labels = prepared_references["labels"]
    for index, identity in enumerate(identities):
        token = labels[index]
        tokens_by_id[identity["id"]] = {"token": token}
        identity_by_label[token] = identity
        # A bare numeric alias has no person meaning in prose. Typed identity
        # fields and contextual references still resolve it through
        # identity_by_id.
        if not re.match(r"^[0-9]+$", identity["id"]):
            _add_alias(aliases, identity["id"], token)
        name_aliases = _learner_name_aliases(identity)
        surname = _surname_of_name(
            _normalize_alias(identity.get("name") or ""))
        full_name_key = _normalize_alias(identity.get("name") or "")
        for alias in name_aliases:
            # W2-P0-13: a given-name-only alias never names the surname;
            # if text pairs it with the real surname ("Alice Thornton"
            # for roster name "Alice B. Thornton"), the surname is
            # redacted too rather than emitted next to the pseudonym.
            partial = bool(surname) and \
                surname not in _normalize_alias(alias).split(" ")
            # W3 follow-up: a single-word name fragment (bare surname,
            # bare given name) can also be an ordinary word ("Teacher"
            # the role vs "Teacher" the surname). Mark it so the
            # matcher requires name-like capitalization. A single-word
            # FULL name is the whole identity, not a fragment, and
            # stays case-insensitive.
            alias_key = _normalize_alias(alias)
            name_token = " " not in alias_key and alias_key != full_name_key
            _add_alias(aliases, alias, token,
                       partial_surnames=(surname,) if partial else (),
                       name_token=name_token)
        if identity.get("email"):
            _add_alias(aliases, identity["email"], token)
        if identity.get("loginId"):
            _add_alias(aliases, identity["loginId"], token)
        if identity.get("sisUserId"):
            _add_alias(aliases, identity["sisUserId"], token)
        for alias in identity.get("aliases") or []:
            _add_alias(aliases, alias, token)
    prepared = {"learnerRoster": context["learnerRoster"],
                "learnerVault": context["learnerVault"],
                "learnerScope": scope,
                "identities": identities,
                "identityById": identity_by_id,
                "tokensById": tokens_by_id,
                "aliases": aliases,
                "aliasMatcher": _build_alias_matcher(aliases),
                "referenceLabels": prepared_references["reference_labels"],
                "identityByLabel": identity_by_label}
    if context.get("allowUnrosteredCanvasIdentities") is True:
        prepared["allowUnrosteredCanvasIdentities"] = True
    if context.get("addresses"):
        prepared["addresses"] = context["addresses"]
    return prepared


def _prepare_learner_text_contexts(contexts):
    preparations = [_learner_text_preparation(c) for c in contexts]
    output = [None] * len(preparations)
    by_vault = {}
    for index, preparation in enumerate(preparations):
        vault = preparation["context"]["learnerVault"]
        by_vault.setdefault(id(vault), []).append((index, preparation, vault))
    for _vid, grouped in by_vault.items():
        vault = grouped[0][2]
        references = vault.prepare_text_reference_sets(
            [{"scope": p["scope"], "identities": p["identities"]}
             for _, p, _v in grouped])
        for group_index, (index, preparation, _v) in enumerate(grouped):
            output[index] = _prepared_learner_text_context(
                preparation, references[group_index])
    return output


def _prepare_learner_text_context(context):
    return _prepare_learner_text_contexts([context])[0]


def redact_known_learner_text(value, context):
    """Replace only identities registered for this exact roster scope. Does
    not try to infer arbitrary names."""
    if not isinstance(value, str):
        raise TypeError("learner text is invalid")
    return _redact_known_learner_text_prepared(
        value, _prepare_learner_text_context(context))


_MOODLE_CAPABILITY_RE = re.compile(r"^(?:moodle|mod|block|enrol|report)/[a-z_]+:[a-z_]+$")
_TOKEN_LABEL_RE = re.compile(
    r"\b(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b")
_WHOLE_ID_RE = re.compile(r"^[0-9]+$")


def _redact_known_learner_text_prepared(value, exact_context,
                                        whole_numeric_id_is_identity=True):
    if _MOODLE_CAPABILITY_RE.match(value):
        return value
    if re.match(r"^\s*[\[{]", value):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        if isinstance(parsed, (list, dict)):
            return json.dumps(
                _redact_learner_egress_prepared(parsed, exact_context),
                ensure_ascii=False, separators=(",", ":"))

    def _normalize_reference(match):
        reference = match.group(0)
        label = exact_context["referenceLabels"].get(reference)
        if not label:
            raise PrivacyError("learner_roster_identity_unavailable")
        return label

    value = _TOKEN_LABEL_RE.sub(_normalize_reference, value)
    # A string that is exactly a numeric platform id names a person: a
    # recipient list entry or a cache value carries people that way, with
    # nothing around the number to say so.
    whole_id = value.strip()
    if whole_numeric_id_is_identity and _WHOLE_ID_RE.match(whole_id) \
            and whole_id in exact_context["tokensById"]:
        entry = exact_context["tokensById"][whole_id]
        value = value.replace(whole_id,
                              entry["token"] if entry["token"] else "[learner]")
    return _replace_known_identity_references(
        _replace_known_aliases(value, exact_context["aliases"],
                               exact_context["aliasMatcher"]),
        exact_context["tokensById"])


_UNROSTERED_EMAIL_RE = re.compile(
    r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", re.IGNORECASE)

# W2-P1-1: surgical redaction replaces the old whole-read refusal.
# SOFT patterns are instructional shapes that get redacted in place
# (redact the sensitive SPAN, keep the read). HARD patterns are
# credential-shaped values that still refuse loudly (data: URLs with
# real base64 payloads, live bearer tokens, real cookies). Divergence
# from the old behavior and the "secret-shaped text is refused
# wholesale" policy line is documented in privacy/README.md and
# privacy/FERPA_POLICY.md.
_SENSITIVE_SOFT_RE = re.compile(
    r"data:[^,;]{0,200};base64,[A-Za-z0-9+/=]{0,31}"
    r"|(?<![a-z0-9])csrf(?![a-z0-9])"
    r"|(?<![a-z0-9])token=[\"\']?[A-Za-z0-9._~+/-]{0,19}"
    r"(?![A-Za-z0-9._~+/-])"
    r"|<[^>]+(?:hidden|display\s*:\s*none)",
    re.IGNORECASE)

# HARD refusals stay loud: a bearer credential, a cookie value, a
# token= with a credential-length value, or a data: URL carrying a
# real base64 payload is actual-credential-shaped material, not
# instructional text. (Short "token=" examples, csrf mentions, hidden
# fields, and short teaching data: URLs are SOFT and get redacted in
# place.)
_SENSITIVE_HARD_RE = re.compile(
    r"(?<![a-z0-9])bearer\s+[A-Za-z0-9._~+/-]{8,}"
    r"|(?<![a-z0-9])cookie\s*=\s*[\"\']?[A-Za-z0-9._~+/-]{8,}"
    r"|(?<![a-z0-9])token=[\"\']?[A-Za-z0-9._~+/-]{20,}"
    r"|data:[^,;]{0,200};base64,[A-Za-z0-9+/=]{32,}",
    re.IGNORECASE)


def _scrub_sensitive_spans(value):
    """W2-P1-1: redact sensitive-shaped spans in place and return
    (scrubbed, refused): refused is True only for hard
    credential-shaped material."""
    view = _normalized_identity_text_view(value)
    if _SENSITIVE_HARD_RE.search(view["text"]):
        return value, True
    replacements = []
    for match in _SENSITIVE_SOFT_RE.finditer(view["text"]):
        source = _source_range_for_view(view, match.start(), match.end())
        if source is not None:
            replacements.append({"start": source["start"],
                                 "end": source["end"],
                                 "replacement": "[redacted]"})
    scrubbed = _apply_source_replacements(value, replacements) \
        if replacements else value
    return scrubbed, False


def _contains_sensitive_text(value):
    # Hard credential-shaped material refuses the read. Inspect the
    # canonical match view so encoded credentials remain refused without
    # rewriting a safe URL. Soft shapes are redacted by
    # _scrub_sensitive_spans instead of refused.
    return bool(_SENSITIVE_HARD_RE.search(
        _normalized_identity_text_view(value)["text"]))


def _without_unrostered_addresses(value, mode="remove"):
    if mode == "refuse":
        if _UNROSTERED_EMAIL_RE.search(
                _normalized_identity_text_view(value)["text"]):
            raise PrivacyError("privacy_sensitive_text_refused")
        return value
    view = _normalized_identity_text_view(value)
    replacements = []
    for match in _UNROSTERED_EMAIL_RE.finditer(view["text"]):
        source = _source_range_for_view(view, match.start(), match.end())
        if source is not None:
            replacements.append({"start": source["start"],
                                 "end": source["end"],
                                 "replacement": "[address removed]"})
    return _apply_source_replacements(value, replacements) \
        if replacements else value


def _project_non_identity_text(value, exact_context):
    # A string under a measure- or status-shaped key is still provider
    # controlled; its key shape only says a bare number there is not a
    # person, never exempts the value from roster redaction.
    redacted = _redact_known_learner_text_prepared(
        value, exact_context, whole_numeric_id_is_identity=False) \
        if exact_context is not None else value
    output = _without_unrostered_addresses(
        redacted, exact_context.get("addresses") if exact_context else None)
    # W2-P1-1: redact sensitive spans surgically; refuse only
    # credential-shaped material.
    scrubbed, refused = _scrub_sensitive_spans(output)
    if refused:
        raise PrivacyError("privacy_sensitive_text_refused")
    # W3-P0-10: bare base64 blobs in ordinary text can hide roster
    # identifiers (the legacy pseudonym lane masked these via
    # _mask_b64; the shipped lane dropped it). Decode each candidate,
    # mask the roster identities inside, and re-encode. Runs after the
    # sensitive scrub so credential-shaped data: URLs still refuse
    # loudly instead of being quietly rewritten.
    if exact_context is None:
        return scrubbed
    return _mask_base64_identity_blobs(scrubbed, exact_context)


# W3-P0-10: bare base64 blobs in ordinary text fields. The only in-tree
# reference for this defense is the legacy
# privacy/pseudonym.py::Deidentifier._mask_b64 (decode, mask the inside,
# re-encode); this is the shipped pipeline's port of that step.
#
# W3 follow-up (threshold): the scan starts at 20 encoded characters
# (15 decoded bytes), lowered from 40. A rewrite fires only when the
# decoded UTF-8 text literally contains a roster alias as a word, so
# non-identity blobs come back byte-identical at any threshold. Measured
# 2026-09-21 over 2.9 MB of realistic text (the repo's own docs, KB, and
# source: the text most like what this boundary sees), with the Alice
# roster loaded: zero rewrites at thresholds 40, 28, 20, 16, and 12,
# and sub-second scan cost at every level. 20 covers every realistic
# identity payload (a full name or email is 15+ bytes: "Alice B.
# Thornton" is 17 bytes / 24 encoded chars; "alice@example.edu" is 17 /
# 24), while 12 and 16 scan 3-8x more candidates for only
# given-name-fragment coverage.
#
# Residual risk (documented, not silent): blobs shorter than 20 chars
# (under 15 decoded bytes) are not scanned, so a lone short given name
# ("Amy" is 8 encoded chars) or a lone short numeric id encoded by
# itself still passes through. Chunked exfiltration also evades the
# scan: a payload split into sub-20-char chunks decodes independently
# per chunk, so a chunk carrying only a bare surname is not caught.
_B64_IDENTITY_BLOB_RE = re.compile(r"[A-Za-z0-9+/]{20,}={0,2}")


def _mask_base64_identity_blobs(value, exact_context):
    """Decode bare base64 candidates, mask roster identities inside with
    the same text pipeline, and re-encode. A candidate that does not
    strict-decode, is not UTF-8 text, or whose decoded text carries no
    roster identity is returned byte-identical."""
    def _replace(match):
        segment = match.group(0)
        try:
            raw = base64.b64decode(segment, validate=True)
        except (binascii.Error, ValueError):
            return segment
        try:
            decoded = raw.decode("utf-8")
        except UnicodeDecodeError:
            return segment
        # Nested blobs mask innermost-first; then the roster pipeline
        # masks the identities in the decoded text. The byte-identical
        # fast path compares against the original decode, so a nested
        # masking still propagates outward through re-encoding.
        nested = _mask_base64_identity_blobs(decoded, exact_context)
        masked = _redact_known_learner_text_prepared(nested, exact_context)
        if masked == decoded:
            return segment
        return base64.b64encode(masked.encode("utf-8")).decode("ascii")
    return _B64_IDENTITY_BLOB_RE.sub(_replace, value)


_NON_IDENTITY_SCALAR_RE = re.compile(
    r"^(?:(?:course|assignment|quiz|module|section|file|page|discussion|topic|"
    r"question|item|group|rubric|context|account|target)[_.]?(?:id|count)|"
    r".*(?:score|grade|points|count|total|rows|limit|size|length|percent|"
    r"status|generation|revision|index|timestamp|duration|attempt|page)|"
    r"depth)$",
    re.IGNORECASE)


def _non_identity_scalar(key):
    return bool(_NON_IDENTITY_SCALAR_RE.match(key))


def _snapshot_learner_token(context, identity):
    entry = context["tokensById"].get(identity["id"])
    if entry is not None and entry["token"]:
        return entry["token"]
    return context["learnerVault"].tokenize(context["learnerScope"], identity)


def _snapshot_learner_identity(context, token):
    label = context["referenceLabels"].get(token)
    known = context["identityByLabel"].get(label) if label else None
    if known is not None:
        return known
    return context["learnerVault"].resolve(context["learnerScope"], token)


_LEARNER_KEY_ALLOWLIST = frozenset([
    "schema", "provider", "course", "name", "id", "title", "type", "tool",
    "code", "status", "data", "result", "content", "text", "learnerToken",
    "student", "user", "author", "participant", "students", "users",
    "authors", "participants", "grade", "score",
])


def _redact_learner_key(key, context):
    if key in _LEARNER_KEY_ALLOWLIST:
        return key
    identity = context["identityById"].get(key)
    output = _without_unrostered_addresses(
        _snapshot_learner_token(context, identity) if identity
        else _redact_known_learner_text_prepared(key, context),
        context.get("addresses"))
    # W2-P1-1: surgical redaction; loud refusal only for credentials.
    scrubbed, refused = _scrub_sensitive_spans(output)
    if refused:
        raise PrivacyError("privacy_sensitive_text_refused")
    return scrubbed


_STRUCTURAL_REFERENCE_FIELDS = frozenset([
    "source_binding_id", "sourceBindingId", "course_id", "courseId",
    "batch_id", "batchId", "child_id", "childId", "operation_id",
    "operationId", "approval_id", "approvalId", "operation_key",
    "operationKey", "effect_key", "effectKey", "idempotency_key",
    "idempotencyKey",
])

_IDENTITY_VALUE_FIELDS = frozenset([
    "userid", "learnerid", "studentid", "canvasuserid", "sisuserid",
    "sispersonid", "pseudonymid", "displayname", "studentname",
    "integrationid", "sisid", "idnumber", "profile", "profileurl",
    "avatarurl", "userids", "studentids", "learnerids", "recipientids",
    "participantids", "authorid", "authorids", "email", "primaryemail",
    "loginid", "sisloginid", "firstname", "lastname", "pronouns",
    "avatarimageurl", "accommodations",
])
_PERSON_ID_ARRAY_FIELDS = frozenset([
    "userids", "studentids", "learnerids", "recipientids",
    "participantids", "authorids", "participatinguserids",
    "assignmentvisibility",
])
_IDENTITY_RECORD_VALUE_FIELDS = frozenset([
    "id", "name", "fullname", "username", "sortablename", "shortname",
])
# W3-P0-12: display-name-shaped fields on an unresolvable author record
# project as the generic "Staff" label; every other identity field on
# the record keeps its fail-closed handling (dropped from the output).
_AUTHOR_DISPLAY_NAME_FIELDS = frozenset([
    "displayname", "name", "fullname", "sortablename", "shortname",
])
# W3-P1-8: LTI launch parameters that are identity BY SPEC. Even when
# the person they name is not on the roster, the value must not pass
# through as opaque text. Keys are _normalize_privacy_key forms.
_SPEC_TYPED_IDENTITY_FIELDS = frozenset([
    "lispersonnamefull",
    "lispersonnamegiven",
    "lispersonnamefamily",
    "lispersoncontactemailprimary",
])
_IDENTITY_CONTAINER_KEYS = {
    "learner": "learner", "learners": "learner",
    "student": "student", "students": "student",
    "user": "user", "users": "user", "person": "user", "people": "user",
    "enrollment": "enrollment", "enrollments": "enrollment",
    "submission": "submission", "submissions": "submission",
    "grade": "grade", "grades": "grade", "gradebook": "grade",
    "participant": "user", "participants": "user",
    "author": "author", "authors": "author",
    "lasteditedby": "author", "editor": "author", "createdby": "author",
    "updatedby": "author",
    "recipient": "recipient", "recipients": "recipient",
    "member": "member", "members": "member",
    "membership": "member", "memberships": "member",
}
_SECRET_FIELD_RE = re.compile(
    r"(?:^|_)(?:authorization|bearer|access_token|refresh_token|csrf|cookie|"
    r"secret|credential|jwt)(?:$|_)", re.IGNORECASE)
_SECRET_FIELD_NORMALIZED = frozenset([
    "authorization", "bearer", "accesstoken", "refreshtoken", "csrf",
    "cookie", "secret", "credential", "jwt", "privateattachment",
    "bytesbase64",
])
_IDENTITY_FIELD_SUFFIX_RE = re.compile(
    r"(?:learner|student|user|person|recipient|enrollment|submission)"
    r"(?:id|name|email|login|sis|identifier|uuid|guid)$")
_RESOURCE_KIND_RE = re.compile(
    r"^(?:course|assignment|quiz|module|section|file|page|discussion|topic|"
    r"question|item|group|rubric|context|account)$", re.IGNORECASE)


def _normalize_privacy_key(key):
    return re.sub(r"[\s_-]+", "",
                  unicodedata.normalize("NFKC", key)).lower()


def _is_secret_field(key):
    return bool(_SECRET_FIELD_RE.search(key)) or \
        _normalize_privacy_key(key) in _SECRET_FIELD_NORMALIZED


def _is_identity_value_field(key, record_identity=False):
    normalized = _normalize_privacy_key(key)
    if (record_identity and normalized in _IDENTITY_RECORD_VALUE_FIELDS) \
            or normalized in _IDENTITY_VALUE_FIELDS:
        return True
    return bool(_IDENTITY_FIELD_SUFFIX_RE.search(normalized))


def _identity_record_kind(key):
    return _IDENTITY_CONTAINER_KEYS.get(_normalize_privacy_key(key))


def _has_identity_record_signal(value):
    return any(_is_identity_value_field(key, True) for key in value.keys())


def _normalized_identity_fields(value):
    return {_normalize_privacy_key(key): candidate
            for key, candidate in value.items()}


def _identity_value(fields, keys):
    for key in keys:
        candidate = fields.get(_normalize_privacy_key(key))
        if isinstance(candidate, (str, int)) and not isinstance(candidate, bool):
            normalized = str(candidate).strip()
            if normalized:
                return normalized
    return None


def _learner_identity(value, kind=None, context=None):
    fields = _normalized_identity_fields(value)
    existing_token = fields.get("learnertoken")
    if context is not None and isinstance(existing_token, str):
        identity = _snapshot_learner_identity(context, existing_token)
        current = context["identityById"].get(identity["id"])
        if current is None:
            raise PrivacyError("learner_roster_identity_unavailable")
        return current
    normalized_keys = set(fields.keys())
    # The SIS id is an identifier to label, never the record's primary
    # id: the roster is keyed by the Canvas user id, so taking the SIS
    # id as primary made a roster read refuse whenever it was set.
    direct_id = _identity_value(fields, [
        "user_id", "userId", "learner_id", "learnerId", "student_id",
        "studentId", "canvas_user_id", "canvasUserId"])
    has_person_id = any(k in normalized_keys for k in
                        ("userid", "learnerid", "studentid", "canvasuserid",
                         "sisuserid"))
    has_identity_profile = any(k in normalized_keys for k in
                               ("email", "loginid", "sortablename",
                                "displayname", "fullname", "studentname",
                                "avatarimageurl", "pronouns", "firstname",
                                "lastname"))
    # Round-4 audit L2: an assignment read with include[]=submission is
    # {"id", "name", "submission": {"user_id", ...}}. The person there is
    # the submission's user_id, not the assignment, so a nested
    # submission that names its own user is not a person signal for the
    # record that carries it.
    person_signals = ("grade", "score", "enrollments", "grades",
                      "submission", "attempts")
    nested = fields.get("submission")
    if isinstance(nested, dict) and any(
            _normalize_privacy_key(k) == "userid" for k in nested):
        person_signals = tuple(k for k in person_signals
                               if k != "submission")
    has_generic_signal = (
        (has_person_id and (has_identity_profile or bool(
            direct_id and context is not None
            and direct_id in context["identityById"])))
        or (context is not None and "id" in normalized_keys
            and "name" in normalized_keys
            and any(k in normalized_keys for k in person_signals))
        or (("avatarimageurl" in normalized_keys
             or "pronouns" in normalized_keys)
            and ("name" in normalized_keys
                 or "displayname" in normalized_keys)))
    if kind is None and not has_generic_signal:
        return None
    fallback_id = None
    if (kind or has_generic_signal) and kind not in ("submission", "enrollment"):
        fallback_id = _identity_value(fields, ["id"])
    ident = direct_id or fallback_id
    sis_user_id = _identity_value(fields, ["sis_user_id", "sisUserId"])
    if not ident and sis_user_id and context is not None:
        matches = [candidate["id"]
                   for candidate in context["identityById"].values()
                   if candidate.get("sisUserId") == sis_user_id]
        if len(matches) == 1:
            ident = matches[0]
    if not ident and sis_user_id:
        ident = sis_user_id
    if not ident:
        return None
    identity = {"id": ident}
    name = _identity_value(fields, ["name", "display_name", "displayName",
                                    "full_name", "fullName", "student_name",
                                    "studentName"])
    email = _identity_value(fields, ["email", "primary_email", "primaryEmail"])
    login_id = _identity_value(fields, ["login_id", "loginId"])
    if name:
        identity["name"] = name
    if email:
        identity["email"] = email
    if login_id:
        identity["loginId"] = login_id
    if sis_user_id:
        identity["sisUserId"] = sis_user_id
    return normalize_learner_identity(identity)

# ---------------------------------------------------------------------------
# redactLearnerEgress: sanitizes an arbitrary envelope without applying an
# output allowlist. Preserves envelope shape and non-identity course data,
# while routing every string and nested learner-shaped record through the
# exact-scope roster and vault boundary.
# ---------------------------------------------------------------------------

# W3 follow-up (bare-surname "Teacher" vs role values): role-shaped keys
# carry role labels, never person names. A rostered surname that spells
# a role label ("Teacher", "Student") must not rewrite the role value,
# and the value match is case-insensitive ("teacher" is the same role
# as "Teacher").
_ROLE_VALUE_KEYS = frozenset({"role", "roles"})
_ROLE_LABELS = frozenset({
    "student", "teacher", "ta", "observer", "designer", "admin",
    "non-editing teacher",
})


def redact_learner_egress(value, context):
    return _redact_learner_egress_prepared(
        value, _prepare_learner_text_context(context))


def redact_learner_egress_batch(entries):
    prepared = _prepare_learner_text_contexts(
        [entry["context"] for entry in entries])
    return [_redact_learner_egress_prepared(entry["value"], prepared[index])
            for index, entry in enumerate(entries)]


def _redact_learner_egress_prepared(value, exact_context):
    def walk(candidate, depth=0, kind=None, inherited_learner_privacy=False,
             scalar_key=""):
        if depth > MAX_PRIVACY_OUTPUT_DEPTH:
            raise PrivacyError("privacy_output_depth_exceeded")
        if isinstance(candidate, bool):
            return candidate
        if isinstance(candidate, (int, float)):
            # redactLearnerNumber sees every JSON number; String(value) in
            # JS matches Python str() for the integer ids the roster uses.
            if isinstance(candidate, float) and not math.isfinite(candidate):
                return candidate
            number_key = str(int(candidate)) \
                if isinstance(candidate, float) and candidate.is_integer() \
                else str(candidate)
            if _non_identity_scalar(scalar_key):
                return candidate
            identity = exact_context["identityById"].get(number_key)
            if identity is None:
                return candidate
            return _snapshot_learner_token(exact_context, identity)
        if isinstance(candidate, str):
            if scalar_key in _STRUCTURAL_REFERENCE_FIELDS:
                # A structural reference names an object, never a person.
                structural = _without_unrostered_addresses(
                    candidate, exact_context.get("addresses"))
                # W2-P1-1: surgical redaction; loud refusal only for
                # credentials.
                scrubbed, refused = _scrub_sensitive_spans(structural)
                if refused:
                    raise PrivacyError("privacy_sensitive_text_refused")
                return scrubbed
            if _non_identity_scalar(scalar_key):
                return _project_non_identity_text(candidate, exact_context)
            if scalar_key == "schema" and re.match(
                    r"^morrow\.[a-z0-9.-]+\.v[0-9]+$", candidate):
                return candidate
            if scalar_key == "provider" and candidate in (
                    "canvas", "moodle", "blackboard"):
                return candidate
            if _normalize_privacy_key(scalar_key) in _ROLE_VALUE_KEYS \
                    and candidate.strip().lower() in _ROLE_LABELS:
                # A role label under a role-shaped key is structured
                # data about the enrollment, never a person mention,
                # even when a rostered surname spells the same word.
                return candidate
            output = _without_unrostered_addresses(
                _redact_known_learner_text_prepared(candidate, exact_context),
                exact_context.get("addresses"))
            # W2-P1-1: surgical redaction; loud refusal only for
            # credentials.
            scrubbed, refused = _scrub_sensitive_spans(output)
            if refused:
                raise PrivacyError("privacy_sensitive_text_refused")
            # W3-P0-10: bare base64 blobs in ordinary text can hide
            # roster identifiers. Runs after the sensitive scrub so
            # credential-shaped data: URLs still refuse loudly.
            # W3-P1-8: spec-typed identity fields (LTI lis_person_*)
            # name a person by spec. When neither the roster pipeline
            # nor unrostered-address removal changed the value, the
            # field names an unrostered person: replace it with a
            # generic token instead of passing it through as opaque
            # text. (A rostered person's name already became their
            # label above.)
            if _normalize_privacy_key(scalar_key) in \
                    _SPEC_TYPED_IDENTITY_FIELDS \
                    and candidate.strip() and scrubbed == candidate:
                return "[redacted]"
            return _mask_base64_identity_blobs(scrubbed, exact_context)
        if isinstance(candidate, list):
            return [walk(entry, depth + 1, kind, inherited_learner_privacy,
                         scalar_key) for entry in candidate]
        if not is_json_object(candidate):
            return candidate
        if (candidate.get("type") in ("image", "audio")
                or candidate.get("encoding") == "base64") \
                and isinstance(candidate.get("data"), str):
            raise PrivacyError("privacy_opaque_artifact_refused")
        learner = _learner_identity(candidate, kind, exact_context)
        detected_identity = learner is not None
        may_scrub = exact_context.get("allowUnrosteredCanvasIdentities") is True \
            and (kind is not None or detected_identity)
        # W3-P0-12: an author record the roster cannot resolve (a teacher
        # or other non-roster person, e.g. on a submission comment)
        # fails closed on the NAME but stays open on availability: the
        # display name projects as the generic "Staff" label and the
        # rest of the record projects normally, instead of refusing the
        # whole read.
        unresolvable_author = (
            kind == "author" and not may_scrub and len(candidate) != 0
            and _has_identity_record_signal(candidate)
            and (learner is None
                 or exact_context["identityById"].get(learner["id"]) is None))
        if unresolvable_author:
            detected_identity = True
            learner = None
        elif kind and not learner and len(candidate) != 0 \
                and not inherited_learner_privacy \
                and _has_identity_record_signal(candidate):
            # W3 follow-up: the refusal fires only when the record
            # carries at least one identity field (id, name, email,
            # login, ...). A dict under a person-container key with no
            # identity fields at all (an id-less submission carrying
            # only a score and a grade, an enrollment carrying only its
            # type) is not a person record; refusing it broke
            # legitimate reads. Its children still walk the full text
            # pipeline below, so any name smuggled inside is redacted.
            raise PrivacyError("privacy_identity_record_unresolved")
        if learner is not None:
            current = exact_context["identityById"].get(learner["id"])
            if current is None:
                if not may_scrub:
                    raise PrivacyError("learner_roster_identity_unavailable")
                learner = None
            else:
                learner = _merge_learner_identity(current, learner)
        kind_value = candidate.get("kind")
        resource_kind = kind_value \
            if isinstance(kind_value, str) and _RESOURCE_KIND_RE.match(kind_value) \
            else scalar_key
        output = {}
        if learner is not None:
            output["learnerToken"] = _snapshot_learner_token(exact_context,
                                                             learner)
        for key, child in candidate.items():
            normalized_key = _normalize_privacy_key(key)
            # W3-P0-12: the unresolvable author's display name becomes
            # the generic "Staff" label; every other identity field on
            # the record keeps its fail-closed handling below.
            if unresolvable_author \
                    and normalized_key in _AUTHOR_DISPLAY_NAME_FIELDS:
                safe_key = _redact_learner_key(key, exact_context)
                if safe_key in output:
                    raise PrivacyError("privacy_identity_key_collision")
                output[safe_key] = "Staff"
                continue
            # Round-4 audit H3: a person-id array (an override's
            # student_ids) projects to the learners' labels in place, so
            # a readback still says WHO a record is for. Every id must be
            # rostered; an unknown one fails closed.
            if normalized_key in _PERSON_ID_ARRAY_FIELDS \
                    and isinstance(child, list) and all(
                        isinstance(item, (int, str))
                        and not isinstance(item, bool) for item in child):
                labels = []
                for item in child:
                    entry = exact_context["tokensById"].get(
                        str(item).strip())
                    if entry is None or not entry.get("token"):
                        raise PrivacyError(
                            "learner_roster_identity_unavailable")
                    labels.append(entry["token"])
                output[_redact_learner_key(key, exact_context)] = labels
                continue
            if _is_secret_field(key) \
                    or _is_identity_value_field(
                        key, detected_identity or may_scrub) \
                    or (learner is not None
                        and normalized_key == "learnertoken"):
                continue
            # A binary MCP resource has no safe text projection at this
            # boundary.
            if normalized_key == "blob" and isinstance(child, str):
                raise PrivacyError("privacy_resource_blob_refused")
            safe_key = _redact_learner_key(key, exact_context)
            if safe_key in output:
                raise PrivacyError("privacy_identity_key_collision")
            output[safe_key] = walk(
                child, depth + 1, _identity_record_kind(key),
                inherited_learner_privacy or detected_identity,
                "%s_id" % resource_kind if key == "id" else key)
        return output

    return walk(value)


# ---------------------------------------------------------------------------
# resolveLearnerTokens: write-direction resolver. Replaces learner labels /
# tokens in tool arguments with the real identity before provider dispatch.
# ---------------------------------------------------------------------------

_TOKEN_LABEL_ARG_RE = re.compile(
    r"\b(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12})\b")
_TOKEN_LABEL_KEY_RE = re.compile(
    r"^(?:Student A[1-9][0-9]*|learner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
    r"[0-9a-f]{4}-[0-9a-f]{12})$")
_IDENTIFIER_KEY_RE = re.compile(
    r"^(?:user|student|learner|recipient|author|participant)(?:s|_?ids?)?$",
    re.IGNORECASE)
_FIELD_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,79}$")


def resolve_learner_tokens(value, vault, scope,
                           roster=None,
                           additional_learner_identifier_fields=()):
    learner_identifier_fields = set(additional_learner_identifier_fields)
    if any(not _FIELD_NAME_RE.match(field)
           for field in learner_identifier_fields):
        raise TypeError("privacy learner identifier field is invalid")

    def resolve_identity(token):
        saved = vault.resolve(scope, token)
        if roster is None:
            return saved
        if not roster.is_ready(scope):
            raise PrivacyError("learner_roster_scope_unavailable")
        current = next((identity for identity in roster.identities(scope)
                        if identity["id"] == saved["id"]), None)
        if current is None:
            raise PrivacyError("learner_roster_identity_unavailable")
        return current

    def resolve_value(candidate, key="", depth=0):
        if depth > MAX_PRIVACY_OUTPUT_DEPTH:
            raise PrivacyError("privacy_output_depth_exceeded")
        if isinstance(candidate, str):
            identifier = bool(_IDENTIFIER_KEY_RE.match(key)) \
                or key in learner_identifier_fields

            def _replace_token(match):
                token = match.group(0)
                identity = resolve_identity(token)
                if identifier and candidate == token:
                    return identity["id"]
                if not identity.get("name"):
                    raise PrivacyError("learner_roster_name_unavailable")
                return identity["name"]

            # Mirrors String.replace with a non-global pattern: only the
            # first label per string is resolved.
            return _TOKEN_LABEL_ARG_RE.sub(_replace_token, candidate, count=1)
        if isinstance(candidate, list):
            return [resolve_value(entry, key, depth + 1)
                    for entry in candidate]
        if not is_json_object(candidate):
            return candidate
        output = {}
        for field, child in candidate.items():
            if field in ("learner_token", "learnerToken"):
                identity = resolve_identity(str(child))
                output["learner_id" if field == "learner_token"
                       else "learnerId"] = identity["id"]
                continue
            resolved_key = resolve_identity(field)["id"] \
                if _TOKEN_LABEL_KEY_RE.match(field) else field
            if resolved_key in output:
                raise PrivacyError("privacy_identity_key_collision")
            output[resolved_key] = resolve_value(child, field, depth + 1)
        return output

    return resolve_value(value)

# ---------------------------------------------------------------------------
# Secure private-file helpers
# ---------------------------------------------------------------------------

PRIVATE_FILE_BYTE_LIMIT = 1024 * 1024


def _assert_private_path(path, base_dir=None):
    resolved = os.path.realpath(path)
    if base_dir is not None:
        base = os.path.realpath(base_dir)
        if resolved != base and not resolved.startswith(base + os.sep):
            raise PrivacyError("privacy_path_escape")
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st.st_mode):
        raise PrivacyError("privacy_symlink_refused")
    if st.st_uid != os.getuid():
        raise PrivacyError("privacy_owner_mismatch")
    return st


def read_private_file(path, byte_limit=PRIVATE_FILE_BYTE_LIMIT):
    """Read a private file, refusing symlinks and foreign owners. Returns
    bytes, or None when the file does not exist."""
    st = _assert_private_path(path)
    if st is None:
        return None
    if st.st_size > byte_limit:
        raise PrivacyError("privacy_file_too_large")
    with open(path, "rb") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_SH)
        try:
            return handle.read(byte_limit + 1)
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_private_file(path, data, byte_limit=PRIVATE_FILE_BYTE_LIMIT,
                       mode=0o600):
    """Atomically replace a private file: write to a temp file in the same
    directory under an exclusive lock, then rename. Refuses symlinks and
    foreign owners.

    Divergence note: the TypeScript source uses a custom cross-process
    owner-file transaction protocol (claim file + journal). This port uses
    flock(2) plus atomic rename, which gives the same guarantees on a
    single host: 0600 files, symlink refusal, owner checks, byte limits.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("private file data must be bytes")
    if len(data) > byte_limit:
        raise PrivacyError("privacy_file_too_large")
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    st = _assert_private_path(path)
    if st is not None and stat.S_ISDIR(st.st_mode):
        raise PrivacyError("privacy_path_invalid")
    lock_path = path + ".lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".priv-")
        try:
            os.fchmod(tmp_fd, mode)
            os.write(tmp_fd, bytes(data))
            os.fsync(tmp_fd)
        finally:
            os.close(tmp_fd)
        os.replace(tmp_path, path)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
