"""Learner vault / tokenization boundary.

Pipeline position:
    browser result parser -> roster normalization -> learner vault/tokenization
    -> output projection -> agent-visible result

Contract:
- Canvas API results that touch learner data (users, enrollments, submissions,
  gradebook, grades, analytics) are NEVER agent-visible with raw PII. The
  completion path projects them through this module before journaling and
  before returning the receipt.
- Tokenization is deterministic per (tenant, canvas learner id) so repeated
  runs and journal rows correlate without revealing identity.
- Tokens are HMAC-SHA256 over the learner id with a locally stored secret;
  they are irreversible without the secret file.
- The raw identity mapping lives only in ~/.morrow/learner_vault/ (0600
  files, 0700 dir). The agent-visible layer sees tokens, never names,
  emails, logins, or SIS ids.
- De-tokenization (vault.lookup) exists for the EDUCATOR's explicit request
  only; it is not wired into any agent output path.

The raw provider payload stays in the pending envelope (a 0600 secret file)
so internal machinery (deferred verify, undo, transient capture) can resolve
result references. Journal rows and completion receipts carry the projection.
Raw browser reports for learner-bearing ops must not be persisted as evidence;
that is the caller's responsibility.

RETENTION STATEMENT (simple, no expiry heuristics):
- Learner names (and the other PII_FIELDS) live at rest in exactly one
  place: ~/.morrow/learner_vault/map.jsonl (0600, inside a 0700 dir),
  keyed by token, namespaced by tenant. The token secret lives beside it
  in secret.key (0600).
- They die when the educator kills them, two ways:
  1. Per-tenant purge: `python3 -m privacy.learner_vault purge --tenant
     <tenant>` drops every record for that tenant. Tokens already handed
     out for the purged tenant stop resolving (lookup returns None).
  2. Full wipe on uninstall: `python3 -m privacy.learner_vault wipe`
     deletes the map AND the secret, then removes the vault dir. A later
     run recreates the vault with a fresh secret, so pre-wipe tokens can
     never resolve again, even to a new map.
- There is no automatic expiry. The educator owns deletion; the product
  never silently retains beyond what the educator asked to keep, because
  the only writer is the projection path and the only deleters are the
  two commands above.
- W4-P0-4/W4-P0-5/W4-P0-6: purge and wipe also purge the browser
  transient state (pending envelopes holding RAW provider payloads and
  brief files) via transport.browser_backend.purge_transient_state(),
  and wipe additionally purges the Chromium profile's
  learner-data-carrying stores (selective by default, keeping session
  cookies; `wipe --full` wipes the whole profile). The import is lazy
  because transport.browser_backend imports this module at module top.
"""


def _purge_browser_transient(purge_profile=False, full_profile=False):
    """Shared by purge_tenant and wipe. Envelopes + briefs are purged on
    EVERY deletion path (W4-P0-4/W4-P0-5, no exception); the profile
    stores only on wipe (W4-P0-6: a per-tenant profile purge is not
    feasible, the stores mix tenants). Returns a report dict. A running
    browser skips the profile-store wipe with a loud warning instead of
    corrupting the live profile."""
    from transport import browser_backend as _bb
    pending, briefs, inflight_skipped = _bb.purge_transient_state()
    report = {"pending_envelopes_removed": pending,
              "briefs_removed": briefs,
              "inflight_envelopes_skipped": inflight_skipped,
              "profile": None}
    if purge_profile:
        try:
            report["profile"] = _bb.purge_browser_profile(
                full=bool(full_profile))
        except _bb.BrowserProfileInUse as exc:
            print("WARNING: %s" % exc, file=sys.stderr)
            report["profile"] = {"skipped": str(exc)}
    return report

import copy
import hashlib
import hmac
import json
import os
import secrets as _secrets
import stat
import sys
from datetime import datetime, timezone

