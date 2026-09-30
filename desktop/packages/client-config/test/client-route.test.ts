import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  installMorrowClient,
  MORROW_ROUTE_ENVIRONMENT,
  morrowClientConfigurationStatus,
  morrowServerEntryArguments,
  morrowServerEntryRoute,
} from "../src/index.js";

// A route names one installed assistant entry and the generation Morrow wrote.
// The runtime reports it only for a live session that started from that entry.
const ROUTE = Object.freeze({ id: "6f1c1c1e-2b9a-4d4e-9c1a-0f5e5d7b8a21", generation: "A".repeat(43) });
const NEXT = Object.freeze({ id: ROUTE.id, generation: "B".repeat(43) });

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "morrow-client-route-")));
  const repositoryRoot = join(directory, "repo");
  const serverEntryPath = join(repositoryRoot, "packages", "mcp-server", "dist", "index.js");
  const upstreamConfigPath = join(repositoryRoot, "morrow.upstreams.json");
  const projectRoot = join(directory, "project");
  const workspaceRoot = join(directory, "materials");
  await mkdir(join(repositoryRoot, "packages", "mcp-server", "dist"), { recursive: true });
  await mkdir(projectRoot);
  await mkdir(workspaceRoot);
  await writeFile(serverEntryPath, "console.error('fixture');\n", "utf8");
  await writeFile(upstreamConfigPath, "{}\n", "utf8");
  return {
    directory,
    options: { repositoryRoot, upstreamConfigPath, serverEntryPath, nodeCommand: process.execPath, projectRoot, workspaceRoot },
  };
}

describe("installed route identity", () => {
  it("names two environment variables that carry no other meaning", () => {
    expect(MORROW_ROUTE_ENVIRONMENT).toEqual({ id: "MORROW_ROUTE_ID", generation: "MORROW_ROUTE_GENERATION" });
  });

  it("writes the route into every project-scoped entry and reads it back from that entry only", async () => {
    const { directory, options } = await fixture();
    try {
      for (const client of ["codex", "claude-code", "gemini-cli"] as const) {
        const installed = installMorrowClient({ ...options, client, route: ROUTE });
        const content = await readFile(installed.path, "utf8");
        expect(morrowServerEntryRoute(client, content)).toEqual(ROUTE);
        expect(morrowServerEntryArguments(client, content)).toEqual([await realpath(options.serverEntryPath)]);
        expect(morrowClientConfigurationStatus({ ...options, client, route: ROUTE }).configured).toBe(true);
        // A different generation is a different configuration.
        expect(morrowClientConfigurationStatus({ ...options, client, route: NEXT }).configured).toBe(false);
        expect(morrowClientConfigurationStatus({ ...options, client }).configured).toBe(false);
      }
      const gemini = JSON.parse(await readFile(join(options.projectRoot, ".gemini", "settings.json"), "utf8"));
      expect(gemini.mcpServers.morrow.env).toEqual({
        MORROW_UPSTREAMS_FILE: await realpath(options.upstreamConfigPath),
        MORROW_ROUTE_ID: ROUTE.id,
        MORROW_ROUTE_GENERATION: ROUTE.generation,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces the route when Morrow rewrites its own entry, and writes no route when none is given", async () => {
    const { directory, options } = await fixture();
    try {
      installMorrowClient({ ...options, client: "gemini-cli", route: ROUTE });
      const rewritten = installMorrowClient({ ...options, client: "gemini-cli", route: NEXT, replaceMorrowEntry: true });
      expect(morrowServerEntryRoute("gemini-cli", await readFile(rewritten.path, "utf8"))).toEqual(NEXT);
      const plain = installMorrowClient({ ...options, client: "claude-code" });
      const entry = JSON.parse(await readFile(plain.path, "utf8")).mcpServers.morrow;
      expect(Object.keys(entry.env)).toEqual(["MORROW_UPSTREAMS_FILE"]);
      expect(morrowServerEntryRoute("claude-code", await readFile(plain.path, "utf8"))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a route that is not one exact id and one exact generation", async () => {
    const { directory, options } = await fixture();
    try {
      for (const route of [
        { id: "not-a-uuid", generation: ROUTE.generation },
        { id: ROUTE.id, generation: "short" },
        { id: ROUTE.id.toUpperCase(), generation: ROUTE.generation },
        { id: ROUTE.id, generation: `${"A".repeat(42)}=` },
        { id: ROUTE.id, generation: ROUTE.generation, extra: true },
      ]) {
        expect(() => installMorrowClient({ ...options, client: "gemini-cli", route: route as never })).toThrow(/route/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("takes the route from the install command as a pair", async () => {
    const { directory, options } = await fixture();
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const base = [
      cliPath, "mcp", "install", "gemini", "--scope", "project",
      "--repository", options.repositoryRoot,
      "--upstreams", options.upstreamConfigPath,
      "--node", process.execPath,
      "--server-entry", options.serverEntryPath,
      "--workspace-root", options.workspaceRoot,
      "--client-project", options.projectRoot,
      "--json",
    ];
    try {
      const installed = spawnSync(process.execPath, [...base, "--route-id", ROUTE.id, "--route-generation", ROUTE.generation], { encoding: "utf8" });
      expect(installed.status, installed.stderr).toBe(0);
      const content = await readFile(join(options.projectRoot, ".gemini", "settings.json"), "utf8");
      expect(morrowServerEntryRoute("gemini-cli", content)).toEqual(ROUTE);
      const half = spawnSync(process.execPath, [...base, "--route-id", ROUTE.id, "--replace-morrow-entry"], { encoding: "utf8" });
      expect(half.status).not.toBe(0);
      expect(half.stderr).toMatch(/--route-id and --route-generation/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
