import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClientConfigBundle,
  installMorrowClient,
  isMorrowServerEntry,
  MorrowClientConfigWriteRefusal,
  morrowClientConfigurationStatus,
  morrowServerEntryArguments,
  withoutMorrowClientJson,
  withoutMorrowCodexTable,
} from "../src/index.js";

/*
 * Ways the assistant-entry rules can fail, written before the change:
 * - Morrow writes `required = true`, so ChatGPT and Codex refuse to start when Morrow cannot.
 * - Codex rewrites config.toml after Morrow (model, trusted projects, tui notices). Removal
 *   and replacement refuse because a table follows Morrow's, or because the whole-file
 *   digest no longer matches, and a dangling entry stays behind.
 * - Removal takes a following table, a comment, or trailing bytes with it.
 * - Morrow's Codex subtables (per-tool approvals) survive removal as a half entry.
 * - A `morrow` entry that Morrow did not write is replaced or removed.
 * - A valid TOML 1.0 file (mixed-type array) is refused as invalid.
 * - An empty JSON file, a byte-order mark, or `"mcpServers": null` stops setup.
 * - A refusal carries no machine-readable reason, so setup shows a generic error.
 * - A read-only file is silently made writable; an existing file's mode is replaced by 0600.
 */

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let directory = "";
let home = "";
let previousHome: string | undefined;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "morrow-assistant-entry-")));
  home = join(directory, "home");
  await mkdir(home, { recursive: true });
  previousHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await chmod(join(home, ".codex"), 0o700).catch(() => {});
  await rm(directory, { recursive: true, force: true });
});

async function runtime(name: string) {
  const repositoryRoot = join(directory, name);
  const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
  const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
  const materials = join(directory, "Materials");
  await mkdir(dirname(serverEntryPath), { recursive: true });
  await mkdir(materials, { recursive: true });
  await writeFile(serverEntryPath, "console.error('fixture');\n");
  await writeFile(upstreamConfigPath, "{}\n");
  return {
    repositoryRoot,
    serverEntryPath,
    upstreamConfigPath,
    workspaceRoot: materials,
    nodeCommand: process.execPath,
  };
}

function codexSection(options: Awaited<ReturnType<typeof runtime>>): string {
  const entry = buildClientConfigBundle({ ...options, nodeCommand: process.execPath }).files
    .find((file) => file.path === "codex.config.toml");
  if (!entry) throw new Error("missing codex section");
  return entry.content;
}

function refusal(attempt: () => unknown): MorrowClientConfigWriteRefusal {
  try {
    attempt();
  } catch (error) {
    if (error instanceof MorrowClientConfigWriteRefusal) return error;
    throw error;
  }
  throw new Error("expected a configuration write refusal");
}

describe("Codex entry that Codex can start without Morrow", () => {
  it("does not mark Morrow as required", async () => {
    const options = await runtime("app");
    expect(codexSection(options)).not.toMatch(/required/);
  });
});

describe("structural Morrow entry removal", () => {
  const morrowTable = [
    "[mcp_servers.morrow]",
    "command = \"/Applications/Morrow.app/node\"",
    "args = [\"/Applications/Morrow.app/index.js\"]",
    "env = { MORROW_UPSTREAMS_FILE = \"/Users/t/Library/Application Support/Morrow/State/morrow.upstreams.json\" }",
    "required = true",
    "",
  ].join("\n");

  it("removes only Morrow's table when Codex appended tables after it", () => {
    const before = "model = \"gpt-6\"\n\n[mcp_servers.other]\ncommand = \"npx\"\n\n";
    const after = "[projects.\"/Users/t/course\"]\ntrust_level = \"trusted\"\n\n# keep this note\n[tui.notices]\nhide_full_access_warning = true\n";
    expect(withoutMorrowCodexTable(`${before}${morrowTable}\n${after}`)).toBe(`${before}${after}`);
  });

  it("keeps a comment block that belongs to the next table", () => {
    const content = `a = 1\n\n${morrowTable}\n# projects Codex trusts\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n`;
    expect(withoutMorrowCodexTable(content)).toBe("a = 1\n\n# projects Codex trusts\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n");
  });

  it("removes Morrow's own subtables with it, wherever they appear", () => {
    const content = `${morrowTable}\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.morrow.tools.morrow_health]\napproval_mode = \"approve\"\n\n[mcp_servers.other]\ncommand = \"x\"\n`;
    expect(withoutMorrowCodexTable(content)).toBe("[projects.\"/x\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.other]\ncommand = \"x\"\n");
  });

  it("refuses an inline or dotted definition it cannot remove without rewriting other bytes", () => {
    expect(() => withoutMorrowCodexTable("mcp_servers = { morrow = { command = \"x\" } }\n")).toThrow(/without rewriting existing TOML/);
    expect(() => withoutMorrowCodexTable("[mcp_servers]\nmorrow.command = \"x\"\n")).toThrow(/without rewriting existing TOML/);
  });

  it("refuses an entry that does not carry Morrow's marker when asked for Morrow's own entry", () => {
    const foreign = "[mcp_servers.morrow]\ncommand = \"someone-else\"\n";
    expect(() => withoutMorrowCodexTable(foreign, "morrow", { requireMorrowEntry: true })).toThrow(/not written by Morrow/);
    expect(withoutMorrowCodexTable(morrowTable, "morrow", { requireMorrowEntry: true })).toBe("");
    const json = "{\n  \"mcpServers\": {\n    \"morrow\": { \"command\": \"someone-else\" }\n  }\n}\n";
    expect(() => withoutMorrowClientJson(json, "mcpServers", "morrow", { requireMorrowEntry: true })).toThrow(/not written by Morrow/);
  });

  it("accepts valid TOML 1.0 that the old parser refused", () => {
    const content = `mixed = [1, "x", { a = 1 }]\n\n${morrowTable}`;
    expect(withoutMorrowCodexTable(content)).toBe("mixed = [1, \"x\", { a = 1 }]\n");
  });

  it("recognizes Morrow's marker in every client entry shape", () => {
    expect(isMorrowServerEntry({ command: "x", env: { MORROW_UPSTREAMS_FILE: "/a" } })).toBe(true);
    expect(isMorrowServerEntry({ command: "x", env: {} })).toBe(false);
    expect(isMorrowServerEntry({ command: "x" })).toBe(false);
    expect(isMorrowServerEntry(null)).toBe(false);
  });
});