# W4-P1-17: single source of truth for the morrow state root.
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.paths import morrow_home  # noqa: E402
# W6-P2-7: the token secret lives in a zeroizable buffer, not bytes, and
# is overwritten on close()/wipe()/rotation (see config/secretbuf.py
# for the honest residual statement).
from config.securebuf import SecretBytes, secret_bytes  # noqa: E402


def _key_bytes(secret):
    """W6-P2-7: unwrap a SecretBytes to its bytearray view for hmac;
    bytes-like passes through unchanged."""
    if isinstance(secret, SecretBytes):
        return secret.view()
    return secret

VAULT_DIR = os.path.join(morrow_home(), "learner_vault")
SECRET_FILE = "secret.key"
MAP_FILE = "map.jsonl"
TOKEN_PREFIX = "lrn_"
TOKEN_HEX_LEN = 20

# Fields that identify a learner to a human reader. Never agent-visible.
PII_FIELDS = frozenset({
    "name", "sortable_name", "short_name", "email", "login_id",
    "sis_user_id", "sis_login_id", "pronouns", "avatar_url",
    "locale", "effective_locale", "time_zone",
})

# Keys whose dict value is a learner object.
USER_KEY_NAMES = frozenset({"user", "student", "author"})


# Fields that, together with an "id", mark a bare dict as a learner record.
# Plain "name" is deliberately excluded: assignments, courses, sections, and
# groups all have names; only user objects carry these.
IDENTITY_FIELDS = frozenset({
    "email", "login_id", "sis_user_id", "sis_login_id",
    "sortable_name", "short_name",
})


class VaultUnavailable(Exception):
    """The learner vault could not be opened (permissions, disk, corrupt)."""


def vault_available() -> bool:
    """The tokenization boundary has landed: this module exists and the
    vault directory is creatable. Fail-closed callers treat False as
    'refuse learner operations'. A pre-existing loose directory is
    tightened to 0700 rather than trusted as-is."""
    try:
        os.makedirs(VAULT_DIR, mode=0o700, exist_ok=True)
        if stat.S_IMODE(os.stat(VAULT_DIR).st_mode) != 0o700:
            os.chmod(VAULT_DIR, 0o700)
        return True
    except OSError:
        return False


def _write_secret(path: str, text: str) -> None:
    # W5-P2-2: pid-unique tmp name; two concurrent writers of the
    # same vault file must not share one staging path.
    tmp = "%s.new.%d" % (path, os.getpid())
    # P2-10: atomic-permission creation (0600 at open), never
    # open()-then-chmod: the vault secret is never group/other-readable,
    # even briefly.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    # W6-P1-8: fsync the file before the atomic rename, then fsync the
    # directory so the rename itself is durable. A crash mid-rewrite
    # must not leave a torn map behind.
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path) or ".")


def _fsync_dir(dirpath: str) -> None:
    """fsync a directory so renames inside it are durable."""
    try:
        dfd = os.open(dirpath, os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)


# W6-P1-8: the identity map's integrity seal. The seal is
# HMAC-SHA256(vault_secret, canonical_map_bytes) stored in a sidecar
# <map>.seal written atomically beside the map. The map body on disk is
# the canonical bytes (sorted, one JSON object per line); _load_map
# refuses to trust a map whose seal does not verify.
MAP_SEAL_SUFFIX = ".seal"
MAP_PREV_SUFFIX = ".prev"


def _canonical_map_bytes(mapping: dict) -> bytes:
    return "".join(
        json.dumps(rec, sort_keys=True) + "\n"
        for rec in sorted(mapping.values(), key=lambda r: r["token"])
    ).encode("utf-8")


def _map_seal_for(secret: bytes, mapping: dict) -> str:
    return "hmac-sha256:" + hmac.new(
        secret, _canonical_map_bytes(mapping), hashlib.sha256).hexdigest()


