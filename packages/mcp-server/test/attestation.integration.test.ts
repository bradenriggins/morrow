import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";
import { GatewayRuntime } from "../src/runtime.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function committedRepository(): Promise<{
  root: string;
  revision: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "morrow-runtime-attestation-"));
  git(root, "init");
  git(root, "config", "user.name", "Morrow Test");
  git(root, "config", "user.email", "morrow-test@example.invalid");
  await writeFile(join(root, "source.txt"), "fixture\n", "utf8");
  git(root, "add", "source.txt");
  git(root, "commit", "-m", "fixture");
  return {
    root,
    revision: git(root, "rev-parse", "HEAD"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function attestedConfig(
  root: string,
  expectedRevision: string,
  expectedToolCount = 4,
) {
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
      repository: "bradenriggins/chcp-team-agent-kit",
      revision: expectedRevision,
      attestation: {
        kind: "local-git",
        root,
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
    const fixture = await committedRepository();
    const runtime = await GatewayRuntime.connect(
      attestedConfig(fixture.root, fixture.revision),
      { journalPath: ":memory:" },
    );
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
          expectedRevision: fixture.revision,
          actualRevision: fixture.revision,
          trackedClean: true,
        },
      });
      expect(source?.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(source?.sourceAttestation?.rootDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(source)).not.toContain(fixture.root);
    } finally {
      await runtime.close();
      await fixture.dispose();
    }
  }, 20_000);

  it("refuses a catalog count mismatch after connecting to the exact source", async () => {
    const fixture = await committedRepository();
    try {
      await expect(GatewayRuntime.connect(
        attestedConfig(fixture.root, fixture.revision, 5),
        { journalPath: ":memory:" },
      )).rejects.toThrow(/Required upstream meridian failed to connect/);
    } finally {
      await fixture.dispose();
    }
  }, 20_000);

  it("refuses a different Git revision before starting the donor process", async () => {
    const fixture = await committedRepository();
    try {
      const differentRevision = fixture.revision.startsWith("0")
        ? `1${fixture.revision.slice(1)}`
        : `0${fixture.revision.slice(1)}`;
      await expect(GatewayRuntime.connect(
        attestedConfig(fixture.root, differentRevision),
        { journalPath: ":memory:" },
      )).rejects.toThrow(/not the configured revision/);
    } finally {
      await fixture.dispose();
    }
  });
});
