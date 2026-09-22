import {
  deserializeMessage,
  INVALID_REQUEST,
  PARSE_ERROR,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_WIRE_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_OUTPUT_MESSAGES = 32;
const MAX_PENDING_OUTPUT_BYTES = 2 * MAX_WIRE_MESSAGE_BYTES;
const OUTPUT_CLOSE_FLUSH_MS = 250;
const PROCESS_OUTPUT_EXIT_GRACE_MS = 1_500;

type PendingOutput = {
  wire: string;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
  onError: ((error: Error) => void) | null;
  onDrain: (() => void) | null;
};

export type StrictStdioServerTransportOptions = Readonly<{
  input?: Readable;
  output?: Writable;
}>;

export class StrictStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly input: Readable;
  private readonly output: Writable;
  private readonly processOutput: boolean;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;
  private started = false;
  private closePromise: Promise<void> | null = null;
  private activeOutput: PendingOutput | null = null;
  private readonly outputQueue: PendingOutput[] = [];
  private pendingOutputBytes = 0;
  private nativeOutputPending = 0;
  private readonly nativeOutputIdleListeners = new Set<() => void>();

  constructor(options: StrictStdioServerTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.processOutput = options.output === undefined;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer) > MAX_WIRE_MESSAGE_BYTES) {
          this.buffer = "";
          this.parseFailure("MCP message exceeds the stdio limit");
        }
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_WIRE_MESSAGE_BYTES) {
        this.parseFailure("MCP message exceeds the stdio limit");
        continue;
      }
      try {
        this.onmessage?.(deserializeMessage(line) as JSONRPCMessage);
      } catch (error) {
        this.parseFailure(
          error instanceof SyntaxError ? "Invalid JSON-RPC message" : "Invalid JSON-RPC request",
          error instanceof SyntaxError ? PARSE_ERROR : INVALID_REQUEST,
        );
      }
    }
  };

  private readonly onInputError = (error: Error): void => this.onerror?.(error);

  private readonly onInputEnd = (): void => {
    void this.close();
  };

  async start(): Promise<void> {
    if (this.started) throw new Error("StrictStdioServerTransport already started");
    if (this.closed) throw new Error("StrictStdioServerTransport is closed");
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
    this.input.once("end", this.onInputEnd);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("StrictStdioServerTransport is closed");
    const serialized = JSON.stringify(message);
    if (typeof serialized !== "string") throw new Error("StrictStdioServerTransport message is not serializable");
    const wire = `${serialized}\n`;
    const bytes = Buffer.byteLength(wire);
    if (bytes > MAX_WIRE_MESSAGE_BYTES) {
      throw new Error("StrictStdioServerTransport message exceeds the stdio limit");
    }
    const pendingCount = this.outputQueue.length + (this.activeOutput ? 1 : 0);
    if (pendingCount >= MAX_PENDING_OUTPUT_MESSAGES || this.pendingOutputBytes + bytes > MAX_PENDING_OUTPUT_BYTES) {
      throw new Error("StrictStdioServerTransport output queue limit exceeded");
    }
    await new Promise<void>((resolve, reject) => {
      this.pendingOutputBytes += bytes;
      this.outputQueue.push({ wire, bytes, resolve, reject, onError: null, onDrain: null });
      this.pumpOutput();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    this.input.off("end", this.onInputEnd);
    if (this.input.listenerCount("data") === 0) this.input.pause();
    this.decoder.end();
    this.buffer = "";
    const outputWasBlocked = this.activeOutput !== null || this.outputQueue.length !== 0 || this.output.writableNeedDrain;
    this.rejectPendingOutput(new Error("StrictStdioServerTransport closed before output drained"));
    this.closePromise = this.flushAndCloseOutput().then((timedOut) => {
      if ((timedOut || outputWasBlocked) && this.processOutput) this.armProcessOutputExit();
    });
    this.onclose?.();
    return this.closePromise;
  }

  private pumpOutput(): void {
    if (this.closed || this.activeOutput) return;
    const pending = this.outputQueue.shift();
    if (!pending) return;
    this.activeOutput = pending;
    pending.onError = (error: Error) => this.finishOutput(pending, error);
    pending.onDrain = () => this.finishOutput(pending, null);
    this.output.once("error", pending.onError);
    this.output.once("drain", pending.onDrain);
    let nativeSettled = false;
    const settleNative = () => {
      if (nativeSettled) return;
      nativeSettled = true;
      this.finishNativeOutput();
    };
    this.nativeOutputPending += 1;
    try {
      if (this.output.write(pending.wire, settleNative)) this.finishOutput(pending, null);
    } catch (error) {
      settleNative();
      this.finishOutput(pending, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private finishOutput(pending: PendingOutput, error: Error | null): void {
    if (this.activeOutput !== pending) return;
    if (pending.onError) this.output.off("error", pending.onError);
    if (pending.onDrain) this.output.off("drain", pending.onDrain);
    this.activeOutput = null;
    this.pendingOutputBytes -= pending.bytes;
    if (error) pending.reject(error);
    else pending.resolve();
    this.pumpOutput();
  }

  private rejectPendingOutput(error: Error): void {
    const active = this.activeOutput;
    this.activeOutput = null;
    if (active) {
      if (active.onError) this.output.off("error", active.onError);
      if (active.onDrain) this.output.off("drain", active.onDrain);
      active.reject(error);
    }
    for (const pending of this.outputQueue.splice(0)) pending.reject(error);
    this.pendingOutputBytes = 0;
  }

  private finishNativeOutput(): void {
    this.nativeOutputPending -= 1;
    if (this.nativeOutputPending !== 0) return;
    for (const listener of this.nativeOutputIdleListeners) listener();
    this.nativeOutputIdleListeners.clear();
  }

  private async flushAndCloseOutput(): Promise<boolean> {
    let timedOut = false;
    if (!this.output.destroyed && !this.output.writableFinished) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.output.off("finish", finish);
          this.output.off("close", finish);
          this.output.off("error", onError);
          resolve();
        };
        const onError = () => finish();
        const timeout = setTimeout(() => {
          timedOut = true;
          finish();
        }, OUTPUT_CLOSE_FLUSH_MS);
        this.output.once("finish", finish);
        this.output.once("close", finish);
        this.output.once("error", onError);
        try {
          if (this.output.writableEnded) finish();
          else this.output.end();
        } catch {
          finish();
        }
      });
    }
    if (!this.output.destroyed) this.output.destroy();
    return timedOut;
  }

  private armProcessOutputExit(): void {
    // Node keeps process.stdout open while a native pipe write is blocked and
    // its public destroy() is a no-op. Let the other close owners settle, then
    // end this dedicated stdio process if the peer still retains the pipe.
    if (this.nativeOutputPending === 0) return;
    const ignoreTeardownError = () => undefined;
    const cleanup = () => {
      clearTimeout(forcedExit);
      this.nativeOutputIdleListeners.delete(cleanup);
      const removeErrorListener = setTimeout(() => this.output.off("error", ignoreTeardownError), 0);
      removeErrorListener.unref();
    };
    const forcedExit = setTimeout(() => {
      this.nativeOutputIdleListeners.delete(cleanup);
      this.output.off("error", ignoreTeardownError);
      process.exit(process.exitCode ?? 0);
    }, PROCESS_OUTPUT_EXIT_GRACE_MS);
    this.output.on("error", ignoreTeardownError);
    this.nativeOutputIdleListeners.add(cleanup);
  }

  private parseFailure(message: string, code = PARSE_ERROR): void {
    void this.send({
      jsonrpc: "2.0",
      id: null,
      error: {
        code,
        message,
      },
    } as unknown as JSONRPCMessage).catch((error: unknown) => {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
  }
}
