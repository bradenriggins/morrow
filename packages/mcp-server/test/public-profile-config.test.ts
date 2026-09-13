import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../src/config.js";

const revision = "a".repeat(40);

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "meridian",
    label: "ExamplePlatform",
    kind: "mcp-stdio",
    command: "python3",
    args: ["server.py"],
    cwd: "/tmp/meridian",
    enabled: true,
    sourceDisposition: "clean_reimplementation",
    ...overrides,
  };
}

describe("public-canvas configuration", () => {
  it("loads the shipped environment-templated public configuration", () => {
    const path = fileURLToPath(new URL("../../../morrow.upstreams.public-canvas.example.json", import.meta.url));
    const parsed = parseGatewayConfig(JSON.parse(readFileSync(path, "utf8")), {
      MORROW_PUBLICATION_POLICY_PATH: "/tmp/publication.json",
      MORROW_NODE_COMMAND: process.execPath,
      MORROW_REPOSITORY_ROOT: "/tmp/morrow-release",
      MORROW_RELEASE_REVISION: revision,
      MORROW_CANVAS_ENTRYPOINT_SHA256: "c".repeat(64),
    });
    expect(parsed.upstreams[0]).toMatchObject({
      revision,
      cwd: "/tmp/morrow-release",
      attestation: {
        root: "/tmp/morrow-release",
        expectedRevision: revision,
        launch: {
          expectedEntrypointSha256: "c".repeat(64),
        },
      },
    });
  });

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
          launch: {
            entrypoint: "server.py",
            runtime: { kind: "sha256", expectedExecutableSha256: "c".repeat(64) },
          },
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
          launch: {
            entrypoint: "server.py",
            runtime: { kind: "sha256", expectedExecutableSha256: "c".repeat(64) },
          },
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

  it("PRIV-08 refuses private and rights-held sources before startup", () => {
    for (const sourceDisposition of ["private_runtime_dependency", "rights_hold", "retired"]) {
      expect(() => parseGatewayConfig({
        schema: "morrow.upstreams.v1",
        profile: "public-canvas",
        publicationPolicy: { path: "/tmp/public-canvas.json" },
        upstreams: [source({
          sourceDisposition,
          cwd: "/tmp/adapter",
          revision,
          attestation: {
            kind: "local-git",
            root: "/tmp/adapter",
            expectedRevision: revision,
            requireTrackedClean: true,
            launch: {
              entrypoint: "server.py",
              runtime: { kind: "sha256", expectedExecutableSha256: "c".repeat(64) },
            },
          },
        })],
      })).toThrow(/public-canvas profile refuses/);
    }
  });
});

describe("sandbox configuration", () => {
  it("accepts only the network-disabled synthetic upstream", () => {
    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "sandbox",
      upstreams: [{
        id: "sandbox",
        label: "Sandbox",
        kind: "mcp-stdio",
        command: "node",
        args: ["sandbox.js"],
        env: { MORROW_SANDBOX: "1", MORROW_ALLOW_EXTERNAL_NETWORK: "0" },
      }],
    })).not.toThrow();

    expect(() => parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "sandbox",
      upstreams: [{
        id: "sandbox",
        label: "Sandbox",
        kind: "mcp-stdio",
        command: "node",
        args: ["sandbox.js"],
        env: { MORROW_SANDBOX: "1", MORROW_ALLOW_EXTERNAL_NETWORK: "1" },
      }],
    })).toThrow(/disabled external network/);
  });
});
