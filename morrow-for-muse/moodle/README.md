# Moodle browser operations for Morrow for Muse

The public entry point is `bin/morrow moodle`. Read [SKILL.md](SKILL.md) for
account pairing, course discovery, Plan/Edit modes, and recovery.
Authentication remains in the VM's installed Chromium. Account pairing is
one-time and course access has no course-count limit.

The package contains these layers:

- `contracts.py`: exact site validation and safe operation errors.
- `browser_transport.py`: fresh account checks, Moodle 4.1 own-profile
  identity, paged course discovery, and private operation preparation.
- `browser_operations.py`: integrity-pinned canonical catalog, registry,
  and adapter loading into an isolated context.
- `dispatch.py`: source privacy, current roster, immutable learner-token
  binding, canonical review, admission, durable claims, and verified writes.
- `cli.py`: private account records, operation discovery, plans, approvals,
  and the public command interface.
- `browser-assets/`: canonical Desktop adapters and generated metadata.

The old Python session, form-login, capability probe, keepalive, and reauth
modules remain source-only historical test tools. They are excluded from
the distribution. Do not use them for school authentication or writes.

Fixture evidence does not prove a school's native setup or every operation.
Native first-use, private attachments, and provider qualification remain
required before release. Source design and E2E details are in
`BROWSER-CONTRACT.md`, which is source-only and not shipped.
