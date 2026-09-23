"""Environment egress and certificate probing for the local-Chromium transport.

Packaging story: the connector must run on any Muse VM, not just the Hatch
sandbox where it was built. Egress differs per VM (authenticated proxy, bare
proxy, or direct), and the local egress CA (if any) differs too. This module
probes the actual environment at launch and returns plain data structures.
It never logs credentials, never puts them in argv, and never hardcodes
sandbox-specific values (no pinned SPKI, no proxy hostnames).

Everything here is stdlib-only so the transport stays dependency-free.
"""

import base64
import hashlib
import hmac
import os
import socket
import ssl
import sys
from urllib.parse import urlparse

# Env override wins; then well-known sandbox locations. None of these is
# required to exist: a VM with direct egress simply has no MITM CA, and the
# Chromium flag is omitted entirely in that case.
CA_PEM_ENV_VAR = "MORROW_EGRESS_CA_PEM"
CA_PEM_CANDIDATES = (
    "/etc/ssl/certs/hatch-egress-ca.pem",
    "/usr/local/share/ca-certificates/egress-ca.crt",
    "/etc/ssl/certs/egress-ca.pem",
)

PROXY_ENV_VARS = ("https_proxy", "HTTPS_PROXY")

# W6-P2-6: optional certificate pinning for TLS upstreams. System-CA +
# hostname verification stays the default; when the operator pins an
# upstream, the peer's leaf-certificate SHA-256 must ADDITIONALLY match
# one of the configured pins or the connection fails CLOSED, before any
# credential is sent (proxy_forwarder) or the probe is trusted
# (direct_egress_ok). Format: "sha256/<base64>,sha256/<base64>,..."
# (HPKP-style; the "sha256/" prefix may be omitted). This pins the leaf
# CERTIFICATE hash, which needs no ASN.1 parser in stdlib; rotate the pin
# together with the upstream certificate. Env-configured only, never
# hardcoded (see the module docstring's packaging story).
PROXY_PIN_ENV_VAR = "MORROW_PROXY_PIN"
EGRESS_PIN_ENV_VAR = "MORROW_EGRESS_PIN"


class CertPinMismatch(Exception):
    """A TLS peer's certificate did not match the configured pin."""


def parse_cert_pins(raw):
    """Parse a pin list into [32-byte SHA-256 digests].

    Accepts "sha256/<base64>" entries (comma-separated); the "sha256/"
    prefix may be omitted. Raises ValueError on anything malformed:
    callers fail closed rather than pinning to a misparsed value.
    """
    pins = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "/" in part:
            algo, b64 = part.split("/", 1)
        else:
            algo, b64 = "sha256", part
        if algo.strip().lower() != "sha256":
            raise ValueError("unsupported pin algorithm %r" % (algo,))
        b64 = b64.strip()
        try:
            digest = base64.b64decode(b64 + "=" * (-len(b64) % 4),
                                      validate=True)
        except Exception:
            raise ValueError("malformed certificate pin %r" % (part,))
        if len(digest) != 32:
            raise ValueError("certificate pin %r is not a SHA-256 digest"
                             % (part,))
        pins.append(digest)
    return pins


def check_cert_pin(cert_der, pins, where):
    """Fail closed unless the peer's leaf cert matches one of `pins`.

    `cert_der` is the peer certificate in DER form (binary_form=True);
    the pin is over sha256(cert_der). No pins configured means no
    check (system-CA + hostname verification still applies upstream).
    Comparison is constant-time per pin.
    """
    if not pins:
        return
    if not cert_der:
        raise CertPinMismatch(
            "%s: no peer certificate to pin against" % (where,))
    digest = hashlib.sha256(cert_der).digest()
    if not any(hmac.compare_digest(digest, pin) for pin in pins):
        raise CertPinMismatch(
            "%s: peer certificate does not match any configured pin; "
            "refusing the connection" % (where,))
DIRECT_PROBE_TIMEOUT = 3  # seconds; the direct-egress check is one quick TLS handshake


# ---------------------------------------------------------------------------
# Proxy URL hygiene
# ---------------------------------------------------------------------------

