import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { LOCAL_OWNER_MAINTENANCE_PATH, requestLocalOwnerMaintenance } from "../src/local-owner-maintenance.js";

// An installed assistant entry carries a route: the id of that installed entry
// and the generation Morrow last wrote into it. The local owner reports a route
// only for a live session that started from such an entry, in the workspace it
// started in. A session without one, such as a direct SDK client, is never
// reported as any installed assistant.
const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FIRST = Object.freeze({ id: "6f1c1c1e-2b9a-4d4e-9c1a-0f5e5d7b8a21", generation: "A".repeat(43) });
const SECOND = Object.freeze({ id: "0d4b6a3e-5c2f-4f1a-8e9b-7a6c5d4e3f21", generation: "B".repeat(43) });
const FIRST_NEXT = Object.freeze({ id: FIRST.id, generation: "C".repeat(43) });

const observedOwners = new Map<string, { pid: number; nonce: string }>();

interface Connected {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fixture(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const configPath = join(directory, "morrow.upstreams.json");
  const journalPath = join(directory, "gateway.sqlite3");
  const materials = join(directory, "Materials");
  const other = join(directory, "Other Materials");
  await mkdir(materials);
  await mkdir(other);
  await writeFile(configPath, `${JSON.stringify({
    schema: "morrow.upstreams.v1",
    profile: "private-full",
    toolSurface: "full",
    sourcePolicy: { requireAttestation: false },
    upstreams: [{
      id: "morrow-legacy",
      label: "Fixture",
      kind: "mcp-stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_SOURCE: "morrow-legacy" },
      priority: 1,
      required: true,
      enabled: true,
    }],
    filters: { excludePrefixes: [], excludeNames: [] },
    operationJournal: { path: journalPath },
    privacy: {
      canvasOrigin: "local",
      account: "local-account",
      principal: "local-principal",
      learnerVaultPath: join(directory, "learner-vault.json"),
    },
    maxCatalogTools: 20,
  }, null, 2)}\n`, "utf8");
  return { directory, configPath, journalPath, materials, other, ownerPath: `${journalPath}.local-owner.json` };
}

async function connect(
  configPath: string,
  cwd: string,
  options: { readonly route?: { readonly id: string; readonly generation: string } | Record<string, string>; readonly modern?: boolean } = {},
): Promise<Connected> {
  const client = new Client(
    { name: "route-test", version: "1.0.0" },
    options.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const route = options.route && "id" in options.route && "generation" in options.route
    ? { MORROW_ROUTE_ID: options.route.id, MORROW_ROUTE_GENERATION: options.route.generation }
    : options.route ?? {};
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    cwd,
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: configPath, ...route },
    stderr: "pipe",
  });
  await client.connect(transport);
  const config = JSON.parse(await readFile(configPath, "utf8")) as { operationJournal: { path: string } };
  const ownerPath = `${config.operationJournal.path}.local-owner.json`;
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid: number; nonce: string };
  observedOwners.set(ownerPath, owner);
  return { client, transport };
}

async function close(connection: Connected | null): Promise<void> {
  await connection?.client.close().catch(() => undefined);
  await connection?.transport.close().catch(() => undefined);
}

async function routes(journalPath: string, workspaceRoot: string): Promise<readonly { id: string; generation: string }[]> {
  const result = await requestLocalOwnerMaintenance({ action: "routes", journalPath, holderPid: process.pid, workspaceRoot });
  if (result.status !== "routes") throw new Error(`unexpected status ${result.status}`);
  return [...result.routes].sort((a, b) => `${a.id}${a.generation}`.localeCompare(`${b.id}${b.generation}`));
}

