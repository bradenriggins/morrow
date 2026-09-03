import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";

const revision = "a".repeat(40);

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "meridian",
    label: "Meridian",
    kind: "mcp-stdio",
    command: "python3",
    args: ["server.py"],
    enabled: true,
    ...overrides,
  };
}

describe("public-canvas configuration", () => {
  it("requires a publication policy path", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "public-canvas",
      upstreams: [source({
        revision,
        attestation: {
          kind: "local-git",
          root: "/tmp/meridian",
          expectedRevision: revision,
          requireTrackedClean: true,
        },
      })],
    })).toThrow(/requires publicationPolicy.path/);
  });

  it("requires a source attestation even when the ordinary policy flag is false", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "public-canvas",
      sourcePolicy: { requireAttestation: false },
      publicationPolicy: { path: "/tmp/public-canvas.json" },
      upstreams: [source()],
    })).toThrow(/requires a configured source attestation/);
  });

  it("resolves local paths and forces source attestation for the public profile", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "public-canvas",
      sourcePolicy: { requireAttestation: false },
      publicationPolicy: {
        path: "${POLICY_PATH}",
        requiredForPublicProfile: true,
      },
      upstreams: [source({
        revision,
        attestation: {
          kind: "local-git",
          root: "${SOURCE_ROOT}",
          expectedRevision: revision,
          requireTrackedClean: true,
        },
      })],
      operationJournal: { path: ":memory:" },
    }, {
      POLICY_PATH: "/tmp/morrow/public-canvas.json",
      SOURCE_ROOT: "/tmp/meridian",
    });

    expect(parsed.profile).toBe("public-canvas");
    expect(parsed.sourcePolicy.requireAttestation).toBe(true);
    expect(parsed.publicationPolicy.path).toBe("/tmp/morrow/public-canvas.json");
    expect(parsed.upstreams[0]?.attestation?.root).toBe("/tmp/meridian");
    expect(parsed.operationJournal.path).toBe(":memory:");
  });
});