class LearnerVault:
    """Deterministic, irreversible learner tokenization with a local
    identity map for educator-initiated de-tokenization."""

    def __init__(self, vault_dir: str = VAULT_DIR):
        self.dir = vault_dir
        try:
            os.makedirs(self.dir, mode=0o700, exist_ok=True)
        except OSError as exc:
            raise VaultUnavailable("cannot create vault dir: %s" % exc)
        self._secret = self._load_or_create_secret()
        self._map = self._load_map()
        self._wiped = False
        self._closed = False
        # W6-P1-2: finish a rotation that died between staging the new
        # secret and committing it.
        self._resume_interrupted_rotation()

    def close(self) -> None:
        """W6-P2-7: overwrite the in-memory token secret.

        The files on disk are untouched. After close() the vault must
        not be used; construct a new LearnerVault instead. Idempotent.
        """
        self._secret.zero()
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # -- secret ---------------------------------------------------------
    def _load_or_create_secret(self) -> SecretBytes:
        # W6-P1-7: never silently re-mint. A missing secret.key is only
        # mintable into a completely fresh vault dir. If ANY vault state
        # exists (map, seal, prev backup) but the secret is gone, that
        # is secret loss: re-minting would silently sever every
        # journaled token<->identity link and mint duplicate identities.
        # Fail closed instead; the operator recovers via the runbook
        # (backup restore, or rotate-secret/re-register).
        #
        # Exception: an interrupted rotate_secret leaves secret.key
        # missing with the new secret staged at secret.key.new (the
        # other agent's W6-P1-2 machinery). That is not loss; let
        # _resume_interrupted_rotation finish the commit below.
        path = os.path.join(self.dir, SECRET_FILE)
        staged = os.path.join(self.dir, SECRET_FILE + ".new")
        if os.path.exists(path):
            with open(path, "rb") as fh:
                secret = fh.read().strip()
            if len(secret) != 64:
                raise VaultUnavailable(
                    "vault secret.key is present but malformed "
                    "(%d bytes, expected 64 hex chars); refusing to "
                    "tokenize with a broken secret" % len(secret))
            return secret_bytes(secret)
        if os.path.exists(staged):
            # Rotation commit pending; the resume step below validates
            # and commits it. Return a placeholder: _secret is replaced
            # by _resume_interrupted_rotation before any token use.
            return secret_bytes(b"")
        state_files = [n for n in os.listdir(self.dir)
                       if n in (MAP_FILE, MAP_FILE + MAP_SEAL_SUFFIX,
                                MAP_FILE + MAP_PREV_SUFFIX)
                       or n.startswith(SECRET_FILE)]
        if state_files:
            raise VaultUnavailable(
                "vault secret.key is missing but vault state exists "
                "(%s): refusing to silently re-mint a new token secret, "
                "which would sever all existing token<->identity links. "
                "Restore secret.key from backup (see the recovery "
                "runbook) or wipe and re-register." % ", ".join(state_files))
        raw = _secrets.token_bytes(32).hex().encode("ascii")
        _write_secret(path, raw.decode("ascii"))
        return secret_bytes(raw)

    def _resume_interrupted_rotation(self) -> None:
        """Complete a rotate_secret that died mid-commit.

        rotate_secret stages the new secret at secret.key.new and only
        renames it over secret.key after the re-keyed map is durable.
        If the staging file exists at open, the previous rotation died
        between staging and commit: finish it now (re-derive the map
        under the staged secret, then commit). Idempotent.
        """
        staged = os.path.join(self.dir, SECRET_FILE + ".new")
        if not os.path.exists(staged):
            return
        with open(staged, "rb") as fh:
            new_secret = fh.read().strip()
        if len(new_secret) != 64:
            raise VaultUnavailable(
                "staged vault secret is malformed; refusing to resume")
        self._map = self._rekey_map(new_secret)
        # W6-P1-8: seal the re-keyed map under the NEW secret (it is not
        # self._secret until the commit below).
        self._persist_map(secret=new_secret)
        os.replace(staged, os.path.join(self.dir, SECRET_FILE))
        old = self._secret
        self._secret = secret_bytes(new_secret)
        old.zero()

    @staticmethod
    def _token_for_secret(secret: bytes, tenant: str,
                          learner_key: str) -> str:
        msg = ("%s\x00%s" % (tenant, learner_key)).encode("utf-8")
        digest = hmac.new(_key_bytes(secret), msg,
                          hashlib.sha256).hexdigest()
        return TOKEN_PREFIX + digest[:TOKEN_HEX_LEN]

    def _rekey_map(self, new_secret: bytes) -> dict:
        """Re-derive every map token under a new secret.

        Records keep (tenant, learner_key), so tokens are recomputed
        deterministically; pii/first_seen/last_seen are preserved. Map
        keys AND rec["token"] move together.
        """
        new_map = {}
        for rec in self._map.values():
            new_token = self._token_for_secret(
                new_secret, rec.get("tenant"), rec.get("learner_key"))
            new_rec = dict(rec)
            new_rec["token"] = new_token
            new_map[new_token] = new_rec
        return new_map

    def rotate_secret(self) -> dict:
        """W6-P1-2: rotate the vault's token HMAC secret.

        Mints a fresh 256-bit secret and re-keys the identity map so
        every learner token is re-derived under the new secret (tokens
        are deterministic per secret, so rotation changes them: this
        starts a new token epoch; pre-rotation tokens stop resolving).
        The retired secret is NOT retained: pre-rotation tokens become
        unresolvable, which is the point of rotating a compromised key.

        Crash safety: the new secret is staged at secret.key.new, the
        re-keyed map is persisted, and only then is the staged secret
        renamed over secret.key (the commit point). A crash before the
        commit leaves the old secret+map live; a crash after leaves the
        new pair live; a crash in between is resumed by
        _resume_interrupted_rotation on the next open. No learner
        record is ever lost: (tenant, learner_key, pii) are preserved
        through the re-key.

        Like purge_tenant, this is read-modify-write with no
        cross-process lock: run it quiescent (no concurrent dispatch),
        and every process re-opens the vault afterwards.
        Returns {"rotated": True, "records_rekeyed": n}.
        """
        self._guard_live()
        new_secret = _secrets.token_bytes(32).hex().encode("ascii")
        staged = os.path.join(self.dir, SECRET_FILE + ".new")
        _write_secret(staged, new_secret.decode("ascii"))
        new_map = self._rekey_map(new_secret)
        self._map = new_map
        # W6-P1-8: seal under the new secret before it is committed.
        self._persist_map(secret=new_secret)
        os.replace(staged, os.path.join(self.dir, SECRET_FILE))
        old = self._secret
        self._secret = secret_bytes(new_secret)
        old.zero()
        return {"rotated": True, "records_rekeyed": len(new_map)}

    # -- identity map ---------------------------------------------------
    def _map_seal_path(self) -> str:
        return os.path.join(self.dir, MAP_FILE + MAP_SEAL_SUFFIX)

    def _map_prev_path(self) -> str:
        return os.path.join(self.dir, MAP_FILE + MAP_PREV_SUFFIX)

    def _parse_map_text(self, text: str) -> dict:
        """Parse canonical map bytes. A torn/unparseable line is
        corruption, not skippable: fail loud so _load_map can route to
        recovery instead of silently dropping identities."""
        mapping = {}
        for lineno, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                raise VaultUnavailable(
                    "vault map.jsonl line %d is not valid JSON "
                    "(torn write or corruption)" % lineno)
            mapping[rec["token"]] = rec
        return mapping

    def _load_map(self) -> dict:
        # W6-P1-8: the map is HMAC-sealed (see _persist_map). Load order:
        #   1. map verifies under the live secret -> parse and trust it;
        #   2. an interrupted rotate_secret left the map re-keyed under
        #      the STAGED secret -> trust it iff it verifies under the
        #      staged secret (the resume step below finishes the commit);
        #   3. otherwise try the .prev last-known-good backup;
        #   4. else fail closed: a torn/tampered map never loads blind.
        # The seal is checked BEFORE parsing: a torn (unparseable) map
        # fails its seal check, so it falls through to .prev recovery
        # instead of raising a parse error here and stranding the vault.
        path = os.path.join(self.dir, MAP_FILE)
        if not os.path.exists(path):
            return {}
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        if self._seal_ok(text.encode("utf-8"), self._secret):
            return self._parse_map_text(text)
        staged = os.path.join(self.dir, SECRET_FILE + ".new")
        if os.path.exists(staged):
            with open(staged, "rb") as fh:
                staged_secret = fh.read().strip()
            if (len(staged_secret) == 64
                    and self._seal_ok(text.encode("utf-8"),
                                      staged_secret)):
                # Interrupted rotation: the map is already re-keyed.
                return self._parse_map_text(text)
        # A seal that exists but does not verify is tampering/bitrot:
        # try the last-known-good backup before failing closed. (This
        # also covers a deleted seal file when a verifiable .prev
        # survives: the .prev proves a sealed map once existed.)
        prev = self._map_prev_path()
        if os.path.exists(prev):
            with open(prev, "r", encoding="utf-8") as fh:
                prev_text = fh.read()
            if self._seal_ok_for(prev, prev_text.encode("utf-8"),
                                 self._secret):
                prev_map = self._parse_map_text(prev_text)
                print("WARNING: vault map.jsonl failed integrity "
                      "verification; restored last-known-good map.jsonl"
                      ".prev (%d records). Investigate the map file "
                      "before trusting new writes." % len(prev_map),
                      file=sys.stderr)
                return prev_map
        # W6-P1-8: a map with NO seal file at all and no verifiable
        # .prev is a pre-seal legacy map (or the seal was deleted
        # alongside tampering). Never trust it silently: fail closed
        # and point at the adopt-legacy ceremony, which seals it
        # explicitly.
        if not os.path.exists(self._map_seal_path()):
            raise VaultUnavailable(
                "vault map.jsonl has no integrity seal (pre-seal "
                "legacy map, or the seal was deleted). Refusing to "
                "trust an unsealed identity map. Run: python3 -m "
                "privacy.learner_vault adopt-legacy  (verifies what it "
                "can, seals the map, and writes the .prev backup).")
        raise VaultUnavailable(
            "vault map.jsonl failed integrity verification and no "
            "verifiable .prev backup exists; refusing to load a "
            "possibly tampered identity map. Restore from backup (see "
            "the recovery runbook).")

    def _write_sealed(self, base_path: str, text: str,
                      secret: bytes) -> None:
        """Write text + its HMAC sidecar atomically (each tmp+rename,
        each fsynced by _write_secret)."""
        _write_secret(base_path, text)
        _write_secret(base_path + MAP_SEAL_SUFFIX,
                      "hmac-sha256:" + hmac.new(
                          _key_bytes(secret), text.encode("utf-8"),
                          hashlib.sha256).hexdigest())

    def _seal_ok_for(self, base_path: str, canonical: bytes,
                     secret: bytes) -> bool:
        if not secret:
            return False
        try:
            with open(base_path + MAP_SEAL_SUFFIX, "r",
                       encoding="utf-8") as fh:
                seal = fh.read().strip()
        except OSError:
            return False
        expect = "hmac-sha256:" + hmac.new(
            _key_bytes(secret), canonical,
            hashlib.sha256).hexdigest()
        return hmac.compare_digest(seal, expect)

    def _seal_ok(self, canonical: bytes, secret: bytes) -> bool:
        return self._seal_ok_for(os.path.join(self.dir, MAP_FILE),
                                 canonical, secret)

    def _persist_map(self, secret: bytes | None = None) -> None:
        # W6-P1-8: persist the canonical map bytes, then seal them with
        # HMAC(secret, canonical_bytes) in a sidecar written atomically.
        # Before replacing, the outgoing map is kept as map.jsonl.prev
        # (last-known-good) so a torn/tampered map has a recovery path.
        # `secret` lets rotate_secret/_resume_interrupted_rotation seal
        # under the NEW secret before it is committed as self._secret.
        path = os.path.join(self.dir, MAP_FILE)
        prev = self._map_prev_path()
        seal_secret = secret if secret is not None else self._secret
        old_body = None
        if os.path.exists(path):
            with open(path, "rb") as src:
                old_body = src.read()
        text = _canonical_map_bytes(self._map).decode("utf-8")
        self._write_sealed(path, text, seal_secret)
        # Last-known-good backup: the pre-write map when there was one,
        # else the just-written map (so even a single-persist vault has
        # a recovery copy), each with its own seal.
        self._write_sealed(prev,
                           old_body.decode("utf-8")
                           if old_body is not None else text,
                           seal_secret)

    def _guard_live(self) -> None:
        if self._wiped:
            raise VaultUnavailable(
                "vault was wiped; construct a new LearnerVault")
        if self._closed:
            raise VaultUnavailable(
                "vault was closed; construct a new LearnerVault")

    # -- tokenization ---------------------------------------------------
    def token_for(self, tenant: str, learner_key: str) -> str:
        """Deterministic, irreversible token for (tenant, learner id)."""
        self._guard_live()
        return self._token_for_secret(self._secret, tenant, learner_key)

    def register(self, tenant: str, learner_key: str, pii: dict) -> str:
        """Record the identity behind a token; return the token.

        pii holds only the PII fields observed for this learner. Calling
        register again with more fields merges them; the token is stable.
        """
        token = self.token_for(tenant, learner_key)
        now = datetime.now(timezone.utc).isoformat()
        rec = self._map.get(token)
        if rec is None:
            rec = {"token": token, "tenant": tenant,
                   "learner_key": str(learner_key), "pii": {},
                   "first_seen": now}
        merged = dict(rec.get("pii") or {})
        for k, v in (pii or {}).items():
            if k in PII_FIELDS and v is not None:
                merged[k] = v
        rec["pii"] = merged
        rec["last_seen"] = now
        self._map[token] = rec
        self._persist_map()
        return token

    def lookup(self, token: str) -> dict | None:
        """Resolve a token to its recorded identity. EDUCATOR-INITIATED
        ONLY: never call this from an agent output path."""
        rec = self._map.get(token)
        return copy.deepcopy(rec) if rec else None

    # -- retention: deletion --------------------------------------------
    def purge_tenant(self, tenant: str) -> int:
        """Drop every identity record for one tenant. Returns the number
        of records purged. Tokens already issued for the purged tenant
        stop resolving (lookup returns None); other tenants are
        untouched and the token secret is kept.

        W4-P0-4/W4-P0-5: also purges ALL browser transient state
        (pending envelopes with raw payloads, brief files). They cannot
        be scoped to a tenant, so they go on every purge."""
        if self._wiped:
            return 0
        doomed = [t for t, rec in self._map.items()
                  if rec.get("tenant") == tenant]
        for t in doomed:
            del self._map[t]
        self._persist_map()
        _purge_browser_transient()
        return len(doomed)

    def wipe(self, full_profile: bool = False) -> dict:
        """Full vault wipe (uninstall path): delete the identity map and
        the token secret, then remove the vault dir. A later run
        recreates the vault with a fresh secret, so pre-wipe tokens can
        never resolve again.

        W4-P0-4/W4-P0-5/W4-P0-6: also purges browser transient state and
        the Chromium profile's learner-data-carrying stores (selective:
        History/Cache/DOM storage/etc. go, session cookies stay so the
        educator stays signed in). full_profile=True wipes the whole
        profile instead. Returns the transient/profile purge report."""
        for name in (MAP_FILE, SECRET_FILE,
                     MAP_FILE + MAP_SEAL_SUFFIX,
                     MAP_FILE + MAP_PREV_SUFFIX,
                     MAP_FILE + MAP_PREV_SUFFIX + MAP_SEAL_SUFFIX,
                     SECRET_FILE + ".new"):
            try:
                os.remove(os.path.join(self.dir, name))
            except OSError:
                pass
        self._map = {}
        self._secret.zero()
        self._secret = secret_bytes(b"")
        self._wiped = True
        try:
            os.rmdir(self.dir)
        except OSError:
            pass
        return _purge_browser_transient(purge_profile=True,
                                        full_profile=full_profile)


