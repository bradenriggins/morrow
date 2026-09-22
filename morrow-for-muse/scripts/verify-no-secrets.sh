#!/bin/bash
# verify-no-secrets.sh [tree]
#
# Packaging secrets gate for the Morrow for Muse connector. Enforces
# pack/deny-list.txt against a tree (default: the tree this script ships
# in). install.sh runs it as the last install step with
# VERIFY_EXCLUDE="helper/profile" (the runtime profile the installer
# itself creates); the carve script enforces the same deny-list without
# exclusions before a distribution is accepted.
#
# [paths] matching is case-insensitive and Unicode-aware: each path is
# NFKC-normalized, invisible characters (zero-width spaces, soft hyphen,
# BOM) are stripped, and common confusable lookalikes (Cyrillic/Greek
# homoglyphs of ASCII letters) are folded to ASCII before matching, so
# homoglyph variants of denied names (e.g. a Cyrillic-A "Cookies") are
# caught, not evaded. The tenant rule extracts hostnames
# case-insensitively and compares them lowercased.
#
# Fails loudly, naming every offending path. Prints nothing secret: only
# paths, pattern names, and counts.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DENY="${TREE}/pack/deny-list.txt"
[ -f "${DENY}" ] || {
  echo "VERIFY-NO-SECRETS FAIL: deny-list not found: ${DENY}" >&2
  exit 1
}
[ -d "${TREE}" ] || {
  echo "VERIFY-NO-SECRETS FAIL: tree not found: ${TREE}" >&2
  exit 1
}

paths=()
contents=()
exempts=()
allows=()
section=""
while IFS= read -r line || [ -n "${line}" ]; do
  clean="${line%%#*}"
  clean="$(printf '%s' "${clean}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -z "${clean}" ] && continue
  case "${clean}" in
    "[paths]") section=paths; continue ;;
    "[content]") section=content; continue ;;
    "[content_exempt]") section=exempts; continue ;;
    "[tenant_allow]") section=allows; continue ;;
    "["*) echo "VERIFY-NO-SECRETS FAIL: unknown section: ${clean}" >&2; exit 1 ;;
  esac
  case "${section}" in
    paths) paths+=("${clean}") ;;
    content) contents+=("${clean}") ;;
    exempts) exempts+=("${clean}") ;;
    allows) allows+=("${clean}") ;;
  esac
done < "${DENY}"
[ "${#paths[@]}" -gt 0 ] || {
  echo "VERIFY-NO-SECRETS FAIL: deny-list has an empty [paths] section" >&2
  exit 1
}

SELF_SKIP_1="pack/deny-list.txt"
SELF_SKIP_2="scripts/verify-no-secrets.sh"

# Normalize a tree-relative path for [paths] matching: NFKC, strip
# invisible characters, fold confusable homoglyphs to ASCII.
# (P2-18: without this, a Unicode-lookalike filename evades the gate.)
norm_path() {
  python3 - "$1" <<'PYEOF'
import sys, unicodedata
s = sys.argv[1]
s = unicodedata.normalize("NFKC", s)
# Strip invisible characters by explicit codepoint (no invisible
# literal may ever hide in this file): U+200B ZERO WIDTH SPACE,
# U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH JOINER,
# U+FEFF ZERO WIDTH NO-BREAK SPACE, U+00AD SOFT HYPHEN.
_INVISIBLE = "\u200b\u200c\u200d\ufeff\u00ad"
s = "".join(c for c in s if c not in _INVISIBLE)
_CONF = {
    # Cyrillic lookalikes -> ASCII
    "\u0430": "a", "\u0441": "c", "\u0435": "e", "\u0456": "i",
    "\u0458": "j", "\u043e": "o", "\u0440": "p", "\u0455": "s",
    "\u0445": "x", "\u0443": "y", "\u043a": "k", "\u043c": "m",
    "\u043d": "h", "\u0442": "t",
    "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E",
    "\u041d": "H", "\u0406": "I", "\u0408": "J", "\u041a": "K",
    "\u041c": "M", "\u041e": "O", "\u0420": "P", "\u0405": "S",
    "\u0422": "T", "\u0425": "X",
    # Greek lookalikes -> ASCII
    "\u03b1": "a", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k",
    "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c4": "t",
    "\u03c7": "x", "\u03b6": "z",
    "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0397": "H",
    "\u0399": "I", "\u039a": "K", "\u039c": "M", "\u039d": "N",
    "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a7": "X",
    "\u0396": "Z",
}
sys.stdout.write("".join(_CONF.get(c, c) for c in s))
PYEOF
}