def redact_proxy_url(url):
    """Render a proxy URL as scheme://host:port only. Credentials, path, and
    query are dropped. Use this for every log line, error message, and CLI
    surface that mentions a proxy."""
    try:
        u = urlparse(url or "")
        host = u.hostname or ""
        port = ":%d" % u.port if u.port else ""
        scheme = u.scheme or "http"
        return "%s://%s%s" % (scheme, host, port)
    except Exception:
        return "<unparseable-proxy-url>"


def proxy_from_env(explicit=None):
    """The raw upstream proxy URL: explicit override first, then the
    https_proxy/HTTPS_PROXY environment. The return value may carry
    credentials, so callers must treat it as secret (never log it)."""
    if explicit:
        return explicit
    for var in PROXY_ENV_VARS:
        val = os.environ.get(var)
        if val:
            return val
    return None


# ---------------------------------------------------------------------------
# Egress CA discovery and SPKI derivation
# ---------------------------------------------------------------------------

def find_egress_ca_pem():
    """Path of the local egress MITM CA certificate (PEM), or None when the
    VM has direct egress with no interception. Env override first, then the
    well-known sandbox paths."""
    override = os.environ.get(CA_PEM_ENV_VAR)
    if override and os.path.isfile(override):
        return override
    for cand in CA_PEM_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    return None


def _der_tlv(data, off):
    """Parse one DER tag-length-value at offset. Returns
    (tag, tag_off, content_off, content_len, total_len)."""
    if off + 2 > len(data):
        raise ValueError("truncated DER at offset %d" % off)
    tag = data[off]
    first = data[off + 1]
    if first & 0x80 == 0:
        length = first
        hdr = 2
    else:
        n = first & 0x7F
        if n == 0 or n > 4 or off + 2 + n > len(data):
            raise ValueError("bad DER length at offset %d" % off)
        length = int.from_bytes(data[off + 2:off + 2 + n], "big")
        hdr = 2 + n
    total = hdr + length
    if off + total > len(data):
        raise ValueError("DER overruns buffer at offset %d" % off)
    return tag, off, off + hdr, length, total


def _der_children(data, content_off, content_len):
    """Split a constructed DER value's content into child TLVs."""
    kids = []
    end = content_off + content_len
    p = content_off
    while p < end:
        tlv = _der_tlv(data, p)
        kids.append(tlv)
        p = tlv[1] + tlv[4]
    if p != end:
        raise ValueError("DER children do not tile the parent")
    return kids


def spki_pin_for_pem(pem_path):
    """Derive the Chromium --ignore-certificate-errors-spki-list pin for a
    PEM certificate: base64(sha256(SubjectPublicKeyInfo)).

    The pin is computed from the actual file on disk at launch time, so it
    follows whatever CA the current VM uses. No pin value is hardcoded
    anywhere; only this derivation exists.
    """
    with open(pem_path, "r") as f:
        text = f.read()
    b64 = []
    in_block = False
    for line in text.splitlines():
        s = line.strip()
        if "BEGIN CERTIFICATE" in s:
            in_block = True
            continue
        if "END CERTIFICATE" in s:
            break
        if in_block and s:
            b64.append(s)
    if not b64:
        raise ValueError("no PEM certificate block in %s" % pem_path)
    der = base64.b64decode("".join(b64))
    # Certificate ::= SEQUENCE { tbsCertificate, sigAlg, sigValue }
    tag, _, tbs_off, tbs_len, _ = _der_tlv(der, 0)
    if tag != 0x30:
        raise ValueError("expected DER SEQUENCE for Certificate")
    outer = _der_children(der, tbs_off, tbs_len)
    # tbsCertificate ::= SEQUENCE; its children are:
    #   [0] version (optional), serial, sig, issuer, validity, subject,
    #   subjectPublicKeyInfo, ...
    _, _, tbsc_off, tbsc_len, _ = _der_tlv(der, outer[0][1])
    kids = _der_children(der, tbsc_off, tbsc_len)
    idx = 0
    if kids[0][0] == 0xA0:  # [0] explicit version present
        idx = 1
    # serial, sig, issuer, validity, subject -> spki is the 6th
    spki = kids[idx + 5]
    if spki[0] != 0x30:
        raise ValueError("expected SEQUENCE for subjectPublicKeyInfo")
    spki_der = der[spki[1]:spki[1] + spki[4]]
    digest = hashlib.sha256(spki_der).digest()
    return base64.b64encode(digest).decode("ascii")