# ---------------------------------------------------------------------------
# Roster normalization: Canvas API shapes -> learner observations
# ---------------------------------------------------------------------------

def _learner_id_of(obj: dict, in_user_key: bool) -> tuple | None:
    """Return (learner_key, key_used) if this dict is a learner record."""
    if not isinstance(obj, dict):
        return None
    uid = obj.get("user_id")
    if isinstance(uid, (int, str)) and str(uid).strip() != "":
        return (str(uid), "user_id")
    if in_user_key or any(k in obj for k in IDENTITY_FIELDS):
        oid = obj.get("id")
        if isinstance(oid, (int, str)) and str(oid).strip() != "":
            return (str(oid), "id")
    return None


def normalize_roster(records: list, tenant: str) -> list:
    """Flatten Canvas roster-ish records (users, enrollments with nested
    user, submissions with nested user) into learner observations:
    [{"learner_key": ..., "pii": {...}, "context": {...}}].

    Context carries non-PII correlation fields (role, enrollment_state,
    grades, course/section ids) for the projection step.
    """
    out = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        seen = _learner_id_of(rec, False)
        nested = rec.get("user") if isinstance(rec.get("user"), dict) else None
        if nested is not None:
            nseen = _learner_id_of(nested, True)
            if nseen:
                seen = seen or nseen
                pii = {k: nested[k] for k in PII_FIELDS
                       if k in nested and nested[k] is not None}
                out.append({"learner_key": nseen[0], "pii": pii,
                            "context": _context_of(rec)})
        if seen:
            pii = {k: rec[k] for k in PII_FIELDS
                   if k in rec and rec[k] is not None}
            # Avoid double-counting the nested user as the outer record.
            if not (nested is not None and seen[0] ==
                    (_learner_id_of(nested, True) or (None,))[0]
                    and not pii):
                out.append({"learner_key": seen[0], "pii": pii,
                            "context": _context_of(rec)})
    return out