# VERIFY_EXCLUDE: colon-separated tree-relative paths to skip entirely.
# install.sh sets this to helper/profile: the profile is runtime state
# the installer itself mkdir-creates (never shipped material), and on
# reinstalls it holds the educator's live session, which must never fail
# an install. This is not a loophole for shipped files: it covers only
# paths the installer creates at install time, and the carve-time gate
# runs without exclusions (a dist containing helper/profile is rejected
# there, before it can ever be installed).
is_verify_excluded() { # $1 = rel path
  local rel="$1" e
  [ -n "${VERIFY_EXCLUDE:-}" ] || return 1
  local old_ifs="$IFS"
  IFS=':'
  for e in ${VERIFY_EXCLUDE}; do
    case "${rel}" in "${e}"|"${e}"/*) IFS="$old_ifs"; return 0 ;; esac
  done
  IFS="$old_ifs"
  return 1
}

is_exempt() { # $1 = rel path; true if in [content_exempt]
  local rel="$1" e
  for e in "${exempts[@]}"; do
    [ "${rel}" = "${e}" ] && return 0
  done
  return 1
}

is_allowed_host() { # $1 = lowercased hostname; true if in [tenant_allow]
  local host="$1" a
  for a in "${allows[@]}"; do
    [ "${host}" = "${a}" ] && return 0
  done
  return 1
}

violations=0
report() { printf 'DENIED: %s\n' "$1"; violations=$((violations + 1)); }

while IFS= read -r -d '' f; do
  rel="${f#${TREE}/}"

  # Installer-created runtime state (VERIFY_EXCLUDE) is never gated.
  is_verify_excluded "${rel}" && continue

  # The gate never scans itself.
  [ "${rel}" = "${SELF_SKIP_1}" ] && continue
  [ "${rel}" = "${SELF_SKIP_2}" ] && continue

  # --- [paths]: absolute, applies to every file including exemptions ---
  # Case-insensitive (P1-25): lowercase the normalized path and the
  # pattern before matching, so COOKIES-JOURNAL, cookies, LoginData all
  # hit the Chromium-store patterns. P0-3: match at ANY depth.
  rel_norm="$(norm_path "${rel}")"
  rel_lc="$(printf '%s' "${rel_norm}" | tr 'A-Z' 'a-z')"
  for pat in "${paths[@]}"; do
    pat_lc="$(printf '%s' "${pat}" | tr 'A-Z' 'a-z')"
    hit=0
    case "${pat_lc}" in
      */)
        dir="${pat_lc%/}"
        case "${rel_lc}" in
          "${dir}"|"${dir}"/*|*/"${dir}"|*/"${dir}"/*) hit=1 ;;
        esac
        ;;
      *)
        # Bash case '*' spans directories, so this already catches
        # patterns containing '*' at any depth; the "*/" form adds
        # bare-name patterns at any depth.
        case "${rel_lc}" in ${pat_lc}|*/${pat_lc}) hit=1 ;; esac
        ;;
    esac
    [ "${hit}" = 1 ] && report "${rel} (path pattern: ${pat})"
  done

  # --- [content] + tenant rule: text files only, minus exemptions -------
  [ -f "${f}" ] || continue
  is_exempt "${rel}" && continue
  grep -Iq . "${f}" 2>/dev/null || continue  # skip binary files
  for pat in "${contents[@]}"; do
    if grep -qE "${pat}" "${f}" 2>/dev/null; then
      report "${rel} (content pattern: ${pat})"
    fi
  done
  # Tenant rule: extract case-insensitively (P1-25: an uppercase
  # https://EVIL.INSTRUCTURE.COM/ used to evade the lowercase-only
  # extraction), compare lowercased against the allow list.
  while IFS= read -r host; do
    [ -z "${host}" ] && continue
    host_lc="$(printf '%s' "${host}" | tr 'A-Z' 'a-z')"
    is_allowed_host "${host_lc}" || report "${rel} (non-example tenant host: ${host})"
  done < <(grep -Eioh '[A-Za-z0-9.-]+\.instructure\.com' "${f}" 2>/dev/null | sort -u)
done < <(find "${TREE}" -mindepth 1 -print0)

if [ "${violations}" -gt 0 ]; then
  printf 'VERIFY-NO-SECRETS FAIL: %d violation(s) in %s\n' \
    "${violations}" "${TREE}" >&2
  exit 1
fi
printf 'verify-no-secrets: PASS (%s clean)\n' "${TREE}"
