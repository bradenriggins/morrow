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
  const large = () => ({ content: [{ type: "text", text: "x".repeat(MAX_INLINE_RESULT_CHARACTERS + 100) }] });
  const handle = (result: JsonObject) => (result.structuredContent as JsonObject).handle as string;

  it("keeps a result being paged when the seventeenth result arrives", () => {
    const store = new ResultArtifactStore();
    const first = handle(store.bound(large()));
    for (let index = 0; index < 15; index += 1) store.bound(large());
    const page = store.page(first, 0, 16);
    expect(page.nextOffset).toBe(16);
    store.bound(large());
    expect(store.page(first, 16, 16).offset).toBe(16);
  });

  it("reports capacity instead of evicting all sixteen active pages or creating an unusable handle", () => {
    const store = new ResultArtifactStore();
    const active: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const saved = store.bound(large());
      store.bindAudience(saved, "assistant-a");
      active.push(handle(saved));
      store.page(active.at(-1)!, 0, 16, "assistant-a");
    }
    const next = store.bound(large());
    expect(next).toMatchObject({ isError: true, structuredContent: { code: "result_artifact_capacity" } });
    expect(() => store.bindAudience(next, "assistant-a")).not.toThrow();
    for (const saved of active) expect(store.page(saved, 16, 16, "assistant-a").offset).toBe(16);
  });

  it("allows unused paging protection to expire without allowing a foreign audience to refresh it", () => {
    const store = new ResultArtifactStore();
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const saved = store.bound(large());
    store.bindAudience(saved, "assistant-a");
    const first = handle(saved);
    store.page(first, 0, 16, "assistant-a");
    for (let index = 0; index < 15; index += 1) store.bound(large());
    clock += 30 * 60_000;
    expect(() => store.page(first, 16, 16, "assistant-b")).toThrow(/authorize/);
    store.bound(large());
    expect(() => store.page(first, 16, 16, "assistant-a")).toThrow(/expired/);
  });
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
