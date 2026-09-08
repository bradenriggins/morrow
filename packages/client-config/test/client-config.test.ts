import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildClientConfigBundle,
  buildClientParityReport,
  buildLocalCanvasConfig,
  installMorrowClient,
  MorrowClientConfigRefusal,
  morrowClientConfigNotes,
  morrowClientConfigPath,
  writeClientConfigBundle,
  writeLocalCanvasConfig,
} from "../src/index.js";

function fileContent(bundle: ReturnType<typeof buildClientConfigBundle>, path: string): string {
  const entry = bundle.files.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`missing generated file ${path}`);
  return entry.content;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function refusalOf(attempt: () => unknown): MorrowClientConfigRefusal {
  try {
    attempt();
  } catch (error) {
    if (error instanceof MorrowClientConfigRefusal) return error;
    throw error;
  }
  throw new Error("expected a Morrow client configuration refusal");
}

describe("buildClientConfigBundle", () => {
  it("builds one local browser-connector configuration without credentials", () => {
    const root = resolve("/tmp/morrow-local");
    const config = buildLocalCanvasConfig(root, "/usr/local/bin/node") as {
      toolSurface: string;
      upstreams: Record<string, unknown>[];
    };
    expect(config.toolSurface).toBe("compact");
    expect(config.upstreams).toEqual([expect.objectContaining({
      id: "canvas-session",
      command: "/usr/local/bin/node",
      cwd: root,
      sourceDisposition: "direct_owned",
      env: {
        MORROW_CANVAS_CATALOG_PATH: resolve(root, "artifacts/canvas-api/canvas-api-catalog.json"),
        MORROW_CANVAS_CONNECTOR_STATE: resolve(root, ".morrow/canvas-connector.json"),
      },
    })]);
    expect(JSON.stringify(config)).not.toMatch(/(?:canvas_token|cookie|credential)/i);
  });

  it("binds consumer connector state to an explicit durable directory", () => {
    const repositoryRoot = resolve("/tmp/morrow-local");
    const stateDirectory = resolve("/tmp/morrow-consumer-state");
    const config = buildLocalCanvasConfig(repositoryRoot, "/usr/local/bin/node", stateDirectory) as {
      upstreams: { env: Record<string, string> }[];
      operationJournal: { path: string };
      privacy: { learnerVaultPath: string };
    };

    expect(config.upstreams[0]!.env.MORROW_CANVAS_CONNECTOR_STATE)
      .toBe(join(stateDirectory, "canvas-connector.json"));
    expect(config.operationJournal.path).toBe(join(stateDirectory, "morrow.sqlite3"));
    expect(config.privacy.learnerVaultPath).toBe(join(stateDirectory, "learner-vault.json"));
  });

  it("upgrades an unchanged generated local configuration and refuses a custom one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-local-upgrade-"));
    const repositoryRoot = join(directory, "current-app");
    const oldRepositoryRoot = join(directory, "prior-app");
    const stateDirectory = join(directory, "State");
    const upstreamConfigPath = join(stateDirectory, "morrow.upstreams.json");
    const oldNode = join(oldRepositoryRoot, "runtime", "node");
    const currentNode = join(repositoryRoot, "runtime", "node");
    try {
      for (const relative of [
        "packages/mcp-server/dist/index.js",
        "packages/canvas-connector-mcp/dist/index.js",
        "artifacts/canvas-api/canvas-api-catalog.json",
        "connector/extension/manifest.json",
      ]) {
        const target = join(repositoryRoot, relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "fixture\n", "utf8");
      }
      await mkdir(stateDirectory, { recursive: true });
      const canonicalStateDirectory = await realpath(stateDirectory);
      await writeFile(
        upstreamConfigPath,
        `${JSON.stringify(buildLocalCanvasConfig(oldRepositoryRoot, oldNode, canonicalStateDirectory), null, 2)}\n`,
        "utf8",
      );

      expect(writeLocalCanvasConfig({
        repositoryRoot,
        path: upstreamConfigPath,
        nodeCommand: currentNode,
        stateDirectory,
        replaceGenerated: true,
      })).toMatchObject({ changed: true, stateDirectory: canonicalStateDirectory });
      expect(JSON.parse(await readFile(upstreamConfigPath, "utf8")))
        .toEqual(buildLocalCanvasConfig(repositoryRoot, currentNode, canonicalStateDirectory));

      const custom = buildLocalCanvasConfig(oldRepositoryRoot, oldNode, canonicalStateDirectory) as {
        filters: { excludeNames: string[] };
      };
      custom.filters.excludeNames.push("custom_tool");
      const customText = `${JSON.stringify(custom, null, 2)}\n`;
      await writeFile(upstreamConfigPath, customText, "utf8");
      expect(() => writeLocalCanvasConfig({
        repositoryRoot,
        path: upstreamConfigPath,
        nodeCommand: currentNode,
        stateDirectory,
        replaceGenerated: true,
      })).toThrow(/Refusing to replace existing Morrow configuration/);
      expect(await readFile(upstreamConfigPath, "utf8")).toBe(customText);

      await writeFile(
        upstreamConfigPath,
        `${JSON.stringify(buildLocalCanvasConfig(oldRepositoryRoot, oldNode, canonicalStateDirectory), null, 2)}\n`,
        "utf8",
      );
      const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
      const upgraded = spawnSync(process.execPath, [
        cliPath, "setup", "--json", "--replace-generated", "--repository", repositoryRoot,
        "--upstreams", upstreamConfigPath, "--state-directory", stateDirectory, "--node", currentNode,
      ], { encoding: "utf8" });
      expect(upgraded.status).toBe(0);
      expect(JSON.parse(upgraded.stdout)).toMatchObject({ changed: true, path: upstreamConfigPath });
      expect(JSON.parse(await readFile(upstreamConfigPath, "utf8")))
        .toEqual(buildLocalCanvasConfig(repositoryRoot, currentNode, canonicalStateDirectory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("generates deterministic ChatGPT/Codex, Claude, Gemini, Cursor, and VS Code configurations", () => {
    const repositoryRoot = resolve("/tmp/Morrow local repo");
    const workspaceRoot = resolve("/tmp/Morrow course workspace");
    const upstreamConfigPath = resolve("/tmp/Morrow local repo/.morrow/upstreams.json");
    const serverEntryPath = resolve(repositoryRoot, "packages/mcp-server/dist/index.js");
    const options = {
      repositoryRoot,
      workspaceRoot,
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
      cwd: workspaceRoot,
      environmentNames: ["MORROW_UPSTREAMS_FILE"],
    });

    const codex = fileContent(first, "codex.config.toml");
    expect(codex).toContain("[mcp_servers.morrow]");
    expect(codex).toContain('default_tools_approval_mode = "writes"');
    expect(codex).toContain("required = true");
    expect(codex).toContain("startup_timeout_sec = 75");
    expect(codex).toContain("tool_timeout_sec = 1200");
    expect(codex).toContain(`cwd = ${JSON.stringify(workspaceRoot)}`);
    expect(codex).toContain(JSON.stringify(upstreamConfigPath));

    const claude = JSON.parse(fileContent(first, "claude.mcp.json")) as Record<string, unknown>;
    expect(claude).toEqual({
      mcpServers: {
        morrow: {
          type: "stdio",
          command: "/usr/local/bin/node",
          args: [serverEntryPath],
          cwd: workspaceRoot,
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
          cwd: workspaceRoot,
          env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
          timeout: 1_200_000,
          trust: false,
        },
      },
    });

    const cursor = JSON.parse(fileContent(first, "cursor.mcp.json")) as Record<string, unknown>;
    expect(cursor).toEqual({
      mcpServers: {
        morrow: {
          type: "stdio",
          command: "/usr/local/bin/node",
          args: [serverEntryPath],
          env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
        },
      },
    });

    const vscode = JSON.parse(fileContent(first, "vscode.mcp.json")) as Record<string, unknown>;
    expect(vscode).toEqual({
      servers: {
        morrow: {
          type: "stdio",
          command: "/usr/local/bin/node",
          args: [serverEntryPath],
          cwd: workspaceRoot,
          env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
        },
      },
    });

    const manifest = JSON.parse(fileContent(first, "manifest.json")) as {
      cwd: string;
      files: { path: string; sha256: string }[];
    };
    expect(manifest.cwd).toBe(workspaceRoot);
    expect(manifest.files).toHaveLength(10);
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
    expect(() => buildClientConfigBundle({
      repositoryRoot: "/tmp/morrow",
      upstreamConfigPath: "/tmp/morrow.upstreams.json",
      nodeCommand: "node",
    })).toThrow(/nodeCommand must be an absolute path/);
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
      expect(report.clients).toHaveLength(6);
      expect(report.clients.every((client) => client.equivalent)).toBe(true);
      expect(report.clients.find((client) => client.client === "cursor"))
        .toMatchObject({ workingDirectory: "client_default" });
      expect(report.clients.find((client) => client.client === "cursor")).not.toHaveProperty("cwd");
      expect(report.clients.find((client) => client.client === "vscode"))
        .toMatchObject({ workingDirectory: "pinned", cwd: repositoryRoot });
      const desktopProjectScope = refusalOf(() => installMorrowClient({ ...options, client: "claude-desktop" }));
      expect(desktopProjectScope.code).toBe("client_scope_unsupported");
      expect(desktopProjectScope.nextAction).toContain("--scope user");

      const projectRoot = join(directory, "course-workspace");
      await mkdir(projectRoot, { recursive: true });
      const canonicalProjectRoot = await realpath(projectRoot);
      const separateCodex = installMorrowClient({ ...options, client: "codex", projectRoot });
      const separateClaude = installMorrowClient({ ...options, client: "claude-code", projectRoot });
      const separateGemini = installMorrowClient({ ...options, client: "gemini-cli", projectRoot });
      expect(separateCodex.path).toBe(join(canonicalProjectRoot, ".codex", "config.toml"));
      expect(await readFile(separateCodex.path, "utf8")).toContain(`cwd = ${JSON.stringify(canonicalProjectRoot)}`);
      expect(JSON.parse(await readFile(separateClaude.path, "utf8")))
        .toMatchObject({ mcpServers: { morrow: { cwd: canonicalProjectRoot, args: [serverEntryPath], env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath } } } });
      expect(JSON.parse(await readFile(separateGemini.path, "utf8")))
        .toMatchObject({ mcpServers: { morrow: { cwd: canonicalProjectRoot, args: [serverEntryPath], env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath } } } });
      expect(() => installMorrowClient({
        ...options,
        client: "codex",
        projectRoot: join(directory, "missing-course-workspace"),
      })).toThrow(/projectRoot does not exist as a directory/);
      expect(() => installMorrowClient({
        ...options,
        client: "claude-desktop",
        scope: "user",
        projectRoot,
      })).toThrow(/projectRoot is supported only for project-scoped/);
      expect(() => installMorrowClient({
        ...options,
        client: "codex",
        workspaceRoot: join(directory, "missing-materials"),
      })).toThrow(/workspaceRoot does not exist as a directory/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a user-scope Codex target separate from the canonical materials workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-user-install-"));
    const repositoryRoot = join(directory, "runtime", "app");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const home = join(directory, "home");
    const materials = join(directory, "Morrow Materials");
    const originalHome = process.env.HOME;
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await mkdir(home, { recursive: true });
      await mkdir(materials, { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      process.env.HOME = home;
      const canonicalMaterials = await realpath(materials);

      const installed = installMorrowClient({
        repositoryRoot,
        upstreamConfigPath,
        serverEntryPath,
        nodeCommand: process.execPath,
        client: "codex",
        scope: "user",
        workspaceRoot: materials,
      });

      expect(installed).toMatchObject({
        scope: "user",
        path: join(home, ".codex", "config.toml"),
        changed: true,
      });
      expect(await readFile(installed.path, "utf8"))
        .toContain(`cwd = ${JSON.stringify(canonicalMaterials)}`);
      await expect(stat(join(materials, ".codex", "config.toml"))).rejects.toThrow();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses Codex TOML before preserving unrelated settings or refusing conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-codex-toml-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const codexPath = join(repositoryRoot, ".codex", "config.toml");
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: process.execPath,
      client: "codex" as const,
    };
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await mkdir(dirname(codexPath), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");

      const canonicalRepositoryRoot = await realpath(repositoryRoot);
      const generated = fileContent(buildClientConfigBundle({ ...options, workspaceRoot: canonicalRepositoryRoot }), "codex.config.toml")
        .replace("[mcp_servers.morrow]", "[mcp_servers.\"morrow\"]");
      const equivalentQuoted = `model = "gpt-6"\n\n${generated}`;
      await writeFile(codexPath, equivalentQuoted, "utf8");
      expect(installMorrowClient(options)).toMatchObject({ changed: false });
      expect(await readFile(codexPath, "utf8")).toBe(equivalentQuoted);

      const unrelated = "model = \"gpt-6\"\n";
      await writeFile(codexPath, unrelated, "utf8");
      expect(installMorrowClient(options)).toMatchObject({ changed: true });
      expect(await readFile(codexPath, "utf8")).toBe(`${unrelated.trimEnd()}\n\n${fileContent(buildClientConfigBundle({ ...options, workspaceRoot: canonicalRepositoryRoot }), "codex.config.toml")}`);

      const trailingWhitespace = "model = \"gpt-6\"  \n# keep this exact spacing\n\n\n";
      await writeFile(codexPath, trailingWhitespace, "utf8");
      expect(installMorrowClient(options)).toMatchObject({ changed: true });
      expect(await readFile(codexPath, "utf8"))
        .toBe(`${trailingWhitespace}${fileContent(buildClientConfigBundle({ ...options, workspaceRoot: canonicalRepositoryRoot }), "codex.config.toml")}`);

      const conflictingInline = "mcp_servers = { morrow = { command = \"other\" } }\n";
      await writeFile(codexPath, conflictingInline, "utf8");
      expect(() => installMorrowClient(options)).toThrow(/existing Morrow server/);
      expect(await readFile(codexPath, "utf8")).toBe(conflictingInline);

      const unrelatedInline = "mcp_servers = { other = { command = \"other\" } }\n";
      await writeFile(codexPath, unrelatedInline, "utf8");
      expect(() => installMorrowClient(options)).toThrow(/without rewriting existing TOML/);
      expect(await readFile(codexPath, "utf8")).toBe(unrelatedInline);

      const malformed = "[mcp_servers\n";
      await writeFile(codexPath, malformed, "utf8");
      expect(() => installMorrowClient(options)).toThrow(/not valid TOML/);
      expect(await readFile(codexPath, "utf8")).toBe(malformed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("installs Cursor and VS Code entries, preserves unrelated settings, and refuses conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-editor-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: process.execPath,
    };
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      const canonicalRepositoryRoot = await realpath(repositoryRoot);
      const cursorPath = join(canonicalRepositoryRoot, ".cursor", "mcp.json");
      const vscodePath = join(canonicalRepositoryRoot, ".vscode", "mcp.json");

      const cursor = installMorrowClient({ ...options, client: "cursor" });
      const vscode = installMorrowClient({ ...options, client: "vscode" });
      expect(cursor).toMatchObject({ scope: "project", path: cursorPath, changed: true });
      expect(vscode).toMatchObject({ scope: "project", path: vscodePath, changed: true });

      // Cursor documents type, command, args, env and envFile for stdio servers. It documents no
      // cwd field, so Morrow must not write one.
      expect(JSON.parse(await readFile(cursorPath, "utf8"))).toEqual({
        mcpServers: {
          morrow: {
            type: "stdio",
            command: process.execPath,
            args: [serverEntryPath],
            env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
          },
        },
      });
      expect(JSON.parse(await readFile(vscodePath, "utf8"))).toEqual({
        servers: {
          morrow: {
            type: "stdio",
            command: process.execPath,
            args: [serverEntryPath],
            cwd: canonicalRepositoryRoot,
            env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
          },
        },
      });

      expect(installMorrowClient({ ...options, client: "cursor" })).toMatchObject({ changed: false });
      expect(installMorrowClient({ ...options, client: "vscode" })).toMatchObject({ changed: false });

      if (process.platform !== "win32") {
        expect((await stat(cursorPath)).mode & 0o777).toBe(0o600);
        expect((await stat(vscodePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("merges into existing Cursor and VS Code files and refuses malformed or conflicting entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-editor-merge-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const cursorPath = join(repositoryRoot, ".cursor", "mcp.json");
    const vscodePath = join(repositoryRoot, ".vscode", "mcp.json");
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: process.execPath,
    };
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await mkdir(dirname(cursorPath), { recursive: true });
      await mkdir(dirname(vscodePath), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");

      await writeFile(cursorPath, `${JSON.stringify({
        mcpServers: { other: { command: "other", args: ["--serve"] } },
      }, null, 2)}\n`, "utf8");
      await writeFile(vscodePath, `${JSON.stringify({
        inputs: [{ type: "promptString", id: "api-key", description: "API key" }],
        servers: { other: { type: "stdio", command: "other" } },
      }, null, 2)}\n`, "utf8");

      expect(installMorrowClient({ ...options, client: "cursor" })).toMatchObject({ changed: true });
      expect(installMorrowClient({ ...options, client: "vscode" })).toMatchObject({ changed: true });

      const mergedCursor = JSON.parse(await readFile(cursorPath, "utf8")) as Record<string, Record<string, unknown>>;
      expect(mergedCursor.mcpServers!.other).toEqual({ command: "other", args: ["--serve"] });
      expect(mergedCursor.mcpServers!.morrow).toMatchObject({ type: "stdio", command: process.execPath });

      const mergedVscode = JSON.parse(await readFile(vscodePath, "utf8")) as Record<string, unknown>;
      expect(mergedVscode.inputs).toEqual([{ type: "promptString", id: "api-key", description: "API key" }]);
      expect((mergedVscode.servers as Record<string, unknown>).other).toEqual({ type: "stdio", command: "other" });
      expect((mergedVscode.servers as Record<string, unknown>).morrow)
        .toMatchObject({ cwd: await realpath(repositoryRoot) });

      const conflictingCursor = `${JSON.stringify({
        mcpServers: { morrow: { command: "someone-elses-morrow" } },
      }, null, 2)}\n`;
      await writeFile(cursorPath, conflictingCursor, "utf8");
      expect(() => installMorrowClient({ ...options, client: "cursor" }))
        .toThrow(/Refusing to replace existing Morrow server morrow/);
      expect(await readFile(cursorPath, "utf8")).toBe(conflictingCursor);

      const conflictingVscode = `${JSON.stringify({
        servers: { morrow: { type: "stdio", command: "someone-elses-morrow" } },
      }, null, 2)}\n`;
      await writeFile(vscodePath, conflictingVscode, "utf8");
      expect(() => installMorrowClient({ ...options, client: "vscode" }))
        .toThrow(/Refusing to replace existing Morrow server morrow/);
      expect(await readFile(vscodePath, "utf8")).toBe(conflictingVscode);

      const malformed = "{ \"mcpServers\": { \n";
      await writeFile(cursorPath, malformed, "utf8");
      expect(() => installMorrowClient({ ...options, client: "cursor" }))
        .toThrow(/is not valid JSON/);
      expect(await readFile(cursorPath, "utf8")).toBe(malformed);

      const notAnObject = "[]\n";
      await writeFile(vscodePath, notAnObject, "utf8");
      expect(() => installMorrowClient({ ...options, client: "vscode" }))
        .toThrow(/must contain a JSON object/);
      expect(await readFile(vscodePath, "utf8")).toBe(notAnObject);

      const wrongContainerType = `${JSON.stringify({ servers: [] }, null, 2)}\n`;
      await writeFile(vscodePath, wrongContainerType, "utf8");
      expect(() => installMorrowClient({ ...options, client: "vscode" }))
        .toThrow(/must contain a JSON object/);
      expect(await readFile(vscodePath, "utf8")).toBe(wrongContainerType);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves custom JSON formatting when it adds Morrow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-json-format-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const settingsPath = join(repositoryRoot, ".gemini", "settings.json");
    const custom = "{\r\n\t\"theme\" : \"night\",\r\n\t\"mcpServers\" : {\r\n\t\t\"other\" : { \"command\" : \"other\" }\r\n\t},\r\n\t\"tail\" : true\r\n}\r\n";
    try {
      await mkdir(dirname(serverEntryPath), { recursive: true });
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      await writeFile(settingsPath, custom, "utf8");

      const installed = installMorrowClient({
        repositoryRoot,
        upstreamConfigPath,
        serverEntryPath,
        nodeCommand: process.execPath,
        client: "gemini-cli",
      });
      const updated = await readFile(settingsPath, "utf8");
      expect(installed).toMatchObject({ changed: true, sha256: sha256(updated) });
      expect(updated).toContain("\t\t\"other\" : { \"command\" : \"other\" },\r\n\t\t\"morrow\" : {");
      expect(updated).toContain("\r\n\t},\r\n\t\"tail\" : true\r\n}\r\n");
      expect(updated.startsWith("{\r\n\t\"theme\" : \"night\",\r\n\t\"mcpServers\" : {")).toBe(true);
      expect(installMorrowClient({
        repositoryRoot,
        upstreamConfigPath,
        serverEntryPath,
        nodeCommand: process.execPath,
        client: "gemini-cli",
      })).toMatchObject({ changed: false, sha256: installed.sha256 });
      expect(await readFile(settingsPath, "utf8")).toBe(updated);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds an exact executable and refuses a server entry whose link escapes the repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-runtime-binding-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const outsideServerEntry = join(directory, "outside-server.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const nodeLink = join(repositoryRoot, "Morrow Node");
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: nodeLink,
      client: "gemini-cli" as const,
    };
    try {
      await mkdir(dirname(serverEntryPath), { recursive: true });
      await writeFile(outsideServerEntry, "console.error('outside');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      await symlink(process.execPath, nodeLink);
      await symlink(outsideServerEntry, serverEntryPath);

      expect(() => installMorrowClient(options)).toThrow(/serverEntryPath must be inside repositoryRoot/);
      await rm(serverEntryPath);
      await writeFile(serverEntryPath, "console.error('inside');\n", "utf8");

      expect(installMorrowClient(options)).toMatchObject({ changed: true });
      const settings = JSON.parse(await readFile(join(repositoryRoot, ".gemini", "settings.json"), "utf8")) as {
        mcpServers: { morrow: { command: string } };
      };
      expect(settings.mcpServers.morrow.command).toBe(nodeLink);

      if (process.platform !== "win32") {
        const nonExecutable = join(repositoryRoot, "not-executable");
        await writeFile(nonExecutable, "node placeholder\n", { encoding: "utf8", mode: 0o600 });
        expect(() => installMorrowClient({ ...options, nodeCommand: nonExecutable }))
          .toThrow(/nodeCommand is not executable/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic-link client file or parent without changing the link target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-symlink-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const geminiDirectory = join(repositoryRoot, ".gemini");
    const settingsPath = join(geminiDirectory, "settings.json");
    const outsideDirectory = join(directory, "outside");
    const outsideSettings = join(outsideDirectory, "settings.json");
    const original = "{\n  \"theme\": \"preserve\"\n}\n";
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: process.execPath,
      client: "gemini-cli" as const,
    };
    try {
      await mkdir(dirname(serverEntryPath), { recursive: true });
      await mkdir(geminiDirectory, { recursive: true });
      await mkdir(outsideDirectory, { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      await writeFile(outsideSettings, original, "utf8");

      await symlink(outsideSettings, settingsPath);
      expect(() => installMorrowClient(options)).toThrow(/settings\.json is a symbolic link/);
      expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(outsideSettings, "utf8")).toBe(original);

      await rm(settingsPath);
      await rm(geminiDirectory, { recursive: true });
      await symlink(outsideDirectory, geminiDirectory, "dir");
      expect(() => installMorrowClient(options)).toThrow(/\.gemini is a symbolic link/);
      expect((await lstat(geminiDirectory)).isSymbolicLink()).toBe(true);
      expect(await readFile(outsideSettings, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces only a receipt-bound client entry during relocation and rejects a newer edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-relocation-"));
    const oldRoot = join(directory, "old-runtime");
    const newRoot = join(directory, "new-runtime");
    const clientProject = join(directory, "course-project");
    const materials = join(directory, "Morrow Materials");
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const fixture = async (root: string) => {
      const serverEntryPath = join(root, "packages", "mcp-server", "dist", "index.js");
      const upstreamConfigPath = join(root, "morrow.upstreams.json");
      await mkdir(dirname(serverEntryPath), { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      return { repositoryRoot: root, serverEntryPath, upstreamConfigPath };
    };
    try {
      await mkdir(clientProject, { recursive: true });
      await mkdir(materials, { recursive: true });
      const oldRuntime = await fixture(oldRoot);
      const newRuntime = await fixture(newRoot);
      const settingsPath = join(clientProject, ".gemini", "settings.json");
      await mkdir(dirname(settingsPath), { recursive: true });
      const customPrefix = "{\n    \"theme\": \"night\",\n    \"mcpServers\": {}\n}\n";
      await writeFile(settingsPath, customPrefix, "utf8");

      const first = installMorrowClient({
        ...oldRuntime,
        nodeCommand: process.execPath,
        client: "gemini-cli",
        projectRoot: clientProject,
        workspaceRoot: materials,
      });
      expect(first.sha256).toBe(sha256(await readFile(settingsPath, "utf8")));

      const upgraded = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "gemini", "--scope", "project",
        "--repository", newRoot, "--upstreams", newRuntime.upstreamConfigPath,
        "--server-entry", newRuntime.serverEntryPath, "--node", process.execPath,
        "--client-project", clientProject, "--workspace-root", materials,
        "--expected-config-sha256", first.sha256, "--json",
      ], { encoding: "utf8" });
      expect(upgraded.status, upgraded.stderr).toBe(0);
      const receipt = JSON.parse(upgraded.stdout) as { changed: boolean; sha256: string };
      const upgradedText = await readFile(settingsPath, "utf8");
      expect(receipt).toMatchObject({ changed: true, sha256: sha256(upgradedText) });
      expect(upgradedText).toContain(newRuntime.serverEntryPath);
      expect(upgradedText).not.toContain(oldRuntime.serverEntryPath);
      expect(upgradedText.startsWith("{\n    \"theme\": \"night\",\n    \"mcpServers\": {")).toBe(true);

      expect(installMorrowClient({
        ...newRuntime,
        nodeCommand: process.execPath,
        client: "gemini-cli",
        projectRoot: clientProject,
        workspaceRoot: materials,
        expectedConfigSha256: receipt.sha256,
      })).toMatchObject({ changed: false, sha256: receipt.sha256 });

      const newer = upgradedText.replace("\"night\"", "\"day\"");
      await writeFile(settingsPath, newer, "utf8");
      expect(() => installMorrowClient({
        ...newRuntime,
        nodeCommand: process.execPath,
        client: "gemini-cli",
        projectRoot: clientProject,
        workspaceRoot: materials,
        expectedConfigSha256: receipt.sha256,
      })).toThrow(/changed after Morrow recorded it/);
      expect(await readFile(settingsPath, "utf8")).toBe(newer);

      const codexPath = join(clientProject, ".codex", "config.toml");
      await mkdir(dirname(codexPath), { recursive: true });
      const codexPrefix = "model = \"gpt-6\"  \n# preserve me\n\n";
      await writeFile(codexPath, codexPrefix, "utf8");
      const oldCodex = installMorrowClient({
        ...oldRuntime,
        nodeCommand: process.execPath,
        client: "codex",
        projectRoot: clientProject,
        workspaceRoot: materials,
      });
      const laterCodexSection = "[projects.\"/tmp/other-course\"]  # preserve this section exactly\ntrust_level = \"trusted\"  \n\n# preserve the final whitespace\n  \n";
      const oldCodexText = await readFile(codexPath, "utf8");
      await writeFile(codexPath, `${oldCodexText}${laterCodexSection}`, "utf8");
      const recordedCodexSha256 = sha256(await readFile(codexPath, "utf8"));
      const newCodex = installMorrowClient({
        ...newRuntime,
        nodeCommand: process.execPath,
        client: "codex",
        projectRoot: clientProject,
        workspaceRoot: materials,
        expectedConfigSha256: recordedCodexSha256,
      });
      const codexText = await readFile(codexPath, "utf8");
      expect(newCodex).toMatchObject({ changed: true, sha256: sha256(codexText) });
      expect(codexText.startsWith(codexPrefix)).toBe(true);
      expect(oldCodex.sha256).toBe(sha256(oldCodexText));
      expect(codexText).toContain(newRuntime.serverEntryPath);
      expect(codexText).not.toContain(oldRuntime.serverEntryPath);
      expect(codexText.match(/\[mcp_servers\.morrow\]/g)).toHaveLength(1);
      expect(codexText.endsWith(laterCodexSection)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("names the documented Claude Desktop file on macOS and Windows and refuses every pair it cannot serve", () => {
    const home = resolve("/tmp/morrow-instructor-home");
    expect(morrowClientConfigPath({
      client: "claude-desktop",
      scope: "user",
      homeDirectory: home,
      platform: "darwin",
    })).toBe(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));

    // Live-unverified: the documented Windows location, not a write proven on a Windows computer.
    expect(morrowClientConfigPath({
      client: "claude-desktop",
      scope: "user",
      platform: "win32",
      applicationDataDirectory: "C:\\Users\\instructor\\AppData\\Roaming",
    })).toBe("C:\\Users\\instructor\\AppData\\Roaming\\Claude\\claude_desktop_config.json");

    const unknownWindowsFolder = refusalOf(() => morrowClientConfigPath({
      client: "claude-desktop",
      scope: "user",
      platform: "win32",
      applicationDataDirectory: "",
    }));
    expect(unknownWindowsFolder.code).toBe("client_configuration_location_unknown");
    expect(unknownWindowsFolder.nextAction).toContain("Edit Config");
    expect(unknownWindowsFolder.message).toContain(unknownWindowsFolder.reason);

    const unsupportedPlatform = refusalOf(() => morrowClientConfigPath({
      client: "claude-desktop",
      scope: "user",
      homeDirectory: home,
      platform: "linux",
    }));
    expect(unsupportedPlatform.code).toBe("client_platform_unsupported");
    expect(unsupportedPlatform.reason).toContain("linux");
    expect(unsupportedPlatform.nextAction).toContain("Claude Code");

    const projectScope = refusalOf(() => morrowClientConfigPath({
      client: "claude-desktop",
      scope: "project",
      projectRoot: resolve("/tmp/morrow-course-project"),
      platform: "darwin",
    }));
    expect(projectScope.code).toBe("client_scope_unsupported");
    expect(projectScope.nextAction).toContain("--scope user");
  });

  it("installs Claude Desktop where this computer documents it, or refuses with a next action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-claude-desktop-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const home = join(directory, "home");
    const originalHome = process.env.HOME;
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: process.execPath,
      client: "claude-desktop" as const,
      scope: "user" as const,
    };
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      process.env.HOME = home;

      if (process.platform === "win32") {
        // A real install here would write the signed-in person's own Claude Desktop file, so this
        // checks only the location. The Windows write stays live-unverified.
        expect(morrowClientConfigPath({ client: "claude-desktop", scope: "user" }))
          .toBe(join(String(process.env.APPDATA), "Claude", "claude_desktop_config.json"));
        return;
      }
      if (process.platform !== "darwin") {
        const refused = refusalOf(() => installMorrowClient(options));
        expect(refused.code).toBe("client_platform_unsupported");
        expect(refused.nextAction).not.toBe("");
        await expect(stat(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")))
          .rejects.toThrow();
        return;
      }

      const configurationPath = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      const installed = installMorrowClient(options);
      expect(installed).toMatchObject({ scope: "user", path: configurationPath, changed: true });
      expect(JSON.parse(await readFile(configurationPath, "utf8"))).toEqual({
        mcpServers: {
          morrow: {
            type: "stdio",
            command: process.execPath,
            args: [serverEntryPath],
            cwd: repositoryRoot,
            env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
          },
        },
      });
      expect((await stat(configurationPath)).mode & 0o777).toBe(0o600);
      expect(installMorrowClient(options)).toMatchObject({ changed: false });

      const conflicting = `${JSON.stringify({
        mcpServers: { morrow: { command: "someone-elses-morrow" } },
      }, null, 2)}\n`;
      await writeFile(configurationPath, conflicting, "utf8");
      expect(() => installMorrowClient(options)).toThrow(/Refusing to replace existing Morrow server morrow/);
      expect(await readFile(configurationPath, "utf8")).toBe(conflicting);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes the recorded Codex scope decision and Claude Desktop locations into the generated files", () => {
    const repositoryRoot = resolve("/tmp/morrow-scope-copy");
    const bundle = buildClientConfigBundle({
      repositoryRoot,
      upstreamConfigPath: join(repositoryRoot, "morrow.upstreams.json"),
      serverEntryPath: join(repositoryRoot, "packages", "mcp-server", "dist", "index.js"),
      nodeCommand: "/usr/local/bin/node",
    });

    for (const name of ["install.posix.sh", "install.powershell.ps1"]) {
      const script = fileContent(bundle, name);
      expect(script).toContain("read ~/.codex/config.toml");
      expect(script).toContain("morrow mcp install codex --scope user");
      expect(script).toContain("A project .codex/config.toml loads only in a project you have marked trusted.");
    }

    const readmeText = fileContent(bundle, "README.txt");
    expect(readmeText).toContain("merge into ~/.codex/config.toml");
    expect(readmeText).toContain("marked trusted");
    expect(readmeText).toContain("Library/Application Support/Claude on macOS");
    expect(readmeText).toContain("%APPDATA%\\Claude on Windows");
  });

  it("tells the person what each written location still needs, and says nothing when it needs nothing", () => {
    expect(morrowClientConfigNotes({ client: "codex", scope: "project", platform: "darwin" }))
      .toEqual([expect.stringContaining("marked trusted")]);
    expect(morrowClientConfigNotes({ client: "codex", scope: "project", platform: "darwin" })[0])
      .toContain("--scope user");
    expect(morrowClientConfigNotes({ client: "codex", scope: "user", platform: "darwin" })).toEqual([]);

    const windowsDesktop = morrowClientConfigNotes({ client: "claude-desktop", scope: "user", platform: "win32" });
    expect(windowsDesktop).toHaveLength(1);
    expect(windowsDesktop[0]).toContain("has not confirmed a write here on a Windows computer");
    expect(windowsDesktop[0]).toContain("Edit Config");
    expect(morrowClientConfigNotes({ client: "claude-desktop", scope: "user", platform: "darwin" })).toEqual([]);
    expect(morrowClientConfigNotes({ client: "claude-code", scope: "project", platform: "win32" })).toEqual([]);
  });

  it("writes a user-scope Cursor file and refuses an undocumented VS Code user-profile path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-client-editor-user-"));
    const repositoryRoot = join(directory, "repo");
    const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
    const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
    const home = join(directory, "home");
    const originalHome = process.env.HOME;
    const options = {
      repositoryRoot,
      upstreamConfigPath,
      serverEntryPath,
      nodeCommand: process.execPath,
      scope: "user" as const,
    };
    try {
      await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
      await writeFile(upstreamConfigPath, "{}\n", "utf8");
      process.env.HOME = home;

      const cursor = installMorrowClient({ ...options, client: "cursor" });
      expect(cursor).toMatchObject({ scope: "user", path: join(home, ".cursor", "mcp.json"), changed: true });
      expect(JSON.parse(await readFile(cursor.path, "utf8")))
        .toMatchObject({ mcpServers: { morrow: { args: [serverEntryPath] } } });

      expect(() => installMorrowClient({ ...options, client: "vscode" }))
        .toThrow(/MCP: Open User Configuration/);
      await expect(stat(join(home, ".vscode", "mcp.json"))).rejects.toThrow();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("explains local setup, one-app installation, and course connection state while preserving JSON diagnostics", async () => {
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
        cliPath, "setup", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(setup.status).toBe(0);
      expect(setup.stdout).toContain("Morrow's local settings are ready.");
      expect(setup.stdout).toContain("This step does not connect a course.");
      expect(setup.stdout).toContain("share one local course connection");
      expect(setup.stdout).toContain("chrome://extensions");
      expect(setup.stdout).toContain("Open or restart that assistant before you use the extension.");
      expect(setup.stdout).not.toContain('"schema"');

      const setupJson = spawnSync(process.execPath, [
        cliPath, "setup", "--json", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(setupJson.status).toBe(0);
      expect(JSON.parse(setupJson.stdout)).toMatchObject({
        schema: "morrow.setup.v1",
        path: upstreamConfigPath,
        credentialsCopied: false,
      });

      const stateDirectory = join(directory, "Morrow State");
      await mkdir(stateDirectory, { recursive: true });
      const consumerUpstreamsPath = join(stateDirectory, "morrow.upstreams.json");
      const consumerSetup = spawnSync(process.execPath, [
        cliPath, "setup", "--json", "--force", "--repository", repositoryRoot,
        "--upstreams", consumerUpstreamsPath, "--state-directory", stateDirectory,
      ], { encoding: "utf8" });
      expect(consumerSetup.status).toBe(0);
      const canonicalStateDirectory = await realpath(stateDirectory);
      expect(JSON.parse(consumerSetup.stdout)).toMatchObject({
        path: consumerUpstreamsPath,
        stateDirectory: canonicalStateDirectory,
      });
      expect(JSON.parse(await readFile(consumerUpstreamsPath, "utf8"))).toMatchObject({
        upstreams: [{ env: { MORROW_CANVAS_CONNECTOR_STATE: join(canonicalStateDirectory, "canvas-connector.json") } }],
        operationJournal: { path: join(canonicalStateDirectory, "morrow.sqlite3") },
        privacy: { learnerVaultPath: join(canonicalStateDirectory, "learner-vault.json") },
      });

      const invalidState = spawnSync(process.execPath, [
        cliPath, "setup", "--repository", repositoryRoot, "--state-directory", "relative-state",
      ], { encoding: "utf8" });
      expect(invalidState.status).toBe(1);
      expect(invalidState.stderr).toContain("stateDirectory must be an absolute path");

      const install = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "gemini", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(install.status).toBe(0);
      expect(install.stdout).toContain("Morrow configuration was installed for Gemini CLI.");
      expect(install.stdout).toContain("did not open or test the assistant");
      expect(install.stdout).toContain("You do not open a separate Morrow application");
      expect(install.stdout).not.toContain("scope=project");

      const codexProjectInstall = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "codex", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(codexProjectInstall.status).toBe(0);
      expect(codexProjectInstall.stdout).toContain("Morrow configuration was installed for ChatGPT or Codex.");
      expect(codexProjectInstall.stdout).toContain("only in a project you have marked trusted");
      expect(codexProjectInstall.stdout).toContain("--scope user");

      const desktopRefusal = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "claude-desktop", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(desktopRefusal.status).toBe(1);
      expect(desktopRefusal.stderr).toContain("Claude Desktop reads one configuration file");
      expect(desktopRefusal.stderr).toContain("Run the same command with --scope user.");
      expect(desktopRefusal.stderr).not.toContain("TypeError");

      const clientProject = join(directory, "assistant-project");
      await mkdir(clientProject, { recursive: true });
      const projectInstall = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "claude", "--repository", repositoryRoot,
        "--client-project", clientProject,
      ], { encoding: "utf8" });
      expect(projectInstall.status).toBe(0);
      expect(JSON.parse(await readFile(join(clientProject, ".mcp.json"), "utf8")))
        .toMatchObject({
          mcpServers: {
            morrow: {
              cwd: await realpath(clientProject),
              args: [serverEntryPath],
              env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath },
            },
          },
        });

      const editorProject = join(directory, "editor-project");
      await mkdir(editorProject, { recursive: true });
      const cursorInstall = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "cursor", "--repository", repositoryRoot,
        "--client-project", editorProject,
      ], { encoding: "utf8" });
      expect(cursorInstall.status).toBe(0);
      expect(cursorInstall.stdout).toContain("Morrow configuration was installed for Cursor.");
      expect(JSON.parse(await readFile(join(editorProject, ".cursor", "mcp.json"), "utf8")))
        .toMatchObject({
          mcpServers: {
            morrow: { type: "stdio", args: [serverEntryPath], env: { MORROW_UPSTREAMS_FILE: upstreamConfigPath } },
          },
        });

      const vscodeInstall = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "vscode", "--repository", repositoryRoot,
        "--client-project", editorProject,
      ], { encoding: "utf8" });
      expect(vscodeInstall.status).toBe(0);
      expect(vscodeInstall.stdout).toContain("Morrow configuration was installed for VS Code.");
      expect(JSON.parse(await readFile(join(editorProject, ".vscode", "mcp.json"), "utf8")))
        .toMatchObject({
          servers: {
            morrow: { type: "stdio", cwd: await realpath(editorProject), args: [serverEntryPath] },
          },
        });

      const vscodeUserInstall = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "vscode", "--scope", "user", "--repository", repositoryRoot,
      ], { encoding: "utf8" });
      expect(vscodeUserInstall.status).toBe(1);
      expect(vscodeUserInstall.stderr).toContain("MCP: Open User Configuration");

      const consumerHome = join(directory, "consumer-home");
      const materials = join(directory, "Morrow Materials");
      await mkdir(consumerHome, { recursive: true });
      await mkdir(materials, { recursive: true });
      const userInstall = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "codex", "--scope", "user", "--repository", repositoryRoot,
        "--workspace-root", materials,
      ], { encoding: "utf8", env: { ...process.env, HOME: consumerHome } });
      expect(userInstall.status).toBe(0);
      expect(await readFile(join(consumerHome, ".codex", "config.toml"), "utf8"))
        .toContain(`cwd = ${JSON.stringify(await realpath(materials))}`);

      const invalidWorkspace = spawnSync(process.execPath, [
        cliPath, "mcp", "install", "codex", "--scope", "user", "--repository", repositoryRoot,
        "--workspace-root", "relative-materials",
      ], { encoding: "utf8", env: { ...process.env, HOME: join(directory, "relative-home") } });
      expect(invalidWorkspace.status).toBe(1);
      expect(invalidWorkspace.stderr).toContain("workspaceRoot must be an absolute path");

      const doctorText = spawnSync(process.execPath, [
        cliPath, "doctor", "--repository", repositoryRoot, "--upstreams", upstreamConfigPath,
      ], { encoding: "utf8" });
      expect(doctorText.status).toBe(0);
      expect(doctorText.stdout).toContain("Morrow troubleshooting check.");
      expect(doctorText.stdout).toContain("Morrow service: did not become ready.");
      expect(doctorText.stdout).toContain("Course connection:");
      expect(doctorText.stdout).not.toContain('"schema"');

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
  }, 20_000);

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
      expect(bundle.files).toHaveLength(11);
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