async function stopOwner(ownerPath: string): Promise<void> {
  const observed = observedOwners.get(ownerPath);
  if (!observed) throw new Error("fixture owner identity was not observed");
  try {
    await waitUntil(() => !existsSync(ownerPath), "the owner's cleanup");
  } catch {
    const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as { pid: number; nonce: string };
    if (descriptor.pid !== observed.pid || descriptor.nonce !== observed.nonce) throw new Error("fixture owner identity changed");
    process.kill(descriptor.pid, "SIGTERM");
    await waitUntil(() => !existsSync(ownerPath), "the owner's bounded stop");
  }
  await waitUntil(async () => {
    try {
      const stat = await readFile(`/proc/${observed.pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { process.kill(observed.pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }, "the observed fixture owner's process exit");
  observedOwners.delete(ownerPath);
}

describe("local-owner installed routes", () => {
  it("reports a classic session's route only in its own workspace, and never a session that carries none", async () => {
    const run = await fixture("morrow-routes-classic-");
    let routed: Connected | null = null;
    let direct: Connected | null = null;
    try {
      direct = await connect(run.configPath, run.materials);
      routed = await connect(run.configPath, run.materials, { route: FIRST });
      await waitUntil(async () => (await routes(run.journalPath, run.materials)).length === 1, "the classic route");
      expect(await routes(run.journalPath, run.materials)).toEqual([FIRST]);
      expect(await routes(run.journalPath, run.other)).toEqual([]);
      // The direct SDK client is connected and working, and it is still not a route.
      await expect(direct.client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({
        structuredContent: { schema: "morrow.health.v1" },
      });
      expect(await routes(run.journalPath, run.materials)).toEqual([FIRST]);
    } finally {
      await close(routed);
      await close(direct);
      await stopOwner(run.ownerPath);
      await rm(run.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a modern session's route", async () => {
    const run = await fixture("morrow-routes-modern-");
    let modern: Connected | null = null;
    try {
      modern = await connect(run.configPath, run.materials, { route: SECOND, modern: true });
      await modern.client.callTool({ name: "morrow_health", arguments: {} });
      await waitUntil(async () => (await routes(run.journalPath, run.materials)).length === 1, "the modern route");
      expect(await routes(run.journalPath, run.materials)).toEqual([SECOND]);
    } finally {
      await close(modern);
      await stopOwner(run.ownerPath);
      await rm(run.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports each route and generation separately and drops one when its process ends", async () => {
    const run = await fixture("morrow-routes-lifetime-");
    const connections: Connected[] = [];
    try {
      connections.push(await connect(run.configPath, run.materials, { route: FIRST }));
      connections.push(await connect(run.configPath, run.materials, { route: SECOND }));
      // The same installed entry started from an older and a newer generation.
      connections.push(await connect(run.configPath, run.materials, { route: FIRST_NEXT }));
      await waitUntil(async () => (await routes(run.journalPath, run.materials)).length === 3, "three routes");
      expect(await routes(run.journalPath, run.materials)).toEqual([SECOND, FIRST, FIRST_NEXT].sort((a, b) => `${a.id}${a.generation}`.localeCompare(`${b.id}${b.generation}`)));
      await close(connections.shift()!);
      await waitUntil(async () => (await routes(run.journalPath, run.materials)).length === 2, "the ended route to go");
      expect(await routes(run.journalPath, run.materials)).not.toContainEqual(FIRST);
    } finally {
      for (const connection of connections) await close(connection);
      await stopOwner(run.ownerPath);
      await rm(run.directory, { recursive: true, force: true });
    }
  }, 40_000);

  it("ignores a malformed or partial route and keeps the session working", async () => {
    const run = await fixture("morrow-routes-malformed-");
    const connections: Connected[] = [];
    try {
      for (const route of [
        { MORROW_ROUTE_ID: "not-a-uuid", MORROW_ROUTE_GENERATION: FIRST.generation },
        { MORROW_ROUTE_ID: FIRST.id },
        { MORROW_ROUTE_ID: FIRST.id, MORROW_ROUTE_GENERATION: "short" },
      ]) {
        const connection = await connect(run.configPath, run.materials, { route });
        connections.push(connection);
        await expect(connection.client.callTool({ name: "morrow_health", arguments: {} })).resolves.toMatchObject({
          structuredContent: { schema: "morrow.health.v1" },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await routes(run.journalPath, run.materials)).toEqual([]);
    } finally {
      for (const connection of connections) await close(connection);
      await stopOwner(run.ownerPath);
      await rm(run.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a route from a process that has no session of its own", async () => {
    const run = await fixture("morrow-routes-sessionless-");
    let direct: Connected | null = null;
    try {
      direct = await connect(run.configPath, run.materials);
      const descriptor = JSON.parse(await readFile(run.ownerPath, "utf8")) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${descriptor.port}${LOCAL_OWNER_MAINTENANCE_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          "content-type": "application/json",
          "x-morrow-proxy-pid": String(process.pid),
          "x-morrow-workspace": Buffer.from(run.materials, "utf8").toString("base64url"),
        },
        body: JSON.stringify({ schema: "morrow.local-owner-maintenance.request.v1", action: "route", holderPid: process.pid, route: FIRST }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "local_owner_route_session_required" });
      expect(await routes(run.journalPath, run.materials)).toEqual([]);
    } finally {
      await close(direct);
      await stopOwner(run.ownerPath);
      await rm(run.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a route status answer that is not exact", async () => {
    const run = await fixture("morrow-routes-answer-");
    let direct: Connected | null = null;
    try {
      direct = await connect(run.configPath, run.materials);
      const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const input = { action: "routes" as const, journalPath: run.journalPath, holderPid: process.pid, workspaceRoot: run.materials };
      for (const body of [
        { schema: "morrow.local-owner-maintenance.v1", status: "routes", routes: [{ id: "x", generation: FIRST.generation }] },
        { schema: "morrow.local-owner-maintenance.v1", status: "routes", routes: [{ ...FIRST, pid: 1 }] },
        { schema: "morrow.local-owner-maintenance.v1", status: "routes", routes: Array.from({ length: 33 }, () => FIRST) },
        { schema: "morrow.local-owner-maintenance.v1", status: "routes" },
      ]) {
        await expect(requestLocalOwnerMaintenance(input, answer(body) as typeof fetch)).rejects.toMatchObject({
          code: "local_owner_maintenance_response_invalid",
        });
      }
    } finally {
      await close(direct);
      await stopOwner(run.ownerPath);
      await rm(run.directory, { recursive: true, force: true });
    }
  }, 30_000);
});