describe("replacing Morrow's entry after the assistant rewrote its file", () => {
  it("re-points Codex without a whole-file digest and keeps every byte Codex wrote", async () => {
    const old = await runtime("Volumes-copy");
    const current = await runtime("Applications-copy");
    const target = join(home, ".codex", "config.toml");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "model = \"gpt-5\"\n");
    installMorrowClient({ ...old, client: "codex", scope: "user" });
    const staleEntry = (await readFile(target, "utf8")).replace("default_tools_approval_mode", "required = true\ndefault_tools_approval_mode");
    const codexRewrite = `${staleEntry.replace("model = \"gpt-5\"", "model = \"gpt-6\"")}\n[projects.\"/Users/t/course\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.morrow.tools.morrow_health]\napproval_mode = \"approve\"\n`;
    await writeFile(target, codexRewrite);

    expect(() => installMorrowClient({ ...current, client: "codex", scope: "user" })).toThrow(/existing Morrow server/);
    const replaced = installMorrowClient({ ...current, client: "codex", scope: "user", replaceMorrowEntry: true });
    const text = await readFile(target, "utf8");
    expect(replaced.changed).toBe(true);
    expect(text.startsWith("model = \"gpt-6\"\n")).toBe(true);
    expect(text).toContain(await realpath(current.serverEntryPath));
    expect(text).not.toContain(old.serverEntryPath);
    expect(text).not.toMatch(/required/);
    expect(text.endsWith("[projects.\"/Users/t/course\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.morrow.tools.morrow_health]\napproval_mode = \"approve\"\n")).toBe(true);
    expect(morrowClientConfigurationStatus({ ...current, client: "codex", scope: "user" }).configured).toBe(true);
    expect(installMorrowClient({ ...current, client: "codex", scope: "user", replaceMorrowEntry: true }).changed).toBe(false);
  });

  it("refuses to replace a morrow entry Morrow did not write, with a machine-readable reason", async () => {
    const current = await runtime("app");
    const target = join(home, ".codex", "config.toml");
    await mkdir(dirname(target), { recursive: true });
    const foreign = "[mcp_servers.morrow]\ncommand = \"someone-else\"\n";
    await writeFile(target, foreign);
    const refused = refusal(() => installMorrowClient({ ...current, client: "codex", scope: "user", replaceMorrowEntry: true }));
    expect(refused.code).toBe("config_entry_not_morrow");
    expect(refused.path).toBe(target);
    expect(await readFile(target, "utf8")).toBe(foreign);
  });

  it("re-points a JSON assistant whose other settings changed", async () => {
    const old = await runtime("old");
    const current = await runtime("new");
    const project = join(directory, "project");
    await mkdir(project, { recursive: true });
    installMorrowClient({ ...old, client: "claude-code", projectRoot: project });
    const target = join(project, ".mcp.json");
    const edited = (await readFile(target, "utf8")).replace("{\n", "{\n  \"theme\": \"night\",\n");
    await writeFile(target, edited);
    installMorrowClient({ ...current, client: "claude-code", projectRoot: project, replaceMorrowEntry: true });
    const document = JSON.parse(await readFile(target, "utf8"));
    expect(document.theme).toBe("night");
    expect(document.mcpServers.morrow.args).toEqual([await realpath(current.serverEntryPath)]);
  });
});

