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
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.process;
    if (!child || this.closed) throw new Error("StrictStdioClientTransport is not connected");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        child.stdin.off("error", onError);
        child.stdin.off("drain", onDrain);
      };
      child.stdin.once("error", onError);
      if (child.stdin.write(`${JSON.stringify(message)}\n`)) {
        cleanup();
        resolve();
      } else {
        child.stdin.once("drain", onDrain);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed && !this.process) return;
    this.closed = true;
    this.buffer = "";
    const child = this.process;
    this.closePromise = this.stopChild(child).finally(() => {
      this.process = undefined;
      this.stderrStream.end();
      this.notifyClose();
    });
    return this.closePromise;
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
      child.stdout.off("data", this.onStdout);
      child.stdout.off("error", this.onStreamError);
      child.stdin.off("error", this.onStreamError);
      child.off("error", this.onStreamError);
      child.off("close", this.onClose);
      child.stderr.unpipe(this.stderrStream);
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
