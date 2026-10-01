# Installed Chromium integration

The final release must connect Moodle through the VM's installed Chromium.
Python receives provider results and account identifiers, never cookies or
sesskeys. A browser session is paired to one exact site URL and educator ID.
Course choice belongs to the assistant. Optional course scopes constrain
operations; account access has no course-count limit.

Integration layers:

1. Private CDP, isolated-world identity checks, bounded course discovery.
2. Provider operation registry and form adapters with exact site/account
   binding, learner-vault handling, complete results, and capability probes.
3. Existing Plan/Edit admission, frozen approvals, durable reservations,
   verified writes, uncertain-effect recovery, and one-time private setup.
4. Native helper, installed-package E2E, and live disposable-provider proof.

The carve supplies layer 2's canonical source assets under
`moodle/browser-assets/`: the Desktop adapters and generated catalog,
unchanged and covered by the integrity manifest. The generated route
registry binds all 250 operations to the worker's adapter choice, private
attachment mode, exact UTF-8 function byte range, and source/function
hashes. Route generation runs only during the build; it adds no Node.js
requirement on the Muse VM. The carve refuses stale worker or adapter
bytes. It does not yet execute those adapters through Muse's governed
dispatch.

`moodle/browser_operations.py` stages those assets through the authenticated
helper proxy. It checks the pinned route registry, catalog, module and exact
callable hashes. It sends bounded chunks into one existing private context,
requires acknowledgments, and verifies source and request bytes inside the
browser before compiling. A changed URL or context refuses the load. The URL
stays inside Chromium. Loading is paced below the helper's normal rate limit.
Staging does not invoke adapters or send provider requests.

`MoodleBrowserTransport._stage_operation` prepares a separate operation tab
and private context. It reads fresh server configuration and binds the
paired account, exact course page, login timestamp, and sesskey before
staging. The trusted configuration stays in the private context. Moodle
4.1 uses the parameter-free own-profile identity check. A modern null or
conflicting account is refused. A changed course account, login, or sesskey
also refuses before invocation. The existing page scripts supply no identity
to this path. The governed executor must close the prepared tab and must
perform its admission, privacy, and journal checks before invocation.

This preparation does not yet make native form readbacks compatible with
Moodle 4.1. Shared adapters that require `userId` in returned form HTML still
need that compatibility check. Preparation is not an operation front door.

`scripts/moodle-adapter-loader-e2e.py` verifies this with the real packaged
helper and a disposable HTTPS fixture under strict CSP. It checks every
canonical callable, Unicode payloads, incomplete acknowledgments, changed
assets, wrong sites, context replacement, and a dummy URL sesskey. The driver
is development-only. Run it with a receipt path, a Chromium executable, and
the carved `moodle/browser-assets` directory. If the VM refuses loopback
pages through its local-network protection, add `--public-staging-only`.
That mode loads adapters on the official public Moodle demo and sends no
provider operation. It proves staging only. The complete fixture read and
strict-CSP checks still need the full fixture mode on a permitted machine.

Layer 1 and adapter staging are not proof that layers 2–4 are finished. No raw browser write
interface may be added as a substitute for governed execution.

## Failure cases, before implementation

- A session cookie or sesskey enters Python, stdout, a receipt, or a file.
- The page replaces fetch, or exports a false `M.cfg` in its main realm.
- Moodle is installed below `/lms`; requests leave that site prefix.
- An IdP/login redirect is followed by an authenticated API request.
- The configured root or educator differs from the live page configuration.
- A guest or unsigned-in user passes the account check.
- Missing, malformed, duplicated, or oversized configuration is accepted.
- The provider changes account between pages and a mixed result is returned.
- Hundreds of courses are silently truncated to the first page.
- A malformed row, oversized body, or error envelope looks complete.
- Course records expose extra person, credential, or provider fields.
- An earlier tab on the same host belongs to a different Moodle site path.
- A page offset or page size is malformed, causes no progress, or repeats.
- Recovery retries a write whose effect is unknown.
- A write bypasses catalog capabilities, privacy, Plan/Edit, or approval.

Layer 1 E2E: `scripts/moodle-browser-e2e.py`, against a disposable loopback
Moodle-shaped server and installed Chromium. It preserves real profiles and
ports. It records every check and provider call count in a JSON artifact.

Authoritative configuration contract:
https://github.com/moodle/moodle/blob/main/public/lib/classes/output/requirements/page_requirements_manager.php
(`get_config_for_javascript`, `get_head_code`). Moodle serializes `M.cfg`
as JSON through `js_writer::set_variable`. It includes `wwwroot`, `sesskey`,
`userId`, and `currentlogin`.

Moodle 4.5 exposes `userId` but places `currentlogin` in the exact
`core/storage_validation` AMD initialization emitted by `js_call_amd`.
The browser parses this source-defined marker without executing page code.
Null, missing, and duplicate login markers refuse. A modern `M.cfg` value
takes precedence, including a null value; it cannot be replaced by a footer.
https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/lib/classes/output/requirements/page_requirements_manager.php
Moodle 4.1 does not expose `M.cfg.userId`. For that version only, the
browser requests `/user/profile.php` without an `id` parameter. Moodle
selects the signed-in user, sets the user context, and serializes its
`contextInstanceId`. The transport requires `page-user-profile`, the same
site, login timestamp and sesskey as the root, and the pinned educator ID.
A present modern `userId`, including null, never triggers this fallback.
Profile content and session secrets remain inside Chromium.
https://github.com/moodle/moodle/blob/MOODLE_401_STABLE/user/profile.php
https://github.com/moodle/moodle/blob/MOODLE_401_STABLE/lib/outputrequirementslib.php

## Current evidence

Layer 1 has 64 passing real Chromium checks, including all 257 courses,
isolated-world fetch, site-prefix tab selection, and fail-closed responses.
The test is repeatable with:

```
python scripts/moodle-browser-e2e.py /path/to/receipt.json /path/to/chromium
```

The fixture uses a fresh profile and disables Chromium local-network checks
only in that disposable test process. This flag never enters production
launch configuration. Muse VM Chromium still refuses loopback navigation;
that VM run failed before a provider request. The Mac Chrome for Testing
153 run passes. VM authenticated-provider proof is still required.

The browser transport exposes identity and paged course reads only. Its
inherited Canvas API method refuses calls. It does not expose a Moodle
write path or replace the uncompleted governed operation layer.
