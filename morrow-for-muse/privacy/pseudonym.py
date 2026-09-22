"""LEGACY REFERENCE IMPLEMENTATION -- no live path imports this module.

Kept in-tree as the reference implementation for the base64-blob
masking defense (see Deidentifier._mask_b64: decode, mask the inside,
re-encode), which the shipped pipeline (privacy/core.py plus
privacy/boundary.py) now implements directly. Nothing in the live
path imports Deidentifier or register_roster; the module is excluded
from the distribution. Do not revive it as a second de-identification
lane; consult it only as the documented reference for the defenses
the shipped pipeline ports.

Deterministic per-educator pseudonyms plus free-text PII masking.

This module is the second half of the learner-data boundary. The vault
(privacy/learner_vault.py) tokenizes structured learner records (dicts
with user ids, emails, names). This module covers what structured
projection cannot see: identifiers inside free text, nested JSON strings,
CSV-grade exports, submission bodies, base64-encoded blobs, and
unicode-homoglyph variants of known names.

Design:
- One educator-held salt at ~/.morrow/privacy_salt (0600, inside a 0700
  dir), generated once on first use, never shipped in the package. Every
  pseudonym is HMAC-SHA256(salt, tenant + scope + identifier), so the
  same student always maps to the same pseudonym on this educator's VM
  and to nothing recognizable anywhere else.
- Deidentifier.register_roster() learns every identifier a response
  carries (names, emails, logins, SIS ids, numeric user ids) from the
  raw provider receipt, then Deidentifier.scrub() replaces every
  occurrence in the agent-visible copy: structured PII keys, plain
  strings, nested objects/arrays, and base64-encoded segments.
- The identifier-to-pseudonym map is recorded educator-side only at
  ~/.morrow/privacy_map.jsonl (0600), so the educator can audit or
  reverse a pseudonym. It never leaves the VM and never ships in the
  package (pack/deny-list.txt denies privacy_salt* and privacy_map*).
- De-identification is ON by default for every learner-data read. The
  shipped pipeline's only reveal is a sealed educator record for one
  course (dispatch/admission.mint_pii_reveal); see
  privacy/FERPA_POLICY.md. The legacy environment variable
  MORROW_REVEAL_STUDENT_PII_REASON is ignored: it is not a consent
  channel.

Retention: purge --tenant drops that tenant's map records (issued
pseudonyms stop resolving); wipe deletes the salt and the whole map,
so no previously issued pseudonym can ever resolve again.

W4-P0-4/W4-P0-5/W4-P0-6: purge and wipe also purge the browser
transient state (pending envelopes holding RAW provider payloads and
brief files) via transport.browser_backend.purge_transient_state(),
and wipe additionally purges the Chromium profile's
learner-data-carrying stores (selective by default, keeping session
cookies; --full wipes the whole profile). The import is lazy because
transport.browser_backend imports privacy.learner_vault at module top.
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

import base64
import binascii
import copy
import hashlib
import hmac
import json
import os
import re
import secrets as _secrets
import stat
import sys
import unicodedata
from datetime import datetime, timezone

# W4-P1-17: single source of truth for the morrow state root.
_TREE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _TREE_ROOT not in sys.path:
    sys.path.insert(0, _TREE_ROOT)
from config.paths import morrow_home  # noqa: E402

# W4-P1-17: salt and map live under the unified MORROW_HOME, never a
# hardcoded ~/.morrow fallback.
MORROW_HOME = morrow_home()
SALT_ENV_VAR = "MORROW_PRIVACY_SALT"
MAP_ENV_VAR = "MORROW_PRIVACY_MAP"
DEFAULT_SALT_PATH = os.path.join(MORROW_HOME, "privacy_salt")
DEFAULT_MAP_PATH = os.path.join(MORROW_HOME, "privacy_map.jsonl")

PSEUDO_PREFIX = "stu_"
PSEUDO_HEX_LEN = 16

# Bare numeric identifiers are only replaced in free text when they are at
# least this long. Canvas user ids are multi-digit; grades and counts are
# not, and a bare "95" must never become a pseudonym.
MIN_NUMERIC_ID_LEN = 4


class PrivacyUnavailable(Exception):
    """The de-identification layer could not run (salt/map unreadable)."""


# ---------------------------------------------------------------------------
# Salt: educator-side only, 0600, generated once, never shipped.
# ---------------------------------------------------------------------------

def salt_path() -> str:
    """Configured salt location (env override for tests)."""
    return os.environ.get(SALT_ENV_VAR) or DEFAULT_SALT_PATH


def default_salt_path() -> str:
    return salt_path()


def map_path() -> str:
    """Configured map location (env override for tests)."""
    return os.environ.get(MAP_ENV_VAR) or DEFAULT_MAP_PATH


def default_map_path() -> str:
    return map_path()


def _ensure_private_dir(path: str) -> None:
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
    except OSError as exc:
        raise PrivacyUnavailable("cannot create %s: %s" % (path, exc))
    try:
        if stat.S_IMODE(os.stat(path).st_mode) != 0o700:
            os.chmod(path, 0o700)
    except OSError as exc:
        raise PrivacyUnavailable("cannot tighten %s: %s" % (path, exc))


def _write_private(path: str, data: bytes) -> None:
    # W5-P2-2: pid-unique tmp name; two concurrent writers of the
    # same file must not share one staging path.
    tmp = "%s.new.%d" % (path, os.getpid())
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_or_create_salt(path: str | None = None) -> bytes:
    """Load the educator's de-id salt, creating it (0600) on first use."""
    path = path or salt_path()
    _ensure_private_dir(os.path.dirname(path) or ".")
    if os.path.exists(path):
        with open(path, "rb") as fh:
            raw = fh.read().strip()
        if len(raw) < 32:
            raise PrivacyUnavailable(
                "privacy salt at %s is truncated; refusing to derive "
                "pseudonyms from it" % path)
        try:
            if stat.S_IMODE(os.stat(path).st_mode) != 0o600:
                os.chmod(path, 0o600)
        except OSError:
            pass
        return raw
    raw = _secrets.token_bytes(32).hex().encode("ascii")
    _write_private(path, raw)
    return raw


