import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StrictStdioClientTransport } from "../src/strict-stdio.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stubborn-child.mjs", import.meta.url));

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

describe("StrictStdioClientTransport shutdown", () => {
  it("serializes outbound writes, bounds queued bytes, and rejects every send on close", async () => {
    const transport = new StrictStdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "-e", "process.stdin.pause(); setInterval(() => undefined, 1_000);"],
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      maxBufferSize: 1024 * 1024,
      shutdownGraceMs: 75,
      shutdownKillWaitMs: 2_000,
    });
    await transport.start();
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "large", arguments: { value: "x".repeat(900_000) } },
    } as const;
    const first = transport.send(message).catch((error: unknown) => error);
    const second = transport.send({ ...message, id: 2 }).catch((error: unknown) => error);

    await expect(transport.send({ ...message, id: 3 })).rejects.toThrow("output queue limit exceeded");
    const stdin = (transport as unknown as { process: { stdin: NodeJS.WritableStream } }).process.stdin;
    expect(stdin.listenerCount("drain")).toBe(1);
    expect(stdin.listenerCount("error")).toBeLessThanOrEqual(2);

    await transport.close();
    await expect(first).resolves.toBeInstanceOf(Error);
    await expect(second).resolves.toBeInstanceOf(Error);
    expect(stdin.listenerCount("drain")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  it("rejects one outbound message above the wire limit before writing it", async () => {
    const transport = new StrictStdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "-e", "process.stdin.resume();"],
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      maxBufferSize: 1_024,
    });
    await transport.start();
    try {
      await expect(transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "large", arguments: { value: "x".repeat(1_024) } },
      })).rejects.toThrow("message exceeds the stdio limit");
    } finally {
      await transport.close();
    }
  });

  it("waits for exit and force-kills a child that ignores graceful shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morrow-stubborn-upstream-"));
    const pidPath = join(directory, "pid");
    const signalPath = join(directory, "signals");
    try {
      const transport = new StrictStdioClientTransport({
        command: process.execPath,
        args: [fixturePath],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          STUBBORN_PID_PATH: pidPath,
          STUBBORN_SIGNAL_PATH: signalPath,
        },
        maxBufferSize: 1024,
        shutdownGraceMs: 75,
        shutdownKillWaitMs: 2_000,
      });
      await transport.start();
      const pids = JSON.parse((await waitForFile(pidPath)).trim()) as { parent: number; descendant: number };
      expect(processIsAlive(pids.parent)).toBe(true);
      expect(processIsAlive(pids.descendant)).toBe(true);

      await transport.close();

      expect((await readFile(signalPath, "utf8")).trim()).toBe("SIGTERM");
      expect(processIsAlive(pids.parent)).toBe(false);
      expect(processIsAlive(pids.descendant)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
