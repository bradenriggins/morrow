import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expandEnvironmentTemplate,
  loadGatewayConfig,
  parseGatewayConfig,
} from "../src/config.js";

describe("gateway configuration", () => {
  it("expands required and fallback environment values", () => {
    expect(expandEnvironmentTemplate("${ONE}/${TWO:-fallback}", { ONE: "value" }))
      .toBe("value/fallback");
  });

  it("fails when a required environment value is missing", () => {
    expect(() => expandEnvironmentTemplate("${MISSING}", {}))
      .toThrow("Missing environment variable MISSING");
  });

  it("removes disabled upstreams, keeps publisher holds, and expands the journal path", () => {
    const parsed = parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "private-full",
      upstreams: [
        {
          id: "fixture",
          label: "Fixture",
          kind: "mcp-stdio",
          command: "python3",
          args: ["${SERVER}"],
          enabled: true,
        },
        {
          id: "disabled",
          label: "Disabled",
          kind: "mcp-stdio",
          command: "false",
          enabled: false,
        },
      ],
      operationJournal: { path: "${STATE_ROOT}/morrow.sqlite3" },
    }, { SERVER: "/tmp/server.py", STATE_ROOT: "/tmp/morrow-state" });

    expect(parsed.upstreams).toHaveLength(1);
    expect(parsed.toolSurface).toBe("compact");
    expect(parsed.filters.excludePrefixes).toEqual(["mindtap_", "connect_"]);
    expect(parsed.operationJournal.path).toBe("/tmp/morrow-state/morrow.sqlite3");
  });

  it("accepts the sandbox and read-only runtime profiles", () => {
    expect(parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "sandbox",
      upstreams: [{
        id: "sandbox",
        label: "Sandbox",
        kind: "mcp-stdio",
        command: "node",
        env: { MORROW_SANDBOX: "1", MORROW_ALLOW_EXTERNAL_NETWORK: "0" },
      }],
      operationJournal: { path: ":memory:" },
    }).profile).toBe("sandbox");
    expect(parseGatewayConfig({
      schema: "morrow.upstreams.v1",
      profile: "read-only",
      upstreams: [{ id: "fixture", label: "Fixture", kind: "mcp-stdio", command: "node" }],
      operationJournal: { path: ":memory:" },
    }).profile).toBe("read-only");
  });

  it("starts relative stdio paths from the selected configuration directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-config-root-"));
    const path = join(directory, "morrow.upstreams.json");
    try {
      await writeFile(path, JSON.stringify({
        schema: "morrow.upstreams.v1",
        profile: "private-full",
        upstreams: [{ id: "fixture", label: "Fixture", kind: "mcp-stdio", command: "node", args: ["server.js"] }],
        operationJournal: { path: ":memory:" },
      }), "utf8");
      const config = await loadGatewayConfig({ MORROW_UPSTREAMS_FILE: path }, "/tmp/other-project");
      expect(config.upstreams[0]).toMatchObject({ cwd: directory, args: ["server.js"] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("registers the private Blackboard API source only when a private Blackboard setup file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-source-"));
    const setup = join(directory, "blackboard-learn.json");
    const upstreams = join(directory, "morrow.upstreams.json");
    try {
      await writeFile(setup, "{}\n", { mode: 0o600 });
      await writeFile(upstreams, JSON.stringify({
        schema: "morrow.upstreams.v1", profile: "private-full",
        upstreams: [{ id: "fixture", label: "Fixture", kind: "mcp-stdio", command: "node" }],
        operationJournal: { path: ":memory:" },
      }));
      const config = await loadGatewayConfig({ MORROW_UPSTREAMS_FILE: upstreams, MORROW_BLACKBOARD_CONFIG: setup }, fileURLToPath(new URL("../../..", import.meta.url)));
      expect(config.upstreams.find((source) => source.id === "blackboard-rest")).toMatchObject({
        required: true,
        env: { MORROW_BLACKBOARD_CONFIG: setup },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps Morrow starting from a workspace directory when Blackboard is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-blackboard-workspace-"));
    const workspace = await mkdtemp(join(tmpdir(), "morrow-blackboard-cwd-"));
    const setup = join(directory, "blackboard-learn.json");
    const upstreams = join(directory, "morrow.upstreams.json");
    try {
      await writeFile(setup, "{}\n", { mode: 0o600 });
      await writeFile(upstreams, JSON.stringify({
        schema: "morrow.upstreams.v1", profile: "private-full",
        upstreams: [{ id: "fixture", label: "Fixture", kind: "mcp-stdio", command: "node" }],
        operationJournal: { path: ":memory:" },
      }));
      const config = await loadGatewayConfig(
        { MORROW_UPSTREAMS_FILE: upstreams, MORROW_BLACKBOARD_CONFIG: setup },
        workspace,
      );
      const source = config.upstreams.find((candidate) => candidate.id === "blackboard-rest");
      if (source) {
        expect(source).toMatchObject({
          kind: "mcp-stdio",
          priority: 175,
          required: true,
          sourceDisposition: "direct_owned",
          env: { MORROW_BLACKBOARD_CONFIG: setup },
        });
        expect(existsSync((source as { args: string[] }).args[0])).toBe(true);
        expect(config.runtimeLimitations ?? []).toEqual([]);
      } else {
        expect(config.runtimeLimitations).toEqual([expect.objectContaining({
          code: "blackboard_runtime_unavailable",
          setupFilePath: setup,
        })]);
      }
      expect(config.upstreams.some((candidate) => candidate.id === "fixture")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("loads the Canvas browser connector default when no upstream file exists", async () => {
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), "morrow-default-config-"));
    try {
      const config = await loadGatewayConfig({ MORROW_UPSTREAMS_FILE: join(directory, "missing.json") }, repositoryRoot);
      expect(config.profile).toBe("private-full");
      expect(config.upstreams).toEqual([expect.objectContaining({
        id: "canvas-session",
        kind: "mcp-stdio",
        sourceDisposition: "direct_owned",
        required: true,
      })]);
      expect(config.maxCatalogTools).toBe(2000);
      expect(config.toolSurface).toBe("compact");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