def pseudonym_for(tenant: str, identifier: str, scope: str = "student",
                  salt: bytes | None = None) -> str:
    """Deterministic pseudonym for one identifier on one tenant.

    Same (tenant, identifier, scope) always yields the same pseudonym
    for this educator; without the salt file the mapping is
    irreversible. The pseudonym carries no fragment of the input.
    """
    salt = salt if salt is not None else load_or_create_salt()
    msg = ("%s\x00%s\x00%s" % (tenant, scope, identifier)).encode("utf-8")
    digest = hmac.new(salt, msg, hashlib.sha256).hexdigest()
    return PSEUDO_PREFIX + digest[:PSEUDO_HEX_LEN]


# ---------------------------------------------------------------------------
# Unicode-homoglyph folding: catch lookalike-script variants of known names.
# The fold is per-character with an explicit index map, so folded match
# spans translate back to exact original-text spans for splicing.
# ---------------------------------------------------------------------------

def _confusables() -> dict:
    table = {}
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
    for src, dst in pairs:
        table[src] = dst
    return table


_CONFUSABLES = _confusables()


def _fold_with_map(text: str):
    """Fold to a confusable-insensitive lowercase form.

    Returns (folded, index_map) where index_map[i] is the original-text
    index of folded[i]. NFKC first (fullwidth and compatibility forms),
    then the lookalike table, then a 1:1 lowercase.
    """
    folded = []
    index_map = []
    for i, ch in enumerate(unicodedata.normalize("NFKC", text)):
        rep = _CONFUSABLES.get(ch, ch.lower())
        for fc in rep:
            folded.append(fc)
            index_map.append(i)
    return "".join(folded), index_map


def fold(text: str) -> str:
    return _fold_with_map(text)[0]


# ---------------------------------------------------------------------------
# Free-text masking patterns.
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_B64_RE = re.compile(r"[A-Za-z0-9+/]{24,}={0,2}")

# Structured PII keys replaced inside learner-shaped dicts. Mirrors
# privacy/learner_vault.PII_FIELDS so the two halves of the boundary agree
# on what counts as identifying.
PII_KEYS = frozenset({
    "name", "sortable_name", "short_name", "email", "login_id",
    "sis_user_id", "sis_login_id", "pronouns", "avatar_url",
    "locale", "effective_locale", "time_zone",
})
USER_KEY_NAMES = frozenset({"user", "student", "author"})


