import { describe, expect, it } from "vitest";
import { MORROW_SERVER_INSTRUCTIONS } from "../src/server-instructions.js";

describe("MORROW_SERVER_INSTRUCTIONS", () => {
  it("states the product boundary and the non-replay rule early", () => {
    expect(MORROW_SERVER_INSTRUCTIONS.length).toBeGreaterThan(500);
    expect(MORROW_SERVER_INSTRUCTIONS.length).toBeLessThan(2_000);
    const opening = MORROW_SERVER_INSTRUCTIONS.slice(0, 512);
    expect(opening).toContain("local LMS operations layer");
    expect(opening).toContain("operation evidence");
    expect(opening).toContain("separate human review");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("sourceSettlement");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Never repeat a write");
    expect(MORROW_SERVER_INSTRUCTIONS).toContain("Do not ask for Canvas credentials");
  });
});
