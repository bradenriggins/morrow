import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const repositoryRevision = execFileSync(
  "git",
  ["-C", repositoryRoot, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();

function attestedConfig(expectedToolCount = 4, expectedRevision = repositoryRevision) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    sourcePolicy: { requireAttestation: true },
    upstreams: [{
      id: "meridian",
      label: "Attested fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "meridian" },
      repository: "example-owner/example-attestation-repo",
      revision: expectedRevision,
      attestation: {
        kind: "local-git",
        root: repositoryRoot,
        expectedRevision,
        requireTrackedClean: true,
        expectedToolCount,
      },
      priority: 100,
      required: true,
      enabled: true,
    }],
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

describe("GatewayRuntime source attestations", () => {
  it("reports verified Git and normalized catalog evidence for a connected source", async () => {
    const runtime = await GatewayRuntime.connect(attestedConfig(), { journalPath: ":memory:" });
    try {
      const source = runtime.health().sources[0];
      expect(source).toMatchObject({
        id: "meridian",
        connected: true,
        toolCount: 4,
        expectedToolCount: 4,
        catalogAttested: true,
        sourceAttestation: {
          schema: "morrow.source-attestation.v1",
          verified: true,
          expectedRevision: repositoryRevision,
          actualRevision: repositoryRevision,
          trackedClean: true,
        },
      });
      expect(source?.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(source?.sourceAttestation?.rootDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(source)).not.toContain(repositoryRoot);
    } finally {
      await runtime.close();
    }
  }, 20_000);

  it("refuses a catalog count mismatch after connecting to the exact source", async () => {
    await expect(GatewayRuntime.connect(attestedConfig(5), { journalPath: ":memory:" }))
      .rejects.toThrow(/Required upstream meridian failed to connect/);
  }, 20_000);

  it("refuses a different Git revision before starting the donor process", async () => {
    const differentRevision = repositoryRevision.startsWith("0")
      ? `1${repositoryRevision.slice(1)}`
      : `0${repositoryRevision.slice(1)}`;
    await expect(GatewayRuntime.connect(
      attestedConfig(4, differentRevision),
      { journalPath: ":memory:" },
    )).rejects.toThrow(/not the configured revision/);
  });
});
