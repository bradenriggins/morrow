import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderEffectBroker } from "../src/index.js";

const roots: string[] = [];
let sequence = 0;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function create(broker: ProviderEffectBroker, input: Partial<Parameters<ProviderEffectBroker["create"]>[0]> = {}) {
  const sourceOperationId = `operation:effect-${++sequence}`;
  return broker.create({
    publicToolName: "canvas_page_update",
    sourceId: "example-legacy",
    sourceToolName: "canvas_page_update",
    catalogDigest: "a".repeat(64),
    request: { page_id: "42", title: "Original" },
    forwardedRequest: { page_id: "42", title: "Original", _morrow: { operation_id: sourceOperationId } },
    sourceOperationId,
    ...input,
  });
}

describe("ProviderEffectBroker", () => {
  it("freezes plans and binds one expiring, single-use approval grant", () => {
    let clock = new Date("2026-09-04T00:00:00.000Z");
    const broker = new ProviderEffectBroker({ path: ":memory:", now: () => clock });
    const request = { page_id: "42", title: "Original" };
    const operation = create(broker, { request });
    request.title = "Mutated";
    expect((broker.get(operation.operationId).plan.arguments as { title: string }).title).toBe("Original");

    const approved = broker.approve(operation.operationId);
    expect(approved.approvalGrantDigest).toMatch(/^[0-9a-f]{64}$/);
    const dispatched = broker.reserveDispatch(operation.operationId);
    expect(dispatched.state).toBe("dispatching");
    expect(dispatched.dispatchAttempt).toBe(1);
    expect(() => broker.reserveDispatch(operation.operationId)).toThrow("cannot dispatch");

    const expiring = create(broker, { approvalTtlMs: 60_000 });
    clock = new Date("2026-09-04T00:01:01.000Z");
    expect(broker.approve(expiring.operationId).state).toBe("cancelled");
    broker.close();
  });

  it("records ambiguity, fresh comparator evidence, and correction lineage", () => {
    const broker = new ProviderEffectBroker({ path: ":memory:" });
    const unknown = create(broker);
    broker.approve(unknown.operationId);
    broker.reserveDispatch(unknown.operationId);
    expect(broker.settleFailure(unknown.operationId, { timeout: true }, true).state).toBe("applied_or_unknown");

    const verified = create(broker, {
      readback: { tool: "canvas_page_get", arguments: { page_id: "42" }, expectedDigest: "b".repeat(64) },
    });
    broker.approve(verified.operationId);
    broker.reserveDispatch(verified.operationId);
    broker.settleResponse(verified.operationId, { upstreamResultDigest: "c".repeat(64) });
    expect(broker.recordReadback(verified.operationId, "d".repeat(64), false).state).toBe("awaiting_verification");
    expect(broker.recordReadback(verified.operationId, "b".repeat(64), true).state).toBe("verified");

    const innerApproval = create(broker, {
      readback: { tool: "canvas_page_get", arguments: { page_id: "42" }, expectedDigest: "e".repeat(64) },
    });
    broker.approve(innerApproval.operationId);
    broker.reserveDispatch(innerApproval.operationId);
    broker.settleResponse(innerApproval.operationId, {
      upstreamResultDigest: "f".repeat(64),
      innerApprovalRequired: true,
    });
    expect(() => broker.recordReadback(innerApproval.operationId, "e".repeat(64), true)).toThrow();

    const correction = create(broker, { correctionOf: verified.operationId });
    expect(correction.correctionOf).toBe(verified.operationId);
    expect(correction.operationId).not.toBe(verified.operationId);
    broker.close();
  });

  it("marks an interrupted dispatch ambiguous on restart and never replays it", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-effects-"));
    roots.push(root);
    const path = join(root, "operations.sqlite3");
    const first = new ProviderEffectBroker({ path });
    const operation = create(first);
    first.approve(operation.operationId);
    first.reserveDispatch(operation.operationId);
    first.close();

    const restarted = new ProviderEffectBroker({ path });
    expect(restarted.get(operation.operationId)).toMatchObject({
      state: "applied_or_unknown",
      dispatchAttempt: 1,
      attention: ["process_restart_after_dispatch"],
    });
    expect(() => restarted.reserveDispatch(operation.operationId)).toThrow();
    restarted.close();
  });
});
