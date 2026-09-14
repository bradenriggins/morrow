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