describe("assistant files setup can read, and the reasons it gives when it cannot", () => {
  async function geminiTarget() {
    const options = await runtime("app");
    const project = join(directory, "project");
    const target = join(project, ".gemini", "settings.json");
    await mkdir(dirname(target), { recursive: true });
    return { options: { ...options, client: "gemini-cli" as const, projectRoot: project }, target };
  }

  it("treats an empty file, a byte-order mark, and a null server list as no servers yet", async () => {
    const { options, target } = await geminiTarget();
    for (const content of ["", "\n", "﻿{\n  \"mcpServers\": {}\n}\n", "{\"theme\": \"x\", \"mcpServers\": null}\n"]) {
      await writeFile(target, content);
      expect(installMorrowClient(options).changed, JSON.stringify(content)).toBe(true);
      const text = await readFile(target, "utf8");
      const document = JSON.parse(text.replace(/^﻿/, ""));
      expect(isMorrowServerEntry(document.mcpServers.morrow)).toBe(true);
      if (content.startsWith("﻿")) expect(text.startsWith("﻿")).toBe(true);
      if (content.includes("theme")) expect(document.theme).toBe("x");
    }
  });

  it("names invalid JSON and invalid TOML with their own reason", async () => {
    const { options, target } = await geminiTarget();
    await writeFile(target, "{ not json");
    expect(refusal(() => installMorrowClient(options))).toMatchObject({ code: "config_invalid", path: target });
    const codex = join(home, ".codex", "config.toml");
    await mkdir(dirname(codex), { recursive: true });
    await writeFile(codex, "[mcp_servers\n");
    expect(refusal(() => installMorrowClient({ ...options, client: "codex", scope: "user", projectRoot: undefined })))
      .toMatchObject({ code: "config_invalid", path: codex });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses a read-only file and leaves its bytes and mode alone", async () => {
    const { options, target } = await geminiTarget();
    await writeFile(target, "{}\n");
    await chmod(target, 0o444);
    expect(refusal(() => installMorrowClient(options))).toMatchObject({ code: "config_read_only", path: target });
    expect((await stat(target)).mode & 0o777).toBe(0o444);
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names a folder it may not write", async () => {
    const options = await runtime("app");
    const folder = join(home, ".codex");
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o555);
    const target = join(folder, "config.toml");
    expect(refusal(() => installMorrowClient({ ...options, client: "codex", scope: "user" })))
      .toMatchObject({ code: "config_permission_denied", path: target });
  });

  it.skipIf(process.platform === "win32")("names a linked settings folder", async () => {
    const options = await runtime("app");
    const elsewhere = join(directory, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(home, ".codex"), "dir");
    expect(refusal(() => installMorrowClient({ ...options, client: "codex", scope: "user" })))
      .toMatchObject({ code: "config_symlink", path: join(home, ".codex", "config.toml") });
  });

  it.skipIf(process.platform === "win32")("keeps an existing file's own mode and never widens it", async () => {
    const { options, target } = await geminiTarget();
    await writeFile(target, "{}\n");
    await chmod(target, 0o644);
    installMorrowClient(options);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(installMorrowClient(options).changed).toBe(false);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it("reports the reason as JSON on standard error in --json mode", async () => {
    const { options, target } = await geminiTarget();
    await writeFile(target, "{ not json");
    const result = spawnSync(process.execPath, [
      cliPath, "mcp", "install", "gemini", "--scope", "project",
      "--repository", options.repositoryRoot, "--upstreams", options.upstreamConfigPath,
      "--server-entry", options.serverEntryPath, "--node", process.execPath,
      "--client-project", options.projectRoot, "--workspace-root", options.workspaceRoot, "--json",
    ], { encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(result.status).toBe(1);
    const line = result.stderr.split("\n").find((entry) => entry.startsWith("{"));
    expect(JSON.parse(line || "null")).toEqual({
      schema: "morrow.client-config-error.v1",
      code: "config_invalid",
      path: target,
    });
  });
});

describe("where Morrow's entry says Morrow is", () => {
  it("reads the arguments of Morrow's own entry, and nothing from an entry someone else wrote", () => {
    const codex = "[mcp_servers.morrow]\ncommand = \"/Volumes/M/node\"\nargs = [\"/Volumes/M/index.js\"]\nenv = { MORROW_UPSTREAMS_FILE = \"/s.json\" }\n";
    expect(morrowServerEntryArguments("codex", codex)).toEqual(["/Volumes/M/index.js"]);
    expect(morrowServerEntryArguments("codex", "[mcp_servers.morrow]\ncommand = \"x\"\nargs = [\"/a\"]\n")).toBeNull();
    expect(morrowServerEntryArguments("codex", "model = \"gpt-6\"\n")).toBeNull();
    const json = JSON.stringify({ mcpServers: { morrow: { command: "n", args: ["/Old/index.js"], env: { MORROW_UPSTREAMS_FILE: "/s.json" } } } });
    expect(morrowServerEntryArguments("gemini-cli", json)).toEqual(["/Old/index.js"]);
    expect(morrowServerEntryArguments("claude-code", "{ broken")).toBeNull();
  });
});
