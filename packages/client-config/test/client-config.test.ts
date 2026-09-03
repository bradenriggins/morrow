import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClientConfigBundle,
  writeClientConfigBundle,
} from "../src/index.js";

function fileContent(bundle: ReturnType<typeof buildClientConfigBundle>, path: string): string {
  const entry = bundle.files.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`missing generated file ${path}`);
  return entry.content;
}

describe("buildClientConfigBundle", () => {
  it("generates deterministic Codex, Claude Code, and Gemini CLI configurations", () => {
    const repositoryRoot = resolve("/tmp/Morrow local repo");
    const upstreamConfigPath = resolve("/tmp/Morrow local repo/.morrow/upstreams.json");
    const serverEntryPath = resolve(repositoryRoot, "packages/mcp-server/dist/index.js");
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: "/usr/local/bin/node",
      serverName: "morrow",
      startupTimeoutSeconds: 75,
      toolTimeoutSeconds: 1200,
      geminiTimeoutMilliseconds: 1_200_000,
    } as const;

    const first = buildClientConfigBundle(options);
    const second = buildClientConfigBundle(options);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: "morrow.client-config-bundle.v1",
      serverName: "morrow",
      transport: "stdio",
      command: "/usr/local/bin/node",
      args: [serverEntryPath],
      cwd: repositoryRoot,
      environmentNames: ["MORROW_UPSTREAMS_FILE"],
    });

    const codex = fileContent(first, "codex.config.toml");
    expect(codex).toContain("[mcp_servers.morrow]");
    expect(codex).toContain('default_tools_approval_mode = "writes"');
    expect(codex).toContain("required = true");
    expect(codex).toContain("startup_timeout_sec = 75");
    expect(codex).toContain("tool_timeout_sec = 1200");
    expect(codex).toContain(JSON.stringify(upstreamConfigPath));

    const claude = JSON.parse(fileContent(first, "claude.mcp.json")) as Record<string, unknown>;
    expect(claude).toEqual({
      mcpServers: {
        morrow: {
          type: "stdio",
          command: "/usr/local/bin/node",
          args: [serverEntryPath],
          cwd: repositoryRoot,
          env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
        },
      },
    });

    const gemini = JSON.parse(fileContent(first, "gemini.settings.json")) as Record<string, unknown>;
    expect(gemini).toEqual({
      mcpServers: {
        morrow: {
          command: "/usr/local/bin/node",
          args: [serverEntryPath],
          cwd: repositoryRoot,
          env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
          timeout: 1_200_000,
          trust: false,
        },
      },
    });

    const manifest = JSON.parse(fileContent(first, "manifest.json")) as {
      files: { path: string; sha256: string }[];
    };
    expect(manifest.files).toHaveLength(7);
    expect(manifest.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect(manifest.files.some((entry) => entry.path === "manifest.json")).toBe(false);
    expect(JSON.stringify(first)).not.toContain("CANVAS_TOKEN");
    expect(JSON.stringify(first)).not.toContain("MORROW_LEGACY_BRIDGE_TOKEN=");
  });

  it("rejects an external server entry and invalid server name", () => {
    expect(() => buildClientConfigBundle({
      repositoryRoot: "/tmp/morrow",
      upstreamConfigPath: "/tmp/morrow.upstreams.json",
      serverEntryPath: "/tmp/other/server.js",
    })).toThrow(/inside repositoryRoot/);
    expect(() => buildClientConfigBundle({
      repositoryRoot: "/tmp/morrow",
      upstreamConfigPath: "/tmp/morrow.upstreams.json",
      serverName: "Morrow with spaces",
    })).toThrow(/serverName/);
  });
});

describe("writeClientConfigBundle", () => {
  it("writes local-only files atomically and refuses an accidental overwrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-config-"));
    const repositoryRoot = join(directory, "repo");
    const outputDirectory = join(repositoryRoot, ".morrow", "clients");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");

      const bundle = writeClientConfigBundle({
        repositoryRoot,
        upstreamConfigPath,
        outputDirectory,
        serverEntryPath,
        nodeCommand: process.execPath,
      });
      expect(bundle.files).toHaveLength(8);
      const manifest = await readFile(join(outputDirectory, "manifest.json"), "utf8");
      expect(JSON.parse(manifest)).toMatchObject({
        schema: "morrow.client-config-manifest.v1",
        environmentNames: ["MORROW_UPSTREAMS_FILE"],
      });
      const names = bundle.files.map((entry) => entry.path);
      for (const name of names) {
        expect(await readFile(join(outputDirectory, name), "utf8"))
          .toBe(fileContent(bundle, name));
      }
      if (process.platform !== "win32") {
        expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(outputDirectory, "manifest.json"))).mode & 0o777).toBe(0o600);
        expect((await stat(join(outputDirectory, "install.posix.sh"))).mode & 0o777).toBe(0o700);
      }
      expect(() => writeClientConfigBundle({
        repositoryRoot,
        upstreamConfigPath,
        outputDirectory,
        serverEntryPath,
      })).toThrow(/Refusing to overwrite/);
      expect(() => writeClientConfigBundle({
        repositoryRoot,
        upstreamConfigPath,
        outputDirectory,
        serverEntryPath,
        force: true,
      })).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
