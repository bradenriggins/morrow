# VM-local Chromium transport

Canvas reads and writes run through `dispatch/executor.py --backend chromium`
as in-page REST fetches in the educator's VM-local Chromium session. The
managed Browser is not this execution lane. Sign-in is presented through the
private native Muse helper; the persistent profile owns the browser session.
Credentials never enter agent-visible configuration, commands, or chat.

## Current architecture

- The helper launches one Chromium for this tree and profile through a private CDP pipe. There is no TCP debugging listener. Cross-process access uses the
  token-authenticated helper proxy and verifies exact tree/profile/version.
- `config.tree_config` resolves ports and paths from the current tree. Default
  numbers are not global identity. Never attach to an arbitrary listener or
  kill a foreign process to obtain a port.
- Both bare and authenticated proxy environments use the protected loopback forwarder in `proxy_forwarder.py`. Chromium cannot reliably use every bare
  platform proxy directly; the forwarder also handles upstream proxy auth.
  It admits only launcher descendants and applies resource bounds. Direct
  egress is used only when no proxy is configured and the probe permits it.
- Platform TLS inspection and its exact CA-derived pin are disclosed in
  `../INSTALL.md`. Never disable global certificate validation or remove a
  configured proxy to bypass a failure.
- First install runs `bash install.sh` with the supported runtime and tenant
  probe. Later `bin/morrow start` restores supervision after a VM reboot.
  Keepalive is an internal supervised maintenance path, not initial onboarding.
- Healthy transport, authenticated account, privacy readiness, admitted
  operation, and verified saved effect are separate checks. A live process or
  an HTTP 200 helper status does not prove a usable Canvas session.

## Governance and privacy

The executor applies current catalog, policy, principal, target, Plan/Edit,
privacy, halt, and journal checks. Canvas response data is projected before
agent-visible receipts and journals. Session-bound fetch and sensitive SDK
credentials remain inside the authorized process/browser boundary. Do not
route production Canvas calls through raw HTTPS or the legacy browser backend.

## Retired infrastructure

Browser-task briefs, form-host experiments, cookie capture, and raw-HTTPS
proof rigs are historical infrastructure, not current setup instructions or
fallbacks. Do not spawn a managed browser task to execute a Canvas batch. Do
not export a cookie jar or provision a remote form host. Historical live proofs
establish only what was tested on their dated path; current admission still
requires current packaged evidence and policy.

The decisions below describe implemented transport controls and their checks.

## Wave 4 adversarial audit decisions (2026-09-22)

This section is the decision record for the Wave 4 browser/CDP/transport
findings. (The audit asked for some of these to be written into
INSTALL.md; INSTALL.md sits outside the in-scope tree for this
remediation, so they live here instead and the gap is reported with the
fix.)

The "Coverage:" lines name the selftest suites that check each
decision. `egress_selftest.py`, `helper_selftest.py`, and
`helper/cdp_http_auth_selftest.py` are install suites: they ship and run
at every install (`scripts/install-suites.sh`). `local_chromium_selftest.py`
runs in the source repository's CI (`scripts/dev-suites.sh`) and is not
part of the release.

### No TCP CDP: pipe only (W4-P0-3, W4-P2-16)

Chromium launches with `--remote-debugging-pipe`, never
`--remote-debugging-port`. CDP frames travel over the anonymous pipe
between the launcher and its own Chromium; there is no TCP listener, so
no cross-process CDP surface exists to authenticate. Direct CDP(port)
construction without a launcher owner is refused. The only
cross-process CDP path is the helper's /cdp/* proxy, which requires the
per-launch HELPER_AUTH_TOKEN (verified by
helper/cdp_http_auth_selftest.py). Coverage: local_chromium_selftest.py
in the source repository (no-debugging-port-flag, cdp-ownerless-refused,
no-tcp-probe-helpers).

### Cross-tree isolation (W4-P2-16)

