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

  it("loads Canvas, Moodle, and Blackboard defaults when no upstream file exists", async () => {
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), "morrow-default-config-"));
    try {
      const config = await loadGatewayConfig({ MORROW_UPSTREAMS_FILE: join(directory, "missing.json") }, repositoryRoot);
      expect(config.profile).toBe("private-full");
      expect(config.upstreams).toMatchObject([{
        id: "canvas-session",
        kind: "mcp-stdio",
        sourceDisposition: "direct_owned",
        required: true,
      }, {
        id: "lms-api",
        kind: "mcp-stdio",
        sourceDisposition: "direct_owned",
        required: true,
      }]);
      expect(config.maxCatalogTools).toBe(2000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
