import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  deserializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";

export interface StrictStdioClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd?: string;
  readonly maxBufferSize: number;
  readonly shutdownGraceMs?: number;
  readonly shutdownKillWaitMs?: number;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
const DEFAULT_SHUTDOWN_KILL_WAIT_MS = 1_500;
const MAX_PENDING_OUTPUT_MESSAGES = 32;

type PendingOutput = {
  readonly wire: string;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  onError: ((error: Error) => void) | null;
  onDrain: (() => void) | null;
};

export class StrictStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly stderrStream = new PassThrough();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private closeNotified = false;
  private activeOutput: PendingOutput | null = null;
  private readonly outputQueue: PendingOutput[] = [];
  private pendingOutputBytes = 0;

  constructor(private readonly options: StrictStdioClientOptions) {}

  get stderr(): NodeJS.ReadableStream | null {
    return this.stderrStream;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("StrictStdioClientTransport already started");
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: "pipe",
      windowsHide: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    this.process = child;
    child.stderr.pipe(this.stderrStream);
    child.stdout.on("data", this.onStdout);
    child.stdout.on("error", this.onStreamError);
    child.stdin.on("error", this.onStreamError);
    child.on("error", this.onStreamError);
    child.on("close", this.onClose);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.process;
    if (!child || this.closed) throw new Error("StrictStdioClientTransport is not connected");
    const serialized = JSON.stringify(message);
    if (typeof serialized !== "string") throw new Error("StrictStdioClientTransport message is not serializable");
    const wire = `${serialized}\n`;
    const bytes = Buffer.byteLength(wire);
    if (bytes > this.options.maxBufferSize) {
      throw new Error("StrictStdioClientTransport message exceeds the stdio limit");
    }
    const pendingCount = this.outputQueue.length + (this.activeOutput ? 1 : 0);
    if (
      pendingCount >= MAX_PENDING_OUTPUT_MESSAGES
      || this.pendingOutputBytes + bytes > 2 * this.options.maxBufferSize
    ) {
      throw new Error("StrictStdioClientTransport output queue limit exceeded");
    }
    await new Promise<void>((resolve, reject) => {
      this.pendingOutputBytes += bytes;
      this.outputQueue.push({ wire, bytes, resolve, reject, onError: null, onDrain: null });
      this.pumpOutput();
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed && !this.process) return;
    this.closed = true;
    this.buffer = "";
    this.rejectPendingOutput(new Error("StrictStdioClientTransport closed before output drained"));
    const child = this.process;
    this.closePromise = this.stopChild(child).finally(() => {
      this.detachChild(child);
      this.process = undefined;
      this.stderrStream.end();
      this.notifyClose();
    });
    return this.closePromise;
  }

  private detachChild(child: ChildProcessWithoutNullStreams | undefined): void {
    if (!child) return;
    child.stdout.off("data", this.onStdout);
    child.stdout.off("error", this.onStreamError);
    child.stdin.off("error", this.onStreamError);
    child.off("error", this.onStreamError);
    child.off("close", this.onClose);
    child.stderr.unpipe(this.stderrStream);
  }

  private pumpOutput(): void {
    const child = this.process;
    if (!child || this.closed || this.activeOutput) return;
    const pending = this.outputQueue.shift();
    if (!pending) return;
    this.activeOutput = pending;
    pending.onError = (error: Error) => this.finishOutput(pending, error);
    pending.onDrain = () => this.finishOutput(pending, null);
    child.stdin.once("error", pending.onError);
    child.stdin.once("drain", pending.onDrain);
    try {
      if (child.stdin.write(pending.wire)) this.finishOutput(pending, null);
    } catch (error) {
      this.finishOutput(pending, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finishOutput(pending: PendingOutput, error: Error | null): void {
    if (this.activeOutput !== pending) return;
    const child = this.process;
    if (child) {
      if (pending.onError) child.stdin.off("error", pending.onError);
      if (pending.onDrain) child.stdin.off("drain", pending.onDrain);
    }
    this.activeOutput = null;
    this.pendingOutputBytes -= pending.bytes;
    if (error) pending.reject(error);
    else pending.resolve();
    this.pumpOutput();
  }

  private rejectPendingOutput(error: Error): void {
    const active = this.activeOutput;
    this.activeOutput = null;
    const child = this.process;
    if (active) {
      if (child && active.onError) child.stdin.off("error", active.onError);
      if (child && active.onDrain) child.stdin.off("drain", active.onDrain);
      active.reject(error);
    }
    for (const pending of this.outputQueue.splice(0)) pending.reject(error);
    this.pendingOutputBytes = 0;
  }

  private childExited(child: ChildProcessWithoutNullStreams): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  private async waitForChildExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.childExited(child)) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("close", onClose);
        resolve(exited);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(this.childExited(child)), timeoutMs);
      child.once("close", onClose);
    });
  }

  private async stopChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
    if (!child) return;
    if (this.childExited(child)) {
      this.terminateChildTree(child, true);
      return;
    }
    child.stdin.end();
    this.terminateChildTree(child, false);
    const graceful = await this.waitForChildExit(
      child,
      this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    );
    if (graceful) {
      this.terminateChildTree(child, true);
      return;
    }
    this.terminateChildTree(child, true);
    const killed = await this.waitForChildExit(
      child,
      this.options.shutdownKillWaitMs ?? DEFAULT_SHUTDOWN_KILL_WAIT_MS,
    );
    if (!killed) {
      this.detachChild(child);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw new Error(`Upstream process ${child.pid ?? "unknown"} did not exit after forced shutdown`);
    }
  }

  private terminateChildTree(child: ChildProcessWithoutNullStreams, force: boolean): void {
    if (!Number.isSafeInteger(child.pid) || Number(child.pid) < 1) return;
    if (process.platform === "win32") {
      try {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} });
        killer.unref();
        return;
      } catch {
        try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
        return;
      }
    }
    try {
      process.kill(-Number(child.pid), force ? "SIGKILL" : "SIGTERM");
    } catch {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
    }
  }

  private readonly onStdout = (chunk: Buffer): void => {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer) > this.options.maxBufferSize) {
          this.fail("Upstream stdout exceeded the MCP message limit");
        }
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.options.maxBufferSize) {
        this.fail("Upstream stdout exceeded the MCP message limit");
        return;
      }
      try {
        this.onmessage?.(deserializeMessage(line) as JSONRPCMessage);
      } catch {
        this.fail("Upstream stdout contained invalid MCP JSON-RPC");
        return;
      }
    }
  };

  private readonly onStreamError = (error: Error): void => this.fail(error.message);

  private readonly onClose = (): void => {
    this.rejectPendingOutput(new Error("StrictStdioClientTransport closed before output drained"));
    this.process = undefined;
    this.stderrStream.end();
    if (!this.closed) {
      this.closed = true;
      this.notifyClose();
    }
  };

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }

  private fail(message: string): void {
    if (this.closed) return;
    const error = new Error(message);
    this.onerror?.(error);
    void this.close();
  }
}