The launcher verifies, via /proc argv inspection, that the process
holding the helper status port and the Chromium profile belongs to the
same tree (exact binary, exact profile dir, exact helper version). A
foreign browser behind the same port is refused with a fail-closed
RuntimeError rather than adopted. Same for the egress forwarder port
(W3-P2-12): exact proxy_forwarder.py argv + exact port.

### Protected egress forwarder (W4-P2-9)

The loopback CONNECT forwarder (proxy_forwarder.py) refuses to start
without MORROW_FORWARDER_LAUNCHER_PID in its environment (fail closed,
exit 2). Every CONNECT is authorized by client-process ancestry:
the client socket's owner is resolved through /proc/net/tcp ->
socket inode -> /proc/<pid>/fd, and the owner must be a strict
descendant of the launcher PID (PID-reuse-safe via starttime-keyed
cache). Non-descendants get HTTP 403 before any request byte is
processed. The launcher passes its PID via the forwarder's child
environment (never argv) and adopts a listening forwarder port only
when the holder's environ names the current launcher PID
(_verify_forwarder_holder); a forwarder owned by another launcher is
refused, not adopted. Coverage: egress_selftest.py sections (c)/(d),
local_chromium_selftest.py verify-forwarder-holder-* in the source
repository.

### HTTPS upstream proxy: TLS before auth (W4-P1-3)

An https:// upstream proxy scheme gets a real TLS handshake before any
CONNECT or Proxy-Authorization byte is written; Proxy-Authorization
travels inside the tunnel, never in plaintext. Verified end-to-end in
egress_selftest.py section (e) with a throwaway self-signed TLS proxy:
the fake proxy asserts the first bytes are a TLS ClientHello and that
CONNECT + Proxy-Authorization arrive inside the encrypted channel.

### HTTPS-only navigation (W4-P1-12, W4-P2-8)

Both transport/_assert_https_nav_url and helper _cdp_proxy_nav_ok
permit https:// only (about:blank narrowly allowed for new tabs, where
no credentialed traffic flows). http:// is refused so session cookies
can never cross the wire in cleartext. The old document.title-based
logged_in check is gone; login state comes from the document URL.
Coverage: local_chromium_selftest.py in the source repository
(https-nav-guard) and helper_selftest.py section 14 (W4-P2-8 navigation
URL policy probe).

### Isolated-world API fetches (W4-P1-13)

API fetches run inside a Page.createIsolatedWorld context: the fetch
JavaScript executes in an isolated realm whose objects cannot be
reached by page scripts, so a compromised page cannot exfiltrate or
rewrite the requests. The trust boundary: the isolated world trusts
Chromium's world isolation, not page content; responses are still
validated as JSON before use. Coverage: local_chromium_selftest.py
in the source repository (isolated-world checks).

### Downloads denied, fail closed (W4-P2-18)

Browser.setDownloadBehavior({"behavior":"deny"}) is set on every
session; there is no download-accept path. Any page that triggers a
download fails closed (the download is dropped, the op errors) rather
than writing untrusted bytes to disk. Coverage:
local_chromium_selftest.py in the source repository.

### Root / --no-sandbox decision (W4-P0-9)

Sandbox status: --no-sandbox is appended only when euid == 0, at the
single launch site, with a loud WARNING log line (W4-P0-9).
Alternatives assessed on 2026-09-22 on this VM (root, unprivileged
user namespaces available): Chromium refuses to run as root without
--no-sandbox (crbug.com/638180, exit 1); dropping to a non-root user
via setpriv crashed the sandbox host (exit 133, crashpad
--database errors) even with --no-sandbox, because the sandbox
subprocesses need a writable HOME/XDG runtime dir that was not
provided. The pragmatic resolution for this agent-VM environment is
root + --no-sandbox + the rest of this hardening stack (private pipe
CDP, token-authed helper proxy, https-only navigation, denied
downloads, authenticated egress forwarder). The flag remains a loud,
single-site, root-only exception, not a default. If a future
deployment runs as non-root with a writable runtime dir, re-probe
non-root launch and drop the exception.
