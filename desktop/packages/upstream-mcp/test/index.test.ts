import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StdioMcpUpstream, UpstreamNotDispatchedError } from "../src/index.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const duplicateFixturePath = fileURLToPath(new URL("./fixtures/raw-duplicate-tools-upstream.mjs", import.meta.url));
const silentFixturePath = fileURLToPath(new URL("./fixtures/silent-upstream.mjs", import.meta.url));

const openUpstreams: StdioMcpUpstream[] = [];
function tracked(upstream: StdioMcpUpstream): StdioMcpUpstream {
  openUpstreams.push(upstream);
  return upstream;
}
afterEach(async () => {
  await Promise.all(openUpstreams.splice(0).map((upstream) => upstream.close().catch(() => undefined)));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "morrow-upstream-mcp-"));
  return directory;
}

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    if (Date.now() >= deadline) throw new Error("upstream child did not record its PID");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`operation did not settle within ${milliseconds} ms`)), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("StdioMcpUpstream", () => {
  it("connects, normalizes tools in ascending name order, and reports a connected, unattested health record", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "3" },
    }));
    const tools = await upstream.connect();
    expect(tools.map((tool) => tool.name)).toEqual(["fake_tool_1", "fake_tool_2", "fake_tool_3"]);
    const health = upstream.health();
    expect(health).toMatchObject({ id: "fixture", connected: true, toolCount: 3, connectionGeneration: 1 });
    expect(health.catalogAttested).toBeUndefined();
    expect(typeof health.catalogDigest).toBe("string");
  });

  it("refuses a published tool count that does not match the attested count, and reports it disconnected", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "2" },
      expectedToolCount: 5,
    }));
    await expect(upstream.connect()).rejects.toThrow(/published 2 tools, not the attested 5/);
    expect(upstream.health().connected).toBe(false);
  });

  it("accepts a published tool count that matches the attested count", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "2" },
      expectedToolCount: 2,
    }));
    await upstream.connect();
    expect(upstream.health()).toMatchObject({ connected: true, toolCount: 2, expectedToolCount: 2, catalogAttested: true });
  });

  it("refuses a catalog digest that does not match the configured attestation", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "2" },
      expectedCatalogDigest: "a".repeat(64),
    }));
    await expect(upstream.connect()).rejects.toThrow(/catalog digest .* does not match the configured attestation/);
    expect(upstream.health().connected).toBe(false);
  });

  it("accepts the exact catalog digest a prior connection actually published", async () => {
    const first = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "2" },
    }));
    await first.connect();
    const digest = first.health().catalogDigest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    await first.close();

    const second = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "2" },
      expectedCatalogDigest: digest,
    }));
    await second.connect();
    expect(second.health()).toMatchObject({ connected: true, catalogAttested: true, catalogDigest: digest });
  });

  it("refuses two tools an upstream publishes under the exact same name", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Misbehaving upstream", command: process.execPath, args: [duplicateFixturePath],
    }));
    await expect(upstream.connect()).rejects.toThrow(/published duplicate tool duplicate_tool/);
    expect(upstream.health().connected).toBe(false);
  });

  it("retries a failed startup attempt and connects on the next one", async () => {
    const directory = await tempDirectory();
    try {
      const marker = join(directory, "startup-marker");
      let preparedLaunches = 0;
      const upstream = tracked(new StdioMcpUpstream({
        id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
        env: { FAKE_TOOL_COUNT: "2", FAKE_FAIL_STARTUP_MARKER: marker },
        prepareLaunch: (launch) => {
          preparedLaunches += 1;
          return { launch };
        },
        supervision: { startupAttempts: 2, reconnectAttempts: 2, initialBackoffMs: 5, maxBackoffMs: 10 },
      }));
      await upstream.connect();
      expect(preparedLaunches).toBe(2);
      expect(upstream.health()).toMatchObject({ connected: true, reconnect: { state: "idle", startupAttempts: 2 } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes before launch preparation settles and refuses to spawn afterward", async () => {
    const directory = await tempDirectory();
    try {
      const marker = join(directory, "launched");
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      let preparing!: () => void;
      const startedPreparing = new Promise<void>((resolve) => {
        preparing = resolve;
      });
      const upstream = tracked(new StdioMcpUpstream({
        id: "fixture",
        label: "Fixture upstream",
        command: process.execPath,
        args: [fixturePath],
        env: { FAKE_FAIL_STARTUP_MARKER: marker },
        prepareLaunch: async (launch) => {
          preparing();
          await preparation;
          return { launch };
        },
      }));
      const connecting = upstream.connect();
      const refused = expect(connecting).rejects.toThrow(/is closed/);
      await startedPreparing;
      const closing = upstream.close();
      expect(upstream.close()).toBe(closing);
      await within(closing, 1_000);
      expect(existsSync(marker)).toBe(false);
      releasePreparation();
      await refused;
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles caller cancellation while launch preparation never settles", async () => {
    let preparing!: () => void;
    const startedPreparing = new Promise<void>((resolve) => { preparing = resolve; });
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture",
      label: "Never prepared upstream",
      command: process.execPath,
      args: [fixturePath],
      prepareLaunch: async () => {
        preparing();
        return await new Promise<never>(() => undefined);
      },
    }));
    const controller = new AbortController();
    const connecting = upstream.connect({ signal: controller.signal });
    await startedPreparing;

    controller.abort(new Error("cancelled never-settling upstream startup"));

    await expect(within(connecting, 1_000)).rejects.toThrow("cancelled never-settling upstream startup");
    await within(upstream.close(), 1_000);
  });

  it("closes and reaps a child that spawned but never answered initialization", async () => {
    const directory = await tempDirectory();
    try {
      const pidPath = join(directory, "silent.pid");
      const upstream = tracked(new StdioMcpUpstream({
        id: "fixture",
        label: "Silent upstream",
        command: process.execPath,
        args: [silentFixturePath],
        env: { SILENT_UPSTREAM_PID_PATH: pidPath },
      }));
      const connecting = upstream.connect();
      const refused = expect(connecting).rejects.toThrow(/is closed/);
      const pid = await readPid(pidPath);
      expect(processIsAlive(pid)).toBe(true);

      const closing = upstream.close();
      expect(upstream.close()).toBe(closing);
      await within(closing, 4_000);
      await refused;
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels the maximum reconnect backoff without spawning a later child", async () => {
    let preparedLaunches = 0;
    vi.useFakeTimers();
    try {
      const upstream = tracked(new StdioMcpUpstream({
        id: "fixture",
        label: "Fixture upstream",
        command: process.execPath,
        args: [fixturePath],
        prepareLaunch: () => {
          preparedLaunches += 1;
          throw new Error("synthetic launch refusal");
        },
        supervision: {
          startupAttempts: 1,
          reconnectAttempts: 8,
          initialBackoffMs: 30_000,
          maxBackoffMs: 60_000,
        },
      }));
      const reconnecting = (upstream as unknown as {
        startConnection(reconnect: boolean): Promise<readonly unknown[]>;
      }).startConnection(true);
      const refused = expect(reconnecting).rejects.toThrow(/is closed/);
      expect(upstream.health().reconnect).toMatchObject({ state: "waiting", attempt: 1 });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(preparedLaunches).toBe(1);
      expect(upstream.health().reconnect).toMatchObject({ state: "waiting", attempt: 2 });
      vi.useRealTimers();

      const closing = upstream.close();
      expect(upstream.close()).toBe(closing);
      await within(closing, 1_000);
      await refused;
      expect(preparedLaunches).toBe(1);
      expect(upstream.health().reconnect).toMatchObject({ state: "closed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("widens its reconnect delay geometrically up to the configured ceiling", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "1" },
      supervision: { startupAttempts: 1, reconnectAttempts: 4, initialBackoffMs: 100, maxBackoffMs: 250 },
    }));
    const backoff = (upstream as unknown as { backoff(attempt: number): number }).backoff.bind(upstream);
    expect(backoff(1)).toBe(100);
    expect(backoff(2)).toBe(200);
    expect(backoff(3)).toBe(250);
    expect(backoff(4)).toBe(250);
  });

  it("reconnects and completes a retried call after the upstream process exits mid-call", async () => {
    const directory = await tempDirectory();
    try {
      const statePrefix = join(directory, "state");
      const upstream = tracked(new StdioMcpUpstream({
        id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
        env: { FAKE_TOOL_COUNT: "1", FAKE_STATE_PREFIX: statePrefix, FAKE_CRASH_TOOL: "fake_tool_1" },
        supervision: { startupAttempts: 2, reconnectAttempts: 2, initialBackoffMs: 5, maxBackoffMs: 10 },
      }));
      await upstream.connect();
      expect(upstream.health().connectionGeneration).toBe(1);
      const result = await upstream.callTool("fake_tool_1", { value: "after-crash" }, { safeToRetry: true });
      expect(result).toMatchObject({ structuredContent: { name: "fake_tool_1", value: "after-crash" } });
      expect(upstream.health().connectionGeneration).toBe(2);
      const calls = (await readFile(`${statePrefix}.calls`, "utf8")).trim().split("\n");
      expect(calls).toEqual(["fake_tool_1", "fake_tool_1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("uses the caller-owned timeout for a long-running upstream tool", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "1", FAKE_TOOL_DELAY_MS: "150" },
    }));
    await upstream.connect();
    await expect(upstream.callTool("fake_tool_1", {}, { timeoutMs: 25 })).rejects.toThrow(/timed out/i);
    await expect(upstream.callTool("fake_tool_1", { value: "bounded" }, { timeoutMs: 1_000 }))
      .resolves.toMatchObject({ structuredContent: { name: "fake_tool_1", value: "bounded" } });
  });

  it("refuses a call to a disconnected upstream when the caller has not opted into a retry", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "1" },
    }));
    const refused = upstream.callTool("fake_tool_1", {});
    await expect(refused).rejects.toThrow(/disconnected before dispatch/);
    // The gateway settles such a call as not sent by this type, not by its message.
    await expect(refused).rejects.toBeInstanceOf(UpstreamNotDispatchedError);
  });

  it("stops reconnecting once closed, and a later call is refused rather than reviving it", async () => {
    const upstream = tracked(new StdioMcpUpstream({
      id: "fixture", label: "Fixture upstream", command: process.execPath, args: [fixturePath],
      env: { FAKE_TOOL_COUNT: "1" },
      supervision: { startupAttempts: 1, reconnectAttempts: 2, initialBackoffMs: 5, maxBackoffMs: 10 },
    }));
    await upstream.connect();
    await upstream.close();
    expect(upstream.health()).toMatchObject({ connected: false, reconnect: { state: "closed" } });
    await expect(upstream.callTool("fake_tool_1", {}, { safeToRetry: true })).rejects.toThrow(/is closed/);
  });
});
