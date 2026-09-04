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
}

export class StrictStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly stderrStream = new PassThrough();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;

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
    const child = this.process;
    if (this.closed) return;
    this.closed = true;
    this.process = undefined;
    this.buffer = "";
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    this.onclose?.();
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
    if (!this.closed) {
      this.closed = true;
      this.onclose?.();
    }
  };

  private fail(message: string): void {
    if (this.closed) return;
    const error = new Error(message);
    this.onerror?.(error);
    void this.close();
  }
}