class Deidentifier:
    """Learn identifiers from a provider response, then scrub every
    occurrence out of the agent-visible copy."""

    def __init__(self, tenant: str, salt: bytes | None = None,
                 salt_file: str | None = None, map_file: str | None = None):
        self.tenant = tenant
        self._salt = salt if salt is not None else load_or_create_salt(
            salt_file)
        self._map_path = map_file or default_map_path()
        # folded identifier -> (original identifier, pseudonym)
        self._identifiers: dict[str, tuple[str, str]] = {}
        # pseudonym -> map record (educator-side reversal/audit)
        self._map: dict[str, dict] = {}
        self._load_map()

    # -- identity map (educator-side only) --------------------------------
    def _load_map(self) -> None:
        # The map file holds every tenant; only this tenant's records are
        # loaded into the live identifier index. Persistence always
        # rewrites the full file so other tenants' records survive.
        path = self._map_path
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    if not rec.get("pseudonym"):
                        continue
                    self._map[rec["pseudonym"]] = rec
                    if rec.get("tenant") == self.tenant:
                        key = fold(rec["identifier"])
                        self._identifiers.setdefault(
                            key, (rec["identifier"], rec["pseudonym"]))
        except (OSError, ValueError) as exc:
            raise PrivacyUnavailable(
                "cannot read privacy map %s: %s" % (path, exc))

    def _persist_map(self) -> None:
        _ensure_private_dir(os.path.dirname(self._map_path) or ".")
        text = "".join(
            json.dumps(rec, sort_keys=True) + "\n"
            for rec in sorted(self._map.values(),
                              key=lambda r: r["pseudonym"]))
        _write_private(self._map_path, text.encode("utf-8"))

    # -- registration ----------------------------------------------------
    def register(self, identifier, scope: str = "student") -> str:
        """Register one identifier string; return its pseudonym.

        Registration is idempotent: the same identifier always yields
        the same pseudonym. The identifier is recorded in the
        educator-side map so a pseudonym can be audited or reversed.
        """
        ident = identifier if isinstance(identifier, str) else str(
            identifier)
        ident = ident.strip()
        if scope == "email":
            ident = ident.lower()
        if not ident:
            raise ValueError("cannot register an empty identifier")
        key = fold(ident)
        hit = self._identifiers.get(key)
        if hit is not None:
            return hit[1]
        pseudo = pseudonym_for(self.tenant, ident, scope, self._salt)
        now = datetime.now(timezone.utc).isoformat()
        rec = self._map.get(pseudo)
        if rec is None:
            rec = {"pseudonym": pseudo, "tenant": self.tenant,
                   "scope": scope, "identifier": ident,
                   "first_seen": now}
        rec["last_seen"] = now
        # A collision between two different identifiers would be a salt
        # compromise signal; fail closed rather than merge identities.
        if rec["identifier"] != ident:
            raise PrivacyUnavailable(
                "pseudonym collision for %r: refusing to merge two "
                "identifiers under one pseudonym" % ident)
        self._map[pseudo] = rec
        self._identifiers[key] = (ident, pseudo)
        self._persist_map()
        return pseudo

    def register_learner(self, learner_key, pii: dict | None) -> None:
        """Register a learner's key plus every PII field observed."""
        self.register(learner_key, scope="user_id")
        for field, value in (pii or {}).items():
            if value is None:
                continue
            text = value if isinstance(value, str) else str(value)
            if text.strip():
                self.register(text, scope=field)

    def register_roster(self, records: list) -> int:
        """Learn identifiers from Canvas roster-ish records (users,
        enrollments with nested user, submissions with nested user).

        Returns the number of learner observations registered.
        """
        from privacy import learner_vault as _lv
        count = 0
        for obs in _lv.normalize_roster(records or [], self.tenant):
            self.register_learner(obs["learner_key"], obs.get("pii"))
            count += 1
        return count

    def lookup(self, pseudonym: str) -> dict | None:
        """Resolve a pseudonym to its recorded identifier.
        EDUCATOR-INITIATED ONLY: never call from an agent output path."""
        rec = self._map.get(pseudonym)
        return copy.deepcopy(rec) if rec else None

    # -- scrubbing -------------------------------------------------------
    def scrub(self, obj):
        """Deep-walk a parsed payload. Structured PII keys become
        pseudonyms; every string is free-text masked. Pure: the input is
        never mutated."""
        return self._walk(obj, in_user_key=False)

    def _walk(self, obj, in_user_key: bool):
        if isinstance(obj, list):
            return [self._walk(item, False) for item in obj]
        if isinstance(obj, dict):
            learner_shaped = in_user_key or self._is_learner_shaped(obj)
            out = {}
            for k, v in obj.items():
                if (learner_shaped and k in PII_KEYS
                        and isinstance(v, str) and v.strip()):
                    out[k] = self.register(v, scope=k)
                elif (learner_shaped and k in ("user_id", "id")
                        and isinstance(v, (int, str))
                        and str(v).strip() != ""):
                    out[k] = self.register(str(v), scope="user_id")
                elif k in USER_KEY_NAMES and isinstance(v, dict):
                    out[k] = self._walk(v, True)
                else:
                    out[k] = self._walk(v, False)
            return out
        if isinstance(obj, str):
            return self._mask_text(obj)
        return obj

    @staticmethod
    def _is_learner_shaped(obj: dict) -> bool:
        from privacy import learner_vault as _lv
        return _lv._learner_id_of(obj, False) is not None

    # -- free-text masking ------------------------------------------------
    def _mask_text(self, text: str) -> str:
        if not text:
            return text
        # 1. Base64-encoded segments: decode, mask the inside, re-encode.
        #    Runs first so identifiers hidden in encoded blobs are caught.
        text = _B64_RE.sub(lambda m: self._mask_b64(m.group(0)), text)
        # 2. Registered identifiers, longest first, on the folded form so
        #    homoglyph variants (Cyrillic/Greek lookalikes) match too.
        folded, index_map = _fold_with_map(text)
        for key in sorted(self._identifiers, key=len, reverse=True):
            if len(key) < 2:
                continue
            _ident, pseudo = self._identifiers[key]
            if key.isdigit():
                text, folded, index_map = self._splice_numeric(
                    text, folded, index_map, key, pseudo)
            else:
                text, folded, index_map = self._splice_all(
                    text, folded, index_map, key, pseudo)
        # 3. Email addresses not seen during registration.
        text = _EMAIL_RE.sub(lambda m: self._mask_email(m.group(0)), text)
        return text

    @staticmethod
    def _splice_all(text, folded, index_map, key, pseudo):
        # The splice is done in folded coordinates with the index map
        # updated in place: no refold per splice, and scanning resumes
        # past the inserted pseudonym (never re-scans it). The latter is
        # the termination guarantee: an identifier that happens to be a
        # substring of its own pseudonym's hex tail cannot loop.
        #
        # Single-token identifiers (pure alphanumeric, e.g. a first name)
        # match on word boundaries only, so "Ann" never eats "annual".
        # Identifiers carrying spaces or punctuation (full names, emails,
        # SIS ids) cannot sit inside a word, so they match as substrings.
        word_key = key.isalnum()
        start = 0
        while True:
            i = folded.find(key, start)
            if i < 0:
                break
            if word_key:
                before = folded[i - 1] if i > 0 else ""
                after = (folded[i + len(key)]
                         if i + len(key) < len(folded) else "")
                if before.isalnum() or after.isalnum():
                    start = i + 1
                    continue
            o_start = index_map[i]
            o_end = index_map[i + len(key) - 1] + 1
            text = text[:o_start] + pseudo + text[o_end:]
            fi_end = i + len(key)
            folded = folded[:i] + pseudo + folded[fi_end:]
            # The tail of the text shifted by the splice delta; its
            # index-map entries must shift with it.
            delta = len(pseudo) - (o_end - o_start)
            index_map = (index_map[:i]
                         + list(range(o_start, o_start + len(pseudo)))
                         + [j + delta for j in index_map[fi_end:]])
            start = i + len(pseudo)
        return text, folded, index_map

    @staticmethod
    def _splice_numeric(text, folded, index_map, key, pseudo):
        # Bare numbers only: never rewrite a digit run that is part of a
        # longer number, and never touch short numbers (grades, counts).
        if len(key) < MIN_NUMERIC_ID_LEN:
            return text, folded, index_map
        start = 0
        while True:
            i = folded.find(key, start)
            if i < 0:
                break
            before = folded[i - 1] if i > 0 else ""
            after = folded[i + len(key)] if i + len(key) < len(folded) else ""
            if before.isdigit() or after.isdigit():
                start = i + 1
                continue
            o_start = index_map[i]
            o_end = index_map[i + len(key) - 1] + 1
            text = text[:o_start] + pseudo + text[o_end:]
            fi_end = i + len(key)
            folded = folded[:i] + pseudo + folded[fi_end:]
            # The tail of the text shifted by the splice delta; its
            # index-map entries must shift with it.
            delta = len(pseudo) - (o_end - o_start)
            index_map = (index_map[:i]
                         + list(range(o_start, o_start + len(pseudo)))
                         + [j + delta for j in index_map[fi_end:]])
            start = i + len(pseudo)
        return text, folded, index_map

    def _mask_email(self, addr: str) -> str:
        return self.register(addr, scope="email")

    def _mask_b64(self, segment: str) -> str:
        try:
            raw = base64.b64decode(segment, validate=True)
        except (binascii.Error, ValueError):
            return segment
        try:
            inner = raw.decode("utf-8")
        except UnicodeDecodeError:
            return segment
        if len(inner) < 4:
            return segment
        printable = sum(1 for ch in inner
                        if ch.isprintable() or ch in "\n\r\t")
        if printable / max(len(inner), 1) < 0.8:
            return segment
        masked = self._mask_text(inner)
        if masked == inner:
            return segment
        return base64.b64encode(masked.encode("utf-8")).decode("ascii")

    # -- retention ---------------------------------------------------------
    def purge_tenant(self, tenant: str) -> int:
        """Drop every map record for one tenant. Issued pseudonyms stop
        resolving; other tenants are untouched and the salt is kept.

        W4-P0-4/W4-P0-5: also purges ALL browser transient state
        (pending envelopes with raw payloads, brief files). They cannot
        be scoped to a tenant, so they go on every purge."""
        doomed = [p for p, rec in self._map.items()
                  if rec.get("tenant") == tenant]
        for p in doomed:
            rec = self._map.pop(p)
            self._identifiers.pop(fold(rec["identifier"]), None)
        self._persist_map()
        _purge_browser_transient()
        return len(doomed)

    def wipe(self, full_profile: bool = False):
        """Full wipe: delete the salt and the identity map. Previously
        issued pseudonyms can never resolve again.

        W4-P0-4/W4-P0-5/W4-P0-6: also purges browser transient state and
        the Chromium profile's learner-data-carrying stores (selective:
        History/Cache/DOM storage/etc. go, session cookies stay so the
        educator stays signed in). full_profile=True wipes the whole
        profile instead."""
        for path in (self._map_path, salt_path()):
            try:
                os.remove(path)
            except OSError:
                pass
        self._identifiers = {}
        self._map = {}
        self._salt = b""
        return _purge_browser_transient(purge_profile=True,
                                        full_profile=full_profile)


def _cli(argv) -> int:
    import argparse
    p = argparse.ArgumentParser(
        description="Pseudonym map retention commands. See the module "
                    "docstring for the retention statement.")
    sub = p.add_subparsers(dest="command", required=True)
    pp = sub.add_parser("purge",
                        help="drop every map record for one tenant")
    pp.add_argument("--tenant", required=True,
                    help="tenant base URL, e.g. https://school.instructure.com")
    wp = sub.add_parser("wipe", help="delete the salt and the whole map")
    wp.add_argument("--full", action="store_true",
                    help="also wipe the whole Chromium profile (default: "
                         "selective store wipe, session cookies kept)")
    args = p.parse_args(argv)

    d = Deidentifier(tenant="__cli__")
    if args.command == "purge":
        n = d.purge_tenant(args.tenant)
        print(json.dumps({"command": "purge", "tenant": args.tenant,
                          "records_purged": n,
                          "transient_purged": True}))
        return 0
    report = d.wipe(full_profile=args.full)
    print(json.dumps({"command": "wipe",
                      "salt_gone": not os.path.exists(salt_path()),
                      "map_gone": not os.path.exists(d._map_path),
                      "transient": report}))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
