# Weekend convergence implementation

This file records the current implementation against Revision 3 of the Morrow MCP V1.0 Weekend Example Plan.

## Catalog and profiles

- `pnpm catalog:export` captures both pinned donors.
- Morrow legacy contributes 284 source tools.
- ExamplePlatform contributes 222 source tools through `ssh -T example-lms-vps`.
- The 35 MindTap and Connect rows receive `rights_hold` and never enter routing.
- The merged catalog contains 471 enabled capabilities.
- Five reviewed alias rules select an explicit schema and route.
- Every enabled capability has source, behavior, authority, route, profile, schema, and digest evidence.
- Runtime profiles fail closed when their source or publication evidence is absent.

## Runtime

- The public process uses the official MCP TypeScript SDK over strict stdio.
- Current and legacy protocol initialization use the same server factory.
- Health includes the gateway, donors, extension bridge, effect broker, batch ledger, approval server, profile, catalog, and source revisions.
- Read results use `morrow.result.v1` and a durable compact gateway operation.
- Output projection selects allowed fields before text inspection.
- Sensitive free text, raw upstream metadata, learner identity, and unreviewed artifacts fail closed.

## Writes and approval

1. The gateway validates the selected capability and freezes the exact request.
2. The plan records target, changed and preserved fields, risk, request cost, authority, readback, and correction support.
3. The operation enters `awaiting_approval` without a provider write.
4. A loopback page shows the frozen operation and issues a one-use nonce.
5. The approval grant binds the plan, profile, actor, provider principal, connection generation, catalog, approval class, and expiry.
6. Dispatch revalidates the current authority and reserves one effect before send.
7. ExamplePlatform writes start an ephemeral SSH process with the exact operation, course, and task-contract digest.
8. Morrow legacy writes pass the outer grant to the extension bridge and can then enter donor approval.
9. A successful send runs the frozen fresh readback immediately when no inner approval remains.
10. An ambiguous send becomes `applied_or_unknown`. Reconciliation performs only the readback and never replays the write.

## Batches

- Batch manifests contain an exact explicit course set, child order, target digests, dependencies, profile and catalog digests, approval coverage, request estimates, readback digests, correction facts, and expiry.
- Arguments and the full manifest use AES-256-GCM at rest.
- Every write child freezes its own outer effect operation at batch creation.
- One loopback batch page renders the full child target set and approves all exact child plans.
- A batch cannot dispatch until every pending child has a current outer grant.
- Each child reserves and consumes one effect before source dispatch.
- Provider approval and provider readback stay separate from orchestration progress.
- A write batch stays nonterminal while any source result is awaiting approval or verification.
- Restart recovery marks interrupted children for inspection and performs no automatic write replay.
- Result pages read only bounded child rows and return an encrypted manifest reference.
- Only explicit course sets are accepted in this release. Other source types require a future gateway-owned resolver receipt.

## Clients and packages

- `morrow mcp install` renders project-scoped Codex, Claude Code, and Gemini configuration.
- Client files contain only the Morrow stdio command, repository working directory, and upstream-config path.
- The CLI exposes doctor, profile, catalog, backend, operation, batch, conformance, install, config inspection, and render commands.
- Private and public package profiles produce deterministic ZIP files, SHA-256 manifests, CycloneDX SBOMs, marker scans, and receipts.
- The public package omits the private ExamplePlatform runtime adapter and requires explicit source-rights records.

## Remaining external gates

The code cannot create these receipts.

- Authorized Canvas live proof needs a current human-authenticated session. MFA currently blocks it.
- Real Codex, Claude Code, and Gemini scenario parity has not completed.
- The packed Morrow legacy extension needs live pairing and task proof.
- Public source rights and publication authorization need an owner decision.
- Independent clean-machine reproduction needs a separate machine or environment.

Morrow remains `1.0.0-rc.0` while any gate is missing.
