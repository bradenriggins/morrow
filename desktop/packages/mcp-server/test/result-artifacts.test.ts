import type { JsonObject } from "@morrow/contracts";
import { LearnerRoster, LearnerVault, redactLearnerEgress } from "@morrow/gateway-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_INLINE_RESULT_CHARACTERS,
  resolveResultArtifact,
  resultArtifactAudience,
  ResultArtifactStore,
} from "../src/result-artifacts.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("ResultArtifactStore", () => {
  it("derives a distinct audience for each local-owner proxy and workspace", () => {
    const protocol = {
      sessionId: undefined,
      http: undefined,
    } as Parameters<typeof resultArtifactAudience>[0];
    const first = resultArtifactAudience(protocol, { proxyPid: 101, workspaceRoot: "/private/tmp/project-a" });

    expect(resultArtifactAudience(protocol, { proxyPid: 101, workspaceRoot: "/private/tmp/project-a" })).toBe(first);
    expect(resultArtifactAudience(protocol, { proxyPid: 102, workspaceRoot: "/private/tmp/project-a" })).not.toBe(first);
    expect(resultArtifactAudience(protocol, { proxyPid: 101, workspaceRoot: "/private/tmp/project-b" })).not.toBe(first);
    expect(resultArtifactAudience({ ...protocol, sessionId: "another-session" }, {
      proxyPid: 101,
      workspaceRoot: "/private/tmp/project-a",
    })).not.toBe(first);
  });

  it("preserves a large input_required protocol envelope", () => {
    const store = new ResultArtifactStore();
    const result = {
      resultType: "input_required",
      inputRequests: {
        review: {
          method: "elicitation/create",
          params: { message: "x".repeat(MAX_INLINE_RESULT_CHARACTERS) },
        },
      },
      requestState: "v1.signed-state",
    } satisfies JsonObject;

    const bounded = store.bound(result, (value) => ({ ...value, projected: true }));

    expect(bounded).toMatchObject({
      resultType: "input_required",
      requestState: "v1.signed-state",
      projected: true,
    });
    expect(bounded.structuredContent).toBeUndefined();
  });

  it("still stores a large ordinary result as an artifact", () => {
    const store = new ResultArtifactStore();
    const bounded = store.bound({
      content: [{ type: "text", text: "x".repeat(MAX_INLINE_RESULT_CHARACTERS) }],
      structuredContent: { schema: "fixture.large.v1" },
    });

    expect(bounded.structuredContent).toMatchObject({ schema: "morrow.result-artifact.v1" });
    expect(bounded).not.toHaveProperty("resultType");
  });

  it("pages the immutable redacted snapshot after its captured roster expires", () => {
    const store = new ResultArtifactStore();
    const start = 1_000_000;
    let clock = start;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const learnerScope = {
      canvasOrigin: "https://canvas.example.test",
      account: "synthetic",
      course: "42",
      principal: "synthetic",
      profile: "private-full",
    };
    const learnerRoster = new LearnerRoster();
    learnerRoster.register(learnerScope, [{ id: "17", name: "Ada Lovelace" }]);
    const learner = {
      learnerRoster,
      learnerVault: new LearnerVault(":memory:"),
      learnerScope,
    };
    const bounded = store.bound({
      content: [{ type: "text", text: "Ada Lovelace reviewed this course. ".repeat(2_000) }],
      structuredContent: { schema: "fixture.learner-result.v1" },
    }, (value) => redactLearnerEgress(value, learner) as JsonObject);

    clock = start + 60_001;
    expect(learnerRoster.isReady(learnerScope)).toBe(false);
    const resolved = resolveResultArtifact(bounded, (handle, offset) => store.page(handle, offset));

    expect(JSON.stringify(resolved)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(resolved)).toContain("Student A1 reviewed this course.");
  });
});
