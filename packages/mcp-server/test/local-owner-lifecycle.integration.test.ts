import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { requestLocalOwnerMaintenance } from "../src/local-owner-maintenance.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface ConnectedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

interface OwnerDescriptor {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLog(path: string): Promise<readonly string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// A child process can still be flushing a file into the temp directory when
// the owner's descriptor disappears, so a single recursive rm can lose a
// rmdir race (ENOTEMPTY). Retry briefly before giving up.
async function removeDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function writeConfig(directory: string, delayMs = 0): Promise<{ configPath: string; journalPath: string; callLogPath: string }> {
  const configPath = join(directory, "morrow.upstreams.json");
  const journalPath = join(directory, "gateway.sqlite3");
  const callLogPath = join(directory, "calls.log");
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
      env: {
        FAKE_SOURCE: "morrow-legacy",
        FAKE_CALL_LOG: callLogPath,
        ...(delayMs ? { FAKE_DELAY_MS: String(delayMs) } : {}),
      },
      priority: 1,
      required: true,
      enabled: true,
      outputPrivacy: {
        canvas_page_get: {
          allowedFields: ["source", "course_id"],
          dataClass: "course",
          maxRecords: 10,
          maxBytes: 2_000,
          freeText: "allow",
          learnerTokens: false,
          artifactInspection: "deny",
        },
      },
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
  return { configPath, journalPath, callLogPath };
}

async function connect(configPath: string, name: string): Promise<ConnectedClient> {
  const client = new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    env: { ...getDefaultEnvironment(), MORROW_UPSTREAMS_FILE: configPath },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function closeClient(connection: ConnectedClient | null): Promise<void> {
  await connection?.client.close().catch(() => undefined);
  await connection?.transport.close().catch(() => undefined);
}

async function openPartialMaintenance(
  descriptor: OwnerDescriptor,
  proxyPid: number,
  workspaceRoot: string,
): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port: descriptor.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const prefix = JSON.stringify({ schema: "morrow.local-owner-maintenance.request.v1" }).slice(0, -1);
  socket.write([
    "POST /morrow-maintenance/v1 HTTP/1.1",
    `Host: 127.0.0.1:${descriptor.port}`,
    `Authorization: Bearer ${descriptor.token}`,
    `X-Morrow-Proxy-Pid: ${proxyPid}`,
    `X-Morrow-Workspace: ${Buffer.from(workspaceRoot, "utf8").toString("base64url")}`,
    "Content-Type: application/json",
    "Content-Length: 512",
    "Connection: keep-alive",
    "",
    prefix,
  ].join("\r\n"));
  return socket;
}

describe("local-owner lifecycle", () => {
  it("lets one idle modern monitor acquire maintenance while active work and a peer still block it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-modern-maintenance-"));
    const { configPath, journalPath, callLogPath } = await writeConfig(directory, 500);
    const ownerPath = `${journalPath}.local-owner.json`;
    const workspaceRoot = await realpath(process.cwd());
    let monitor: ConnectedClient | null = null;
    let peer: ConnectedClient | null = null;
    try {
      monitor = await connect(configPath, "modern-maintenance-monitor");
      expect(monitor.client.getProtocolEra()).toBe("modern");
      expect(monitor.transport.pid).not.toBeNull();
      await monitor.client.callTool({ name: "morrow_health", arguments: {} });
      const held = await requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath,
        holderPid: process.pid,
        monitorProxyPid: monitor.transport.pid!,
        workspaceRoot,
      });
      expect(held.status).toBe("held");
      if (held.status !== "held") throw new Error("maintenance lease was not held");
      await expect(requestLocalOwnerMaintenance({
        action: "release",
        journalPath,
        holderPid: process.pid,
        workspaceRoot,
        leaseId: held.leaseId,
        leaseToken: held.leaseToken,
      })).resolves.toMatchObject({ status: "released" });

