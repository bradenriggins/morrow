# Morrow defect-eradication goal

Status: **active**

Started: 2026-09-12

Branch: `codex/defect-root-eradication`
Baseline: `d262ac47571dbba8a617f47b80ec7223c4ab46bd`

## Objective

Remove every known Morrow defect by repairing its root cause. Continue adversarial discovery after each repair wave. Add every validated defect to the ledger. Close a defect only after the implementation, a focused regression, the required broad gate, and direct result inspection prove the repaired requirement.

The controlling ledger is [DEFECT-ERADICATION-LEDGER.md](DEFECT-ERADICATION-LEDGER.md).

## Non-negotiable invariants

1. A write is verified only by fresh evidence bound to the exact source, account, course, target, request, and provider identity.
2. Cancellation and failed creation revoke all undispatched authority through the same durable state transition.
3. Learner identity is typed data. Resource IDs, scores, labels, and free text never become identities from scalar coincidence.
4. Every provider contract preserves opaque identifiers, pagination values, empty values, and official response shapes.
5. Every MCP continuation, cancellation, protocol frame, and session transition preserves its protocol meaning end to end.
6. Desktop state has one durable owner. Setup, rollback, removal, repair, refresh, and relaunch are transactional and identity-bound.
7. Release evidence forms one verifiable graph from exact source through staged bytes and artifacts to authorization and publication state.
8. Bounded work remains bounded in time, concurrency, memory, and provider calls at every public entry point.
9. Generated contracts and fixtures are derived from the same implementation rules and cannot mask a provider mismatch.

## Repair sequence

1. Establish the ledger, root families, baseline gate, and isolated branch.
2. Repair false verification and durable authority first.
3. Repair privacy typing, artifact semantics, and public egress.
4. Repair provider contracts for Canvas, Moodle, and Blackboard.
5. Repair MCP, Bridge, Desktop, and configuration lifecycles.
6. Replace release gates with the unified evidence graph.
7. Run the full repository gate and inspect the built application and generated artifacts.
8. Run another adversarial pass across changed roots and previously unsearched paths. Add and repair every new validated defect.
9. Close the goal only when the ledger has no open validated defect and every closure has current evidence.

## Completion record required for each defect

- Root cause and affected invariant.
- Deliberate implementation change.
- Focused regression that fails on the baseline and passes on the repair.
- Required generated-file updates.
- Focused check result.
- Broad gate result after integration.
- Direct inspection of the authoritative output or state.
- Commit or immutable patch identity for the repair.

Historical audit evidence is retained at `/Users/Braden/Documents/Codex/Morrow-repo-audit-2026-09-12-d262ac4`.