def _context_of(rec: dict) -> dict:
    ctx = {}
    for k in ("role", "enrollment_state", "type", "enrollment_type",
              "grades", "score", "grade", "points",
              "course_id", "section_id", "assignment_id",
              "workflow_state", "created_at", "updated_at",
              "submitted_at", "graded_at"):
        if k in rec and k not in PII_FIELDS:
            ctx[k] = rec[k]
    return ctx


# ---------------------------------------------------------------------------
# Output projection: raw payload -> agent-visible payload
# ---------------------------------------------------------------------------

def project_payload(obj, vault: LearnerVault, tenant: str):
    """Deep-walk a parsed provider payload. Every learner-shaped dict is
    registered in the vault and replaced by its token plus non-PII fields.
    The walk is pure: the input is never mutated."""
    return _project(obj, vault, tenant, in_user_key=False)


def _project(obj, vault: LearnerVault, tenant: str, in_user_key: bool):
    if isinstance(obj, list):
        return [_project(item, vault, tenant, False) for item in obj]
    if isinstance(obj, dict):
        seen = _learner_id_of(obj, in_user_key)
        if seen is not None:
            return _project_learner(obj, vault, tenant, seen[0], seen[1])
        return {k: _project(v, vault, tenant, k in USER_KEY_NAMES)
                for k, v in obj.items()}
    return obj


