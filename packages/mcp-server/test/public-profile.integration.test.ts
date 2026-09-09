import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicationRuleForTool } from "@morrow/gateway-core";
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
  const root = await mkdtemp(join(tmpdir(), "morrow-public-profile-source-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Morrow Test");
  git(root, "config", "user.email", "morrow-test@example.invalid");
  await writeFile(join(root, "source.txt"), "fixture\n", "utf8");
  git(root, "add", "source.txt");
  git(root, "commit", "--quiet", "-m", "fixture");
  return {
    root,
    revision: git(root, "rev-parse", "HEAD"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function privateConfig() {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    upstreams: [{
      id: "meridian",
      label: "ExamplePlatform fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "meridian" },
      priority: 100,
      required: true,
      enabled: true,
    }],
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

function publicConfig(input: {
  root: string;
  revision: string;
  publicationPath: string;
}) {
  return parseGatewayConfig({
    schema: "morrow.upstreams.v1",
    profile: "public-canvas",
    sourcePolicy: { requireAttestation: true },
    publicationPolicy: {
      path: input.publicationPath,
      requiredForPublicProfile: true,
    },
    upstreams: [{
      id: "meridian",
      label: "ExamplePlatform fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "meridian" },
      repository: "example/public-canvas-adapter",
      sourceDisposition: "clean_reimplementation",
      revision: input.revision,
      attestation: {
        kind: "local-git",
        root: input.root,
        expectedRevision: input.revision,
        requireTrackedClean: true,
        expectedToolCount: 6,
      },
      priority: 100,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 1_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
    }],
    operationJournal: { path: ":memory:" },
    maxCatalogTools: 20,
  });
}

async function publicationFixture(): Promise<{
  directory: string;
  sourceRoot: string;
  revision: string;
  publicationPath: string;
  manifest: Record<string, unknown>;
  dispose: () => Promise<void>;
}> {
  const source = await committedRepository();
  const directory = await mkdtemp(join(tmpdir(), "morrow-public-profile-policy-"));
  const privateRuntime = await GatewayRuntime.connect(privateConfig(), { journalPath: ":memory:" });
  try {
    const sourceHealth = privateRuntime.health().sources[0];
    if (!sourceHealth?.catalogDigest) throw new Error("fixture source has no catalog digest");
    const selected = privateRuntime.catalog.tools.find((tool) => tool.publicName === "canvas_page_get");
    if (!selected) throw new Error("fixture public tool is missing");
    const manifest = {
      schema: "morrow.publication-policy.v1",
      profile: "public-canvas",
      release: "1.0.0-rc.0",
      sources: [{
        sourceId: "meridian",
        catalogDigest: sourceHealth.catalogDigest,
        toolCount: sourceHealth.toolCount,
      }],
      tools: [publicationRuleForTool(selected, "canvas_page_get")],
    };
    const publicationPath = join(directory, "public-canvas.json");
    await writeFile(publicationPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      directory,
      sourceRoot: source.root,
      revision: source.revision,
      publicationPath,
      manifest,
      dispose: async () => {
        await source.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } finally {
    await privateRuntime.close();
  }
}

describe("public-canvas runtime profile", () => {
  it("publishes only the exact reviewed source contract and reports its receipt", async () => {
    const fixture = await publicationFixture();
    const runtime = await GatewayRuntime.connect(publicConfig({
      root: fixture.sourceRoot,
      revision: fixture.revision,
      publicationPath: fixture.publicationPath,
    }), { journalPath: ":memory:" });
    try {
      expect(runtime.catalog.tools.map((tool) => tool.publicName)).toEqual(["canvas_page_get"]);
      expect(runtime.catalog.collisions).toEqual([]);
      expect(runtime.catalog.excluded).toEqual(expect.arrayContaining([
        {
          upstreamId: "meridian",
          upstreamName: "meridian_only",
          reason: "publication_policy",
        },
        {
          upstreamId: "meridian",
          upstreamName: "mindtap_hidden",
          reason: "held_provider",
        },
        {
          upstreamId: "meridian",
          upstreamName: "connect_hidden",
          reason: "held_provider",
        },
        {
          upstreamId: "meridian",
          upstreamName: "morrow_browser_edit_policy_set",
          reason: "excluded_name",
        },
        {
          upstreamId: "meridian",
          upstreamName: "morrow_private_chat_exchange",
          reason: "excluded_name",
        },
      ]));

      const health = runtime.health();
      expect(health).toMatchObject({
        ready: true,
        profile: "public-canvas",
        publicToolCount: 1,
        collisionCount: 0,
        excludedToolCount: 5,
        publicationPolicy: {
          applied: true,
          profile: "public-canvas",
          sourceCount: 1,
          allowedToolCount: 1,
          omittedToolCount: 1,
        },
        sources: [{
          id: "meridian",
          connected: true,
          toolCount: 6,
          expectedToolCount: 6,
          catalogAttested: true,
          sourceAttestation: {
            verified: true,
            expectedRevision: fixture.revision,
            actualRevision: fixture.revision,
          },
        }],
      });
      expect(health.publicationPolicy?.manifestDigest).toMatch(/^[0-9a-f]{64}$/);

      const selected = await runtime.call("canvas_page_get", { course_id: "101" });
      expect(selected.isError).not.toBe(true);
      expect(selected.structuredContent).toMatchObject({
        schema: "morrow.result.v1",
        verification: { status: "not_applicable" },
        data: { source: "meridian", course_id: "101" },
      });

      const omitted = await runtime.call("meridian_only", {});
      expect(omitted).toMatchObject({
        isError: true,
        structuredContent: {
          schema: "morrow.result.v1",
          verification: { status: "not_applicable" },
          data: { code: "tool_not_found" },
        },
      });
    } finally {
      await runtime.close();
      await fixture.dispose();
    }
  }, 30_000);

  it("refuses source catalog drift and selected-tool contract drift", async () => {
    const fixture = await publicationFixture();
    try {
      const sourceDrift = structuredClone(fixture.manifest) as {
        sources: { catalogDigest: string }[];
      };
      sourceDrift.sources[0]!.catalogDigest = "f".repeat(64);
      await writeFile(fixture.publicationPath, `${JSON.stringify(sourceDrift, null, 2)}\n`, "utf8");
      await expect(GatewayRuntime.connect(publicConfig({
        root: fixture.sourceRoot,
        revision: fixture.revision,
        publicationPath: fixture.publicationPath,
      }), { journalPath: ":memory:" })).rejects.toThrow(/source catalog drift/);

      const contractDrift = structuredClone(fixture.manifest) as {
        tools: { inputSchemaSha256: string }[];
      };
      contractDrift.tools[0]!.inputSchemaSha256 = "e".repeat(64);
      await writeFile(fixture.publicationPath, `${JSON.stringify(contractDrift, null, 2)}\n`, "utf8");
      await expect(GatewayRuntime.connect(publicConfig({
        root: fixture.sourceRoot,
        revision: fixture.revision,
        publicationPath: fixture.publicationPath,
      }), { journalPath: ":memory:" })).rejects.toThrow(/contract drift/);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