      const slow = monitor.client.callTool({ name: "canvas_page_get", arguments: { course_id: "101" } });
      await waitUntil(async () => (await readLog(callLogPath)).includes("canvas_page_get"), "the active modern request");
      await expect(requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath,
        holderPid: process.pid,
        monitorProxyPid: monitor.transport.pid!,
        workspaceRoot,
      })).rejects.toMatchObject({ code: "local_owner_maintenance_work_active" });
      await slow;
      const heldAfterSlow = await requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath,
        holderPid: process.pid,
        monitorProxyPid: monitor.transport.pid!,
        workspaceRoot,
      });
      expect(heldAfterSlow.status).toBe("held");
      if (heldAfterSlow.status !== "held") throw new Error("maintenance lease was not reacquired");
      await requestLocalOwnerMaintenance({
        action: "release",
        journalPath,
        holderPid: process.pid,
        workspaceRoot,
        leaseId: heldAfterSlow.leaseId,
        leaseToken: heldAfterSlow.leaseToken,
      });

      peer = await connect(configPath, "modern-maintenance-peer");
      await peer.client.callTool({ name: "morrow_health", arguments: {} });
      await expect(requestLocalOwnerMaintenance({
        action: "acquire",
        journalPath,
        holderPid: process.pid,
        monitorProxyPid: monitor.transport.pid!,
        workspaceRoot,
      })).rejects.toMatchObject({ code: "local_owner_maintenance_work_active" });
    } finally {
      await Promise.all([closeClient(peer), closeClient(monitor)]);
      await waitUntil(() => !existsSync(ownerPath), "the modern owner's cleanup");
      await removeDirectory(directory);
    }
  }, 20_000);

  it("aborts a partial maintenance body and exits within the shutdown bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-owner-http-close-"));
    const { configPath, journalPath } = await writeConfig(directory);
    const ownerPath = `${journalPath}.local-owner.json`;
    const workspaceRoot = await realpath(process.cwd());
    let monitor: ConnectedClient | null = null;
    let partial: Socket | null = null;
    try {
      monitor = await connect(configPath, "owner-http-close-monitor");
      expect(monitor.transport.pid).not.toBeNull();
      const descriptorBytes = await readFile(ownerPath);
      const descriptor = JSON.parse(descriptorBytes.toString("utf8")) as OwnerDescriptor & Record<string, unknown>;
      const descriptorStat = await stat(ownerPath);
      expect(Object.keys(descriptor).sort()).toEqual([
        "configDigest", "journalPath", "nonce", "pid", "port", "schema", "startedAt", "token",
      ]);
      expect(descriptor.journalPath).toBe(join(await realpath(directory), "gateway.sqlite3"));
      expect(descriptorBytes.toString("utf8")).toBe(`${JSON.stringify(descriptor)}\n`);
      expect(descriptorStat.mode & 0o077).toBe(0);
      expect(descriptorStat.nlink).toBe(1);
      expect(descriptorStat.size).toBeLessThanOrEqual(4_096);
      partial = await openPartialMaintenance(descriptor, monitor.transport.pid!, workspaceRoot);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const partialClosed = new Promise<void>((resolve) => partial!.once("close", () => resolve()));

      const startedAt = Date.now();
      process.kill(descriptor.pid, "SIGTERM");
      await expect(Promise.race([
        partialClosed,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("partial owner request stayed open")), 1_000)),
      ])).resolves.toBeUndefined();
      await waitUntil(() => !processIsAlive(descriptor.pid), "the bounded owner shutdown");
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await expect(fetch(`http://127.0.0.1:${descriptor.port}/mcp`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    } finally {
      partial?.destroy();
      await closeClient(monitor);
      try {
        const descriptor = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerDescriptor;
        if (processIsAlive(descriptor.pid)) process.kill(descriptor.pid, "SIGKILL");
      } catch { /* owner already stopped */ }
      await removeDirectory(directory);
    }
  }, 15_000);
});
