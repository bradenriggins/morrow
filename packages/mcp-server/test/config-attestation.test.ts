import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";

const revision = "a".repeat(40);

function upstream(overrides: Record<string, unknown> = {}) {
  return {
    id: "meridian",
    label: "ExamplePlatform",
    kind: "mcp-stdio",
    command: "python3",
    args: ["server.py"],
    enabled: true,
    ...overrides,
  };
}

describe("source attestation and batch scheduler configuration", () => {
  it("requires evidence for every enabled source when the policy is active", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      sourcePolicy: { requireAttestation: true },
      upstreams: [upstream()],
    })).toThrow(/requires a configured source attestation/);
  });

  it("expands the attested root and applies conservative scheduler defaults", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      sourcePolicy: { requireAttestation: true },
      upstreams: [upstream({
        revision,
        attestation: {
          kind: "local-git",
          root: "${DONOR_ROOT}",
          expectedRevision: revision.toUpperCase(),
          requireTrackedClean: true,
          expectedToolCount: 205,
        },
      })],
    }, { DONOR_ROOT: "/tmp/donor" });

    expect(parsed.batchScheduler).toEqual({ maxConcurrentWindows: 1 });
    expect(parsed.upstreams[0]?.attestation).toMatchObject({
      root: "/tmp/donor",
      expectedRevision: revision,
      expectedToolCount: 205,
    });
  });

  it("refuses a declaration that names a different revision than its attestation", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      upstreams: [upstream({
        revision,
        attestation: {
          kind: "local-git",
          root: "/tmp/donor",
          expectedRevision: "b".repeat(40),
          requireTrackedClean: true,
        },
      })],
    })).toThrow(/declares revision/);
  });

  it("accepts an explicit bounded active-window count", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      upstreams: [upstream()],
      batchScheduler: { maxConcurrentWindows: 4 },
    });
    expect(parsed.batchScheduler.maxConcurrentWindows).toBe(4);
  });
});
