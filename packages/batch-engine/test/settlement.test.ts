import { describe, expect, it } from "vitest";
import {
  BatchSourceSettlementStore,
  sourceSettlementStateFromTask,
} from "../src/public.js";

describe("BatchSourceSettlementStore", () => {
  it("tracks staging separately from final provider outcome", () => {
    const store = new BatchSourceSettlementStore({ path: ":memory:" });
    store.initialize("bat:test-1234", [
      { childId: "course:41", sourceId: "example-legacy", sourceBindingId: "canvas:41" },
      { childId: "course:42", sourceId: "example-legacy", sourceBindingId: "canvas:42" },
    ]);
    expect(store.summary("bat:test-1234")).toMatchObject({
      outcome: "not_started",
      notStarted: 2,
      terminal: false,
    });

    store.markStaged("bat:test-1234", "course:41", {
      sourceTaskId: "task-41",
      gatewayOperationId: "gop:41-12345678",
    });
    store.markStaged("bat:test-1234", "course:42", {
      sourceTaskId: "task-42",
      gatewayOperationId: "gop:42-12345678",
    });
    expect(store.summary("bat:test-1234")).toMatchObject({
      outcome: "awaiting_approval",
      awaitingApproval: 2,
      terminal: false,
    });

    store.applyTaskProjection("bat:test-1234", "course:41", {
      taskId: "task-41",
      status: "completed",
      outcome: "succeeded",
      terminal: true,
      verificationStatus: "verified",
      resultCounts: { done: 1 },
    }, "gop:reconcile-41");
    store.applyTaskProjection("bat:test-1234", "course:42", {
      taskId: "task-42",
      status: "awaiting_confirmation",
      outcome: "awaiting_approval",
      terminal: false,
      resultCounts: {},
    }, "gop:reconcile-42");
    expect(store.summary("bat:test-1234")).toMatchObject({
      outcome: "awaiting_approval",
      succeeded: 1,
      awaitingApproval: 1,
    });

    store.applyTaskProjection("bat:test-1234", "course:42", {
      taskId: "task-42",
      status: "completed",
      outcome: "succeeded",
      terminal: true,
      verificationStatus: "verified",
      resultCounts: { done: 1 },
    }, "gop:reconcile-42-final");
    expect(store.summary("bat:test-1234")).toMatchObject({
      outcome: "succeeded",
      succeeded: 2,
      terminal: true,
    });
    expect(store.get("bat:test-1234", "course:42")).toMatchObject({
      taskDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultCounts: { done: 1 },
    });
    store.close();
  });

  it("preserves ambiguous and effect-possible failure states", () => {
    expect(sourceSettlementStateFromTask({
      taskId: "task-1",
      status: "failed",
      resultCounts: { done: 1 },
    })).toBe("failed_effect_possible");
    expect(sourceSettlementStateFromTask({
      taskId: "task-2",
      status: "failed",
      resultCounts: {},
    })).toBe("failed_no_effect");
    expect(sourceSettlementStateFromTask({
      taskId: "task-3",
      status: "completed",
      resultCounts: { unconfirmed: 1 },
    })).toBe("inspection_required");
  });

  it("refuses task identity substitution", () => {
    const store = new BatchSourceSettlementStore({ path: ":memory:" });
    store.initialize("bat:test-5678", [
      { childId: "course:1", sourceId: "example-legacy" },
    ]);
    store.markStaged("bat:test-5678", "course:1", { sourceTaskId: "task-1" });
    expect(() => store.applyTaskProjection("bat:test-5678", "course:1", {
      taskId: "task-other",
      status: "completed",
      outcome: "succeeded",
    })).toThrow(/does not match/);
    store.close();
  });
});
