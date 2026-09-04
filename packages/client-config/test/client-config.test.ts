import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildClientConfigBundle,
  buildClientParityReport,
  buildLocalCanvasConfig,
  installMorrowClient,
  writeClientConfigBundle,
} from "../src/index.js";

function fileContent(bundle: ReturnType<typeof buildClientConfigBundle>, path: string): string {
  const entry = bundle.files.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`missing generated file ${path}`);
  return entry.content;
}

describe("buildClientConfigBundle", () => {
  it("builds a two-install local Canvas configuration without credentials", () => {
    const root = resolve("/tmp/morrow-local");
    const config = buildLocalCanvasConfig(root, "/usr/local/bin/node") as { upstreams: Record<string, unknown>[] };
    expect(config.upstreams).toMatchObject([{
      id: "canvas-session",
      command: "/usr/local/bin/node",
      cwd: root,
      sourceDisposition: "direct_owned",
    }]);
    expect(JSON.stringify(config)).not.toMatch(/(?:canvas_token|cookie|credential)/i);
  });

  it("generates deterministic ChatGPT/Codex, Claude, and Gemini configurations", () => {
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
    expect(JSON.parse(fileContent(first, "claude-desktop.config.json"))).toEqual(claude);

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
    expect(manifest.files).toHaveLength(8);
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

describe("project installation and hermetic parity", () => {
  it("installs project-scoped configurations without credentials and reports config-only parity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-install-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      const options = { repositoryRoot, upstreamConfigPath, serverEntryPath, nodeCommand: process.execPath };

      const codex = installMorrowClient({ ...options, client: "codex" });
      const claude = installMorrowClient({ ...options, client: "claude-code" });
      const gemini = installMorrowClient({ ...options, client: "gemini-cli" });
      expect([codex, claude, gemini]).toEqual(expect.arrayContaining([
        expect.objectContaining({ scope: "project", changed: true }),
      ]));
      expect(await readFile(join(repositoryRoot, ".codex", "config.toml"), "utf8"))
        .toContain("[mcp_servers.morrow]");
      expect(JSON.parse(await readFile(join(repositoryRoot, ".mcp.json"), "utf8")))
        .toMatchObject({ mcpServers: { morrow: { env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath } } } });
      expect(JSON.parse(await readFile(join(repositoryRoot, ".gemini", "settings.json"), "utf8")))
        .toMatchObject({ mcpServers: { morrow: { trust: false } } });

      const report = buildClientParityReport(options);
      expect(report).toMatchObject({
        schema: "morrow.client-parity-report.v1",
        proofLevel: "hermetic_config_only",
        realClientExecution: "not_run",
      });
      expect(report.clients).toHaveLength(4);
      expect(report.clients.every((client) => client.equivalent)).toBe(true);
      expect(() => installMorrowClient({ ...options, client: "claude-desktop" }))
        .toThrow(/only --scope user/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes the project-scoped unified CLI and JSON diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-cli-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await mkdir(join(repositoryRoot, "packages", "canvas-connector-mcp", "dist"), { recursive: true });
      await mkdir(join(repositoryRoot, "artifacts", "canvas-api"), { recursive: true });
      await mkdir(join(repositoryRoot, "connector", "extension"), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(join(repositoryRoot, "packages", "canvas-connector-mcp", "dist", "index.js"), "console.error('fixture');\n", "utf8");
      await writeFile(join(repositoryRoot, "artifacts", "canvas-api", "canvas-api-catalog.json"), "{}\n", "utf8");
      await writeFile(join(repositoryRoot, "connector", "extension", "manifest.json"), "{}\n", "utf8");
      const setup = spawnSync(process.execPath, [
        cliPath, "setup", "--json", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(setup.status).toBe(0);
      expect(JSON.parse(setup.stdout)).toMatchObject({
        schema: "morrow.setup.v1",
        path: upstreamConfigPath,
        credentialsCopied: false,
      });
      const install = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "gemini", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(install.status).toBe(0);
      expect(install.stdout).toContain("scope=project");

      const doctor = spawnSync(process.execPath, [
        cliPath, "doctor", "--json", "--repository", repositoryRoot, "--upstreams", upstreamConfigPath,
      ], { encoding: "utf8" });
      expect(doctor.status).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        schema: "morrow.doctor.v1",
        projectScopeDefault: true,
        upstreamConfigExists: true,
        runtime: {
          attempted: true,
          ready: false,
          reason: "runtime_probe_failed",
        },
      });

      const profile = spawnSync(process.execPath, [
        cliPath, "profile", "show", "--json", "--repository", repositoryRoot, "--upstreams", upstreamConfigPath,
      ], { encoding: "utf8" });
      expect(profile.status).toBe(0);
      expect(JSON.parse(profile.stdout)).toMatchObject({ schema: "morrow.profile-status.v1" });

      const invalidResume = spawnSync(process.execPath, [
        cliPath, "batch", "resume", "bat:example", "--json", "--repository", repositoryRoot,
        "--upstreams", upstreamConfigPath,
      ], { encoding: "utf8" });
      expect(invalidResume.status).toBe(1);
      expect(invalidResume.stderr).toContain("batch resume requires --course-set-digest");

      const inspector = spawnSync(process.execPath, [
        cliPath, "mcp", "print-config", "inspector", "--json", "--repository", repositoryRoot,
        "--upstreams", upstreamConfigPath, "--server-entry", serverEntryPath,
      ], { encoding: "utf8" });
      expect(inspector.status).toBe(0);
      expect(JSON.parse(inspector.stdout)).toMatchObject({
        schema: "morrow.inspector-config.v1",
        transport: "stdio",
        env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("makes doctor report live Morrow runtime readiness", () => {
    const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.sandbox.example.json");
    const doctor = spawnSync(process.execPath, [
      cliPath,
      "doctor",
      "--json",
      "--repository",
      repositoryRoot,
      "--upstreams",
      upstreamConfigPath,
      "--server-entry",
      serverEntryPath,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MORROW_SANDBOX_ESTATE_PATH: ":memory:",
        MORROW_SANDBOX_STATE_PATH: ":memory:",
      },
    });
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      schema: "morrow.doctor.v1",
      runtime: {
        attempted: true,
        ready: true,
        profile: "sandbox",
        publicToolCount: 3,
      },
    });
  }, 20_000);
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
      expect(bundle.files).toHaveLength(9);
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
