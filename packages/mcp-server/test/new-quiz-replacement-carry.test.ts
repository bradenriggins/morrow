import { describe, expect, it } from "vitest";
import { uncarriedPaths } from "../src/new-quiz-item-lifecycle.js";

describe("New Quiz question replacement", () => {
  it("does not refuse a question for a field that holds nothing", () => {
    // Canvas returns an empty tag list on every saved question. Nothing in it can
    // be lost, so it must not stop a question's type from being changed.
    const saved = { entry: { tag_associations: [], item_body: "<p>Q</p>" } };
    expect(uncarriedPaths(saved, [], true)).not.toContain("entry.tag_associations");
  });

  it("still refuses a question whose uncarried field holds something", () => {
    const saved = { entry: { tag_associations: [{ id: "7", name: "unit 1" }], item_body: "<p>Q</p>" } };
    expect(uncarriedPaths(saved, [], true)).toContain("entry.tag_associations");
  });
});
