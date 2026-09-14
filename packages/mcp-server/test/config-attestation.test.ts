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
    cwd: "/tmp/donor",
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

  it("requires an explicit entrypoint contract for every local Git attestation", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      upstreams: [upstream({
        revision,
        attestation: {
          kind: "local-git",
          root: "/tmp/donor",
          expectedRevision: revision,
          requireTrackedClean: true,
        },
      })],
    })).toThrow();
  });

  it("requires the launch and attestation to use the same local worktree root", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      upstreams: [upstream({
        cwd: "/tmp/decoy",
        revision,
        attestation: {
          kind: "local-git",
          root: "/tmp/donor",
          expectedRevision: revision,
          requireTrackedClean: true,
          launch: {
            entrypoint: "server.py",
            runtime: { kind: "sha256", expectedExecutableSha256: "c".repeat(64) },
          },
        },
      })],
    })).toThrow(/same local worktree root/);
  });

  it("expands the attested root and applies conservative scheduler defaults", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      sourcePolicy: { requireAttestation: true },
      upstreams: [upstream({
        revision: "${DONOR_REVISION}",
        attestation: {
          kind: "local-git",
          root: "${DONOR_ROOT}",
          expectedRevision: "${DONOR_REVISION}",
          requireTrackedClean: true,
          expectedToolCount: 205,
          expectedCatalogDigest: "${DONOR_CATALOG_SHA256}",
          launch: {
            entrypoint: "server.py",
            expectedEntrypointSha256: "${DONOR_ENTRYPOINT_SHA256}",
            runtime: {
              kind: "sha256",
              expectedExecutableSha256: "${DONOR_RUNTIME_SHA256}",
            },
          },
        },
      })],
    }, {
      DONOR_ROOT: "/tmp/donor",
      DONOR_REVISION: revision.toUpperCase(),
      DONOR_CATALOG_SHA256: "b".repeat(64).toUpperCase(),
      DONOR_ENTRYPOINT_SHA256: "c".repeat(64).toUpperCase(),
      DONOR_RUNTIME_SHA256: "d".repeat(64).toUpperCase(),
    });

    expect(parsed.batchScheduler).toEqual({ maxConcurrentReadWindows: 2 });
    expect(parsed.upstreams[0]?.attestation).toMatchObject({
      root: "/tmp/donor",
      expectedRevision: revision,
      expectedToolCount: 205,
      expectedCatalogDigest: "b".repeat(64),
      launch: {
        expectedEntrypointSha256: "c".repeat(64),
        runtime: { expectedExecutableSha256: "d".repeat(64) },
      },
    });
  });

  it("refuses a revision template whose expanded value is not a full object id", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      upstreams: [upstream({
        revision: "${DONOR_REVISION}",
        attestation: {
          kind: "local-git",
          root: "/tmp/donor",
          expectedRevision: "${DONOR_REVISION}",
          requireTrackedClean: true,
          launch: {
            entrypoint: "server.py",
            runtime: { kind: "sha256", expectedExecutableSha256: "c".repeat(64) },
          },
        },
      })],
    }, { DONOR_REVISION: "main" })).toThrow(/must expand to a full Git object id/);
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
          launch: {
            entrypoint: "server.py",
            runtime: { kind: "sha256", expectedExecutableSha256: "c".repeat(64) },
          },
        },
      })],
    })).toThrow(/declares revision/);
  });

  it("accepts an explicit bounded read-window count", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      upstreams: [upstream()],
      batchScheduler: { maxConcurrentReadWindows: 4 },
    });
    expect(parsed.batchScheduler.maxConcurrentReadWindows).toBe(4);
  });
});