def _project_learner(obj: dict, vault: LearnerVault, tenant: str,
                     learner_key: str, id_key: str) -> dict:
    pii = {k: obj[k] for k in PII_FIELDS
           if k in obj and obj[k] is not None}
    token = vault.register(tenant, learner_key, pii)
    out = {}
    for k, v in obj.items():
        if k in PII_FIELDS or k == id_key:
            continue
        if k in USER_KEY_NAMES and isinstance(v, dict):
            out["learner"] = _project(v, vault, tenant, True)
            continue
        out[k] = _project(v, vault, tenant, False)
    out["learner_token"] = token
    return out


def project_receipt(receipt: dict, vault: LearnerVault,
                    tenant: str) -> dict:
    """Project an executor receipt (the agent-visible surface)."""
    return project_payload(copy.deepcopy(receipt), vault, tenant)


# ---------------------------------------------------------------------------
# CLI: retention commands. `python3 -m privacy.learner_vault purge --tenant
# <tenant>` | `python3 -m privacy.learner_vault wipe`
# ---------------------------------------------------------------------------

def _cli(argv) -> int:
    import argparse
    p = argparse.ArgumentParser(
        description="Learner vault retention commands. See the module "
                    "docstring for the retention statement.")
    sub = p.add_subparsers(dest="command", required=True)
    pp = sub.add_parser("purge", help="drop every identity record for one tenant")
    pp.add_argument("--tenant", required=True,
                    help="tenant prefix, e.g. the Canvas subdomain label")
    wp = sub.add_parser("wipe", help="full vault wipe (uninstall path)")
    wp.add_argument("--full", action="store_true",
                    help="also wipe the whole Chromium profile (default: "
                         "selective store wipe, session cookies kept)")
    rp = sub.add_parser("rotate-secret",
                        help="W6-P1-2: rotate the vault token HMAC secret, "
                             "re-keying the identity map (new token epoch; "
                             "run quiescent)")
    ap = sub.add_parser("adopt-legacy",
                        help="W6-P1-8: seal a pre-seal legacy map.jsonl. "
                             "Loads the unsealed map (operator-attended, "
                             "like journal-seal), writes the integrity "
                             "seal and the .prev backup.")
    args = p.parse_args(argv)

    vault = LearnerVault.__new__(LearnerVault)
    if args.command == "adopt-legacy":
        # Bypass __init__ (which would fail closed on the unsealed map):
        # this ceremony IS the explicit trust decision.
        vault_dir = VAULT_DIR
        os.makedirs(vault_dir, mode=0o700, exist_ok=True)
        vault.dir = vault_dir
        vault._wiped = False
        vault._secret = vault._load_or_create_secret()
        path = os.path.join(vault_dir, MAP_FILE)
        if not os.path.exists(path):
            print(json.dumps({"command": "adopt-legacy",
                              "adopted": False,
                              "detail": "no map.jsonl; nothing to adopt"}))
            return 0
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        mapping = vault._parse_map_text(text)
        # Re-derive every token under the live secret and confirm the
        # stored tokens match: catches a map that was hand-edited with
        # wrong tokens (the common tamper shape).
        mismatched = [t for t, rec in mapping.items()
                      if vault._token_for_secret(
                          vault._secret, rec.get("tenant"),
                          rec.get("learner_key")) != t]
        if mismatched:
            print(json.dumps({"command": "adopt-legacy",
                              "adopted": False,
                              "mismatched_tokens": mismatched[:10],
                              "detail": "map tokens do not re-derive "
                                        "under the live secret; refusing "
                                        "to seal a tampered map"}))
            return 1
        vault._map = mapping
        vault._persist_map()
        print(json.dumps({"command": "adopt-legacy", "adopted": True,
                          "records": len(mapping)}))
        return 0
    vault = LearnerVault()
    if args.command == "purge":
        n = vault.purge_tenant(args.tenant)
        print(json.dumps({"command": "purge", "tenant": args.tenant,
                          "records_purged": n,
                          "transient_purged": True}))
        return 0
    if args.command == "rotate-secret":
        result = vault.rotate_secret()
        print(json.dumps({"command": "rotate-secret", **result,
                          "detail": "new token epoch: pre-rotation tokens "
                                    "no longer resolve; re-open the vault "
                                    "in every process"}))
        return 0
    report = vault.wipe(full_profile=args.full)
    print(json.dumps({"command": "wipe", "vault_dir": vault.dir,
                      "removed": not os.path.exists(vault.dir),
                      "transient": report}))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