def chrome_spki_args():
    """Extra Chromium args for the local egress CA, or [] when no MITM CA
    is present (direct egress: Chromium launches with no spki-list flag)."""
    pem = find_egress_ca_pem()
    if not pem:
        return []
    return ["--ignore-certificate-errors-spki-list=" + spki_pin_for_pem(pem)]


def ca_found():
    """Boolean only, for logs. Never cert contents."""
    return find_egress_ca_pem() is not None


# ---------------------------------------------------------------------------
# Egress probing
# ---------------------------------------------------------------------------

def _configured_canvas_base():
    """CANVAS_BASE resolved the way every agent-side reader resolves it
    (config/tree_config: the environment, then this tree's helper/env,
    then the legacy global env), or ""."""
    tree = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if tree not in sys.path:
        sys.path.insert(0, tree)
    from config import tree_config
    return tree_config.canvas_base()


def default_test_host():
    # P0-11: the tenant base wins when set; otherwise a neutral public
    # host. Never an operator-specific tenant: the egress probe must not
    # depend on (or leak) one educator's account.
    base = _configured_canvas_base() or "https://example.com"
    try:
        host = urlparse(base).hostname
        if host:
            return host
    except Exception:
        pass
    return "example.com"


def direct_egress_ok(host, timeout=DIRECT_PROBE_TIMEOUT):
    """One quick TLS handshake to host:443. Returns (ok, detail).

    Uses only stdlib sockets; carries no credentials and performs no HTTP.
    W6-P2-6: when MORROW_EGRESS_PIN is set, the peer's leaf certificate
    must additionally match a configured pin or the probe fails closed.
    """
    try:
        pins = parse_cert_pins(os.environ.get(EGRESS_PIN_ENV_VAR, ""))
    except ValueError as exc:
        return False, "%s is malformed: %s" % (EGRESS_PIN_ENV_VAR, exc)
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                check_cert_pin(tls.getpeercert(binary_form=True), pins,
                               "egress probe to %s" % host)
        return True, "TLS handshake to %s:443 succeeded" % host
    except CertPinMismatch as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)


def probe_egress(proxy_url=None, test_host=None, timeout=DIRECT_PROBE_TIMEOUT):
    """Probe the VM's egress in priority order and return a plain dict:

      mode:            "proxy_auth" | "proxy" | "direct" | "blocked"
      proxy:           redacted proxy URL (scheme://host:port) or None
      needs_forwarder: True only when Chromium needs the loopback forwarder
                       (authenticated proxy; Chrome cannot do proxy auth)
      upstream:        raw proxy URL for the forwarder subprocess env ONLY.
                       INTERNAL: never log, print, or argv this field.
      detail:          human-readable, credential-free explanation.

    Order: (a) authenticated proxy from env, (b) unauthenticated proxy from
    env, (c) no proxy env: quick direct-egress check; success means no
    forwarder is needed, failure names everything that was tried.
    """
    raw = proxy_from_env(proxy_url)
    if raw:
        try:
            has_auth = bool(urlparse(raw).username)
        except Exception:
            has_auth = False
        redacted = redact_proxy_url(raw)
        if has_auth:
            return {
                "mode": "proxy_auth",
                "proxy": redacted,
                "needs_forwarder": True,
                "upstream": raw,
                "detail": ("authenticated egress proxy at %s; Chromium "
                           "needs the loopback forwarder to inject "
                           "Proxy-Authorization" % redacted),
            }
        return {
            "mode": "proxy",
            "proxy": redacted,
            "needs_forwarder": False,
            "upstream": raw,
            "detail": ("unauthenticated egress proxy at %s; Chromium can "
                       "use it directly via --proxy-server" % redacted),
        }
    host = test_host or default_test_host()
    ok, why = direct_egress_ok(host, timeout=timeout)
    if ok:
        return {
            "mode": "direct",
            "proxy": None,
            "needs_forwarder": False,
            "upstream": None,
            "detail": ("direct egress to %s:443 works; no proxy and no "
                       "forwarder needed" % host),
        }
    tried = ("authenticated proxy (no https_proxy/HTTPS_PROXY in "
             "environment); unauthenticated proxy (same); direct TLS to "
             "%s:443 (failed: %s)" % (host, why))
    return {
        "mode": "blocked",
        "proxy": None,
        "needs_forwarder": False,
        "upstream": None,
        "detail": "no usable egress. Tried: %s" % tried,
    }
