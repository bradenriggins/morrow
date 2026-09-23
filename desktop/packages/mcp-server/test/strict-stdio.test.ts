import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { StrictStdioServerTransport } from "../src/strict-stdio.js";

function feed(transport: StrictStdioServerTransport, chunk: Buffer): void {
  (transport as unknown as { onData(chunk: Buffer): void }).onData(chunk);
}

function response(id: number): JSONRPCMessage {
  return { jsonrpc: "2.0", id, result: { ok: true } } as JSONRPCMessage;
}

class ControlledOutput extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableFinished = false;

  constructor(private readonly finishOnEnd: boolean) {
    super();
  }

  write(value: string, callback?: () => void): boolean {
    this.writes.push(value);
    queueMicrotask(() => callback?.());
    return false;
  }

  end(): this {
    this.writableEnded = true;
    if (this.finishOnEnd) {
      this.writableFinished = true;
      queueMicrotask(() => this.emit("finish"));
    }
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function transportWithOutput(output: ControlledOutput): StrictStdioServerTransport {
  return new StrictStdioServerTransport({
    input: new PassThrough(),
    output: output as unknown as Writable,
  });
}

describe("StrictStdioServerTransport", () => {
  it.each(["café", "日本語", "🙂"])("preserves %s across every byte split", (value) => {
    const wire = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { value } },
    })}\n`, "utf8");

    for (let split = 1; split < wire.length; split += 1) {
      const transport = new StrictStdioServerTransport();
      const messages: JSONRPCMessage[] = [];
      transport.onmessage = (message) => messages.push(message);

      feed(transport, wire.subarray(0, split));
      feed(transport, wire.subarray(split));

      expect(messages, `split at byte ${split}`).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        params: { arguments: { value } },
      });
    }
  });

  it("serializes writes and admits only a bounded number of pending messages", async () => {
    const output = new ControlledOutput(true);
    const transport = transportWithOutput(output);
    const first = transport.send(response(1));
    const second = transport.send(response(2));

    expect(output.writes).toHaveLength(1);
    output.emit("drain");
    await first;
    expect(output.writes).toHaveLength(2);
    output.emit("drain");
    await second;

    const blockedOutput = new ControlledOutput(true);
    const blockedTransport = transportWithOutput(blockedOutput);
    const accepted = Array.from({ length: 32 }, (_, index) => (
      blockedTransport.send(response(index)).catch((error: unknown) => error)
    ));
    await expect(blockedTransport.send(response(33))).rejects.toThrow("output queue limit exceeded");
    await blockedTransport.close();
    const settlements = await Promise.all(accepted);
    expect(settlements).toHaveLength(32);
    expect(settlements.every((value) => value instanceof Error && /closed/.test(value.message))).toBe(true);
    await transport.close();
  });

  it("close rejects every pending send and removes its output listeners", async () => {
    const output = new ControlledOutput(false);
    const transport = transportWithOutput(output);
    const baselineErrors = output.listenerCount("error");
    const baselineDrains = output.listenerCount("drain");
    let closes = 0;
    transport.onclose = () => { closes += 1; };
    const first = transport.send(response(1)).catch((error: unknown) => error);
    const second = transport.send(response(2)).catch((error: unknown) => error);

    expect(output.listenerCount("error")).toBe(baselineErrors + 1);
    expect(output.listenerCount("drain")).toBe(baselineDrains + 1);
    const close = transport.close();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBeInstanceOf(Error);
    expect(secondResult).toBeInstanceOf(Error);
    expect((firstResult as Error).message).toContain("closed");
    expect((secondResult as Error).message).toContain("closed");
    await close;

    expect(output.destroyed).toBe(true);
    expect(output.listenerCount("error")).toBe(baselineErrors);
    expect(output.listenerCount("drain")).toBe(baselineDrains);
    expect(closes).toBe(1);
    await expect(transport.send(response(3))).rejects.toThrow("is closed");
    await expect(transport.start()).rejects.toThrow("is closed");
  });

  it("exits after a real peer pauses its full stdout pipe and ends stdin", async () => {
    const fixture = resolve("test/fixtures/strict-stdio-backpressure.mjs");
    const child = spawn(process.execPath, [fixture], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.pause();
    child.stderr.setEncoding("utf8");
    let stderr = "";
    let exited = false;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => {
        exited = true;
        resolveExit({ code, signal });
      });
    });
    const backpressured = new Promise<void>((resolveBackpressure, rejectBackpressure) => {
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes("BACKPRESSURED\n")) resolveBackpressure();
      });
      child.once("exit", () => {
        if (!stderr.includes("BACKPRESSURED\n")) rejectBackpressure(new Error(`fixture exited before backpressure: ${stderr}`));
      });
    });

    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fill" })}\n`);
      // Starting the fixture is setup, and a loaded runner can take seconds to do
      // it. Only the exit after stdin ends is timed.
      await Promise.race([
        backpressured,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fixture did not backpressure")), 15_000)),
      ]);
      const closeStarted = Date.now();
      child.stdin.end();
      const result = await Promise.race([
        exit,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("backpressured fixture did not exit")), 2_500)),
      ]);
      expect(Date.now() - closeStarted).toBeLessThan(2_500);
      expect(result).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("BACKPRESSURED\n");
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      if (!exited) child.kill("SIGKILL");
    }
  }, 30_000);
});
