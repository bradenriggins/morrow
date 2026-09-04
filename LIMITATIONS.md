# Limitations

This file maps current limits from `docs/implementation/MORROW-LEGACY-BRIDGE.md` and stop conditions from `docs/implementation/EXAMPLE-WORKTREE.md`. It also records held-provider limits that already appear in `README.md`, `docs/sources/donor-manifest.json`, and the upstream example files.

Do not treat this file as a new capability list.

## Current limits

These limits come from the Morrow legacy bridge note:

- The bridge has automated protocol, authentication, collision, and fake-extension proof. It has not yet been exercised against Braden's live packed Morrow extension.
- The overlay targets the pinned donor revision. A new donor revision requires a catalog re-export and a review of the patch anchors.
- Browser-session capabilities remain dependent on the existing extension and its live Canvas bindings.
- MindTap and Connect never enter the source catalog used by this bridge.
- The client conformance report is a hermetic configuration check. It is not real-client proof. Codex, Claude Code, and Gemini CLI must each connect and run the required scenario before a client-support claim is made.
- `morrow_operation_cancel` is an interface placeholder. It does not cancel a provider task.

## Held providers

`docs/sources/donor-manifest.json` records `heldProviders` as `mindtap` and `connect`.

`README.md` states the same provider boundary: Canvas is the initial provider. MindTap and Connect are removed from the merged catalog. They remain outside supported claims pending written permission or formal developer terms.

The upstream example files and the gateway config default `filters.excludePrefixes` to `mindtap_` and `connect_`. Those names are removed at catalog construction time.

## Catalog cap

The upstream example files set `maxCatalogTools` to `1000`. The gateway config schema accepts a positive integer through `5000` and defaults to `1000`.

## Release-candidate boundary

`1.0.0-rc.0` identifies a local candidate format. It is not a tag, publication,
provider authorization, or release claim.

`pnpm package:rc` can create deterministic local bytes and a receipt that binds
them to one commit and tree. The receipt remains non-promotable until these
external receipts are verified:

- authorized live Canvas proof;
- client-parity proof;
- independent clean-machine reproduction; and
- publication authorization.

The candidate also blocks until every staged source file has a reviewed
source-origin ledger entry and every zero-tolerance check has a zero-count
receipt. `pnpm weekend:check` and `pnpm conformance:report` must fail while any
of these records are absent. The Appendix C implementation map is
`config/appendix-c-path-map.json`; it records current architecture paths and
does not make deferred donor-owned behavior release-ready.

## Stop conditions

Stop the branch when any change would do one of these acts. This list comes from `docs/implementation/EXAMPLE-WORKTREE.md`:

- copy private CHCP material into this repository
- publish MindTap or Connect methods
- add a direct Canvas route to the gateway
- let a tool bypass its owning authority or approval path
- silently replace a duplicate tool
- forward raw upstream metadata
- auto-select a contract-drift row
- infer a semantic alias without an explicit reviewed rule
- return an upstream error with unreviewed raw details
- expose the bridge pairing token through URLs, MCP output, logs, or committed source
- allow a non-loopback bridge listener
- let the MCP surface approve, resume, undo, or otherwise act on a donor task
- report a possibly applied write as successful without source-owned readback

## Related records

- `docs/implementation/MORROW-LEGACY-BRIDGE.md`
- `docs/implementation/EXAMPLE-WORKTREE.md`
- `docs/sources/donor-manifest.json`
- `README.md`
- `morrow.upstreams.example.json`
- `morrow.upstreams.with-legacy-bridge.example.json`
